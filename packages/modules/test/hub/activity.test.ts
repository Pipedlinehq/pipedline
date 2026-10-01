import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { hub } from '@ros/modules';
import { roomForKeys } from './helpers';

describe('hub: recent assistant activity (listAgentCalls)', () => {
  const t = useTestEnv();

  it('an owner sees every key\'s calls, a manager only their own keys\', a host none, another org nothing', async () => {
    const { diner, group } = t.fixture;
    await roomForKeys(t.app, t.fixture);
    const owner = await diner.as('owner');
    const manager = await diner.as('manager');
    const host = await diner.as('host');
    const mine = await t.app.tenant(diner.orgId, manager, (ctx) => hub.createAgentKey(ctx, { name: 'Manager key', scopes: ['venue:read'], expiresInDays: 7 }));
    const theirs = await t.app.tenant(diner.orgId, owner, (ctx) => hub.createAgentKey(ctx, { name: 'Owner key', scopes: ['venue:read'], expiresInDays: 7 }));
    await t.db
      .insertInto('agent_calls')
      .values([
        { org_id: diner.orgId, key_id: mine.view.id, actor_kind: 'agent_key', plug_key: 'os', tool: 'sales_summary', effect: 'read', outcome: 'answered', duration_ms: 12 },
        { org_id: diner.orgId, key_id: theirs.view.id, actor_kind: 'agent_key', plug_key: 'os', tool: 'menu_list', effect: 'read', outcome: 'refused', duration_ms: 3 },
      ])
      .execute();

    const seenByOwner = await t.app.tenant(diner.orgId, owner, (ctx) => hub.listAgentCalls(ctx, { limit: 200 }));
    expect(seenByOwner.map((c) => c.keyName)).toEqual(expect.arrayContaining(['Manager key', 'Owner key']));
    const row = seenByOwner.find((c) => c.keyId === mine.view.id)!;
    expect(row).toMatchObject({ tool: 'sales_summary', outcome: 'answered', effect: 'read', plugKey: 'os', durationMs: 12 });
    // The key itself never appears, only its prefix.
    expect(JSON.stringify(seenByOwner)).not.toContain(mine.key.slice(20));

    const seenByManager = await t.app.tenant(diner.orgId, manager, (ctx) => hub.listAgentCalls(ctx, { limit: 200 }));
    expect(seenByManager.length).toBeGreaterThan(0);
    expect(seenByManager.every((c) => c.keyId === mine.view.id || c.staffId === diner.staff.manager!.staffId)).toBe(true);
    expect(seenByManager.some((c) => c.keyId === theirs.view.id)).toBe(false);

    const filtered = await t.app.tenant(diner.orgId, owner, (ctx) => hub.listAgentCalls(ctx, { keyId: theirs.view.id }));
    expect(filtered.map((c) => c.tool)).toEqual(['menu_list']);

    await expect(t.app.tenant(diner.orgId, host, (ctx) => hub.listAgentCalls(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    const groupOwner = await group.as('owner');
    const other = await t.app.tenant(group.orgId, groupOwner, (ctx) => hub.listAgentCalls(ctx, { limit: 200 }));
    expect(other.some((c) => c.keyId === mine.view.id || c.keyId === theirs.view.id)).toBe(false);
  });
});
