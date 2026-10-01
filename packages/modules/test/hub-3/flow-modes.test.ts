import { describe, expect, it } from 'vitest';
import { drainJobs, getModule, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { approvals, campaigns, hub } from '@ros/modules';
import { agentRuns as flowRuns, enrolDirect, messagesFor, newGuest, pendingBatches, resetFlow, sentTo, setMode } from '../campaigns/helpers';
import { WORKER, setAgent } from './helpers';

/**
 * A lifecycle flow is a hosted agent, so a venue's own assistant settings bound it as they
 * bound any other: the level a flow runs at, at a venue, is the stricter of the org's flow
 * mode and that venue's `hosted_agents` / `autonomy_level_per_agent` for the flow's agent.
 */
describe('campaigns: a flow runs no further than the venue allows its agent', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const WELCOME = campaigns.FLOW_AGENTS.welcome.key;
  const run = (org = diner()) => {
    t.clock.advanceMinutes(1);
    return campaigns.runFlows(t.app, org.orgId, { flowKey: 'welcome', trigger: 'test' });
  };

  it('the fixture venues allow each flow agent up to its ceiling, so the org\'s mode decides there', async () => {
    const state = await t.app.tenant(diner().orgId, WORKER, (ctx) => getModule(ctx, diner().venueId, hub.hubModule));
    expect(state.enabled).toBe(true);
    expect(state.config.hosted_agents).toEqual(expect.arrayContaining(Object.values(campaigns.FLOW_AGENTS).map((a) => a.key)));
    expect(state.config.autonomy_level_per_agent).toMatchObject({ flow_welcome: 'autonomous', flow_winback: 'supervised' });
    for (const mode of ['shadow', 'supervised', 'autonomous'] as const) {
      expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => campaigns.effectiveModeAt(ctx, { key: 'welcome', mode, offerId: null }, diner().venueId))).toBe(mode);
    }
    // The agent's own ceiling still holds, whatever both settings say.
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => campaigns.effectiveModeAt(ctx, { key: 'vip', mode: 'autonomous', offerId: null }, diner().venueId))).toBe('supervised');
  });

  it('the stricter of the two wins, in either direction', async () => {
    const at = (flowMode: 'off' | 'shadow' | 'supervised' | 'autonomous') => t.app.tenant(diner().orgId, WORKER, (ctx) => campaigns.effectiveModeAt(ctx, { key: 'welcome', mode: flowMode, offerId: null }, diner().venueId));
    await setAgent(t, diner(), diner().venueId, WELCOME, 'shadow');
    expect(await at('autonomous')).toBe('shadow');
    expect(await at('off')).toBe('off');
    await setAgent(t, diner(), diner().venueId, WELCOME, 'supervised');
    expect(await at('autonomous')).toBe('supervised');
    expect(await at('shadow')).toBe('shadow');
    await setAgent(t, diner(), diner().venueId, WELCOME, 'autonomous');
    expect(await at('supervised')).toBe('supervised');
    // Switched on with no level given: shadow.
    await t.app.tenant(diner().orgId, WORKER, async (ctx) => {
      const now = (await getModule(ctx, diner().venueId, hub.hubModule)).config;
      const { [WELCOME]: _gone, ...levels } = now.autonomy_level_per_agent;
      await setModule(ctx, hub.hubModule, { venueId: diner().venueId, config: { autonomy_level_per_agent: levels } });
    });
    expect(await at('autonomous')).toBe('shadow');
    // Not switched on at the venue, or assistants off there altogether: off.
    await setAgent(t, diner(), diner().venueId, WELCOME, 'off');
    expect(await at('autonomous')).toBe('off');
    await setAgent(t, diner(), diner().venueId, WELCOME, 'autonomous');
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner().venueId, enabled: false }));
    expect(await at('autonomous')).toBe('off');
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, hub.hubModule, { venueId: diner().venueId, enabled: true }));
    expect(await at('autonomous')).toBe('autonomous');
  });

  it('an autonomous flow sends at the venue that allows it and only records at the venue held to shadow', async () => {
    const [cbd, other] = Object.values(group().venues);
    const flowId = await resetFlow(t, group(), 'welcome');
    await setMode(t, group(), 'welcome', 'autonomous');
    await setAgent(t, group(), cbd!.id, WELCOME, 'autonomous');
    await setAgent(t, group(), other!.id, WELCOME, 'shadow');
    const here = await newGuest(t, group(), { emailConsent: true, firstName: 'Cara', venueId: cbd!.id });
    const there = await newGuest(t, group(), { emailConsent: true, firstName: 'Otis', venueId: other!.id });
    await enrolDirect(t, group(), flowId, here.customerId, cbd!.id);
    await enrolDirect(t, group(), flowId, there.customerId, other!.id);

    const results = await run(group());
    await drainJobs(t.app);
    expect(results.find((r) => r.venueId === cbd!.id)).toMatchObject({ mode: 'autonomous', acted: 1 });
    expect(results.find((r) => r.venueId === other!.id)).toMatchObject({ mode: 'shadow', acted: 0 });
    // The flow put the CBD guest's message in the outbox. (The group fixture has no verified
    // marketing sender, so the outbox stops it there; that is comms' rule, not the flow's.)
    expect((await messagesFor(t, here.customerId, { flowId })).map((m) => [m.template_key, m.venue_id])).toEqual([['campaigns.welcome', cbd!.id]]);
    expect(sentTo(t, there.email)).toHaveLength(0);
    expect(await messagesFor(t, there.customerId, { flowId })).toHaveLength(0);
    const runs = await flowRuns(t, group(), WELCOME);
    expect(runs.find((r) => r.venue_id === other!.id)).toMatchObject({ mode: 'shadow', status: 'succeeded' });
    expect(runs.find((r) => r.venue_id === other!.id)!.summary).toContain('Nothing was sent.');

    // The console shows the level per venue.
    const owner = await group().as('owner');
    const flows = await t.app.tenant(group().orgId, owner, (ctx) => campaigns.listFlows(ctx));
    const welcome = flows.find((f) => f.key === 'welcome')!;
    expect(welcome).toMatchObject({ mode: 'autonomous', effectiveMode: 'autonomous' });
    expect(welcome.venueModes).toEqual(expect.arrayContaining([{ venueId: cbd!.id, mode: 'autonomous' }, { venueId: other!.id, mode: 'shadow' }]));

    // The venue switches the agent off: the flow does nothing there and records no run.
    await setAgent(t, group(), other!.id, WELCOME, 'off');
    const before = (await flowRuns(t, group(), WELCOME)).filter((r) => r.venue_id === other!.id).length;
    const off = await run(group());
    expect(off.find((r) => r.venueId === other!.id)).toMatchObject({ mode: 'off', acted: 0, runId: '' });
    expect((await flowRuns(t, group(), WELCOME)).filter((r) => r.venue_id === other!.id)).toHaveLength(before);
    expect(sentTo(t, there.email)).toHaveLength(0);
    await setMode(t, group(), 'welcome', 'shadow');
  });

  it('a batch approved before the venue turned its agent down is not sent', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    await setAgent(t, diner(), diner().venueId, WELCOME, 'supervised');
    await setMode(t, diner(), 'welcome', 'autonomous');
    const guest = await newGuest(t, diner(), { emailConsent: true, firstName: 'Bea' });
    await enrolDirect(t, diner(), flowId, guest.customerId);
    // The org says autonomous; the venue says supervised: a batch waits for a person.
    const [r] = await run();
    expect(r).toMatchObject({ mode: 'supervised', acted: 0 });
    const [batch] = await pendingBatches(t, diner(), flowId);
    expect(batch).toBeDefined();
    expect(sentTo(t, guest.email)).toHaveLength(0);

    const manager = await diner().as('manager');
    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, batch!.id, { decision: 'approved' }));
    // Before the worker gets to it, the venue turns the agent back to shadow.
    await setAgent(t, diner(), diner().venueId, WELCOME, 'shadow');
    await drainJobs(t.app);
    expect(sentTo(t, guest.email)).toHaveLength(0);
    expect(await messagesFor(t, guest.customerId, { flowId })).toHaveLength(0);

    // Raised again, the next run asks again and the approved batch goes.
    await setAgent(t, diner(), diner().venueId, WELCOME, 'supervised');
    await run();
    const [next] = await pendingBatches(t, diner(), flowId);
    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, next!.id, { decision: 'approved' }));
    await drainJobs(t.app);
    expect(sentTo(t, guest.email)).toHaveLength(1);
    await setMode(t, diner(), 'welcome', 'shadow');
    await setAgent(t, diner(), diner().venueId, WELCOME, 'autonomous');
  });
});
