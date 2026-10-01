import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { revokeConnection } from '@ros/core';
import { ledger } from '@ros/modules';
import { BASE, chooseVenue, closeBrowser, closeDb, codeIn, db, eventually, inbox, newVisitor, orgBySlug, signInStaff, waitForMessage } from './helpers';
import { closeOpsApp, devGet, devPost, opsApp, staffAs } from './ops-helpers';

/**
 * Connecting Square by signing in, driven through the console in a browser.
 *
 * "Square" here is the simulated sign-in provider the e2e setup switches on (ROS_SIM_SQUARE_OAUTH,
 * packages/adapters/src/sim/oauth.ts): "Connect Square" sends the browser to a stand-in sign-in
 * page on the platform host, whose Allow and Deny redirect back to the console's REAL callback
 * route, and whose tokens are the ones the simulated POS accepts. Everything on our side of the
 * redirect (the server action, the callback route, the ledger's sign-in functions, the secret
 * store, the back-fill job) is the code that runs against real Square. Outcomes are read back
 * from the database.
 */
const CONNECTIONS = '/console/settings/connections';
const CALLBACK = '/console/connections/square/callback';
const run = Date.now().toString(36);
const TOKEN_MARKS = ['simpos-token-', 'simsignin-refresh-', 'simsignin-code-', 'sim-signin-whsec-'];

const squareRows = (orgId: string) => db().selectFrom('connections').selectAll().where('org_id', '=', orgId).where('plug_key', '=', 'square').execute();
const liveSquare = async (venueId: string) => (await db().selectFrom('connections').selectAll().where('venue_id', '=', venueId).where('plug_key', '=', 'square').where('status', '!=', 'revoked').execute())[0];
const pendingSecrets = async (orgId: string) => (await db().selectFrom('secrets').select('id').where('org_id', '=', orgId).where('purpose', '=', 'oauth_pending:square').execute()).length;
const inLedger = (orgId: string, ref: string) => db().selectFrom('transactions').select(['id', 'venue_id']).where('org_id', '=', orgId).where('external_ref', '=', ref).executeTakeFirst();
const signInSeen = () => devGet<{ plugKey: string; accounts: Array<{ accountRef: string; granted: boolean }>; revocations: Array<{ accountRef: string | null; everything: boolean }> }>('pos-signin');

/** A merchant account at the simulated provider, with these locations and sales already taken at them. */
async function seedAccount(accountRef: string, locations: Array<{ ref: string; name: string; salesDaysAgo?: number[] }>): Promise<string[][]> {
  const out: string[][] = [];
  for (const l of locations) {
    const r = await devPost<{ paymentIds: string[] }>('pos-seed', { accountRef, locationRef: l.ref, name: l.name, salesDaysAgo: l.salesDaysAgo ?? [] });
    out.push(r.paymentIds);
  }
  return out;
}

async function openConnections(page: Page, venueName?: string): Promise<void> {
  await page.goto(`${BASE()}${CONNECTIONS}`);
  if (venueName) await chooseVenue(page, venueName);
  await page.getByRole('heading', { name: 'Connect the point of sale' }).waitFor();
}

/** Press "Connect Square" as a manager would, and arrive at the provider's sign-in page. Returns the `state` it was sent with. */
async function startSignIn(page: Page, opts: { access?: 'read' | 'write'; months?: string } = {}): Promise<string> {
  const form = page.getByTestId('signin-square');
  if (opts.access === 'write') await form.getByRole('radio', { name: /Read sales, and send online orders and payments/ }).check();
  if (opts.months) await form.locator('select[name=historyMonths]').selectOption(opts.months);
  await form.getByRole('button', { name: 'Connect Square' }).click();
  await page.waitForURL(/\/dev\/pos-signin\?/);
  await page.getByRole('heading', { name: 'Simulated Square sign-in' }).waitFor();
  return new URL(page.url()).searchParams.get('state')!;
}

/** The seller's side: say which merchant account is signing in, and press Allow. */
async function allow(page: Page, accountRef: string): Promise<void> {
  await page.fill('input[name=account]', accountRef);
  await page.getByRole('button', { name: 'Allow' }).click();
}

/** The URL the provider would send the browser back to after Allow, without following it. */
async function callbackUrl(state: string, accountRef: string): Promise<string> {
  const { redirectTo } = await devPost<{ redirectTo: string }>('pos-signin-decide', { state, decision: 'allow', account: accountRef });
  expect(new URL(redirectTo).pathname).toBe(CALLBACK);
  return redirectTo;
}

/** Leave each org as it was found: no Square connection, so later scenarios start from "not connected". */
async function disconnectEverywhere(): Promise<void> {
  const app = await opsApp();
  for (const [slug, owner] of [['oak-diner', 'owner@oak-diner.test'], ['oak-group', 'owner@oak-group.test']] as const) {
    const who = await staffAs(owner, slug);
    for (const row of await squareRows(who.orgId)) {
      if (row.status !== 'revoked') await app.tenant(who.orgId, who.principal, (ctx) => revokeConnection(ctx, row.id));
    }
  }
}

afterEach(disconnectEverywhere);

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
});

describe('console: connecting Square by signing in', () => {
  it('a manager connects an account with one location: the tokens are sealed, nothing secret is on any row or page, and the history asked for arrives', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `simsq-one-${run}`;
    const location = `simsq-one-loc-${run}`;
    const [[recentA, recentB, old]] = (await seedAccount(account, [{ ref: location, name: 'Diner counter', salesDaysAgo: [40, 70, 500] }])) as [[string, string, string]];

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await openConnections(v.page);
    // Read-only is what is offered unless the manager asks for more.
    const form = v.page.getByTestId('signin-square');
    expect(await form.getByRole('radio', { name: /Read sales only/ }).isChecked()).toBe(true);
    const state = await startSignIn(v.page, { months: '3' });
    // The provider is asked for the read scopes only, and the URL carries a signed state, not a token.
    expect(await v.page.getByTestId('signin-scopes').locator('li').allInnerTexts()).toEqual(ledger.SQUARE_READ_SCOPES);
    expect(state.split('.')).toHaveLength(2);
    for (const mark of TOKEN_MARKS) expect(v.page.url()).not.toContain(mark);

    await allow(v.page, account);
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    const notice = v.page.getByTestId('signin-notice');
    await notice.getByText(/Square is connected to .+ Sales from now on reach the ledger; past sales are being fetched in the background\./).waitFor();

    const row = (await liveSquare(diner.venueId))!;
    const staff = await db().selectFrom('staff').select('id').where('org_id', '=', diner.orgId).where('email', '=', 'manager@oak-diner.test').executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'connected', org_id: diner.orgId, venue_id: diner.venueId, external_account_id: account, scopes: ledger.SQUARE_READ_SCOPES, connected_by_staff_id: staff.id, last_error: null });
    expect(row.config).toEqual({ environment: 'simulated', locationRef: location });
    const { now } = await devGet<{ now: string }>('clock');
    expect(Math.abs(row.expires_at!.getTime() - (Date.parse(now) + 30 * 86_400_000))).toBeLessThan(120_000);

    // Sealed: a reference on the row, ciphertext in the secret store, and the tokens nowhere a person or a log could read them.
    const secret = await db().selectFrom('secrets').select(['purpose', 'ciphertext']).where('id', '=', row.secret_ref!).executeTakeFirstOrThrow();
    expect(secret.purpose).toBe('conn:square');
    for (const mark of TOKEN_MARKS) expect(Buffer.from(secret.ciphertext).includes(mark)).toBe(false);
    for (const table of ['connections', 'audit_log', 'jobs'] as const) {
      const dump = JSON.stringify(await db().selectFrom(table).selectAll().where('org_id', '=', diner.orgId).execute());
      for (const mark of TOKEN_MARKS) expect(dump, `${table} holds ${mark}`).not.toContain(mark);
      expect(dump, `${table} holds the state`).not.toContain(state);
    }
    const html = await v.page.content();
    for (const mark of TOKEN_MARKS) expect(html).not.toContain(mark);
    const audit = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('org_id', '=', diner.orgId).where('entity_id', '=', row.id).execute();
    expect(audit).toContainEqual({ action: 'connection.created', actor_kind: 'staff' });
    expect(await pendingSecrets(diner.orgId)).toBe(0);

    // The back-fill job ran: the two sales inside three months are in the ledger at this venue, once each; the older one is not.
    await eventually(async () => (await inLedger(diner.orgId, recentA)) && (await inLedger(diner.orgId, recentB)), 'the two recent sales in the ledger', 60_000);
    expect((await inLedger(diner.orgId, recentA))!.venue_id).toBe(diner.venueId);
    expect(await inLedger(diner.orgId, old)).toBeUndefined();
    const jobs = await db().selectFrom('jobs').select(['status', 'payload']).where('org_id', '=', diner.orgId).where('kind', '=', 'ledger.pos_ingest').execute();
    const backfill = jobs.filter((j) => (j.payload as { connectionId?: string; stream?: string }).connectionId === row.id && (j.payload as { stream?: string }).stream === 'backfill');
    expect(backfill.length).toBeGreaterThan(0);
    await eventually(async () => (await db().selectFrom('ingest_cursors').select('stream').where('connection_id', '=', row.id).execute()).length === 2, 'both ingest cursors');

    // The row says what a manager needs: healthy, what it may do, that the sign-in looks after itself, and when it last synced.
    await v.page.reload();
    const shown = v.page.getByTestId('connection-square');
    await shown.getByText('Connected', { exact: true }).waitFor();
    const words = await shown.innerText();
    expect(words).toContain('Access: reads sales only.');
    expect(words).toContain('The sign-in renews automatically.');
    expect(words).toContain('Last sync');
    expect(words).not.toContain('Access expires');
    // Connected already: there is no second "Connect Square" to press.
    expect(await v.page.getByRole('button', { name: 'Connect Square', exact: true }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an account with several locations: nothing is connected until the manager chooses, then the chosen one is', async () => {
    const group = await orgBySlug('oak-group');
    const cbd = group.venues.find((x) => x.slug === 'cbd')!;
    const account = `simsq-many-${run}`;
    const [kiosk, bar] = [`simsq-kiosk-${run}`, `simsq-bar-${run}`];
    const [, [barSale]] = (await seedAccount(account, [{ ref: kiosk, name: 'Harbour kiosk' }, { ref: bar, name: 'Laneway bar', salesDaysAgo: [20] }])) as [string[], [string]];

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await openConnections(v.page, cbd.name);
    await startSignIn(v.page, { access: 'write', months: '3' });
    expect(await v.page.getByTestId('signin-scopes').locator('li').allInnerTexts()).toEqual([...ledger.SQUARE_READ_SCOPES, ...ledger.SQUARE_WRITE_SCOPES]);
    await allow(v.page, account);

    // Back on the callback route, which now asks which location. The tokens wait sealed; no connection exists.
    const chooser = v.page.getByTestId('signin-choose');
    await chooser.waitFor();
    // The spent code and state are taken out of the address bar once the page is up.
    await v.page.waitForURL(`${BASE()}${CALLBACK}`);
    expect(await chooser.locator('input[name=locationRef]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).toEqual([kiosk, bar]);
    await chooser.getByText('Harbour kiosk').waitFor();
    expect(await liveSquare(cbd.id)).toBeUndefined();
    expect(await pendingSecrets(group.orgId)).toBe(1);
    // The page holds a signed reference to the waiting sign-in, never a token. (The single-use code it arrived with is already spent.)
    const html = await v.page.content();
    for (const mark of TOKEN_MARKS.filter((m) => m !== 'simsignin-code-')) expect(html).not.toContain(mark);

    await chooser.getByRole('radio', { name: /Laneway bar/ }).check();
    await chooser.getByRole('button', { name: 'Connect this location' }).click();
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    await v.page.getByTestId('signin-notice').getByText(/Square is connected to/).waitFor();

    const row = (await liveSquare(cbd.id))!;
    expect(row).toMatchObject({ status: 'connected', external_account_id: account, scopes: [...ledger.SQUARE_READ_SCOPES, ...ledger.SQUARE_WRITE_SCOPES] });
    expect((row.config as { locationRef: string }).locationRef).toBe(bar);
    // The waiting sign-in was used up with the choice.
    expect(await pendingSecrets(group.orgId)).toBe(0);
    await eventually(() => inLedger(group.orgId, barSale), 'the chosen location\'s sale in the ledger', 60_000);
    expect((await inLedger(group.orgId, barSale))!.venue_id).toBe(cbd.id);
    expect(await v.page.getByTestId('connection-square').innerText()).toContain('Access: reads sales, and sends online orders and payments.');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a location already feeding another venue is refused in place; leaving discards the sign-in and ends it at the provider', async () => {
    const group = await orgBySlug('oak-group');
    const cbd = group.venues.find((x) => x.slug === 'cbd')!;
    const newtown = group.venues.find((x) => x.slug === 'newtown')!;
    const account = `simsq-shared-${run}`;
    const [one, two] = [`simsq-s1-${run}`, `simsq-s2-${run}`];
    await seedAccount(account, [{ ref: one, name: 'Shared one' }, { ref: two, name: 'Shared two' }]);

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    // CBD takes the first location.
    await openConnections(v.page, cbd.name);
    await startSignIn(v.page, { months: '0' });
    await allow(v.page, account);
    await v.page.getByTestId('signin-choose').getByRole('button', { name: 'Connect this location' }).click();
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    const first = (await liveSquare(cbd.id))!;
    expect((first.config as { locationRef: string }).locationRef).toBe(one);

    // Newtown signs in to the same account and asks for the same location.
    const waiting = await pendingSecrets(group.orgId);
    await openConnections(v.page, newtown.name);
    await startSignIn(v.page, { months: '0' });
    await allow(v.page, account);
    const chooser = v.page.getByTestId('signin-choose');
    await chooser.getByRole('radio', { name: /Shared one/ }).check();
    await chooser.getByRole('button', { name: 'Connect this location' }).click();
    await chooser.getByRole('alert').getByText('That location is already connected to another venue.').waitFor();
    expect(await liveSquare(newtown.id)).toBeUndefined();
    // The sign-in is still waiting, so the manager could choose the other location; this one leaves instead.
    expect(await pendingSecrets(group.orgId)).toBe(waiting + 1);
    const revokesBefore = (await signInSeen()).revocations.length;
    await chooser.getByRole('button', { name: 'Leave without connecting' }).click();
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?left=square$`));
    await v.page.getByTestId('signin-notice').getByText('You left before choosing a location, so nothing was connected').waitFor();

    expect(await pendingSecrets(group.orgId)).toBe(waiting);
    expect(await liveSquare(newtown.id)).toBeUndefined();
    // Only that one token was ended at the provider: the account still feeds CBD.
    expect((await signInSeen()).revocations.slice(revokesBefore)).toEqual([{ accountRef: account, everything: false }]);
    expect((await liveSquare(cbd.id))!).toMatchObject({ id: first.id, status: 'connected' });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('pressing Deny at Square connects nothing, and the console says so plainly', async () => {
    const diner = await orgBySlug('oak-diner');
    const before = (await squareRows(diner.orgId)).map((r) => [r.id, r.status]);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await openConnections(v.page);
    await startSignIn(v.page);
    await v.page.getByRole('button', { name: 'Deny' }).click();

    const declined = v.page.getByTestId('signin-declined');
    await declined.getByText('You pressed Deny at Square, so nothing was connected.').waitFor();
    const url = new URL(v.page.url());
    expect(url.pathname).toBe(CALLBACK);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect((await squareRows(diner.orgId)).map((r) => [r.id, r.status])).toEqual(before);
    expect(await liveSquare(diner.venueId)).toBeUndefined();
    expect(await pendingSecrets(diner.orgId)).toBe(0);

    // Back on the screen, the offer is still there.
    await declined.getByRole('link', { name: 'Back to connected services' }).click();
    await v.page.getByTestId('signin-square').getByRole('button', { name: 'Connect Square' }).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a state that was altered on the way back is refused before the code is used', async () => {
    const diner = await orgBySlug('oak-diner');
    const group = await orgBySlug('oak-group');
    const account = `simsq-tamper-${run}`;
    await seedAccount(account, [{ ref: `simsq-tamper-loc-${run}`, name: 'Tamper counter' }]);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await openConnections(v.page);
    const state = await startSignIn(v.page);
    const real = new URL(await callbackUrl(state, account));

    // The same signature over a body that now names another org's venue.
    const [body, sig] = state.split('.') as [string, string];
    const altered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), v: group.venueId })).toString('base64url');
    const forged = new URL(real);
    forged.searchParams.set('state', `${altered}.${sig}`);
    await v.page.goto(forged.toString());
    await v.page.getByTestId('signin-refused').getByRole('alert').getByText('That sign-in has expired. Start connecting again.').waitFor();
    expect(await liveSquare(diner.venueId)).toBeUndefined();
    expect(await liveSquare(group.venueId)).toBeUndefined();

    // No state at all, and a made-up one, are answered the same way.
    for (const bad of [`${BASE()}${CALLBACK}?code=${real.searchParams.get('code')}`, `${BASE()}${CALLBACK}?code=x&state=not-a-state`]) {
      await v.page.goto(bad);
      await v.page.getByTestId('signin-refused').getByText('That sign-in has expired. Start connecting again.').waitFor();
    }
    expect(await liveSquare(diner.venueId)).toBeUndefined();

    // The code was never spent on the forgeries: the untouched redirect still connects.
    await v.page.goto(real.toString());
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    expect((await liveSquare(diner.venueId))!).toMatchObject({ status: 'connected', external_account_id: account });
    // And a code works once: the same redirect again connects nothing new and says the sign-in is over.
    await v.page.goto(real.toString());
    await v.page.getByTestId('signin-refused').getByRole('alert').getByText('Square did not accept that sign-in. Start connecting again.').waitFor();
    expect((await squareRows(diner.orgId)).filter((r) => r.status !== 'revoked')).toHaveLength(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front-of-house staff are offered no Connect button, and a callback forged for them with a manager\'s state is refused', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `simsq-foh-${run}`;
    await seedAccount(account, [{ ref: `simsq-foh-loc-${run}`, name: 'Front counter' }]);

    const host = await newVisitor();
    await signInStaff(host.page, 'host@oak-diner.test');
    await host.page.goto(`${BASE()}${CONNECTIONS}`);
    await host.page.getByText('Your role does not include this').waitFor();
    expect(await host.page.getByRole('button', { name: 'Connect Square', exact: true }).count()).toBe(0);
    expect(await host.page.getByTestId('signin-square').count()).toBe(0);

    // A manager starts a sign-in; its redirect (a real state and a real code) is opened in the host's session instead.
    const manager = await newVisitor();
    await signInStaff(manager.page, 'manager@oak-diner.test');
    await openConnections(manager.page);
    const state = await startSignIn(manager.page);
    const url = await callbackUrl(state, account);
    await host.page.goto(url);
    await host.page.getByTestId('signin-refused').getByRole('alert').getByText('That sign-in has expired. Start connecting again.').waitFor();
    expect(await liveSquare(diner.venueId)).toBeUndefined();
    expect(await pendingSecrets(diner.orgId)).toBe(0);
    expect(host.problems).toEqual([]);
    expect(manager.problems).toEqual([]);
    await host.context.close();
    await manager.context.close();
  });

  it('disconnect: the dialog says what ends, the connection and its sealed sign-in are gone, and the access is ended at Square', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `simsq-bye-${run}`;
    await seedAccount(account, [{ ref: `simsq-bye-loc-${run}`, name: 'Bye counter' }]);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await openConnections(v.page);
    await startSignIn(v.page, { months: '0' });
    await allow(v.page, account);
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    const row = (await liveSquare(diner.venueId))!;
    expect((await signInSeen()).accounts).toContainEqual({ accountRef: account, granted: true });

    await v.page.getByTestId('revoke-square').click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.getByText('Sales stop arriving from Square').waitFor();
    await dialog.getByText('the access you gave us at Square is ended').waitFor();
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await v.page.getByTestId('console-flash').getByText('our access at Square has been ended').waitFor();

    const after = await db().selectFrom('connections').select(['status', 'secret_ref']).where('id', '=', row.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'revoked', secret_ref: null });
    await eventually(async () => (await db().selectFrom('secrets').select('id').where('id', '=', row.secret_ref!).execute()).length === 0, 'the sealed sign-in deleted');
    // The last connection for that merchant: the whole grant is ended at the provider, which now refuses the account.
    const seen = await signInSeen();
    expect(seen.revocations.at(-1)).toEqual({ accountRef: account, everything: true });
    expect(seen.accounts).toContainEqual({ accountRef: account, granted: false });
    const audit = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_id', '=', row.id).execute();
    expect(audit).toContainEqual({ action: 'connection.revoked', actor_kind: 'staff' });

    // Not connected any more: the row is gone and Square is offered again.
    expect(await v.page.getByTestId('connection-square').count()).toBe(0);
    await v.page.getByTestId('signin-square').getByRole('button', { name: 'Connect Square' }).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a signed-out person sent back from Square signs in and is returned to the callback with its query intact', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `simsq-away-${run}`;
    await seedAccount(account, [{ ref: `simsq-away-loc-${run}`, name: 'Away counter' }]);
    const email = 'manager@oak-diner.test';
    const started = await newVisitor();
    await signInStaff(started.page, email);
    await openConnections(started.page);
    const url = await callbackUrl(await startSignIn(started.page), account);
    await started.context.close();

    // The redirect lands in a browser with no session (it expired while they were at Square).
    const v = await newVisitor();
    await v.page.goto(url);
    await v.page.waitForURL(/\/login\?next=/);
    const next = new URL(v.page.url()).searchParams.get('next')!;
    expect(`${BASE()}${next}`).toBe(url);
    expect(await liveSquare(diner.venueId)).toBeUndefined();

    const before = (await inbox(email)).length;
    await v.page.fill('input[name=email]', email);
    await v.page.click('button[type=submit]');
    await v.page.waitForURL(/sent=1/);
    const message = await eventually(async () => {
      const all = await inbox(email);
      return all.length > before ? all.at(-1) : null;
    }, 'the sign-in code');
    await v.page.fill('input[name=code]', codeIn(message.body));
    await v.page.click('button[type=submit]');

    // Signed in, the callback ran with the same state and code, as the same person.
    await v.page.getByTestId('signin-notice').getByText(/Square is connected to/).waitFor();
    expect(new URL(v.page.url()).pathname).toBe(CONNECTIONS);
    expect((await liveSquare(diner.venueId))!).toMatchObject({ status: 'connected', external_account_id: account });
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('when Square stops accepting the saved sign-in, the row asks for it to be connected again, and reconnecting mends the same connection', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `simsq-lapse-${run}`;
    await seedAccount(account, [{ ref: `simsq-lapse-loc-${run}`, name: 'Lapse counter' }]);
    const email = 'manager@oak-diner.test';
    const v = await newVisitor();
    await signInStaff(v.page, email);
    await openConnections(v.page);
    await startSignIn(v.page, { access: 'write', months: '0' });
    await allow(v.page, account);
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));
    const row = (await liveSquare(diner.venueId))!;
    expect(await v.page.getByTestId('reconnect-square').count()).toBe(0);

    // The seller removes the app in their Square account; the next renewal is refused.
    await devPost('pos-signin-withdraw', { accountRef: account });
    const renewal = await devPost<{ connectionId: string; outcome: string }>('pos-signin-renew', { venueId: diner.venueId });
    expect(renewal).toEqual({ connectionId: row.id, outcome: 'refused' });
    expect(await db().selectFrom('connections').select(['status', 'last_error']).where('id', '=', row.id).executeTakeFirstOrThrow()).toEqual({ status: 'unhealthy', last_error: 'Square no longer accepts the saved sign-in.' });
    // The person who connected it is told by email.
    await waitForMessage(email, (m) => m.subject === 'Square needs connecting again');

    await v.page.goto(`${BASE()}${CONNECTIONS}`);
    const shown = v.page.getByTestId('connection-square');
    await shown.getByText('Needs attention', { exact: true }).waitFor();
    await shown.getByText('Square no longer accepts the saved sign-in.').waitFor();
    expect(await shown.innerText()).not.toContain('renews automatically');
    const prompt = v.page.getByTestId('reconnect-square');
    await prompt.getByText('Square needs connecting again').waitFor();
    await prompt.getByRole('button', { name: 'Reconnect Square' }).click();
    await v.page.waitForURL(/\/dev\/pos-signin\?/);
    // It asks for what the connection had before.
    expect(await v.page.getByTestId('signin-scopes').locator('li').allInnerTexts()).toEqual([...ledger.SQUARE_READ_SCOPES, ...ledger.SQUARE_WRITE_SCOPES]);
    await allow(v.page, account);
    await v.page.waitForURL(new RegExp(`${CONNECTIONS}\\?connected=square$`));

    const mended = (await liveSquare(diner.venueId))!;
    expect(mended).toMatchObject({ id: row.id, status: 'connected', last_error: null, secret_ref: row.secret_ref });
    expect(await v.page.getByTestId('reconnect-square').count()).toBe(0);
    await v.page.getByTestId('connection-square').getByText('Connected', { exact: true }).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
