import { beforeAll, describe, expect, it } from 'vitest';
import { type PlatformPrincipal, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { hub, onboarding } from '@ros/modules';
import { WORKER } from '../analytics/helpers';
import { issueKey, roomForKeys } from '../hub/helpers';

/**
 * Analytics tools choose their own venue (a `venue` argument, or every venue the key sees). The
 * hub's per-venue gates now hold for that venue too: a venue where the hub is off, or where the
 * tool's scope is not allowed, is not among the venues the tool can reach. Also: a closing org
 * revokes every key, and a hosted agent's calls are recorded as its own.
 */
describe('hub-2: per-venue gates for tools that choose their venue; keys end with the org', () => {
  const t = useTestEnv();
  const group = () => t.fixture.group;
  const hubSet = (venueId: string, config: Partial<hub.HubConfig>, enabled?: boolean) =>
    t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId, config, ...(enabled === undefined ? {} : { enabled }) }));
  const run = async (key: string, tool: string, args: Record<string, unknown>) => {
    const caller = (await hub.resolveAgentKey(t.app, key))!;
    const offered = hub.offeredTools(caller, { canAsk: false }).find((o) => o.tool.name === tool);
    if (!offered) return 'not offered' as const;
    return hub.runTool(t.app, caller, offered, args);
  };

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
  });

  it('a venue that does not allow the tool\'s scope is out of reach, named or not', async () => {
    const owner = await group().as('owner');
    const key = await issueKey(t.app, group().orgId, owner, { scopes: ['metrics:read', 'sales:read'] });
    const everywhere = (await run(key.key, 'metrics_query', { metrics: ['orders'], dimensions: ['venue'], period: 'last_28_days' })) as { ok: true; output: any };
    expect(everywhere.output.venues.names.sort()).toEqual(['Oak Group Bondi', 'Oak Group CBD', 'Oak Group Newtown']);

    // Bondi allows only venue scopes: metrics are not for assistants there.
    await hubSet(group().venues.bondi!.id, { allowed_scopes: ['venue:*'] });
    const narrowed = (await run(key.key, 'metrics_query', { metrics: ['orders'], dimensions: ['venue'], period: 'last_28_days' })) as { ok: true; output: any };
    expect(narrowed.ok).toBe(true);
    expect(narrowed.output.venues.names.sort()).toEqual(['Oak Group CBD', 'Oak Group Newtown']);
    expect(narrowed.output.rows.map((r: any) => r.dimensions.venue).sort()).toEqual(['Oak Group CBD', 'Oak Group Newtown']);
    const named = await run(key.key, 'metrics_query', { metrics: ['orders'], venue: 'bondi' });
    expect(named).toEqual({ ok: false, message: 'Venue not found' });
    const summary = await run(key.key, 'sales_summary', { venue: 'Oak Group Bondi' });
    expect(summary).toEqual({ ok: false, message: 'Venue not found' });
    // The refusals are on the record, with no arguments.
    const refused = await t.db.selectFrom('agent_calls').select(['tool', 'outcome']).where('key_id', '=', key.id).where('outcome', '=', 'refused').execute();
    expect(refused.map((r) => r.tool).sort()).toEqual(['metrics_query', 'sales_summary']);
    await hubSet(group().venues.bondi!.id, { allowed_scopes: ['*'] });
  });

  it('a venue where the hub is switched off is out of reach, and a venue that turned assistants off likewise', async () => {
    const owner = await group().as('owner');
    const key = await issueKey(t.app, group().orgId, owner, { scopes: ['metrics:read', 'outcomes:read'] });
    await hubSet(group().venues.newtown!.id, {}, false);
    const r = (await run(key.key, 'metrics_query', { metrics: ['orders'], dimensions: ['venue'], period: 'last_28_days' })) as { ok: true; output: any };
    expect(r.output.venues.names.sort()).toEqual(['Oak Group Bondi', 'Oak Group CBD']);
    expect(await run(key.key, 'campaign_outcomes', { venue: 'newtown' })).toEqual({ ok: false, message: 'Venue not found' });
    await hubSet(group().venues.newtown!.id, {}, true);
    await hubSet(group().venues.cbd!.id, { agent_access_enabled: false });
    expect(await run(key.key, 'insights_digest', { venue: 'cbd' })).toEqual({ ok: false, message: 'Venue not found' });
    await hubSet(group().venues.cbd!.id, { agent_access_enabled: true });
    // Back on: reachable again.
    expect(await run(key.key, 'campaign_outcomes', { venue: 'newtown' })).toMatchObject({ ok: true, output: { venue: 'Oak Group Newtown' } });
  });

  it('a person\'s role below the tool\'s at one venue keeps that venue out; an owner-only view does not survive narrowing', async () => {
    // The manager works at CBD and Newtown only: Bondi was never theirs.
    const manager = await group().as('manager');
    const key = await issueKey(t.app, group().orgId, manager, { scopes: ['metrics:read'] });
    expect(await run(key.key, 'metrics_query', { metrics: ['orders'], venue: 'bondi' })).toEqual({ ok: false, message: 'Venue not found' });
    const caller = (await hub.resolveAgentKey(t.app, key.key))!;
    const narrowed = hub.narrowTo(caller, caller.venues.slice(0, 1));
    expect(Object.keys(narrowed.principal.staff.venueRoles)).toEqual([caller.venues[0]!.id]);
    expect(narrowed.principal.venueIds).toEqual([caller.venues[0]!.id]);
    const ownerCaller = (await hub.resolveAgentKey(t.app, (await issueKey(t.app, group().orgId, await group().as('owner'), { scopes: ['metrics:read'] })).key))!;
    expect(ownerCaller.principal.staff.isOwner).toBe(true);
    expect(hub.narrowTo(ownerCaller, ownerCaller.venues.slice(0, 2)).principal.staff.isOwner).toBe(false);
    expect(hub.narrowTo(ownerCaller, ownerCaller.venues)).toBe(ownerCaller);
  });

  it('a hosted agent\'s calls are recorded as its own, not a key\'s', async () => {
    const owner = await group().as('owner');
    const key = await issueKey(t.app, group().orgId, owner, { scopes: ['metrics:read'] });
    const caller = (await hub.resolveAgentKey(t.app, key.key))!;
    await hub.recordCall(t.app, { ...caller, hosted: { agentKey: 'weekly_digest', runId: null } }, { tool: 'insights_digest', effect: 'read', outcome: 'answered', startedAt: performance.now() });
    const row = await t.db.selectFrom('agent_calls').select(['key_id', 'actor_kind', 'hosted_agent_key', 'tool']).where('org_id', '=', group().orgId).where('hosted_agent_key', '=', 'weekly_digest').executeTakeFirstOrThrow();
    expect(row).toEqual({ key_id: null, actor_kind: 'hosted_agent', hosted_agent_key: 'weekly_digest', tool: 'insights_digest' });
  });

  it('closing an org revokes every assistant key, signed-in assistant and service key it had', async () => {
    const diner = t.fixture.diner;
    const owner = await diner.as('owner');
    const a = await issueKey(t.app, diner.orgId, owner, { scopes: ['metrics:read'] });
    const b = await issueKey(t.app, diner.orgId, await diner.as('manager'), { scopes: ['sales:read'] });
    expect(await hub.resolveAgentKey(t.app, a.key)).not.toBeNull();
    const u = await t.db.selectFrom('users').select('id').where('email', '=', 'admin@rosplatform.test').executeTakeFirstOrThrow();
    const admin: PlatformPrincipal = { kind: 'platform', adminUserId: u.id, reason: 'test' };
    await onboarding.closeOrg(t.app, admin, { orgId: diner.orgId, reason: 'Venue sold; contract ended' });
    const live = await t.db.selectFrom('agent_keys').select('id').where('org_id', '=', diner.orgId).where('revoked_at', 'is', null).execute();
    expect(live).toEqual([]);
    for (const k of [a, b]) {
      expect(await hub.resolveAgentKey(t.app, k.key)).toBeNull();
      const audited = await t.db.selectFrom('audit_log').select(['actor_kind', 'after']).where('entity_id', '=', k.id).where('action', '=', 'agent_key.revoked').executeTakeFirstOrThrow();
      expect(audited).toMatchObject({ actor_kind: 'platform', after: { reason: 'org_closed' } });
    }
  });
});
