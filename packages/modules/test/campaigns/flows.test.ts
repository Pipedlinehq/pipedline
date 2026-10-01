import { describe, expect, it } from 'vitest';
import { drainJobs, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { approvals, campaigns, identity } from '@ros/modules';
import { WORKER, agentFor, agentRuns, enrolDirect, enrolment, eventsNamed, guestOf, messagesFor, newGuest, pendingBatches, record, resetFlow, sentTo, setMode } from './helpers';

describe('campaigns: lifecycle flows', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  // Each run a minute after the last, so runs are ordered in time.
  const run = (org = diner(), flowKey: campaigns.FlowKey = 'welcome') => {
    t.clock.advanceMinutes(1);
    return campaigns.runFlows(t.app, org.orgId, { flowKey, trigger: 'test' });
  };
  const decide = async (approvalId: string, decision: 'approved' | 'rejected', org = diner(), who: 'manager' | 'owner' = 'manager') => {
    const p = await org.as(who);
    return t.app.tenant(org.orgId, p, (ctx) => approvals.decideApproval(ctx, approvalId, { decision }));
  };

  it('every flow starts in shadow, pinned to its first template version, with its ceiling shown', async () => {
    const manager = await diner().as('manager');
    const flows = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.listFlows(ctx));
    expect(flows.map((f) => [f.key, f.mode, f.templateVersion])).toEqual([
      ['welcome', 'shadow', '1.0.0'],
      ['post_purchase', 'shadow', '1.0.0'],
      ['winback', 'shadow', '1.0.0'],
      ['vip', 'shadow', '1.0.0'],
      ['birthday', 'shadow', '1.0.0'],
    ]);
    expect(flows.find((f) => f.key === 'welcome')!.ceiling).toBe('autonomous');
    // The seeded win-back carries an offer, so it can go no higher than supervised.
    expect(flows.find((f) => f.key === 'winback')!.ceiling).toBe('supervised');
    expect(flows.find((f) => f.key === 'winback')!.lastRun?.mode).toBe('shadow');
  });

  it('only an owner raises a flow, never past its ceiling; an assistant never lets one send', async () => {
    const manager = await diner().as('manager');
    const owner = await diner().as('owner');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'welcome', mode: 'supervised' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner().orgId, owner, (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'winback', mode: 'autonomous' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.app.tenant(diner().orgId, owner, (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'vip', mode: 'autonomous' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.app.tenant(diner().orgId, agentFor(owner), (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'welcome', mode: 'supervised' }))).rejects.toMatchObject({ code: 'forbidden' });
    // A manager may always turn one down.
    await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.setFlowMode(ctx, { flowKey: 'birthday', mode: 'shadow' }));
    const audited = await t.db.selectFrom('audit_log').select('action').where('org_id', '=', diner().orgId).where('action', '=', 'flow.mode_set').execute();
    expect(audited.length).toBeGreaterThanOrEqual(1);
    expect((await t.db.selectFrom('flows').select('mode').where('org_id', '=', diner().orgId).where('key', '=', 'winback').executeTakeFirstOrThrow()).mode).toBe('shadow');
  });

  it('a guest without consent, or whose address is suppressed, is never messaged in any mode', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    const ok = await newGuest(t, diner(), { emailConsent: true, firstName: 'Olive' });
    const noConsent = await newGuest(t, diner(), { firstName: 'Nina' });
    const suppressed = await newGuest(t, diner(), { emailConsent: true, firstName: 'Sam' });
    const manager = await diner().as('manager');
    await t.app.tenant(diner().orgId, manager, (ctx) => import('@ros/modules').then(({ comms }) => comms.addManualSuppression(ctx, 'email', suppressed.email!)));

    for (const mode of ['shadow', 'supervised', 'autonomous'] as const) {
      await setMode(t, diner(), 'welcome', mode);
      for (const g of [ok, noConsent, suppressed]) await enrolDirect(t, diner(), flowId, g.customerId);
      await run();
      if (mode === 'supervised') {
        const [batch] = await pendingBatches(t, diner(), flowId);
        const entries = (batch!.payload as unknown as campaigns.FlowBatchPayload).entries.map((e) => e.id);
        expect(entries).toEqual([(await enrolment(t, flowId, ok.customerId))!.id]);
        await decide(batch!.id, 'approved');
      }
      await drainJobs(t.app);
      for (const g of [noConsent, suppressed]) {
        expect(sentTo(t, g.email)).toHaveLength(0);
        expect(await messagesFor(t, g.customerId, { flowId })).toHaveLength(0);
        const e = await enrolment(t, flowId, g.customerId);
        expect(e).toMatchObject({ status: 'exited', context: { exit: 'no_consent' } });
      }
    }
    // The consenting guest got exactly one welcome, however many modes and runs it went through.
    expect(sentTo(t, ok.email)).toHaveLength(1);
    expect(sentTo(t, ok.email)[0]!.body).toContain('Hi Olive');
    await setMode(t, diner(), 'welcome', 'shadow');
  });

  it('shadow sends nothing and records who would get what, with first names only', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    await setMode(t, diner(), 'welcome', 'shadow');
    const g = await newGuest(t, diner(), { emailConsent: true, firstName: 'Zelda' });
    expect(await enrolment(t, flowId, g.customerId)).toMatchObject({ status: 'active', step: 0 });
    t.clock.advanceMinutes(11);
    const [r] = await run();
    await drainJobs(t.app);

    expect(await messagesFor(t, g.customerId)).toHaveLength(0);
    expect(sentTo(t, g.email)).toHaveLength(0);
    expect(await enrolment(t, flowId, g.customerId)).toMatchObject({ status: 'active', step: 0 });
    const [latest] = await agentRuns(t, diner(), 'flow_welcome');
    expect(latest).toMatchObject({ id: r!.runId, mode: 'shadow', status: 'succeeded', template_version: '1.0.0', venue_id: diner().venueId });
    expect(latest!.summary).toMatch(/^Shadow: would send the Welcome email to 1 guest at Oak Diner\. Nothing was sent\.$/);
    const out = latest!.output as { wouldSend: number; sample: Array<{ firstName: string; subject: string; body: string }> };
    expect(out.wouldSend).toBe(1);
    expect(out.sample).toEqual([expect.objectContaining({ firstName: 'Zelda', subject: 'Welcome to Oak Diner' })]);
    expect(out.sample[0]!.body).toContain('Hi Zelda');
    const text = JSON.stringify(latest);
    expect(text).not.toContain(g.email!);
    expect(text).not.toContain('Tester');
    expect(text).not.toContain('@');
  });

  it('supervised: one approval per batch; nothing until approved; exactly once when approved, however often it is replayed', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    await setMode(t, diner(), 'welcome', 'supervised');
    const a = await newGuest(t, diner(), { emailConsent: true, firstName: 'Ada' });
    const b = await newGuest(t, diner(), { emailConsent: true, firstName: 'Bea' });
    t.clock.advanceMinutes(11);
    await run();
    await drainJobs(t.app);
    let batches = await pendingBatches(t, diner(), flowId);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.venue_id).toBe(diner().venueId);
    expect(batches[0]!.summary).toBe('Send the Welcome email to 2 guests of Oak Diner. Nothing goes until you approve; anyone who opts out before it goes is skipped.');
    expect(sentTo(t, a.email)).toHaveLength(0);
    expect(await messagesFor(t, a.customerId)).toHaveLength(0);

    // The next run does not ask again while that batch waits.
    await run();
    batches = await pendingBatches(t, diner(), flowId);
    expect(batches).toHaveLength(1);
    expect((await agentRuns(t, diner(), 'flow_welcome'))[0]).toMatchObject({ mode: 'supervised', status: 'skipped' });

    await decide(batches[0]!.id, 'approved');
    await drainJobs(t.app);
    for (const g of [a, b]) {
      expect(sentTo(t, g.email)).toHaveLength(1);
      const msgs = await messagesFor(t, g.customerId, { flowId });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]).toMatchObject({ status: 'sent', template_key: 'campaigns.welcome', venue_id: diner().venueId });
      expect(await enrolment(t, flowId, g.customerId)).toMatchObject({ status: 'completed' });
    }
    expect(sentTo(t, a.email)[0]!.body).toContain('Hi Ada');

    // Approving twice, replaying the send, and re-queuing the job all send nothing more.
    await expect(decide(batches[0]!.id, 'approved')).rejects.toMatchObject({ code: 'conflict' });
    const replay = await t.app.tenant(diner().orgId, WORKER, (ctx) => campaigns.sendFlowBatch(ctx, batches[0]!.id));
    expect(replay).toEqual({ queued: 0, suppressed: 0, skipped: 2 });
    await t.app.tenant(diner().orgId, WORKER, (ctx) => import('@ros/core').then(({ enqueue }) => enqueue(ctx, campaigns.flowBatchSendJob, { approvalId: batches[0]!.id }, { key: `${batches[0]!.id}:again` })));
    await drainJobs(t.app);
    await run();
    await drainJobs(t.app);
    expect(sentTo(t, a.email)).toHaveLength(1);
    expect(sentTo(t, b.email)).toHaveLength(1);
    const steps = await eventsNamed(t, diner().orgId, 'flow.step_queued', { flow_id: flowId, mode: 'supervised' });
    expect(steps.filter((e) => e.customer_id === a.customerId || e.customer_id === b.customerId)).toHaveLength(2);
  });

  it('supervised: a rejected batch sends nothing and its guests wait for the next batch; an expired one likewise', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    await setMode(t, diner(), 'welcome', 'supervised');
    const e = await newGuest(t, diner(), { emailConsent: true });
    t.clock.advanceMinutes(11);
    await run();
    const [first] = await pendingBatches(t, diner(), flowId);
    await decide(first!.id, 'rejected');
    await drainJobs(t.app);
    expect(sentTo(t, e.email)).toHaveLength(0);
    expect(await messagesFor(t, e.customerId)).toHaveLength(0);
    expect(await enrolment(t, flowId, e.customerId)).toMatchObject({ status: 'active', step: 0 });

    await run();
    const [second] = await pendingBatches(t, diner(), flowId);
    expect(second!.id).not.toBe(first!.id);
    expect((second!.payload as unknown as campaigns.FlowBatchPayload).count).toBe(1);

    // Nobody decides for two days: the batch lapses, and nothing goes.
    t.clock.advanceMinutes(49 * 60);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => approvals.expireApprovals(ctx));
    expect((await t.db.selectFrom('approvals').select('status').where('id', '=', second!.id).executeTakeFirstOrThrow()).status).toBe('expired');
    await expect(decide(second!.id, 'approved')).rejects.toMatchObject({ code: 'conflict' });
    await drainJobs(t.app);
    expect(sentTo(t, e.email)).toHaveLength(0);
    expect(await enrolment(t, flowId, e.customerId)).toMatchObject({ status: 'active' });
  });

  it('an opt-out between approval and send is honoured, and ends every flow for that guest', async () => {
    const flowId = await resetFlow(t, diner(), 'welcome');
    await setMode(t, diner(), 'welcome', 'supervised');
    const g = await newGuest(t, diner(), { emailConsent: true });
    const vipFlow = (await t.db.selectFrom('flows').select('id').where('org_id', '=', diner().orgId).where('key', '=', 'vip').executeTakeFirstOrThrow()).id;
    await enrolDirect(t, diner(), vipFlow, g.customerId);
    t.clock.advanceMinutes(11);
    await run();
    const [batch] = await pendingBatches(t, diner(), flowId);
    await decide(batch!.id, 'approved');
    // The guest unsubscribes before the worker gets to the batch.
    await t.app.tenant(diner().orgId, guestOf(g.customerId), (ctx) => identity.revokeConsent(ctx, { customerId: g.customerId, purpose: 'marketing_email', source: 'guest_account' }));
    await drainJobs(t.app);
    expect(sentTo(t, g.email)).toHaveLength(0);
    expect(await messagesFor(t, g.customerId)).toHaveLength(0);
    expect(await enrolment(t, flowId, g.customerId)).toMatchObject({ status: 'exited', context: { exit: 'unsubscribed' } });
    expect(await enrolment(t, vipFlow, g.customerId)).toMatchObject({ status: 'exited', context: { exit: 'unsubscribed' } });
    expect((await eventsNamed(t, diner().orgId, 'flow.exited', { reason: 'unsubscribed' })).filter((e) => e.customer_id === g.customerId)).toHaveLength(2);
  });

  it('win-back finds lapsed guests and a purchase ends it for them', async () => {
    const flowId = await resetFlow(t, diner(), 'winback');
    await setMode(t, diner(), 'winback', 'shadow');
    const h = await newGuest(t, diner(), { emailConsent: true, firstName: 'Hugo' });
    await record(t, diner(), h.customerId, { occurredAt: new Date(t.clock().getTime() - 70 * 86_400_000) });
    const recent = await newGuest(t, diner(), { emailConsent: true });
    await record(t, diner(), recent.customerId, { occurredAt: new Date(t.clock().getTime() - 20 * 86_400_000) });

    await run(diner(), 'winback');
    expect(await enrolment(t, flowId, h.customerId)).toMatchObject({ status: 'active', step: 0, venue_id: diner().venueId });
    expect(await enrolment(t, flowId, recent.customerId)).toBeUndefined();

    await record(t, diner(), h.customerId);
    expect(await enrolment(t, flowId, h.customerId)).toMatchObject({ status: 'exited', context: { exit: 'purchase' } });
    expect((await eventsNamed(t, diner().orgId, 'flow.exited', { flow_id: flowId, reason: 'purchase' })).filter((e) => e.customer_id === h.customerId)).toHaveLength(1);

    // Supervised now: the batch leaves Hugo out, and the run does not enrol him again.
    await setMode(t, diner(), 'winback', 'supervised');
    await run(diner(), 'winback');
    const hId = (await enrolment(t, flowId, h.customerId))!.id;
    for (const b of await pendingBatches(t, diner(), flowId)) expect((b.payload as unknown as campaigns.FlowBatchPayload).entries.map((e) => e.id)).not.toContain(hId);
    expect(await enrolment(t, flowId, h.customerId)).toMatchObject({ status: 'exited' });
  });

  it('the template version is pinned per org: 1.0.0 sends once, 1.1.0 adds a reminder a week later with the same code', async () => {
    const flowId = await resetFlow(t, diner(), 'winback');
    await setMode(t, diner(), 'winback', 'supervised');
    const owner = await diner().as('owner');

    const p = await newGuest(t, diner(), { emailConsent: true, firstName: 'Pia' });
    await enrolDirect(t, diner(), flowId, p.customerId);
    await run(diner(), 'winback');
    let [batch] = await pendingBatches(t, diner(), flowId);
    expect((batch!.payload as unknown as campaigns.FlowBatchPayload).templateVersion).toBe('1.0.0');
    await decide(batch!.id, 'approved');
    await drainJobs(t.app);
    expect(await enrolment(t, flowId, p.customerId)).toMatchObject({ status: 'completed' });
    const code = await t.db.selectFrom('offer_codes').select('code').where('customer_id', '=', p.customerId).where('source', '=', 'flow:winback').executeTakeFirstOrThrow();
    const pMail = sentTo(t, p.email);
    expect(pMail).toHaveLength(1);
    expect(pMail[0]!.subject).toBe('We have missed you, Pia');
    expect(pMail[0]!.body).toContain(`Your own code is ${code.code}: 15% off`);
    expect((await agentRuns(t, diner(), 'flow_winback'))[0]!.template_version).toBe('1.0.0');

    await t.app.tenant(diner().orgId, owner, (ctx) => campaigns.pinFlowTemplate(ctx, { flowKey: 'winback', version: '1.1.0' }));
    await expect(t.app.tenant(diner().orgId, owner, (ctx) => campaigns.pinFlowTemplate(ctx, { flowKey: 'winback', version: '9.9.9' }))).rejects.toMatchObject({ code: 'invalid' });
    const q = await newGuest(t, diner(), { emailConsent: true, firstName: 'Quinn' });
    await enrolDirect(t, diner(), flowId, q.customerId);
    await run(diner(), 'winback');
    [batch] = await pendingBatches(t, diner(), flowId);
    expect((batch!.payload as unknown as campaigns.FlowBatchPayload).templateVersion).toBe('1.1.0');
    await decide(batch!.id, 'approved');
    await drainJobs(t.app);
    const after = await enrolment(t, flowId, q.customerId);
    expect(after).toMatchObject({ status: 'active', step: 1 });
    expect(after!.next_at!.getTime()).toBe(t.clock().getTime() + 7 * 86_400_000);
    expect((await agentRuns(t, diner(), 'flow_winback'))[0]!.template_version).toBe('1.1.0');

    t.clock.advanceDays(7);
    await run(diner(), 'winback');
    [batch] = await pendingBatches(t, diner(), flowId);
    // A week on, more fixture guests have crossed 60 days; Quinn's reminder is in the batch with them.
    expect((batch!.payload as unknown as campaigns.FlowBatchPayload).entries).toContainEqual({ id: after!.id, step: 1, cycle: 1 });
    await decide(batch!.id, 'approved');
    await drainJobs(t.app);
    const qMail = sentTo(t, q.email);
    expect(qMail.map((m) => m.subject)).toEqual(['We have missed you, Quinn', 'Still thinking about it, Quinn?']);
    const qCode = await t.db.selectFrom('offer_codes').select('code').where('customer_id', '=', q.customerId).where('source', '=', 'flow:winback').execute();
    expect(qCode).toHaveLength(1);
    expect(qMail[1]!.body).toContain(qCode[0]!.code);
    expect(await enrolment(t, flowId, q.customerId)).toMatchObject({ status: 'completed' });
    // Pia, pinned before the change, got one message and no reminder.
    expect(sentTo(t, p.email)).toHaveLength(1);
  });

  it('at a group, a batch belongs to its venue: a manager with no role there cannot see or approve it; an assistant never can', async () => {
    const o = group();
    const flowId = await resetFlow(t, o, 'welcome');
    await setMode(t, o, 'welcome', 'supervised');
    const bondi = await newGuest(t, o, { emailConsent: true, venueId: o.venues.bondi!.id });
    const cbd = await newGuest(t, o, { emailConsent: true, venueId: o.venues.cbd!.id });
    t.clock.advanceMinutes(11);
    await run(o);
    const batches = await pendingBatches(t, o, flowId);
    const atBondi = batches.find((b) => b.venue_id === o.venues.bondi!.id)!;
    const atCbd = batches.find((b) => b.venue_id === o.venues.cbd!.id)!;
    expect((atBondi.payload as unknown as campaigns.FlowBatchPayload).entries.map((e) => e.id)).toEqual([(await enrolment(t, flowId, bondi.customerId))!.id]);
    expect((atCbd.payload as unknown as campaigns.FlowBatchPayload).entries.map((e) => e.id)).toEqual([(await enrolment(t, flowId, cbd.customerId))!.id]);

    const manager = await o.as('manager');
    await expect(t.app.tenant(o.orgId, manager, (ctx) => approvals.decideApproval(ctx, atBondi.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'not_found' });
    const visible = await t.app.tenant(o.orgId, manager, (ctx) => approvals.listApprovals(ctx, { status: 'pending' }));
    expect(visible.map((a) => a.id)).not.toContain(atBondi.id);
    expect(visible.map((a) => a.id)).toContain(atCbd.id);
    const owner = await o.as('owner');
    await expect(t.app.tenant(o.orgId, agentFor(owner), (ctx) => approvals.decideApproval(ctx, atBondi.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'invalid' });
    expect((await t.db.selectFrom('approvals').select('status').where('id', '=', atBondi.id).executeTakeFirstOrThrow()).status).toBe('pending');
    // Another org's manager cannot reach it either.
    const dinerManager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, dinerManager, (ctx) => approvals.decideApproval(ctx, atBondi.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'not_found' });

    await t.app.tenant(o.orgId, manager, (ctx) => approvals.decideApproval(ctx, atCbd.id, { decision: 'approved' }));
    await t.app.tenant(o.orgId, owner, (ctx) => approvals.decideApproval(ctx, atBondi.id, { decision: 'approved' }));
    await drainJobs(t.app);
    // Queued once each, at their own venue. (The group has no verified marketing domain, so comms fails them closed.)
    for (const [g, v] of [[bondi, o.venues.bondi!.id], [cbd, o.venues.cbd!.id]] as const) {
      const m = await messagesFor(t, g.customerId, { flowId });
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({ venue_id: v, status: 'failed', error: 'no_verified_sending_identity' });
    }
    await setMode(t, o, 'welcome', 'shadow');
  });

  it('a first purchase enrols post-purchase for day 21 and the VIP threshold enrols VIP; merge and erase follow the guest', async () => {
    const post = await resetFlow(t, diner(), 'post_purchase');
    const vip = await resetFlow(t, diner(), 'vip');
    const owner = await diner().as('owner');
    await t.app.tenant(diner().orgId, owner, (ctx) => campaigns.updateFlow(ctx, { flowKey: 'vip', config: { vipOrders: 3 } }));
    const a = await newGuest(t, diner(), { emailConsent: true });
    const noConsent = await newGuest(t, diner());
    await record(t, diner(), a.customerId);
    await record(t, diner(), noConsent.customerId);
    const e = await enrolment(t, post, a.customerId);
    expect(e).toMatchObject({ status: 'active', step: 0 });
    expect(e!.next_at!.getTime()).toBe(t.clock().getTime() + 21 * 86_400_000);
    expect(await enrolment(t, post, noConsent.customerId)).toBeUndefined();
    await record(t, diner(), a.customerId);
    // The second visit ends post-purchase: it did its job.
    expect(await enrolment(t, post, a.customerId)).toMatchObject({ status: 'exited', context: { exit: 'purchase' } });
    expect(await enrolment(t, vip, a.customerId)).toBeUndefined();
    await record(t, diner(), a.customerId);
    expect(await enrolment(t, vip, a.customerId)).toMatchObject({ status: 'active' });

    // Merge: the winner keeps the enrolments; where both were in a flow, the winner's stands.
    const b = await newGuest(t, diner(), { emailConsent: true });
    const welcome = (await t.db.selectFrom('flows').select('id').where('org_id', '=', diner().orgId).where('key', '=', 'welcome').executeTakeFirstOrThrow()).id;
    expect(await enrolment(t, welcome, a.customerId)).toBeTruthy();
    expect(await enrolment(t, welcome, b.customerId)).toBeTruthy();
    const winnerWelcome = (await enrolment(t, welcome, a.customerId))!.id;
    await enrolDirect(t, diner(), (await t.db.selectFrom('flows').select('id').where('org_id', '=', diner().orgId).where('key', '=', 'birthday').executeTakeFirstOrThrow()).id, b.customerId);
    await t.app.tenant(diner().orgId, owner, (ctx) => identity.mergeCustomers(ctx, { winnerId: a.customerId, loserId: b.customerId, reason: 'test' }));
    expect(await t.db.selectFrom('flow_enrollments').select('id').where('customer_id', '=', b.customerId).execute()).toHaveLength(0);
    const mine = await t.db.selectFrom('flow_enrollments as e').innerJoin('flows as f', 'f.id', 'e.flow_id').select(['f.key', 'e.id']).where('e.customer_id', '=', a.customerId).execute();
    expect(mine.map((m) => m.key).sort()).toEqual(['birthday', 'post_purchase', 'vip', 'welcome']);
    expect(mine.find((m) => m.key === 'welcome')!.id).toBe(winnerWelcome);

    const exported = await t.app.tenant(diner().orgId, owner, (ctx) => identity.exportCustomer(ctx, a.customerId));
    expect((exported.campaigns as unknown[]).length).toBe(4);
    await t.app.tenant(diner().orgId, owner, (ctx) => identity.eraseCustomer(ctx, a.customerId));
    expect(await t.db.selectFrom('flow_enrollments').select('id').where('customer_id', '=', a.customerId).execute()).toHaveLength(0);
  });

  it('with the module off, flows are not found and a run does nothing there', async () => {
    const o = diner();
    const flowId = await resetFlow(t, o, 'welcome');
    await setMode(t, o, 'welcome', 'autonomous');
    const g = await newGuest(t, o, { emailConsent: true });
    await enrolDirect(t, o, flowId, g.customerId);
    await t.app.tenant(o.orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: o.venueId, enabled: false }));
    const manager = await o.as('manager');
    await expect(t.app.tenant(o.orgId, manager, (ctx) => campaigns.listFlows(ctx))).rejects.toMatchObject({ code: 'module_disabled', status: 404 });
    expect(await run()).toEqual([]);
    await drainJobs(t.app);
    expect(await messagesFor(t, g.customerId)).toHaveLength(0);
    await t.app.tenant(o.orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: o.venueId, enabled: true }));
    await run();
    await drainJobs(t.app);
    expect(sentTo(t, g.email)).toHaveLength(1);
    await setMode(t, o, 'welcome', 'shadow');
  });
});
