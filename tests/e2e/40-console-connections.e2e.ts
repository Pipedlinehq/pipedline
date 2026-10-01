import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '@ros/core';
import { BASE, chooseVenue, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { SHOTS, devPost } from './ops-helpers';

/**
 * Connected services, driven through the console: a point of sale connected and its history
 * fetched, a service with its own assistant tools (Criota) connected and given a key of its own,
 * the organisation's email platform, and an ad platform. Providers are the simulated ones in the
 * web process; every outcome is read back from the database.
 */

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

describe('console: connected services', () => {
  it('a venue disconnects its point of sale, connects another account by choosing its location, and fetches its history', async () => {
    const group = await orgBySlug('oak-group');
    const bondi = group.venues.find((x) => x.slug === 'bondi')!;
    const accountRef = `simpos-acct-e2e-${run}`;
    const locationRef = `simpos-loc-e2e-${run}`;
    // The till the venue is moving to already exists at the provider, with sales taken on it: two
    // inside the last twelve months, one further back. (All well before the periods the analytics
    // scenarios look at, so this history does not move their numbers.)
    const seeded = await devPost<{ paymentIds: string[] }>('pos-seed', { accountRef, locationRef, name: 'Bondi counter', salesDaysAgo: [200, 300, 500] });
    expect(seeded.paymentIds).toHaveLength(3);
    const [recentA, recentB, old] = seeded.paymentIds as [string, string, string];
    const inLedger = async (ref: string) => db().selectFrom('transactions').select(['id', 'venue_id', 'source']).where('org_id', '=', group.orgId).where('external_ref', '=', ref).executeTakeFirst();

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-group.test');
    await v.page.goto(`${BASE()}/console/settings/connections`);
    await chooseVenue(v.page, bondi.name);
    await v.page.getByRole('heading', { name: `Connected at ${bondi.name}` }).waitFor();

    // The fixture till goes first. Its row leaves the list with the dialog that confirmed it, so
    // the answer is said in the console's own message area instead.
    const before = await db().selectFrom('connections').select(['id', 'secret_ref']).where('venue_id', '=', bondi.id).where('plug_key', '=', 'sim-pos').where('status', '!=', 'revoked').executeTakeFirstOrThrow();
    await v.page.getByTestId('revoke-sim-pos').click();
    const confirm = v.page.locator('dialog[open]');
    await confirm.getByText('its stored credentials are destroyed').waitFor();
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await v.page.getByTestId('console-flash').getByText('Disconnected. Its stored credentials were destroyed.').waitFor();
    expect(await v.page.locator('dialog[open]').count()).toBe(0);
    const revoked = await db().selectFrom('connections').select(['status', 'secret_ref']).where('id', '=', before.id).executeTakeFirstOrThrow();
    expect(revoked.status).toBe('revoked');
    expect(revoked.secret_ref).toBeNull();

    // Step one: ask the provider which locations the account has. Step two: say which is this venue.
    await v.page.getByRole('textbox', { name: 'Account or merchant ID' }).fill(accountRef);
    await v.page.getByRole('button', { name: 'Find its locations' }).click();
    const location = v.page.locator('select[name=locationRef]');
    await location.waitFor();
    expect(await location.locator('option').allInnerTexts()).toEqual(['Bondi counter']);
    await v.page.selectOption('select[name=backfillMonths]', '12');
    await v.page.getByRole('button', { name: 'Connect this location' }).click();
    await v.page.getByText(/Connected\. Sales from Simulated POS now reach the ledger; past sales are being fetched/).waitFor();

    const conn = await db().selectFrom('connections').select(['id', 'status', 'external_account_id', 'config', 'secret_ref', 'connected_by_staff_id']).where('venue_id', '=', bondi.id).where('plug_key', '=', 'sim-pos').where('status', '!=', 'revoked').executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ status: 'connected', external_account_id: accountRef });
    expect((conn.config as { locationRef: string }).locationRef).toBe(locationRef);
    // The credentials are sealed: a reference on the row, nothing readable.
    expect(conn.secret_ref).toBeTruthy();
    expect(JSON.stringify(conn)).not.toContain('accessToken');

    // The back-fill runs in the background and brings in the sales inside its window, at this venue, once each.
    await eventually(async () => (await inLedger(recentA)) && (await inLedger(recentB)), 'the two recent sales in the ledger', 60_000);
    expect((await inLedger(recentA))!.venue_id).toBe(bondi.id);
    expect(await inLedger(old)).toBeUndefined();
    const cursors = await db().selectFrom('ingest_cursors').select(['stream', 'synced_through']).where('connection_id', '=', conn.id).execute();
    // One cursor for sales from now on, one for the history that was asked for.
    expect(cursors.map((c) => c.stream).sort()).toEqual(['backfill', 'transactions']);

    // Asking for more history widens the window; nothing already in the ledger is counted twice.
    await v.page.reload();
    const row = v.page.getByTestId('connection-sim-pos');
    await row.getByRole('button', { name: 'Fetch history' }).click();
    const fetch = v.page.getByRole('dialog', { name: 'Fetch past sales from Simulated POS' });
    await fetch.locator('select[name=months]').selectOption('24');
    await fetch.getByRole('button', { name: 'Fetch history' }).click();
    await fetch.getByText('Fetching the last 24 months of sales').waitFor();
    await eventually(() => inLedger(old), 'the older sale in the ledger', 60_000);
    for (const ref of seeded.paymentIds) {
      expect((await db().selectFrom('transactions').select('id').where('org_id', '=', group.orgId).where('external_ref', '=', ref).execute()).length).toBe(1);
    }
    const audit = await db().selectFrom('audit_log').select(['actor_kind', 'after']).where('action', '=', 'pos.backfill_requested').where('entity_id', '=', conn.id).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect((audit.after as { months: number }).months).toBe(24);

    // A sale rung up on the newly connected till arrives by its webhook, signed with the connection's own secret.
    const sale = await devPost<{ paymentId: string; delivery: { status: number } }>('sale', { venueId: bondi.id });
    expect(sale.delivery.status).toBe(200);
    await eventually(() => inLedger(sale.paymentId), 'the new sale in the ledger');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner connects Criota with a key from Criota, then gives Criota a key of its own that can only read outcomes', async () => {
    const group = await orgBySlug('oak-group');
    const { accessKey } = await devPost<{ accessKey: string }>('criota', { action: 'issue', account: `Oak Group ${run}` });

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-group.test');
    await v.page.goto(`${BASE()}/console/settings/connections`);
    const form = v.page.locator('form', { has: v.page.locator('input[name=accessKey]') });
    await form.locator('select[name=plugKey]').selectOption('criota-sim');
    await form.locator('input[name=accessKey]').fill(accessKey);
    await form.locator('input[name=account]').fill(`Oak Group ${run}`);
    await form.getByRole('button', { name: 'Connect', exact: true }).click();
    await form.getByText('Connected. We check the key with the service in the background').waitFor();

    const conn = await eventually(
      () => db().selectFrom('connections').select(['id', 'status', 'venue_id', 'secret_ref', 'config']).where('org_id', '=', group.orgId).where('plug_key', '=', 'criota-sim').where('status', '!=', 'revoked').executeTakeFirst(),
      'the Criota connection',
    );
    expect(conn.venue_id).toBeNull();
    expect(conn.secret_ref).toBeTruthy();
    // The pasted key is nowhere on the row or in the audit log.
    expect(JSON.stringify(conn)).not.toContain(accessKey);
    const logged = await db().selectFrom('audit_log').select(['action', 'before', 'after']).where('org_id', '=', group.orgId).where('entity_id', '=', conn.id).execute();
    expect(logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(logged)).not.toContain(accessKey);

    // The service answers with that key: the connection is healthy.
    await v.page.getByRole('button', { name: 'Check assistant plugs now' }).click();
    await eventually(async () => (await db().selectFrom('connections').select(['status', 'last_ok_at']).where('id', '=', conn.id).executeTakeFirstOrThrow()).last_ok_at, 'Criota answered');
    await v.page.reload();
    const row = v.page.getByTestId('connection-criota-sim');
    await row.getByText('Connected', { exact: true }).waitFor();

    // A key for Criota itself: shown once, stored as a hash, tied to the connection, read-only, outcomes only.
    const keyName = `Criota outcomes ${run}`;
    const keys = v.page.getByTestId('service-keys-criota-sim');
    await keys.locator('input[name=name]').fill(keyName);
    await keys.locator('input[name=expiresInDays]').fill('14');
    await keys.getByRole('button', { name: /Create a key for/ }).click();
    const shown = v.page.getByTestId('new-service-key');
    await shown.waitFor();
    const key = (await shown.textContent())!.trim();
    expect(key).toMatch(/^ros_agent_[A-Za-z0-9_-]{43}$/);

    const stored = await db().selectFrom('agent_keys').selectAll().where('org_id', '=', group.orgId).where('name', '=', keyName).executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ audience: 'service:criota-sim', connection_id: conn.id, can_write: false, scopes: ['outcomes:read'], revoked_at: null });
    expect(Buffer.from(stored.key_hash).equals(Buffer.from(hashToken(key)))).toBe(true);
    expect(JSON.stringify({ ...stored, key_hash: stored.key_hash.toString('hex') })).not.toContain(key.slice(20));
    const days = (stored.expires_at.getTime() - stored.created_at.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(14);

    // Shown once: after a reload the page names the key but cannot show it.
    await v.page.reload();
    await v.page.getByTestId('service-keys-criota-sim').getByText(keyName).waitFor();
    expect(await v.page.content()).not.toContain(key.slice(20));

    // The key dies with the connection.
    await v.page.getByTestId('revoke-criota-sim').click();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await v.page.getByTestId('console-flash').getByText('Disconnected.').waitFor();
    await eventually(async () => (await db().selectFrom('agent_keys').select('revoked_at').where('id', '=', stored.id).executeTakeFirstOrThrow()).revoked_at, 'the service key revoked with its connection');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a manager is not offered what only an owner may connect, and the service refuses it too', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/connections`);
    await v.page.getByRole('heading', { name: 'Your email platform' }).waitFor();
    expect(await v.page.getByRole('button', { name: 'Connect email platform' }).count()).toBe(0);
    expect(await v.page.getByRole('button', { name: 'Connect ad platform' }).count()).toBe(0);
    expect(await v.page.getByRole('button', { name: /Create a key for/ }).count()).toBe(0);
    await v.page.getByText('Only an owner can connect or disconnect it').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner connects the email platform: its first sync runs, "sync now" runs another, and disconnecting hands email back', async () => {
    const diner = await orgBySlug('oak-diner');
    const account = `sim-esp-${run}`;
    const apiKey = `sim-esp-key-${run}-secret`;
    const tier = async () => {
      const row = await db().selectFrom('orgs').select('settings').where('id', '=', diner.orgId).executeTakeFirstOrThrow();
      return ((row.settings ?? {}) as { comms_esp?: { emailMarketingTier?: string } }).comms_esp?.emailMarketingTier ?? 'native';
    };
    expect(await tier()).toBe('native');

    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/connections`);
    const form = v.page.locator('form', { has: v.page.locator('input[name=apiKey]') });
    await form.locator('select[name=plugKey]').selectOption('sim-esp');
    await form.locator('input[name=externalAccountId]').fill(account);
    await form.locator('input[name=apiKey]').fill(apiKey);
    await form.locator('select[name=tier]').selectOption('connected');
    await form.getByRole('button', { name: 'Connect email platform' }).click();
    await v.page.getByText(/connected\. It sends your marketing email from now on, and the first sync has started/).waitFor();

    const conn = await db().selectFrom('connections').select(['id', 'status', 'venue_id', 'secret_ref', 'config']).where('org_id', '=', diner.orgId).where('plug_key', '=', 'sim-esp').where('status', '!=', 'revoked').executeTakeFirstOrThrow();
    expect(conn.venue_id).toBeNull();
    expect(JSON.stringify(conn)).not.toContain(apiKey);
    expect(await tier()).toBe('connected');
    // The first sync, queued by connecting, pushes the guests who agreed to marketing.
    const first = await eventually(
      async () => {
        const s = await db().selectFrom('esp_sync_state').select(['last_run_at', 'last_ok_at', 'last_error']).where('connection_id', '=', conn.id).executeTakeFirst();
        return s?.last_ok_at ? s : null;
      },
      'the first sync',
      60_000,
    );
    expect(first.last_error).toBeNull();
    const profiles = await db().selectFrom('esp_sync_profiles').select(['state']).where('connection_id', '=', conn.id).execute();
    expect(profiles.length).toBeGreaterThan(0);

    await v.page.reload();
    const row = v.page.getByTestId('esp-sim-esp');
    await row.getByText('It sends your marketing email').waitFor();
    await v.page.screenshot({ path: `${SHOTS}/console-connections.png`, fullPage: true });
    expect(await row.innerText()).toContain(`${profiles.filter((p) => p.state === 'subscribed').length.toLocaleString('en-AU')} subscribed`);
    await row.getByRole('button', { name: 'Sync now' }).click();
    await eventually(async () => {
      const s = await db().selectFrom('esp_sync_state').select('last_run_at').where('connection_id', '=', conn.id).executeTakeFirstOrThrow();
      return s.last_run_at && s.last_run_at.getTime() > first.last_run_at!.getTime();
    }, 'a second sync after "Sync now"', 60_000);

    await v.page.getByTestId('esp-disconnect-sim-esp').click();
    await v.page.locator('dialog[open]').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await v.page.getByTestId('console-flash').getByText('Marketing email is sent by us again').waitFor();
    const after = await db().selectFrom('connections').select(['status', 'secret_ref']).where('id', '=', conn.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ status: 'revoked', secret_ref: null });
    expect(await tier()).toBe('native');
    await v.page.getByText('None connected: marketing email is sent by us.').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an owner connects an ad platform for one venue; the token is sealed and the screen shows what was reported', async () => {
    const diner = await orgBySlug('oak-diner');
    const dataset = `sim-dataset-${run}`;
    const token = `sim-ads-token-${run}-secret`;
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/settings/connections`);
    const form = v.page.locator('form', { has: v.page.locator('select[name=scope]') });
    await form.locator('select[name=plugKey]').selectOption('sim-ads');
    await form.locator('input[name=externalAccountId]').fill(dataset);
    await form.locator('input[name=accessToken]').fill(token);
    await form.locator('select[name=scope]').selectOption('venue');
    await form.getByRole('button', { name: 'Connect ad platform' }).click();
    await v.page.getByText('Connected. Purchases by guests who agreed to ad-platform sharing are reported from now on').waitFor();

    const conn = await db().selectFrom('connections').select(['id', 'status', 'venue_id', 'external_account_id', 'secret_ref', 'config']).where('org_id', '=', diner.orgId).where('plug_key', '=', 'sim-ads').where('status', '!=', 'revoked').executeTakeFirstOrThrow();
    expect(conn).toMatchObject({ status: 'connected', venue_id: diner.venueId, external_account_id: dataset });
    expect(JSON.stringify(conn)).not.toContain(token);
    const row = v.page.getByTestId('ads-sim-ads');
    await row.waitFor();
    expect(await row.getByTestId('ads-counts').innerText()).toMatch(/^0 reported, 0 waiting/);
    expect(await v.page.content()).not.toContain(token);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
