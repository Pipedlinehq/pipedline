import { describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { createTestApp, useTestEnv } from '@ros/testkit';
import { auth, hub } from '@ros/modules';
import { connectModern, issueKey, rawToolCall, roomForKeys } from './helpers';

const WORKER = { kind: 'worker' as const, job: 'test' };

describe('hub: assistant access keys', () => {
  const t = useTestEnv();

  it('a manager creates a key for themself: shown once, stored as a hash, read-only, expiring, and audited without the key', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const made = await t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { name: 'My Claude', scopes: ['venue:read'], expiresInDays: 30 }));
    expect(made.key).toMatch(/^ros_agent_[A-Za-z0-9_-]{43}$/);
    expect(made.view).toMatchObject({ name: 'My Claude', scopes: ['venue:read'], venueIds: null, canWrite: false, status: 'active', staffId: diner.staff.manager!.staffId });
    expect(made.view.expiresAt.toISOString()).toBe('2026-10-30T02:00:00.000Z');
    expect(made.view.prefix).toBe(`${made.key.slice(0, 16)}…`);

    const row = await t.db.selectFrom('agent_keys').selectAll().where('id', '=', made.view.id).executeTakeFirstOrThrow();
    expect(row.can_write).toBe(false);
    expect(row.org_id).toBe(diner.orgId);
    expect(Buffer.isBuffer(row.key_hash) && row.key_hash.length).toBe(32);
    // The key is nowhere in the database: not in its row, not in the audit entry.
    const audited = await t.db.selectFrom('audit_log').selectAll().where('entity_type', '=', 'agent_key').where('entity_id', '=', made.view.id).execute();
    expect(audited.map((a) => [a.action, a.actor_kind, a.actor_id])).toEqual([['agent_key.created', 'staff', diner.staff.manager!.staffId]]);
    const secret = made.key.slice('ros_agent_'.length);
    expect(JSON.stringify({ ...row, key_hash: row.key_hash.toString('hex') }) + JSON.stringify(audited)).not.toContain(secret.slice(8));

    // It is listed by its prefix and works as a key.
    const listed = await t.app.tenant(diner.orgId, manager, (ctx) => hub.listAgentKeys(ctx));
    expect(listed.map((k) => k.id)).toContain(made.view.id);
    expect(JSON.stringify(listed)).not.toContain(secret.slice(8));
    expect((await hub.resolveAgentKey(t.app, made.key))!.keyName).toBe('My Claude');
  });

  it('expiry is required and capped by the venue; the number of keys per person is capped too', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const create = (input: Record<string, unknown>) => t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { name: 'k', scopes: ['venue:read'], ...input } as never));
    await expect(create({})).rejects.toThrow();
    await expect(create({ expiresInDays: 91 })).rejects.toMatchObject({ code: 'invalid', message: 'A key can last at most 90 days here.' });
    await t.app.tenant(diner.orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner.venueId, config: { key_max_lifetime_days: 7, max_keys_per_staff: 2 } }));
    await expect(create({ expiresInDays: 8 })).rejects.toMatchObject({ code: 'invalid' });

    const host = await diner.as('host');
    const before = (await t.app.tenant(diner.orgId, manager, (ctx) => hub.listAgentKeys(ctx))).filter((k) => k.status === 'active').length;
    for (let i = before; i < 2; i++) await create({ expiresInDays: 7 });
    await expect(create({ expiresInDays: 7 })).rejects.toMatchObject({ code: 'conflict' });
    // A revoked key no longer counts.
    const mine = await t.app.tenant(diner.orgId, manager, (ctx) => hub.listAgentKeys(ctx));
    await t.app.tenant(diner.orgId, manager, (ctx) => hub.revokeAgentKey(ctx, mine[0]!.id));
    await expect(create({ expiresInDays: 7 })).resolves.toBeTruthy();
    // The cap is per person: it says nothing about anyone else. (A host cannot make one at all.)
    await expect(t.app.tenant(diner.orgId, host, (ctx) => hub.createAgentKey(ctx, { name: 'k', scopes: ['venue:read'], expiresInDays: 7 }))).rejects.toMatchObject({ code: 'forbidden' });
    await t.app.tenant(diner.orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner.venueId, config: { key_max_lifetime_days: 90, max_keys_per_staff: 5 } }));
    await roomForKeys(t.app, t.fixture);
  });

  it('only an owner can allow changes; an assistant cannot make or manage keys; unknown scopes and other organisations\' venues are refused', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const owner = await diner.as('owner');
    const base = { name: 'k', scopes: ['venue:read', 'venue:write'], expiresInDays: 10 };

    await expect(t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { ...base, canWrite: true }))).rejects.toMatchObject({ code: 'forbidden', message: 'Only an owner can allow a key to make changes.' });
    const ownerKey = await t.app.tenant(diner.orgId, owner, (ctx) => hub.createAgentKey(ctx, { ...base, canWrite: true }));
    expect(ownerKey.view.canWrite).toBe(true);

    // The owner's tick on a manager's key.
    const managerKey = await t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, base));
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => hub.setAgentKeyCanWrite(ctx, managerKey.view.id, true))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await t.app.tenant(diner.orgId, owner, (ctx) => hub.setAgentKeyCanWrite(ctx, managerKey.view.id, true))).canWrite).toBe(true);
    expect((await t.db.selectFrom('agent_keys').select('can_write').where('id', '=', managerKey.view.id).executeTakeFirstOrThrow()).can_write).toBe(true);
    expect((await hub.resolveAgentKey(t.app, managerKey.key))!.principal.canWrite).toBe(true);

    // A key cannot mint, list or revoke keys: that is done by a person, signed in.
    const agent = (await hub.resolveAgentKey(t.app, ownerKey.key))!.principal;
    await expect(t.app.tenant(diner.orgId, agent, (ctx) => hub.createAgentKey(ctx, base))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, agent, (ctx) => hub.listAgentKeys(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, agent, (ctx) => hub.revokeAgentKey(ctx, managerKey.view.id))).rejects.toMatchObject({ code: 'forbidden' });

    await expect(t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { ...base, scopes: ['everything:write'] }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { ...base, venueIds: [group.venues.cbd!.id] }))).rejects.toMatchObject({ code: 'not_found' });
    // Another organisation's key id is not found, for an owner too.
    const groupOwner = await group.as('owner');
    await expect(t.app.tenant(group.orgId, groupOwner, (ctx) => hub.revokeAgentKey(ctx, managerKey.view.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, groupOwner, (ctx) => hub.setAgentKeyCanWrite(ctx, managerKey.view.id, false))).rejects.toMatchObject({ code: 'not_found' });
    expect(await t.app.tenant(group.orgId, groupOwner, (ctx) => hub.listAgentKeys(ctx))).toEqual([]);
  });

  it('a person sees and revokes their own keys; an owner sees and revokes anyone\'s; a revoked key is refused at once', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    const accounts = await group.as('accounts');
    const owner = await group.as('owner');
    const mine = await issueKey(t.app, group.orgId, manager, { scopes: ['venue:read'] });
    const theirs = await issueKey(t.app, group.orgId, owner, { scopes: ['venue:read'] });

    expect((await t.app.tenant(group.orgId, manager, (ctx) => hub.listAgentKeys(ctx))).map((k) => k.id)).toEqual([mine.id]);
    expect((await t.app.tenant(group.orgId, owner, (ctx) => hub.listAgentKeys(ctx))).map((k) => k.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect((await t.app.tenant(group.orgId, owner, (ctx) => hub.listAgentKeys(ctx, { staffId: group.staff.manager!.staffId }))).map((k) => k.id)).toEqual([mine.id]);
    // Someone else's key is not found, not forbidden.
    await expect(t.app.tenant(group.orgId, manager, (ctx) => hub.revokeAgentKey(ctx, theirs.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, accounts, (ctx) => hub.revokeAgentKey(ctx, mine.id))).rejects.toMatchObject({ code: 'not_found' });

    const s = await connectModern(t.app, mine.key);
    expect((await s.call('venue_status', { venue: 'cbd' })).isError).toBe(false);
    await t.app.tenant(group.orgId, owner, (ctx) => hub.revokeAgentKey(ctx, mine.id));
    await t.app.tenant(group.orgId, owner, (ctx) => hub.revokeAgentKey(ctx, mine.id)); // safe to repeat
    expect((await rawToolCall(t.app, mine.key, 'venue_status', { venue: 'cbd' })).http).toBe(401);
    await expect(s.call('venue_status', { venue: 'cbd' })).rejects.toThrow();
    await s.close().catch(() => undefined);

    const row = await t.db.selectFrom('agent_keys').select(['revoked_at']).where('id', '=', mine.id).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    const revoked = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', mine.id).where('action', '=', 'agent_key.revoked').execute();
    expect(revoked).toHaveLength(1);
    expect((await t.app.tenant(group.orgId, manager, (ctx) => hub.listAgentKeys(ctx)))[0]!.status).toBe('revoked');
  });

  it('an expired key is refused', async () => {
    const { diner } = t.fixture;
    const key = await issueKey(t.app, diner.orgId, await diner.as('owner'), { scopes: ['venue:read'], expiresInDays: 2 });
    expect((await rawToolCall(t.app, key.key, 'venue_status', {})).answer?.isError).toBe(false);
    t.clock.advanceDays(2);
    const late = await rawToolCall(t.app, key.key, 'venue_status', {});
    expect(late.http).toBe(401);
    expect(await hub.resolveAgentKey(t.app, key.key)).toBeNull();
    expect((await t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => hub.listAgentKeys(ctx))).find((k) => k.id === key.id)!.status).toBe('expired');
  });

  it('a disabled staff member\'s keys die with their access, in the same step', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const owner = await diner.as('owner');
    const a = await issueKey(t.app, diner.orgId, manager, { scopes: ['venue:read'] });
    const b = await issueKey(t.app, diner.orgId, manager, { scopes: ['venue:read'] });
    const ownersOwn = await issueKey(t.app, diner.orgId, owner, { scopes: ['venue:read'] });
    expect((await rawToolCall(t.app, a.key, 'venue_status', {})).answer?.isError).toBe(false);

    await t.app.tenant(diner.orgId, owner, (ctx) => auth.disableStaff(ctx, diner.staff.manager!.staffId));

    for (const k of [a, b]) {
      expect((await rawToolCall(t.app, k.key, 'venue_status', {})).http).toBe(401);
      const row = await t.db.selectFrom('agent_keys').select('revoked_at').where('id', '=', k.id).executeTakeFirstOrThrow();
      expect(row.revoked_at).not.toBeNull();
    }
    // Nobody else's key is touched.
    expect((await rawToolCall(t.app, ownersOwn.key, 'venue_status', {})).answer?.isError).toBe(false);
    // Even a key row that somehow survived would be refused: the person's standing is read on every request.
    await t.db.updateTable('agent_keys').set({ revoked_at: null }).where('id', '=', a.id).execute();
    expect(await hub.resolveAgentKey(t.app, a.key)).toBeNull();
  });

  it('a key is refused when its organisation is paused', async () => {
    const { group } = t.fixture;
    const key = await issueKey(t.app, group.orgId, await group.as('owner'), { scopes: ['venue:read'] });
    expect(await hub.resolveAgentKey(t.app, key.key)).not.toBeNull();
    await t.db.updateTable('orgs').set({ status: 'paused' }).where('id', '=', group.orgId).execute();
    expect(await hub.resolveAgentKey(t.app, key.key)).toBeNull();
    await t.db.updateTable('orgs').set({ status: 'live' }).where('id', '=', group.orgId).execute();
  });

  it('describes the scopes a key can hold, with the tools each unlocks', () => {
    const scopes = hub.describeScopes(t.app);
    expect(scopes.find((s) => s.scope === 'venue:read')).toMatchObject({ effect: 'read', guestLevel: false });
    expect(scopes.find((s) => s.scope === 'venue:read')!.tools.map((x) => x.name)).toContain('venue_status');
    expect(scopes.find((s) => s.scope === 'guests:read')).toMatchObject({ guestLevel: true });
    expect(scopes.find((s) => s.scope === 'outcomes:read')).toBeTruthy();
    expect(scopes.find((s) => s.scope === 'plug:criota:write')).toMatchObject({ effect: 'write', plug: 'Criota' });
    expect(scopes.find((s) => s.scope === 'plug:criota-sim:read')).toMatchObject({ effect: 'read', plug: 'Criota (simulated)' });
  });

  it('a simulated plug is never on offer in production', async () => {
    const prod = createTestApp(t.url, { config: { env: 'production' } });
    try {
      const scopes = hub.knownScopes(prod.app);
      expect(scopes).toContain('plug:criota:read');
      expect(scopes).not.toContain('plug:criota-sim:read');
      expect(hub.mcpPlugs(prod.app).map((p) => p.key)).not.toContain('criota-sim');
      const { diner } = t.fixture;
      const owner = await diner.as('owner');
      await expect(prod.app.tenant(diner.orgId, owner, (ctx) => hub.createAgentKey(ctx, { name: 'k', scopes: ['plug:criota-sim:read'], expiresInDays: 5 }))).rejects.toMatchObject({ code: 'invalid' });
      await expect(prod.app.tenant(diner.orgId, owner, (ctx) => hub.connectMcpPlug(ctx, { plugKey: 'criota-sim', accessKey: 'criota_mcp_test_whatever' }))).rejects.toMatchObject({ code: 'not_found' });
    } finally {
      await prod.close();
    }
  });
});
