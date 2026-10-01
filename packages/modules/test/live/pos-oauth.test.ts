import { beforeEach, describe, expect, it } from 'vitest';
import { type ConnectionRow, drainJobs, resolveConnection, tickSchedules } from '@ros/core';
import { createSquareAdapter, createSquareOAuth } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { ledger } from '@ros/modules';

/**
 * Square sign-in end to end through the ledger's service functions, the real Square adapters
 * and the real database, with Square itself replaced by a stub that answers as its
 * documentation says. Nothing here has run against Square or its sandbox.
 */
const APP_ID = 'sq0idp-test-application';
const APP_SECRET = 'sq0csp-test-application-secret';
const WEBHOOK_KEY = 'square-webhook-signature-key';
const WEBHOOK_URL = 'https://console.rosplatform.test/webhooks/pos/square';
const MERCHANT = 'MLQW2MYBY81PZ';
const DAY = 86_400_000;
const COLUMNS = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
}

describe('connecting Square by sign-in', () => {
  const t = useTestEnv();

  /** What "Square" is doing right now. Each test sets it. */
  const square = {
    calls: [] as Call[],
    locations: [{ id: 'L-ONE', name: 'Oak Diner', timezone: 'Australia/Sydney', status: 'ACTIVE' }] as Array<Record<string, string>>,
    issued: 0,
    /** Access tokens Square still honours. */
    live: new Set<string>(),
    token: 'ok' as 'ok' | 'refused' | 'down',
    revoke: 'ok' as 'ok' | 'down',
    merchant: MERCHANT,
  };
  const calls = (path: string) => square.calls.filter((c) => c.path === path);

  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    square.calls.push({ method: init?.method ?? 'GET', path: url.pathname, headers, body });
    const answer = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/oauth2/token') {
      if (square.token === 'down') return answer(503, {});
      if (square.token === 'refused') return answer(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] });
      const access = `EAAl-access-${++square.issued}`;
      square.live.add(access);
      const expires = new Date(t.clock().getTime() + 30 * DAY).toISOString();
      // Code flow: the refresh token stays the same and is not repeated on a refresh.
      return answer(200, { access_token: access, token_type: 'bearer', expires_at: expires, merchant_id: square.merchant, short_lived: false, ...(body.grant_type === 'authorization_code' ? { refresh_token: 'EQAAl-refresh-1' } : {}) });
    }
    if (url.pathname === '/oauth2/revoke') {
      if (square.revoke === 'down') return answer(500, {});
      if (body.revoke_only_access_token) square.live.delete(body.access_token);
      else square.live.clear();
      return answer(200, { success: true });
    }
    if (url.pathname === '/v2/locations') {
      const token = (headers.Authorization ?? '').replace('Bearer ', '');
      if (!square.live.has(token)) return answer(401, { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }] });
      return answer(200, { locations: square.locations });
    }
    return answer(500, { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }] });
  }) as typeof globalThis.fetch;

  const registerSquare = () => {
    const adapter = createSquareAdapter({ fetch });
    t.app.adapters.register('pos', adapter);
    t.app.adapters.register('payment', adapter);
    t.app.adapters.register('oauth', createSquareOAuth({ applicationId: APP_ID, applicationSecret: APP_SECRET, environment: 'sandbox', webhookSignatureKey: WEBHOOK_KEY, webhookUrl: WEBHOOK_URL, fetch }));
  };

  beforeEach(() => {
    registerSquare();
    square.calls.length = 0;
    square.locations = [{ id: 'L-ONE', name: 'Oak Diner', timezone: 'Australia/Sydney', status: 'ACTIVE' }];
    square.token = 'ok';
    square.revoke = 'ok';
    square.merchant = MERCHANT;
  });

  const squareRows = (orgId?: string) => {
    let q = t.db.selectFrom('connections').select(COLUMNS).where('plug_key', '=', 'square');
    if (orgId) q = q.where('org_id', '=', orgId);
    return q.execute();
  };
  const pendingSecrets = async () => (await t.db.selectFrom('secrets').select('id').where('purpose', '=', 'oauth_pending:square').execute()).length;
  const credentialsOf = async (row: ConnectionRow) => (await resolveConnection(t.app, row)).credentials;

  /** Sign in and connect the diner, as its manager. */
  async function connectDiner() {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const start = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }));
    const outcome = await ledger.completePosOAuth(t.app, { orgId: diner.orgId, principal: manager, state: start.state, code: 'sq0cgb-code' });
    if (outcome.status !== 'connected') throw new Error(`expected connected, got ${outcome.status}`);
    const row = (await squareRows(diner.orgId)).find((r) => r.id === outcome.connection.id)!;
    return { diner, manager, row: row as ConnectionRow, view: outcome.connection };
  }

  // ── start ──────────────────────────────────────────────────────────────────────────────────

  it('start gives the manager Square\'s sign-in URL with a signed state, and calls nobody', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const start = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId, scopes: ledger.SQUARE_READ_SCOPES }));
    const url = new URL(start.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://connect.squareupsandbox.com/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: APP_ID, scope: 'MERCHANT_PROFILE_READ PAYMENTS_READ ORDERS_READ', session: 'false', state: start.state });
    expect(start.url).not.toContain(APP_SECRET);
    expect(start.expiresAt.getTime() - t.clock().getTime()).toBe(15 * 60_000);
    expect(square.calls).toEqual([]);
    expect(await squareRows()).toEqual([]);
  });

  it('start is refused below manager, at a venue the caller has no role at, for another org\'s venue, and for an assistant', async () => {
    const { diner, group } = t.fixture;
    const go = (principal: any, orgId: string, venueId: string) => t.app.tenant(orgId, principal, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId }));
    await expect(go(await diner.as('host'), diner.orgId, diner.venueId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(go({ kind: 'anon' }, diner.orgId, diner.venueId)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(go(await group.as('manager'), group.orgId, group.venues.bondi!.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(go(await group.as('manager'), group.orgId, diner.venueId)).rejects.toMatchObject({ code: 'not_found' });
    // An internal principal passes role checks elsewhere; connecting a till still needs a person.
    await expect(go({ kind: 'worker', job: 'x' }, diner.orgId, diner.venueId)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('start refuses a scope the plug may not be granted, a plug that is not signed into, and a deployment without Square credentials', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const go = (input: Parameters<typeof ledger.startPosOAuth>[1]) => t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, input));
    await expect(go({ plugKey: 'square', venueId: diner.venueId, scopes: ['CUSTOMERS_WRITE'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(go({ plugKey: 'sim-pos', venueId: diner.venueId })).rejects.toMatchObject({ code: 'invalid' });
    await expect(go({ plugKey: 'nope', venueId: diner.venueId })).rejects.toMatchObject({ code: 'not_found' });
  });

  // ── the redirect back ──────────────────────────────────────────────────────────────────────

  it('completing with one location connects it: tokens sealed, platform webhook key and environment on the connection, nothing secret on any row', async () => {
    const { diner, row, view } = await connectDiner();

    expect(view).toMatchObject({ venueId: diner.venueId, plugKey: 'square', status: 'connected', externalAccountId: MERCHANT, locationRef: 'L-ONE' });
    expect(row.status).toBe('connected');
    expect(row.venue_id).toBe(diner.venueId);
    expect(row.external_account_id).toBe(MERCHANT);
    expect(row.scopes).toEqual([...ledger.SQUARE_READ_SCOPES, ...ledger.SQUARE_WRITE_SCOPES]);
    expect(row.config).toEqual({ environment: 'sandbox', applicationId: APP_ID, webhookUrl: WEBHOOK_URL, locationRef: 'L-ONE' });
    expect(row.expires_at!.getTime()).toBe(t.clock().getTime() + 30 * DAY);
    expect(await credentialsOf(row)).toEqual({ webhookSecret: WEBHOOK_KEY, accessToken: 'EAAl-access-' + square.issued, refreshToken: 'EQAAl-refresh-1' });

    // The exchange carried the application secret in the body; the location list used the new token.
    expect(calls('/oauth2/token')[0]!.body).toEqual({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: 'authorization_code', code: 'sq0cgb-code' });
    expect(calls('/v2/locations')).toHaveLength(1);

    // Tokens exist only sealed: not on the connection, in the audit log, or in a job.
    for (const table of ['connections', 'audit_log', 'jobs'] as const) {
      const dump = JSON.stringify(await t.db.selectFrom(table).selectAll().where('org_id', '=', diner.orgId).execute());
      expect(dump, table).not.toContain('EAAl-access');
      expect(dump, table).not.toContain('EQAAl-refresh');
      expect(dump, table).not.toContain(WEBHOOK_KEY);
    }
    const audited = await t.db.selectFrom('audit_log').select('action').where('org_id', '=', diner.orgId).where('entity_id', '=', row.id).execute();
    expect(audited.map((a) => a.action)).toContain('connection.created');
    expect(await pendingSecrets()).toBe(0);
  });

  it('a state is good only for the person and org it was made for, unaltered, for fifteen minutes', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const { state } = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }));
    const before = (await squareRows()).length;
    const go = (orgId: string, principal: any, s: string) => ledger.completePosOAuth(t.app, { orgId, principal, state: s, code: 'sq0cgb-code' });

    await expect(go(diner.orgId, await diner.as('owner'), state)).rejects.toMatchObject({ code: 'invalid' }); // another person
    await expect(go(group.orgId, await group.as('manager'), state)).rejects.toMatchObject({ code: 'invalid' }); // another org
    const [body, sig] = state.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), v: group.venues.cbd!.id })).toString('base64url');
    await expect(go(diner.orgId, manager, `${forged}.${sig}`)).rejects.toMatchObject({ code: 'invalid' }); // altered
    await expect(go(diner.orgId, manager, 'garbage')).rejects.toMatchObject({ code: 'invalid' });
    await expect(go(diner.orgId, { kind: 'worker', job: 'x' }, state)).rejects.toMatchObject({ code: 'forbidden' });

    t.clock.advanceMinutes(16);
    await expect(go(diner.orgId, manager, state)).rejects.toMatchObject({ code: 'invalid' }); // expired

    expect(calls('/oauth2/token')).toEqual([]); // Square was never asked
    expect((await squareRows()).length).toBe(before);
  });

  it('a seller who declines connects nothing and no code is exchanged', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const before = (await squareRows()).length;
    const { state } = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }));
    expect(await ledger.completePosOAuth(t.app, { orgId: diner.orgId, principal: manager, state, error: 'access_denied' })).toEqual({ status: 'declined' });
    expect(square.calls).toEqual([]);
    expect((await squareRows()).length).toBe(before);
  });

  it('a code Square refuses, or Square being down, connects nothing and says which', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const before = (await squareRows()).length;
    const { state } = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }));
    square.token = 'refused';
    await expect(ledger.completePosOAuth(t.app, { orgId: diner.orgId, principal: manager, state, code: 'used-code' })).rejects.toMatchObject({ code: 'invalid' });
    square.token = 'down';
    await expect(ledger.completePosOAuth(t.app, { orgId: diner.orgId, principal: manager, state, code: 'c' })).rejects.toMatchObject({ code: 'provider_error' });
    expect((await squareRows()).length).toBe(before);
    expect(await pendingSecrets()).toBe(0);
  });

  it('a refusal thrown by another copy of the adapter code (as in the web build) is still a refusal, not an outage', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    // What a second copy of @ros/core throws: the same name, a different class object.
    class OAuthRefusedError extends Error {
      override name = 'OAuthRefusedError';
    }
    const foreign = new OAuthRefusedError('square: 401 on /oauth2/token');
    expect(foreign instanceof (await import('@ros/core')).OAuthRefusedError).toBe(true);
    expect(new Error('square: 503') instanceof (await import('@ros/core')).OAuthRefusedError).toBe(false);

    const real = t.app.adapters.get('oauth', 'square');
    t.app.adapters.register('oauth', { ...real, exchangeCode: async () => Promise.reject(foreign) });
    const { state } = await t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }));
    await expect(ledger.completePosOAuth(t.app, { orgId: diner.orgId, principal: manager, state, code: 'used-code' })).rejects.toMatchObject({ code: 'invalid', message: 'Square did not accept that sign-in. Start connecting again.' });
  });

  // ── several locations ──────────────────────────────────────────────────────────────────────

  it('an account with several locations: the tokens wait sealed, the manager chooses, one location per venue', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    square.merchant = 'MERCHANT-GROUP';
    square.locations = [
      { id: 'L-CBD', name: 'CBD', status: 'ACTIVE' },
      { id: 'L-NEWTOWN', name: 'Newtown', status: 'ACTIVE' },
    ];
    const cbd = group.venues.cbd!.id;
    const newtown = group.venues.newtown!.id;

    const s1 = await t.app.tenant(group.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: cbd }));
    const o1 = await ledger.completePosOAuth(t.app, { orgId: group.orgId, principal: manager, state: s1.state, code: 'code-1' });
    if (o1.status !== 'choose_location') throw new Error('expected a choice');
    expect(o1.locations).toEqual([{ ref: 'L-CBD', name: 'CBD' }, { ref: 'L-NEWTOWN', name: 'Newtown' }]);
    expect(await squareRows(group.orgId)).toEqual([]); // nothing connected yet
    expect(await pendingSecrets()).toBe(1);
    expect(o1.pending).not.toContain('EAAl');

    // Not a location of that account; not this person's; not this org's.
    await expect(ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o1.pending, locationRef: 'L-SOMEONE-ELSE' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: await group.as('owner'), pending: o1.pending, locationRef: 'L-CBD' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ledger.finishPosOAuth(t.app, { orgId: t.fixture.diner.orgId, principal: await t.fixture.diner.as('manager'), pending: o1.pending, locationRef: 'L-CBD' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await squareRows(group.orgId)).toEqual([]);

    const view = await ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o1.pending, locationRef: 'L-CBD' });
    expect(view).toMatchObject({ venueId: cbd, locationRef: 'L-CBD', externalAccountId: 'MERCHANT-GROUP', status: 'connected' });
    expect(await pendingSecrets()).toBe(0);
    // The pending token is spent with its secret.
    await expect(ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o1.pending, locationRef: 'L-NEWTOWN' })).rejects.toMatchObject({ code: 'invalid' });

    // A second venue cannot take the same location, and may then choose the other one.
    const s2 = await t.app.tenant(group.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: newtown }));
    const o2 = await ledger.completePosOAuth(t.app, { orgId: group.orgId, principal: manager, state: s2.state, code: 'code-2' });
    if (o2.status !== 'choose_location') throw new Error('expected a choice');
    await expect(ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o2.pending, locationRef: 'L-CBD' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await pendingSecrets()).toBe(1);
    await ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o2.pending, locationRef: 'L-NEWTOWN' });
    const rows = await squareRows(group.orgId);
    expect(rows.map((r) => [r.venue_id, (r.config as { locationRef: string }).locationRef]).sort()).toEqual([[cbd, 'L-CBD'], [newtown, 'L-NEWTOWN']].sort());
    expect(await pendingSecrets()).toBe(0);
  });

  it('walking away from the location list forgets the tokens and ends them at Square; so does choosing too late', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    square.merchant = 'MERCHANT-WALK';
    square.locations = [{ id: 'L-A', name: 'A', status: 'ACTIVE' }, { id: 'L-B', name: 'B', status: 'ACTIVE' }];
    const venueId = group.venues.cbd!.id;
    const begin = async () => {
      const s = await t.app.tenant(group.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId }));
      const o = await ledger.completePosOAuth(t.app, { orgId: group.orgId, principal: manager, state: s.state, code: 'c' });
      if (o.status !== 'choose_location') throw new Error('expected a choice');
      return o;
    };

    const a = await begin();
    const tokenA = `EAAl-access-${square.issued}`;
    expect(square.live.has(tokenA)).toBe(true);
    await ledger.cancelPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: a.pending });
    expect(await pendingSecrets()).toBe(0);
    expect(square.live.has(tokenA)).toBe(false);
    expect(calls('/oauth2/revoke').at(-1)!.body).toEqual({ client_id: APP_ID, access_token: tokenA, revoke_only_access_token: true });

    const b = await begin();
    const tokenB = `EAAl-access-${square.issued}`;
    t.clock.advanceMinutes(31);
    await expect(ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: b.pending, locationRef: 'L-A' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await pendingSecrets()).toBe(0);
    expect(square.live.has(tokenB)).toBe(false);
    expect((await squareRows(group.orgId)).filter((r) => r.external_account_id === 'MERCHANT-WALK')).toEqual([]);
  });

  // ── keeping it alive ───────────────────────────────────────────────────────────────────────

  it('a fresh token is left alone; a week-old one is renewed by the schedule and the new token is the one sealed', async () => {
    const { diner, row } = await connectDiner();
    const first = (await credentialsOf(row)).accessToken;

    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('not_due');
    t.clock.advanceDays(6);
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('not_due');
    expect(calls('/oauth2/token')).toHaveLength(1); // only the original exchange

    t.clock.advanceDays(2); // eight days old: inside Square's seven-day renewal advice
    await tickSchedules(t.app, { only: ['ledger.pos_oauth_sweep'] });
    await drainJobs(t.app, { kinds: ['ledger.pos_oauth_sweep', 'ledger.pos_oauth_refresh'] });

    const refresh = calls('/oauth2/token').at(-1)!;
    expect(refresh.body).toEqual({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: 'refresh_token', refresh_token: 'EQAAl-refresh-1' });
    const after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)! as ConnectionRow;
    const creds = await credentialsOf(after);
    expect(creds.accessToken).not.toBe(first);
    // (The sweep renews every org's due connection, so this is not necessarily the last token issued.)
    expect(Number(creds.accessToken!.split('-').pop())).toBeGreaterThan(Number(first!.split('-').pop()));
    expect(square.live.has(creds.accessToken!)).toBe(true);
    expect(creds.refreshToken).toBe('EQAAl-refresh-1'); // kept: Square does not repeat it
    expect(creds.webhookSecret).toBe(WEBHOOK_KEY);
    expect(after.status).toBe('connected');
    expect(after.expires_at!.getTime()).toBe(t.clock().getTime() + 30 * DAY);
    expect(after.secret_ref).toBe(row.secret_ref);

    // Running it again straight away does nothing: the handler is safe to run twice.
    const n = calls('/oauth2/token').length;
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('not_due');
    expect(calls('/oauth2/token')).toHaveLength(n);
    const jobs = await t.db.selectFrom('jobs').select(['kind', 'status']).where('kind', 'like', 'ledger.pos_oauth%').where('org_id', '=', diner.orgId).execute();
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('a seller who withdrew access: the connection goes unhealthy and the person who connected it is told, once', async () => {
    const { diner, manager, row } = await connectDiner();
    t.clock.advanceDays(8);
    square.token = 'refused';
    square.live.clear(); // Square no longer honours the access token either
    t.sim.email.reset();

    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('refused');
    let after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('unhealthy');
    expect(after.last_error).toBe('Square no longer accepts the saved sign-in.');

    await drainJobs(t.app, { kinds: ['comms.send'] });
    const staff = await t.db.selectFrom('staff').select(['email', 'first_name']).where('id', '=', (manager as { staffId: string }).staffId).executeTakeFirstOrThrow();
    const notices = t.sim.email.sent.filter((m) => m.subject === 'Square needs connecting again');
    expect(notices.map((m) => m.to)).toEqual([staff.email]);
    expect(notices[0]!.body).toContain(`Hi ${staff.first_name}`);
    expect(notices[0]!.body).toContain('http://console.rosplatform.test/console');
    expect(notices[0]!.body).not.toContain('EAAl');

    // The next sweeps try again (that is how it would recover) but do not write again.
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('refused');
    t.clock.advanceDays(1);
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('refused');
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.sent.filter((m) => m.subject === 'Square needs connecting again')).toHaveLength(1);

    // Signing in again brings the same connection back.
    square.token = 'ok';
    const again = await connectDiner();
    expect(again.row.id).toBe(row.id);
    after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('connected');
    expect(after.last_error).toBeNull();
  });

  it('a refusal while the saved token still works is OUR problem: the venue is not blamed or emailed', async () => {
    const { diner, row } = await connectDiner();
    t.clock.advanceDays(8);
    square.token = 'refused'; // e.g. a wrong application secret
    t.sim.email.reset();
    await expect(ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).rejects.toMatchObject({ code: 'provider_error' });
    const after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('connected');
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.sent.filter((m) => m.subject === 'Square needs connecting again')).toEqual([]);
  });

  it('an outage is retried without touching the connection, until the token has actually expired', async () => {
    const { diner, row } = await connectDiner();
    t.clock.advanceDays(8);
    square.token = 'down';
    t.sim.email.reset();
    await expect(ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).rejects.toMatchObject({ code: 'provider_error' });
    expect((await squareRows(diner.orgId)).find((r) => r.id === row.id)!.status).toBe('connected');

    t.clock.advanceDays(23); // past expires_at
    await expect(ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).rejects.toMatchObject({ code: 'provider_error' });
    const after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('unhealthy');
    expect(after.last_error).toBe('Square sign-in has expired and could not be renewed.');
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.sent.filter((m) => m.subject === 'Square needs connecting again')).toHaveLength(1);

    // Square comes back: the unhealthy connection is renewed and healthy again.
    square.token = 'ok';
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).toBe('refreshed');
    expect((await squareRows(diner.orgId)).find((r) => r.id === row.id)!.status).toBe('connected');
  });

  it('a refresh that answers for a different merchant is not stored', async () => {
    const { diner, row } = await connectDiner();
    const before = await credentialsOf(row);
    t.clock.advanceDays(8);
    square.merchant = 'SOMEONE-ELSE';
    await expect(ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id })).rejects.toMatchObject({ code: 'provider_error' });
    expect(await credentialsOf(row)).toEqual(before);
  });

  it('refresh skips what is not a sign-in connection, and another org cannot refresh this one', async () => {
    const { diner, row } = await connectDiner();
    const simPos = await t.db.selectFrom('connections').select('id').where('org_id', '=', diner.orgId).where('plug_key', '=', 'sim-pos').executeTakeFirstOrThrow();
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: simPos.id, force: true })).toBe('skipped');
    const n = calls('/oauth2/token').length;
    expect(await ledger.refreshPosOAuth(t.app, { orgId: t.fixture.group.orgId, connectionId: row.id, force: true })).toBe('skipped');
    expect(calls('/oauth2/token')).toHaveLength(n);
  });

  it('the sweep schedule applies only to an org with a sign-in POS', async () => {
    await connectDiner();
    const { diner, group } = t.fixture;
    expect(await ledger.posOAuthSweepSchedule.appliesTo!(t.app, diner.orgId)).toBe(true);
    const groupHasSquare = (await squareRows(group.orgId)).some((r) => r.status !== 'revoked');
    expect(await ledger.posOAuthSweepSchedule.appliesTo!(t.app, group.orgId)).toBe(groupHasSquare);
  });

  // ── ending it ──────────────────────────────────────────────────────────────────────────────

  it('disconnect: only a manager of that venue; revoked here, sealed tokens deleted, the grant ended at Square', async () => {
    const { diner, manager, row } = await connectDiner();
    const token = (await credentialsOf(row)).accessToken!;

    await expect(ledger.disconnectPosOAuth(t.app, { orgId: diner.orgId, principal: await diner.as('host'), connectionId: row.id })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(ledger.disconnectPosOAuth(t.app, { orgId: t.fixture.group.orgId, principal: await t.fixture.group.as('manager'), connectionId: row.id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await squareRows(diner.orgId)).find((r) => r.id === row.id)!.status).toBe('connected');
    expect(calls('/oauth2/revoke').filter((c) => c.body.access_token === token)).toEqual([]);

    expect(await ledger.disconnectPosOAuth(t.app, { orgId: diner.orgId, principal: manager, connectionId: row.id })).toEqual({ revokedAtProvider: true });
    const after = (await squareRows(diner.orgId)).find((r) => r.id === row.id)!;
    expect(after.status).toBe('revoked');
    expect(after.secret_ref).toBeNull();
    expect(await t.db.selectFrom('secrets').select('id').where('id', '=', row.secret_ref!).execute()).toEqual([]);
    // The last connection for that merchant: the whole grant is ended.
    expect(calls('/oauth2/revoke').at(-1)!.body).toEqual({ client_id: APP_ID, access_token: token, revoke_only_access_token: false });
    expect(calls('/oauth2/revoke').at(-1)!.headers.Authorization).toBe(`Client ${APP_SECRET}`);
    const audited = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', row.id).execute();
    expect(audited.map((a) => a.action)).toContain('connection.revoked');
    // A revoked connection is not refreshed.
    expect(await ledger.refreshPosOAuth(t.app, { orgId: diner.orgId, connectionId: row.id, force: true })).toBe('skipped');
  });

  it('disconnect while Square is down still disconnects here, and says Square was not told', async () => {
    const { diner, manager, row } = await connectDiner();
    square.revoke = 'down';
    expect(await ledger.disconnectPosOAuth(t.app, { orgId: diner.orgId, principal: manager, connectionId: row.id })).toEqual({ revokedAtProvider: false });
    expect((await squareRows(diner.orgId)).find((r) => r.id === row.id)!.status).toBe('revoked');
  });

  it('disconnecting one of two venues on the same merchant ends only that venue\'s token', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    square.merchant = 'MERCHANT-SHARED';
    square.locations = [{ id: 'L-S1', name: 'One', status: 'ACTIVE' }, { id: 'L-S2', name: 'Two', status: 'ACTIVE' }];
    const connect = async (venueId: string, locationRef: string) => {
      const s = await t.app.tenant(group.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId }));
      const o = await ledger.completePosOAuth(t.app, { orgId: group.orgId, principal: manager, state: s.state, code: 'c' });
      if (o.status !== 'choose_location') throw new Error('expected a choice');
      return ledger.finishPosOAuth(t.app, { orgId: group.orgId, principal: manager, pending: o.pending, locationRef });
    };
    // Any earlier Square connections at these venues are for other merchants and unaffected.
    const one = await connect(group.venues.cbd!.id, 'L-S1');
    const two = await connect(group.venues.newtown!.id, 'L-S2');
    await ledger.disconnectPosOAuth(t.app, { orgId: group.orgId, principal: manager, connectionId: one.id });
    expect(calls('/oauth2/revoke').at(-1)!.body.revoke_only_access_token).toBe(true);
    const still = (await squareRows(group.orgId)).find((r) => r.id === two.id)! as ConnectionRow;
    expect(still.status).toBe('connected');
    expect(square.live.has((await credentialsOf(still)).accessToken!)).toBe(true);
  });

  it('without Square credentials on the deployment, start says sign-in is not set up', async () => {
    // Last: a fresh registry kind cannot be unregistered, so this test builds its own check.
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const has = t.app.adapters.has.bind(t.app.adapters);
    (t.app.adapters as { has: unknown }).has = (kind: string, key: string) => (kind === 'oauth' ? false : has(kind as never, key));
    try {
      await expect(t.app.tenant(diner.orgId, manager, (ctx) => ledger.startPosOAuth(ctx, { plugKey: 'square', venueId: diner.venueId }))).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      (t.app.adapters as { has: unknown }).has = has;
    }
  });
});
