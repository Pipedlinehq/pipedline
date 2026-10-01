import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { useTestEnv } from '@ros/testkit';
import { approvals, hub, tenancy } from '@ros/modules';
import { paidOrder } from '../commerce/helpers';
import { WORKER, agentApprovals, agentCalls, agentRuns, setAgent } from './helpers';

/**
 * The hosted-agent runner (docs/modules/hub.md section 8): an agent acts through the same tool
 * catalogue an assistant uses, and what it may do alone is the venue's setting, never above the
 * agent's own ceiling. Every assertion reads the database back.
 */
const helper = hub.defineHostedAgent({
  key: 'test_helper',
  name: 'Test helper',
  description: 'A test agent that may act alone on tools that are not sensitive.',
  templateVersion: '1',
  ceiling: 'autonomous',
  scopes: ['menu:read', 'menu:write', 'orders:read', 'orders:write', 'venue:read'],
});
const careful = hub.defineHostedAgent({
  key: 'test_careful',
  name: 'Test careful',
  description: 'A test agent that may never act alone.',
  templateVersion: '1',
  ceiling: 'supervised',
  scopes: ['menu:read', 'menu:write'],
});
const reader = hub.defineHostedAgent({ key: 'test_reader', name: 'Test reader', description: 'Holds one read scope.', templateVersion: '1', ceiling: 'supervised', scopes: ['venue:read'], role: 'read_only' });

describe('hub: the hosted-agent runner', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const venueId = () => diner().venueId;

  const available = async (itemId: string) => (await t.db.selectFrom('menu_items').select(['is_available']).where('id', '=', itemId).executeTakeFirstOrThrow()).is_available;
  const item = async (name = 'Fries, aioli') => t.db.selectFrom('menu_items').select(['id', 'name']).where('org_id', '=', diner().orgId).where('name', '=', name).executeTakeFirstOrThrow();
  const sellOut = (run: hub.HostedRun, name: string) => run.act('menu_set_availability', { item: name, available: false, until: 'until_changed' });
  const runAs = (agent: hub.HostedAgentDef, body: hub.HostedAgentBody, org = diner(), venue: string | null = venueId()) => hub.runHostedAgent(t.app, { orgId: org.orgId, agent, venueId: venue, trigger: 'test' }, body);
  const decide = async (approvalId: string, decision: 'approved' | 'rejected', who: 'manager' | 'owner' = 'manager', org = diner()) => {
    const p = await org.as(who);
    return t.app.tenant(org.orgId, p, (ctx) => approvals.decideApproval(ctx, approvalId, { decision }));
  };
  const restore = async (itemId: string) => void (await t.db.updateTable('menu_items').set({ is_available: true, unavailable_until: null }).where('id', '=', itemId).execute());

  it('is off until the venue switches the agent on, then shadow, and never above the agent\'s ceiling', async () => {
    await setAgent(t, diner(), venueId(), helper.key, 'off');
    expect(await hub.hostedCaller(t.app, { orgId: diner().orgId, agent: helper })).toBeNull();
    const off = await runAs(helper, async () => ({ summary: 'should not run' }));
    expect(off).toMatchObject({ status: 'skipped', mode: 'off', runId: null });
    expect(await agentRuns(t, diner().orgId, helper.key)).toHaveLength(0);

    // Listed with no level: shadow.
    await t.app.tenant(diner().orgId, WORKER, async (ctx) => {
      const { setModule, getModule } = await import('@ros/core');
      const now = (await getModule(ctx, venueId(), hub.hubModule)).config;
      await setModule(ctx, hub.hubModule, { venueId: venueId(), config: { hosted_agents: [...now.hosted_agents, helper.key] } });
    });
    expect((await hub.hostedCaller(t.app, { orgId: diner().orgId, agent: helper }))!.modes.get(venueId())).toBe('shadow');

    // A venue that asks for autonomous gets the agent's ceiling and no more.
    await setAgent(t, diner(), venueId(), careful.key, 'autonomous');
    const hc = (await hub.hostedCaller(t.app, { orgId: diner().orgId, agent: careful }))!;
    expect(hc.modes.get(venueId())).toBe('supervised');
    // It acts as itself: an agent principal, never an owner, with only its declared scopes.
    expect(hc.caller.principal).toMatchObject({ kind: 'agent', keyId: 'hosted:test_careful', canWrite: true, scopes: ['menu:read', 'menu:write'] });
    expect(hc.caller.principal.staff).toMatchObject({ isOwner: false, staffId: hub.HOSTED_STAFF_ID, venueRoles: { [venueId()]: 'manager' } });
    expect(hc.caller.hosted).toEqual({ agentKey: 'test_careful', runId: null });
  });

  it('reads through the tool catalogue: only tools its scopes unlock, recorded as the agent\'s own calls', async () => {
    await setAgent(t, diner(), venueId(), reader.key, 'supervised');
    const seen: Record<string, unknown> = {};
    const out = await runAs(reader, async (run) => {
      const status = await run.read<{ venue: { name: string }; features_on: string[] }>('venue_status');
      seen.venue = status.venue.name;
      // A tool whose scope it does not hold is not on offer, exactly as for a key.
      await expect(run.read('menu_list')).rejects.toMatchObject({ name: 'AgentToolError', reason: 'not_offered' });
      // A change with a scope it does not hold is refused without anything being read.
      seen.act = await run.act('menu_set_availability', { item: 'Fries, aioli', available: false });
      return { summary: `Read ${status.venue.name}.` };
    });
    expect(seen.venue).toBe('Oak Diner');
    expect(seen.act).toMatchObject({ status: 'refused' });
    expect(out.status).toBe('succeeded');

    const [run] = await agentRuns(t, diner().orgId, reader.key);
    expect(run).toMatchObject({ mode: 'supervised', status: 'succeeded', summary: 'Read Oak Diner.', venue_id: venueId(), trigger: 'test' });
    const calls = await agentCalls(t, diner().orgId, reader.key);
    expect(calls).toEqual([{ tool: 'venue_status', effect: 'read', outcome: 'answered', actor_kind: 'hosted_agent', key_id: null, agent_run_id: run!.id, plug_key: 'os' }]);
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(0);
  });

  it('cannot reach another organisation, or a venue where it is not switched on', async () => {
    // On at one of the group's venues only.
    const [first, second] = Object.values(group().venues);
    await setAgent(t, group(), first!.id, reader.key, 'supervised');
    await setAgent(t, group(), second!.id, reader.key, 'off');
    const hc = (await hub.hostedCaller(t.app, { orgId: group().orgId, agent: reader }))!;
    expect(hc.caller.venues.map((v) => v.id)).toEqual([first!.id]);
    expect(Object.keys(hc.caller.principal.staff.venueRoles)).toEqual([first!.id]);

    await hub.runHostedAgent(t.app, { orgId: group().orgId, agent: reader, trigger: 'test' }, async (run) => {
      expect(run.everywhere).toBe(false);
      expect((await run.read<{ venue: { name: string } }>('venue_status')).venue.name).toBe(first!.name);
      return { summary: 'ok' };
    });
    // Named at the venue it is off at: nothing runs.
    expect(await hub.runHostedAgent(t.app, { orgId: group().orgId, agent: reader, venueId: second!.id, trigger: 'test' }, async () => ({ summary: 'no' }))).toMatchObject({ status: 'skipped', mode: 'off' });
    // Named at another organisation's venue: nothing runs either.
    expect(await hub.runHostedAgent(t.app, { orgId: group().orgId, agent: reader, venueId: venueId(), trigger: 'test' }, async () => ({ summary: 'no' }))).toMatchObject({ status: 'skipped', mode: 'off' });
    const dinerCalls = await t.db.selectFrom('agent_calls').select('id').where('org_id', '=', diner().orgId).where('agent_run_id', 'in', (await agentRuns(t, group().orgId, reader.key)).map((r) => r.id)).execute();
    expect(dinerCalls).toHaveLength(0);
  });

  it('shadow: records what it would do; nothing is queued and nothing changes', async () => {
    const fries = await item();
    await setAgent(t, diner(), venueId(), helper.key, 'shadow');
    const out = await runAs(helper, async (run) => {
      const r = await sellOut(run, fries.name);
      return { summary: `Would: ${r.status}` };
    });
    expect(out.actions).toEqual([{ status: 'shadow', tool: 'menu_set_availability', question: 'Mark "Fries, aioli" as sold out at Oak Diner until someone puts it back? It will show as unavailable on the website, the QR menu and in ordering straight away.' }]);
    expect(await available(fries.id)).toBe(true);
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(0);
    const last = (await agentRuns(t, diner().orgId, helper.key)).find((r) => r.id === out.runId)!;
    expect(last).toMatchObject({ mode: 'shadow', status: 'succeeded' });
    expect((last.output as { actions: unknown[] }).actions).toEqual(out.actions);
    // The question was put (and recorded as put); nothing was confirmed.
    expect((await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.agent_run_id === last.id).map((c) => c.outcome)).toEqual(['asked']);
  });

  it('supervised: one approval per proposed action; approved, the question is rebuilt and the change made in the same transaction', async () => {
    const fries = await item();
    await setAgent(t, diner(), venueId(), helper.key, 'supervised');
    const first = await runAs(helper, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    expect(first.actions[0]).toMatchObject({ status: 'queued', tool: 'menu_set_availability' });
    expect(await available(fries.id)).toBe(true);

    let pending = await agentApprovals(t, diner().orgId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ status: 'pending', venue_id: venueId(), requested_by_kind: 'agent', requested_by_id: 'hosted:test_helper' });
    expect(pending[0]!.summary).toBe('Test helper proposes: Mark "Fries, aioli" as sold out at Oak Diner until someone puts it back? It will show as unavailable on the website, the QR menu and in ordering straight away.');
    expect(pending[0]!.expires_at!.getTime() - t.clock().getTime()).toBe(48 * 3_600_000);
    expect(pending[0]!.payload).toMatchObject({ agent: 'test_helper', tool: 'menu_set_availability', venueId: venueId(), input: { item: 'Fries, aioli', available: false, until: 'until_changed' } });

    // The same action proposed again by a later run: still one approval.
    const again = await runAs(helper, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    expect(again.actions[0]).toEqual({ status: 'waiting', tool: 'menu_set_availability', approvalId: pending[0]!.id });
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(1);

    // An assistant can never grant it; a person can.
    const manager = await diner().as('manager');
    await expect(
      t.app.tenant(diner().orgId, { kind: 'agent', keyId: 'k', staff: manager, scopes: [], venueIds: null, canWrite: true }, (ctx) => approvals.decideApproval(ctx, pending[0]!.id, { decision: 'approved' })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await available(fries.id)).toBe(true);

    await decide(pending[0]!.id, 'approved');
    expect(await available(fries.id)).toBe(false);
    pending = await agentApprovals(t, diner().orgId);
    expect(pending[0]!.status).toBe('approved');
    const calls = await agentCalls(t, diner().orgId, helper.key);
    // (The test clock stands still, so rows of one instant are compared without order.)
    expect(calls.filter((c) => c.agent_run_id === first.runId).map((c) => c.outcome).sort()).toEqual(['asked', 'confirmed']);
    const audit = await t.db.selectFrom('audit_log').select(['action', 'actor_kind', 'entity_id', 'after']).where('org_id', '=', diner().orgId).where('action', '=', 'agent.action_approved').execute();
    expect(audit).toEqual([{ action: 'agent.action_approved', actor_kind: 'staff', entity_id: pending[0]!.id, after: { agent: 'test_helper', tool: 'menu_set_availability' } }]);
    // The menu change itself is on the record as the agent's, made with a person's yes.
    const menuAudit = await t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id']).where('org_id', '=', diner().orgId).where('entity_id', '=', fries.id).orderBy('occurred_at', 'desc').executeTakeFirst();
    expect(menuAudit).toEqual({ actor_kind: 'agent', actor_id: 'hosted:test_helper' });
    // A decided approval cannot be decided again.
    await expect(decide(pending[0]!.id, 'approved')).rejects.toMatchObject({ code: 'conflict' });
    await restore(fries.id);
    await t.db.updateTable('approvals').set({ status: 'rejected', decided_at: new Date(t.clock().getTime() - 30 * 3_600_000) }).where('id', '=', pending[0]!.id).execute();
  });

  it('approved after the facts changed: nothing is changed, the approval stays pending, the person is told why', async () => {
    const fries = await item();
    await setAgent(t, diner(), venueId(), helper.key, 'supervised');
    // "until the end of this service" is part of the question; so is the item's name.
    await runAs(helper, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    const approval = (await agentApprovals(t, diner().orgId)).find((a) => a.status === 'pending')!;
    // The venue renames the venue-facing thing the question names.
    await t.db.updateTable('venues').set({ name: 'Oak Diner & Bar' }).where('id', '=', venueId()).execute();
    await expect(decide(approval.id, 'approved')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('Nothing was changed') });
    expect(await available(fries.id)).toBe(true);
    expect((await agentApprovals(t, diner().orgId)).find((a) => a.id === approval.id)!.status).toBe('pending');
    expect((await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.outcome === 'confirmed' && c.tool === 'menu_set_availability')).toHaveLength(1);
    await t.db.updateTable('venues').set({ name: 'Oak Diner' }).where('id', '=', venueId()).execute();

    // Turned back to shadow since: the proposal is void.
    await setAgent(t, diner(), venueId(), helper.key, 'shadow');
    await expect(decide(approval.id, 'approved')).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('switched off or turned back to shadow') });
    expect(await available(fries.id)).toBe(true);
    await setAgent(t, diner(), venueId(), helper.key, 'supervised');

    // Rejected: recorded, nothing changes, and the same action is not proposed again for a day.
    await decide(approval.id, 'rejected');
    expect(await available(fries.id)).toBe(true);
    expect((await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.outcome === 'declined')).toHaveLength(1);
    const soon = await runAs(helper, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    expect(soon.actions[0]).toEqual({ status: 'declined', tool: 'menu_set_availability', approvalId: approval.id });
    expect((await agentApprovals(t, diner().orgId)).filter((a) => a.status === 'pending')).toHaveLength(0);
    t.clock.advance(25 * 3_600_000);
    const later = await runAs(helper, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    expect(later.actions[0]).toMatchObject({ status: 'queued' });

    // Left undecided past its deadline: it lapses, and nothing is done.
    t.clock.advance(49 * 3_600_000);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => approvals.expireApprovals(ctx));
    const lapsed = (await agentApprovals(t, diner().orgId)).at(-1)!;
    expect(lapsed.status).toBe('expired');
    await expect(decide(lapsed.id, 'approved')).rejects.toMatchObject({ code: 'conflict' });
    expect(await available(fries.id)).toBe(true);
    expect((await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.outcome === 'expired')).toHaveLength(1);
  });

  it('autonomous: makes a change that is not sensitive; a sensitive one still waits for a person; a supervised agent never acts alone', async () => {
    const fries = await item();
    await setAgent(t, diner(), venueId(), helper.key, 'autonomous');
    const order = await paidOrder(t, diner(), venueId());
    const out = await runAs(helper, async (run) => {
      await sellOut(run, fries.name);
      await run.act('order_decide', { order: order.reference, decision: 'accept' });
      return { summary: 'acted' };
    });
    // Not sensitive: done at once, with the question it answered and the tool's allowlisted output.
    expect(out.actions[0]).toMatchObject({ status: 'done', tool: 'menu_set_availability', output: { item_id: fries.id, name: 'Fries, aioli', available: false, back_at: null } });
    expect(await available(fries.id)).toBe(false);
    // Sensitive (it can refund a guest): queued for a person, whatever the level.
    expect(out.actions[1]).toMatchObject({ status: 'queued', tool: 'order_decide' });
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow()).status).toBe('placed');
    const calls = (await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.agent_run_id === out.runId);
    expect(calls.map((c) => `${c.tool}:${c.outcome}`).sort()).toEqual(['menu_set_availability:asked', 'menu_set_availability:confirmed', 'order_decide:asked']);
    // The person approves: the order is accepted, by the agent with that person behind it.
    const approval = (await agentApprovals(t, diner().orgId)).find((a) => a.status === 'pending' && (a.payload as { tool: string }).tool === 'order_decide')!;
    await decide(approval.id, 'approved');
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', order.id).executeTakeFirstOrThrow()).status).toBe('accepted');
    await restore(fries.id);

    // The same change by an agent whose ceiling is supervised, at a venue that asked for autonomous: queued, not made.
    await setAgent(t, diner(), venueId(), careful.key, 'autonomous');
    const held = await runAs(careful, async (run) => ({ summary: (await sellOut(run, fries.name)).status }));
    expect(held).toMatchObject({ mode: 'supervised' });
    expect(held.actions[0]).toMatchObject({ status: 'queued' });
    expect(await available(fries.id)).toBe(true);
    await t.db.updateTable('approvals').set({ status: 'rejected', decided_at: new Date(t.clock().getTime() - 30 * 3_600_000) }).where('org_id', '=', diner().orgId).where('status', '=', 'pending').execute();
  });

  it('a manager who has no role at the venue cannot approve its agent\'s proposal', async () => {
    const [first] = Object.values(group().venues);
    await setAgent(t, group(), first!.id, careful.key, 'supervised');
    const g = await t.db.selectFrom('menu_items').select(['id', 'name']).where('org_id', '=', group().orgId).where('venue_id', '=', first!.id).where('is_available', '=', true).limit(1).executeTakeFirstOrThrow();
    const out = await hub.runHostedAgent(t.app, { orgId: group().orgId, agent: careful, venueId: first!.id, trigger: 'test' }, async (run) => ({ summary: (await run.act('menu_set_availability', { item: g.id, available: false })).status }));
    expect(out.actions[0]).toMatchObject({ status: 'queued' });
    const approval = (await agentApprovals(t, group().orgId)).at(-1)!;
    // The other organisation's manager: the approval does not exist for them.
    const outsider = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, outsider, (ctx) => approvals.decideApproval(ctx, approval.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group().orgId, outsider, (ctx) => approvals.decideApproval(ctx, approval.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.db.selectFrom('menu_items').select('is_available').where('id', '=', g.id).executeTakeFirstOrThrow()).is_available).toBe(true);
    expect((await agentApprovals(t, group().orgId)).at(-1)!.status).toBe('pending');
  });

  it('the organisation\'s daily cap stops further proposals; reads go on', async () => {
    await setAgent(t, diner(), venueId(), helper.key, 'supervised');
    const owner = await diner().as('owner');
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => hub.setHostedAgentSettings(ctx, { actions_per_day: 1 }))).rejects.toMatchObject({ code: 'forbidden' });
    const used = await t.app.tenant(diner().orgId, WORKER, (ctx) => hub.hostedActionsToday(ctx, 'Australia/Sydney'));
    await t.app.tenant(diner().orgId, owner, (ctx) => hub.setHostedAgentSettings(ctx, { actions_per_day: used + 1 }));
    expect((await t.app.tenant(diner().orgId, owner, (ctx) => tenancy.getOrg(ctx))).id).toBe(diner().orgId);

    const before = (await agentApprovals(t, diner().orgId)).length;
    const out = await runAs(helper, async (run) => {
      await sellOut(run, 'Fries, aioli');
      await run.act('menu_set_availability', { item: 'Fries, aioli', available: false, until: 'end_of_service' });
      const status = await run.read<{ venue: { name: string } }>('venue_status');
      return { summary: status.venue.name };
    });
    expect(out.actions.map((a) => a.status)).toEqual(['queued', 'capped']);
    expect(out.actions[1]).toEqual({ status: 'capped', tool: 'menu_set_availability', cap: used + 1 });
    expect(out.summary).toBe('Oak Diner');
    expect((await agentApprovals(t, diner().orgId)).length).toBe(before + 1);
    expect((await agentCalls(t, diner().orgId, helper.key)).filter((c) => c.agent_run_id === out.runId).map((c) => c.outcome).sort()).toEqual(['answered', 'asked', 'capped']);
    // A shadow run is not an action and is not held back by the cap.
    await setAgent(t, diner(), venueId(), helper.key, 'shadow');
    const shadow = await runAs(helper, async (run) => ({ summary: (await sellOut(run, 'Fries, aioli')).status }));
    expect(shadow.actions[0]).toMatchObject({ status: 'shadow' });
    // The next day the count starts again.
    await setAgent(t, diner(), venueId(), helper.key, 'supervised');
    t.clock.advance(24 * 3_600_000);
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => hub.hostedActionsToday(ctx, 'Australia/Sydney'))).toBe(0);
    await t.app.tenant(diner().orgId, owner, (ctx) => hub.setHostedAgentSettings(ctx, { actions_per_day: 20 }));
  });

  it('a model step is bounded, schema-checked and checked by the agent\'s own code; its tokens are on the run', async () => {
    await setAgent(t, diner(), venueId(), reader.key, 'supervised');
    const shape = z.object({ line: z.string().max(80) });
    t.sim.llm.respond('test.step', () => ({ line: 'All quiet.' }));
    const ok = await runAs(reader, async (run) => ({ summary: (await run.generate({ purpose: 'test.step', system: 'Say one line.', input: { venue: 'Oak Diner' }, schema: shape })).line }));
    expect(ok).toMatchObject({ status: 'succeeded', summary: 'All quiet.' });
    const okRun = (await agentRuns(t, diner().orgId, reader.key)).find((r) => r.id === ok.runId)!;
    expect(okRun.tokens_in).toBeGreaterThan(0);
    expect(okRun.tokens_out).toBe(50);
    expect(t.sim.llm.calls.at(-1)).toMatchObject({ purpose: 'test.step', orgId: diner().orgId, input: '{"venue":"Oak Diner"}' });

    // The agent's own check says no: the run fails and says why; nothing built from the answer is used.
    const rejected = await runAs(reader, async (run) => {
      const out = await run.generate({ purpose: 'test.step', system: 'Say one line.', input: {}, schema: shape, check: (o) => (o.line.includes('quiet') ? ['mentions "quiet"'] : []) });
      return { summary: out.line };
    });
    expect(rejected).toMatchObject({ status: 'failed' });
    const failedRun = (await agentRuns(t, diner().orgId, reader.key)).find((r) => r.id === rejected.runId)!;
    expect(failedRun).toMatchObject({ status: 'failed', error: expect.stringContaining('mentions "quiet"') });
    expect((failedRun.output as { rejected: string[] }).rejected).toEqual(['mentions "quiet"']);

    // An answer of the wrong shape never reaches the agent.
    t.sim.llm.respond('test.step', () => ({ line: 42 }));
    expect(await runAs(reader, async (run) => ({ summary: (await run.generate({ purpose: 'test.step', system: 's', input: {}, schema: shape })).line }))).toMatchObject({ status: 'failed' });

    // No more than a fixed number of model steps in one run.
    t.sim.llm.respond('test.step', () => ({ line: 'x' }));
    const before = t.sim.llm.calls.length;
    const greedy = await runAs(reader, async (run) => {
      for (let i = 0; i < hub.MAX_MODEL_STEPS_PER_RUN + 3; i++) await run.generate({ purpose: 'test.step', system: 's', input: {}, schema: shape });
      return { summary: 'never' };
    });
    expect(greedy.status).toBe('failed');
    expect(t.sim.llm.calls.length - before).toBe(hub.MAX_MODEL_STEPS_PER_RUN);
  });
});
