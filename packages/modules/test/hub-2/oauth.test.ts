import { beforeAll, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { auth as authModule, hub } from '@ros/modules';
import { roomForKeys } from '../hub/helpers';
import type { App } from '@ros/core';
import { MCP, ORIGIN, REDIRECT, assistant, authorizeQuery, httpsApp, pkce, platformFetch, post, register } from './oauth-helpers';

/**
 * Signing an assistant in without pasting a key: discovery, registration, authorization code
 * with PKCE, a consent step with an unticked "allow changes" box, short-lived access tokens,
 * renewal with rotation. The tokens resolve to the same identity a pasted key does and obey the
 * same rules.
 */
describe('hub-2: assistant sign-in (OAuth)', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  let app: App;

  /** The person, on the consent page, signed in to the console. */
  const consent = async (who: Parameters<App['tenant']>[1], orgId: string, query: URLSearchParams | URL, choice: hub.OAuthDecisionInput) => {
    const q = query instanceof URL ? query.searchParams : query;
    const review = await app.tenant(orgId, who, (ctx) => hub.reviewOAuthRequest(ctx, q));
    const decided = await app.tenant(orgId, who, (ctx) => hub.decideOAuthRequest(ctx, q, choice));
    return { review, redirectTo: decided.redirectTo };
  };

  beforeAll(async () => {
    app = httpsApp(t.app);
    await roomForKeys(app, t.fixture);
  });

  it('publishes where to sign in, and a request without a credential is told where', async () => {
    const f = platformFetch(app);
    const as = (await (await f(`${ORIGIN}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/console/oauth/authorize`,
      token_endpoint: `${ORIGIN}/api/hub/oauth/token`,
      registration_endpoint: `${ORIGIN}/api/hub/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    const pr = (await (await f(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)).json()) as Record<string, any>;
    expect(pr).toMatchObject({ resource: MCP, authorization_servers: [`${ORIGIN}/`].map((x) => expect.stringMatching(new RegExp(`^${x.replace(/\/$/, '')}/?$`))) });
    const res = await f(MCP, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
    // Nothing else answers under these paths.
    expect(await hub.handleOAuthRequest(app, new Request(`${ORIGIN}/api/hub/oauth/other`, { method: 'POST' }))).toBeNull();
  });

  it('the whole flow with the official client: discover, register, the person says yes with changes unticked, reads only', async () => {
    const a = assistant(app, { name: 'Claude' });
    const sentTo = await a.start();
    expect(`${sentTo.origin}${sentTo.pathname}`).toBe(`${ORIGIN}/console/oauth/authorize`);
    expect(sentTo.searchParams.get('code_challenge_method')).toBe('S256');
    const owner = await diner().as('owner');
    const { review, redirectTo } = await consent(owner, diner().orgId, sentTo, { allow: true });
    if (review.outcome !== 'ask') throw new Error('expected a question');
    // What the consent page shows: who, where it returns, every permission, and the box UNTICKED.
    expect(review.assistant.name).toBe('Claude');
    expect(review.returnsTo).toEqual({ host: '127.0.0.1', thisComputer: true });
    expect(review.account).toMatchObject({ org: 'Oak Diner', isOwner: true });
    expect(review.allowChanges).toEqual({ offered: true, canTick: true, ticked: false });
    expect(review.scopes.read.map((s) => s.scope)).toEqual(expect.arrayContaining(['metrics:read', 'sales:read', 'venue:read']));
    expect(review.scopes.changes.length).toBeGreaterThan(0);
    expect(review.scopes.read.some((s) => s.scope.startsWith('guests:'))).toBe(false);
    expect(new URL(review.cancelTo).searchParams.get('error')).toBe('access_denied');

    expect(new URL(redirectTo).searchParams.get('iss')).toBe(ORIGIN);
    expect(await a.finish(redirectTo)).toBe('AUTHORIZED');
    const tokens = a.tokens()!;
    expect(tokens.access_token).toMatch(/^ros_oat_/);
    expect(tokens.refresh_token).toMatch(/^ros_ort_/);
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.scope).toBe('read');

    // A signed-in connection is an agent key of kind 'oauth': reads only, the box having stayed unticked.
    const key = await t.db.selectFrom('agent_keys').select(['id', 'kind', 'can_write', 'scopes', 'staff_id', 'org_id', 'audience']).where('oauth_client_id', '=', a.clientId()!).executeTakeFirstOrThrow();
    expect(key).toMatchObject({ kind: 'oauth', can_write: false, org_id: diner().orgId, audience: 'assistant' });
    expect(key.scopes.every((s) => s.endsWith(':read'))).toBe(true);
    // Only hashes are stored.
    const stored = JSON.stringify(await t.db.selectFrom('agent_oauth_tokens').selectAll().where('key_id', '=', key.id).execute());
    expect(stored).not.toContain(tokens.access_token);

    const session = await a.connect();
    const names = await session.tools();
    expect(names).toEqual(expect.arrayContaining(['metrics_query', 'sales_summary']));
    expect(names).not.toContain('menu_set_availability');
    const answer = await session.call('sales_summary', {});
    expect(answer.isError).toBe(false);
    await session.close();
    const calls = await t.db.selectFrom('agent_calls').select(['actor_kind', 'tool', 'outcome']).where('key_id', '=', key.id).execute();
    expect(calls).toContainEqual({ actor_kind: 'oauth_assistant', tool: 'sales_summary', outcome: 'answered' });
    // The console lists it as a signed-in assistant.
    const listed = await app.tenant(diner().orgId, owner, (ctx) => hub.listAgentKeys(ctx));
    expect(listed.find((k) => k.id === key.id)).toMatchObject({ label: 'Signed-in assistant', kind: 'oauth', name: 'Claude' });
  });

  it('"allow changes" is the owner\'s to tick; ticked, the connection may change things (each change still asks)', async () => {
    const clientId = await register(app);
    const { verifier, challenge } = pkce();
    const q = authorizeQuery(clientId, challenge);
    const manager = await diner().as('manager');
    await expect(app.tenant(diner().orgId, manager, (ctx) => hub.decideOAuthRequest(ctx, q, { allow: true, allowChanges: true }))).rejects.toMatchObject({ code: 'forbidden' });
    const mreview = await app.tenant(diner().orgId, manager, (ctx) => hub.reviewOAuthRequest(ctx, q));
    expect(mreview).toMatchObject({ outcome: 'ask', allowChanges: { canTick: false, ticked: false } });

    const owner = await diner().as('owner');
    const { redirectTo } = await consent(owner, diner().orgId, q, { allow: true, allowChanges: true });
    const code = new URL(redirectTo).searchParams.get('code')!;
    const r = await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: MCP });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe('read write');
    const caller = (await hub.resolveAgentKey(app, r.body.access_token))!;
    expect(caller.principal.canWrite).toBe(true);
    expect(caller.kind).toBe('oauth');
    expect(hub.offeredTools(caller, { canAsk: true }).some((o) => o.tool.effect === 'write')).toBe(true);
    // An assistant that asked for reads only is never offered the box.
    const readOnly = await app.tenant(diner().orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, authorizeQuery(clientId, challenge, { scope: 'read' })));
    expect(readOnly).toMatchObject({ allowChanges: { offered: false, ticked: false } });
    // Declining sends the person back with a no, and nothing is made.
    const before = await t.db.selectFrom('agent_oauth_codes').select('code_hash').execute();
    const no = await app.tenant(diner().orgId, owner, (ctx) => hub.decideOAuthRequest(ctx, q, { allow: false }));
    expect(new URL(no.redirectTo).searchParams.get('error')).toBe('access_denied');
    expect((await t.db.selectFrom('agent_oauth_codes').select('code_hash').execute()).length).toBe(before.length);
  });

  it('a wrong verifier gets nothing and spends nothing; a code used twice ends what it made', async () => {
    const clientId = await register(app);
    const { verifier, challenge } = pkce();
    const { redirectTo } = await consent(await diner().as('owner'), diner().orgId, authorizeQuery(clientId, challenge), { allow: true });
    const code = new URL(redirectTo).searchParams.get('code')!;
    const wrong = await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const otherClient = await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: await register(app), redirect_uri: REDIRECT });
    expect(otherClient.body.error).toBe('invalid_grant');
    expect(await t.db.selectFrom('agent_keys').select('id').where('oauth_client_id', '=', clientId).execute()).toEqual([]);

    const first = await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(first.status).toBe(200);
    expect(await hub.resolveAgentKey(app, first.body.access_token)).not.toBeNull();
    const again = await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT });
    expect(again).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    // The replay ended the connection the first exchange made.
    expect(await hub.resolveAgentKey(app, first.body.access_token)).toBeNull();
    const key = await t.db.selectFrom('agent_keys').select(['id', 'revoked_at']).where('oauth_client_id', '=', clientId).executeTakeFirstOrThrow();
    expect(key.revoked_at).not.toBeNull();
    expect((await t.db.selectFrom('audit_log').select('after').where('entity_id', '=', key.id).where('action', '=', 'agent_key.revoked').executeTakeFirstOrThrow()).after).toMatchObject({ reason: 'code_replay' });
    // A code past its two minutes is worth nothing.
    const late = pkce();
    const { redirectTo: r2 } = await consent(await diner().as('owner'), diner().orgId, authorizeQuery(clientId, late.challenge), { allow: true });
    t.clock.advanceMinutes(3);
    expect((await post(app, '/api/hub/oauth/token', { grant_type: 'authorization_code', code: new URL(r2).searchParams.get('code')!, code_verifier: late.verifier, client_id: clientId })).body.error).toBe('invalid_grant');
  });

  it('an access token lasts an hour; renewal rotates; a renewal token used twice ends the connection', async () => {
    const a = assistant(app);
    const sentTo = await a.start();
    const { redirectTo } = await consent(await diner().as('owner'), diner().orgId, sentTo, { allow: true });
    await a.finish(redirectTo);
    const first = a.tokens()!;
    expect(await hub.resolveAgentKey(app, first.access_token)).not.toBeNull();

    t.clock.advanceMinutes(61);
    expect(await hub.resolveAgentKey(app, first.access_token)).toBeNull();
    const expired = await platformFetch(app)(MCP, { method: 'POST', headers: { authorization: `Bearer ${first.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(expired.status).toBe(401);
    expect(expired.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const renewed = await post(app, '/api/hub/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: a.clientId()! });
    expect(renewed.status).toBe(200);
    expect(renewed.body.refresh_token).not.toBe(first.refresh_token);
    expect(await hub.resolveAgentKey(app, renewed.body.access_token)).not.toBeNull();
    // The old renewal token, presented again: two holders, so the connection ends.
    const reused = await post(app, '/api/hub/oauth/token', { grant_type: 'refresh_token', refresh_token: first.refresh_token!, client_id: a.clientId()! });
    expect(reused.body.error).toBe('invalid_grant');
    expect(await hub.resolveAgentKey(app, renewed.body.access_token)).toBeNull();
    expect((await post(app, '/api/hub/oauth/token', { grant_type: 'refresh_token', refresh_token: renewed.body.refresh_token, client_id: a.clientId()! })).body.error).toBe('invalid_grant');
  });

  it('a connection is confined to the org and the venues of the person who approved it, and obeys every rule a pasted key does', async () => {
    const group = t.fixture.group;
    const manager = await group.as('manager'); // CBD and Newtown only
    const a = assistant(app);
    const sentTo = await a.start();
    const { review, redirectTo } = await consent(manager, group.orgId, sentTo, { allow: true });
    if (review.outcome !== 'ask') throw new Error('expected a question');
    expect(review.venues.map((v) => v.name).sort()).toEqual(['Oak Group CBD', 'Oak Group Newtown']);
    await a.finish(redirectTo);
    const caller = (await hub.resolveAgentKey(app, a.tokens()!.access_token))!;
    expect(caller.orgId).toBe(group.orgId);
    expect(caller.venues.map((v) => v.slug).sort()).toEqual(['cbd', 'newtown']);
    expect(caller.principal.staff.isOwner).toBe(false);
    const session = await a.connect();
    const bondi = await session.call('metrics_query', { metrics: ['orders'], venue: 'bondi' });
    expect(bondi).toMatchObject({ isError: true, text: 'Venue not found' });
    const dinerVenue = await session.call('metrics_query', { metrics: ['orders'], venue: 'main' });
    expect(dinerVenue.isError).toBe(true);
    await session.close();

    // Narrowed on the consent page to one venue: only that one.
    const b = assistant(app);
    const sentB = await b.start();
    const only = await consent(manager, group.orgId, sentB, { allow: true, venueIds: [group.venues.newtown!.id] });
    await b.finish(only.redirectTo);
    expect((await hub.resolveAgentKey(app, b.tokens()!.access_token))!.venues.map((v) => v.slug)).toEqual(['newtown']);
    // A venue the person does not work at cannot be chosen.
    const c = assistant(app);
    await expect(consent(manager, group.orgId, await c.start(), { allow: true, venueIds: [group.venues.bondi!.id] })).rejects.toMatchObject({ code: 'invalid' });

    // The person is disabled: their sign-ins end with them, as their keys do.
    const staffRow = await t.db.selectFrom('staff').select('id').where('org_id', '=', group.orgId).where('email', '=', 'manager@oak-group.test').executeTakeFirstOrThrow();
    await app.tenant(group.orgId, await group.as('owner'), (ctx) => authModule.disableStaff(ctx, staffRow.id));
    expect(await hub.resolveAgentKey(app, b.tokens()!.access_token)).toBeNull();
    // The assistant ends its own connection: revocation answers 200 whether or not the token was ours.
    expect((await post(app, '/api/hub/oauth/revoke', { token: 'ros_oat_nonsense', client_id: 'x' })).status).toBe(200);
  });

  it('refuses an unknown assistant, an address it did not name, and a request without PKCE', async () => {
    const owner = await diner().as('owner');
    const clientId = await register(app);
    const { challenge } = pkce();
    await expect(app.tenant(diner().orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, authorizeQuery('ros_oc_AAAAAAAAAAAAAAAAAAAAAA', challenge)))).rejects.toMatchObject({ code: 'invalid' });
    await expect(app.tenant(diner().orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, authorizeQuery(clientId, challenge, { redirect_uri: 'https://evil.example/cb' })))).rejects.toMatchObject({ code: 'invalid' });
    const noPkce = await app.tenant(diner().orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, authorizeQuery(clientId, challenge, { code_challenge_method: 'plain' })));
    expect(noPkce.outcome).toBe('return');
    expect(new URL((noPkce as { redirectTo: string }).redirectTo).searchParams.get('error')).toBe('invalid_request');
    const otherResource = await app.tenant(diner().orgId, owner, (ctx) => hub.reviewOAuthRequest(ctx, authorizeQuery(clientId, challenge, { resource: 'https://elsewhere.example/mcp' })));
    expect(new URL((otherResource as { redirectTo: string }).redirectTo).searchParams.get('error')).toBe('invalid_target');
    // Registration: https or this computer only; no secrets.
    const bad = await platformFetch(app)(`${ORIGIN}/api/hub/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_redirect_uri');
    // Consent is a person's, signed in: an assistant key cannot give it.
    const caller = { kind: 'agent' as const, keyId: '00000000-0000-4000-8000-00000000abcd', staff: owner, scopes: [], venueIds: null, canWrite: false };
    await expect(app.tenant(diner().orgId, caller, (ctx) => hub.decideOAuthRequest(ctx, authorizeQuery(clientId, challenge), { allow: true }))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
