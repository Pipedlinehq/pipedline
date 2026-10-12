import { describe, expect, it } from 'vitest';
import type { StaffPrincipal } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { hub } from '@ros/modules';

/**
 * Plug detail (pattern 14): a module's page lists its tools with "last used" from a real logged
 * call; a connected service's page shows its connection, its health and the 30-day note when it
 * has done nothing; what leaves the venue is said in plain words; roles and other orgs.
 */
describe('hub: plugin detail pages', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const run = <T>(orgId: string, p: StaffPrincipal, fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(orgId, p, fn);

  it('a module\'s page: manifest words, its tools, and last-used from the call log', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    const owner = await diner().as('owner');
    const key = await run(diner().orgId, owner, (ctx) => hub.createAgentKey(ctx, { name: 'Detail test', scopes: ['menu:read'], expiresInDays: 7 }));
    const earlier = new Date(t.clock().getTime() - 3 * 86_400_000);
    const latest = new Date(t.clock().getTime() - 60_000);
    await t.db
      .insertInto('agent_calls')
      .values([
        { org_id: diner().orgId, key_id: key.view.id, actor_kind: 'agent_key', plug_key: 'os', tool: 'menu_list', effect: 'read', outcome: 'answered', duration_ms: 12, occurred_at: earlier },
        { org_id: diner().orgId, key_id: key.view.id, actor_kind: 'agent_key', plug_key: 'os', tool: 'menu_list', effect: 'read', outcome: 'refused', duration_ms: 3, occurred_at: latest },
        // Another org's call to the same tool must not count here.
        { org_id: group().orgId, key_id: null, actor_kind: 'hosted_agent', hosted_agent_key: 'ops_watch', plug_key: 'os', tool: 'menu_list', effect: 'read', outcome: 'answered', duration_ms: 3, occurred_at: t.clock() },
      ])
      .execute();
    const d = await run(diner().orgId, manager, (ctx) => hub.plugDetail(ctx, { venueId, key: 'menu' }));
    expect(d.entry).toMatchObject({ key: 'menu', kind: 'module', on: true });
    expect(d.entry.reads.length).toBeGreaterThan(0);
    expect(d.entry.writes.length).toBeGreaterThan(0);
    const menuList = d.tools.find((x) => x.name === 'menu_list')!;
    expect(menuList).toMatchObject({ effect: 'read', lastOutcome: 'refused', calls30d: 2 });
    expect(menuList.lastUsedAt?.toISOString()).toBe(latest.toISOString());
    expect(d.lastUsedAt?.toISOString()).toBe(latest.toISOString());
    expect(d.tools.filter((x) => x.name !== 'menu_list').every((x) => x.lastUsedAt === null && x.calls30d === 0)).toBe(true);
    expect(d.connections).toEqual([]);
    expect(d.idleNote).toBeNull();
    expect(d.dataLeaves).toEqual([]);
    expect(d.offeredToAssistantsHere).toBeNull();
    // A role below manager, another org's venue, a key not in the catalogue.
    await expect(run(diner().orgId, await diner().as('host'), (ctx) => hub.plugDetail(ctx, { venueId, key: 'menu' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => hub.plugDetail(ctx, { venueId, key: 'menu' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(diner().orgId, manager, (ctx) => hub.plugDetail(ctx, { venueId, key: 'not-a-plugin' }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a connected service\'s page: the connection and its health, what leaves the venue, the 30-day note, and last-used from its own calls', async () => {
    const owner = await diner().as('owner');
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    const conn = await run(diner().orgId, owner, (ctx) => hub.connectMcpPlug(ctx, { plugKey: 'criota-sim', accessKey: 'criota-sim-test-key-0001', account: 'oak' }));
    // Connected 40 days ago, never used: idle.
    const longAgo = new Date(t.clock().getTime() - 40 * 86_400_000);
    await t.db.updateTable('connections').set({ connected_at: longAgo, last_ok_at: null }).where('id', '=', conn.id).execute();
    const idle = await run(diner().orgId, manager, (ctx) => hub.plugDetail(ctx, { venueId, key: 'criota-sim' }));
    expect(idle.entry).toMatchObject({ key: 'criota-sim', kind: 'plug', on: true });
    expect(idle.connections.map((c) => [c.id, c.status, c.account])).toEqual([[conn.id, 'connected', 'oak']]);
    expect(idle.idleNote).toMatch(/has not read or written anything in 30 days/);
    expect(idle.dataLeaves.join(' ')).toMatch(/Per-venue campaign totals|per-venue campaign totals/i);
    expect(idle.dataLeaves.join(' ')).toMatch(/never anything about one guest/);
    expect(idle.offeredToAssistantsHere).toBe(false);
    expect(idle.lastUsedAt).toBeNull();
    // A call through the plug's tools, as the gateway records it: now it is in use and the note goes.
    const key = await run(diner().orgId, owner, (ctx) => hub.createAgentKey(ctx, { name: 'Plug test', scopes: ['plug:criota-sim:read'], expiresInDays: 7 }));
    const at = new Date(t.clock().getTime() - 2 * 86_400_000);
    await t.db.insertInto('agent_calls').values({ org_id: diner().orgId, key_id: key.view.id, actor_kind: 'agent_key', plug_key: 'criota-sim', tool: 'criota_sim__list_campaigns', effect: 'read', outcome: 'answered', duration_ms: 40, occurred_at: at }).execute();
    const used = await run(diner().orgId, manager, (ctx) => hub.plugDetail(ctx, { venueId, key: 'criota-sim' }));
    expect(used.idleNote).toBeNull();
    expect(used.lastUsedAt?.toISOString()).toBe(at.toISOString());
    expect(used.tools.map((x) => [x.name, x.calls30d, x.lastOutcome])).toEqual([['criota_sim__list_campaigns', 1, 'answered']]);
    // A health check is not a use: a fresh last_ok_at alone does not lift the note for an assistant plug.
    await t.db.deleteFrom('agent_calls').where('plug_key', '=', 'criota-sim').execute();
    await t.db.updateTable('connections').set({ last_ok_at: t.clock() }).where('id', '=', conn.id).execute();
    expect((await run(diner().orgId, manager, (ctx) => hub.plugDetail(ctx, { venueId, key: 'criota-sim' }))).idleNote).not.toBeNull();
    // The other org does not see this connection on its own page for the same plug.
    const theirs = await run(group().orgId, await group().as('manager'), (ctx) => hub.plugDetail(ctx, { venueId: group().venues.cbd!.id, key: 'criota-sim' }));
    expect(theirs.connections).toEqual([]);
    expect(theirs.entry.on).toBe(false);
    expect(theirs.idleNote).toBeNull();
  });
});
