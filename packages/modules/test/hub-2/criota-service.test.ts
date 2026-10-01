import { beforeAll, describe, expect, it } from 'vitest';
import { markConnectionHealth, revokeConnection, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, hub, identity, ledger } from '@ros/modules';
import { WORKER, sale } from '../analytics/helpers';
import { issueKey, roomForKeys } from '../hub/helpers';

/**
 * The Criota outcomes boundary (docs/modules/hub.md section 7), closed: a key an owner makes for
 * the connected Criota service reads campaign outcomes only where the venue switched sharing on,
 * never below the larger floor, only Criota's campaigns, never writes, never holds another
 * scope, and dies with the connection. A staff member's own assistant is unaffected.
 */
describe('hub-2: a service key for Criota', () => {
  const t = useTestEnv();
  let connectionId: string;
  const diner = () => t.fixture.diner;

  const hubSet = (orgId: string, venueId: string, config: Partial<hub.HubConfig>) => t.app.tenant(orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId, config }));
  const serviceKey = async (org = diner(), connection = connectionId, venueIds?: string[]) => {
    const owner = await org.as('owner');
    return t.app.tenant(org.orgId, owner, (ctx) => hub.createServiceKey(ctx, { connectionId: connection, expiresInDays: 30, ...(venueIds ? { venueIds } : {}) }));
  };
  /** campaign_outcomes as the hub runs it for this key. */
  const outcomesFor = async (key: string, args: Record<string, unknown> = {}) => {
    const caller = await hub.resolveAgentKey(t.app, key);
    if (!caller) return null;
    const offered = hub.offeredTools(caller, { canAsk: true }).find((o) => o.tool.name === 'campaign_outcomes');
    if (!offered) return 'not offered' as const;
    return hub.runTool(t.app, caller, offered, args);
  };
  /** Guests who arrived through a link, each with a sale. */
  async function guests(tag: string, n: number, acquisition: { source: string; campaignId: string; creatorId?: string }, orgId = diner().orgId, venueId = diner().venueId) {
    const at = new Date(t.clock().getTime() - 30 * 86_400_000);
    await t.app.tenant(orgId, WORKER, async (ctx) => {
      for (let i = 0; i < n; i++) {
        const r = await identity.resolveCustomer(ctx, {
          hints: [{ kind: 'email', value: `${tag}-${i}@svc.example` }],
          via: 'online-order',
          venueId,
          profile: { firstName: 'Sam', lastName: `Svc-${tag}-${i}` },
          acquisition: { ...acquisition, landingPath: '/offer', at },
        });
        await ledger.recordTransaction(ctx, sale(`svc-${tag}-${i}`, new Date(at.getTime() + 3_600_000)), { venueId, customerId: r.customerId! });
      }
    });
  }

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
    const owner = await diner().as('owner');
    const row = await t.app.tenant(diner().orgId, owner, (ctx) => hub.connectMcpPlug(ctx, { plugKey: 'criota-sim', accessKey: t.sim.criota.issueKey('Oak Diner') }));
    connectionId = row.id;
    // A Criota campaign with 8 guests (above 5, below 20), and a newsletter campaign that is not Criota's.
    await guests('crio8', 8, { source: 'criota', campaignId: 'camp_crio_eight', creatorId: 'creator_eight' });
    await guests('news', 12, { source: 'newsletter', campaignId: 'camp_newsletter' });
  });

  it('only an owner makes one, for a live connection; it holds outcomes:read and nothing else, is labelled, and can never write', async () => {
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => hub.createServiceKey(ctx, { connectionId, expiresInDays: 30 }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('owner'), (ctx) => hub.createServiceKey(ctx, { connectionId, expiresInDays: 30 }))).rejects.toMatchObject({ code: 'not_found' });

    const made = await serviceKey();
    expect(made.view).toMatchObject({ audience: 'service:criota-sim', connectionId, kind: 'key', scopes: ['outcomes:read'], canWrite: false, label: 'Service key for Criota (simulated)' });
    const row = await t.db.selectFrom('agent_keys').select(['audience', 'connection_id', 'scopes', 'can_write', 'kind']).where('id', '=', made.view.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ audience: 'service:criota-sim', connection_id: connectionId, scopes: ['outcomes:read'], can_write: false, kind: 'key' });
    const created = await t.db.selectFrom('audit_log').select(['action', 'after']).where('entity_id', '=', made.view.id).executeTakeFirstOrThrow();
    expect(created).toMatchObject({ action: 'agent_key.created', after: { audience: 'service:criota-sim', scopes: ['outcomes:read'], canWrite: false } });
    // The console list says whose it is.
    const listed = await t.app.tenant(diner().orgId, await diner().as('owner'), (ctx) => hub.listAgentKeys(ctx));
    expect(listed.find((k) => k.id === made.view.id)!.label).toBe('Service key for Criota (simulated)');

    // "Can make changes" cannot be ticked for it, even by the owner.
    await expect(t.app.tenant(diner().orgId, await diner().as('owner'), (ctx) => hub.setAgentKeyCanWrite(ctx, made.view.id, true))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await t.db.selectFrom('agent_keys').select('can_write').where('id', '=', made.view.id).executeTakeFirstOrThrow()).can_write).toBe(false);

    // Even a row altered behind the platform's back resolves to outcomes:read, reads only.
    await t.db.updateTable('agent_keys').set({ scopes: ['outcomes:read', 'sales:read', 'venue:write', 'metrics:read'], can_write: true }).where('id', '=', made.view.id).execute();
    const caller = (await hub.resolveAgentKey(t.app, made.key))!;
    expect(caller.principal).toMatchObject({ scopes: ['outcomes:read'], canWrite: false, audience: 'service:criota-sim' });
    expect(caller.principal.staff.isOwner).toBe(false);
    expect(hub.offeredTools(caller, { canAsk: true }).map((o) => o.tool.name)).toEqual(['campaign_outcomes']);
    await t.db.updateTable('agent_keys').set({ scopes: ['outcomes:read'], can_write: false }).where('id', '=', made.view.id).execute();
  });

  it('gets nothing while the venue has not switched sharing on, then only Criota\'s campaigns, never below the larger floor', async () => {
    const made = await serviceKey();
    // Sharing is off by default, even with a live Criota connection.
    const off = (await outcomesFor(made.key)) as { ok: true; output: Record<string, any> };
    expect(off.ok).toBe(true);
    expect(off.output).toMatchObject({ outcomes: [], venues_covered: 0 });
    expect(off.output.wording).toMatch(/No venue has switched on sharing/);

    await hubSet(diner().orgId, diner().venueId, { criota_share_enabled: true });
    const onNow = (await outcomesFor(made.key)) as { ok: true; output: Record<string, any> };
    expect(onNow.ok).toBe(true);
    expect(onNow.output.venues_covered).toBe(1);
    expect(onNow.output.min_cohort).toBe(10); // the venue's criota_min_cohort default, above analytics' 5
    const ids = onNow.output.outcomes.map((o: any) => o.campaign_id);
    expect(ids).not.toContain('camp_newsletter');
    for (const o of onNow.output.outcomes) expect(o.creator_id).not.toBeNull();
    // Eight guests: measured for the venue's own staff at floor 5, withheld for Criota at floor 10.
    const eight = onNow.output.outcomes.find((o: any) => o.campaign_id === 'camp_crio_eight');
    expect(eight).toMatchObject({ status: 'not_enough_guests', new_customers: null, orders: null, revenue_band: null });

    // Raised further: the service's answer follows; lowered below analytics' own floor, analytics' wins.
    await hubSet(diner().orgId, diner().venueId, { criota_min_cohort: 20 });
    const raised = (await outcomesFor(made.key)) as { ok: true; output: Record<string, any> };
    expect(raised.output.min_cohort).toBe(20);
    for (const o of raised.output.outcomes) if (o.new_customers !== null) expect(o.new_customers).toBeGreaterThanOrEqual(20);
    await t.app.tenant(diner().orgId, await diner().as('owner'), (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 30 }));
    await hubSet(diner().orgId, diner().venueId, { criota_min_cohort: 5 });
    expect(((await outcomesFor(made.key)) as { ok: true; output: Record<string, any> }).output.min_cohort).toBe(30);
    await t.app.tenant(diner().orgId, await diner().as('owner'), (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 5 }));
    await hubSet(diner().orgId, diner().venueId, { criota_min_cohort: 10 });

    // No guest leaves: no customer id anywhere in the answer.
    const people = await t.db.selectFrom('customers').select('id').where('org_id', '=', diner().orgId).execute();
    const text = JSON.stringify(onNow.output);
    expect(people.some((p) => text.includes(p.id))).toBe(false);
    // On the record as the service's call.
    const calls = await t.db.selectFrom('agent_calls').select(['actor_kind', 'tool', 'effect', 'outcome']).where('key_id', '=', made.view.id).execute();
    expect(calls.every((c) => c.actor_kind === 'service_key' && c.tool === 'campaign_outcomes' && c.effect === 'read')).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(3);

    // Switched off again: nothing.
    await hubSet(diner().orgId, diner().venueId, { criota_share_enabled: false });
    expect(((await outcomesFor(made.key)) as { ok: true; output: Record<string, any> }).output.outcomes).toEqual([]);
  });

  it('a staff member\'s own assistant key is unaffected: every campaign, analytics\' own floor, sharing or not', async () => {
    const owner = await diner().as('owner');
    const staffKey = await issueKey(t.app, diner().orgId, owner, { scopes: ['outcomes:read'] });
    const r = (await outcomesFor(staffKey.key)) as { ok: true; output: Record<string, any> };
    expect(r.ok).toBe(true);
    expect(r.output.min_cohort).toBe(5);
    const ids = r.output.outcomes.map((o: any) => o.campaign_id);
    expect(ids).toEqual(expect.arrayContaining(['camp_newsletter', 'camp_crio_eight']));
    expect(r.output.outcomes.find((o: any) => o.campaign_id === 'camp_crio_eight').status).toBe('measured');
    const calls = await t.db.selectFrom('agent_calls').select('actor_kind').where('key_id', '=', staffKey.id).execute();
    expect(calls.map((c) => c.actor_kind)).toEqual(['agent_key']);
  });

  it('for a group: one venue at a time, and a venue that does not share is not found', async () => {
    const group = t.fixture.group;
    const owner = await group.as('owner');
    const conn = await t.app.tenant(group.orgId, owner, (ctx) => hub.connectMcpPlug(ctx, { plugKey: 'criota-sim', accessKey: t.sim.criota.issueKey('Oak Group') }));
    const made = await serviceKey(group, conn.id);
    await hubSet(group.orgId, group.venues.cbd!.id, { criota_share_enabled: true });
    await hubSet(group.orgId, group.venues.newtown!.id, { criota_share_enabled: true });
    // Two venues share: no total across them is released.
    const both = await outcomesFor(made.key, { venue: 'cbd' });
    expect(both).toMatchObject({ ok: true, output: { venue: 'Oak Group CBD', venues_covered: 1 } });
    const unnamed = (await outcomesFor(made.key, {})) as { ok: false; message: string };
    expect(unnamed.ok).toBe(false);
    expect(unnamed.message).toMatch(/Name one venue/);
    // Bondi does not share: to the service it does not exist.
    const bondi = (await outcomesFor(made.key, { venue: 'bondi' })) as { ok: false; message: string };
    expect(bondi).toMatchObject({ ok: false, message: 'Venue not found' });
  });

  it('dies with its connection: unhealthy, it stops answering; revoked, the key itself is revoked', async () => {
    const made = await serviceKey();
    expect(await hub.resolveAgentKey(t.app, made.key)).not.toBeNull();
    await markConnectionHealth(t.app, connectionId, { ok: false, error: 'refused' });
    expect(await hub.resolveAgentKey(t.app, made.key)).toBeNull();
    await markConnectionHealth(t.app, connectionId, { ok: true });
    expect(await hub.resolveAgentKey(t.app, made.key)).not.toBeNull();

    const staffKey = await issueKey(t.app, diner().orgId, await diner().as('owner'), { scopes: ['outcomes:read'] });
    await t.app.tenant(diner().orgId, await diner().as('owner'), (ctx) => revokeConnection(ctx, connectionId));
    expect(await hub.resolveAgentKey(t.app, made.key)).toBeNull();
    const row = await t.db.selectFrom('agent_keys').select('revoked_at').where('id', '=', made.view.id).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    const audited = await t.db.selectFrom('audit_log').select(['action', 'after']).where('entity_id', '=', made.view.id).where('action', '=', 'agent_key.revoked').executeTakeFirstOrThrow();
    expect(audited.after).toMatchObject({ reason: 'connection_revoked', connectionId });
    // The staff member's own key did not depend on the connection and still works.
    expect(await hub.resolveAgentKey(t.app, staffKey.key)).not.toBeNull();
    // And no new one can be made for a dead connection.
    await expect(serviceKey()).rejects.toMatchObject({ code: 'conflict' });
  });
});
