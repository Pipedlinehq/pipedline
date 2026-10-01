import { describe, expect, it } from 'vitest';
import { drainJobs } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { approvals, campaigns, identity } from '@ros/modules';
import { type TestGuest, agentRuns, guestOf, messagesFor, newGuest, resetFlow, sentTo, setMode, smsTo, unique } from './helpers';

describe('campaigns: waves, daily caps and quiet hours', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;

  it('an autonomous flow sends at most a wave per run and at most its daily cap per venue-local day', async () => {
    const o = diner();
    const flowId = await resetFlow(t, o, 'welcome');
    const owner = await o.as('owner');
    await t.app.tenant(o.orgId, owner, (ctx) => campaigns.updateFlow(ctx, { flowKey: 'welcome', config: { waveSize: 3, dailyCap: 5 } }));
    await setMode(t, o, 'welcome', 'autonomous');
    const guests: TestGuest[] = [];
    for (let i = 0; i < 8; i++) guests.push(await newGuest(t, o, { emailConsent: true, firstName: `Wave${i}` }));
    t.clock.advanceMinutes(11);

    const queuedSoFar = async () => {
      let n = 0;
      for (const g of guests) n += (await messagesFor(t, g.customerId, { flowId })).length;
      return n;
    };
    const runOnce = async () => {
      t.clock.advanceMinutes(1);
      return campaigns.runFlows(t.app, o.orgId, { flowKey: 'welcome', trigger: 'test' });
    };

    await runOnce();
    expect(await queuedSoFar()).toBe(3);
    await runOnce();
    expect(await queuedSoFar()).toBe(5);
    await runOnce();
    expect(await queuedSoFar()).toBe(5);
    const last = (await agentRuns(t, o, 'flow_welcome'))[0]!;
    expect(last).toMatchObject({ mode: 'autonomous', status: 'succeeded' });
    expect(last.summary).toContain('Queued the Welcome email for 0 guests');
    expect((last.output as { dailyCapLeft: number }).dailyCapLeft).toBe(0);
    await drainJobs(t.app);
    expect(guests.filter((g) => sentTo(t, g.email).length === 1)).toHaveLength(5);

    // The next venue-local day, the rest go.
    t.clock.advanceDays(1);
    await runOnce();
    await drainJobs(t.app);
    expect(await queuedSoFar()).toBe(8);
    for (const g of guests) expect(sentTo(t, g.email)).toHaveLength(1);
  });

  it('a one-off campaign goes in waves an interval apart; the audience is recounted at send; an opt-out mid-send is honoured', async () => {
    const o = diner();
    const tag = unique('wave-campaign');
    const manager = await o.as('manager');
    await t.app.tenant(o.orgId, manager, (ctx) => campaigns.setCampaignsSettings(ctx, { campaignWaveSize: 10, waveIntervalMinutes: 60 }));
    const guests: TestGuest[] = [];
    for (let i = 0; i < 12; i++) guests.push(await newGuest(t, o, { emailConsent: true, tag, firstName: `Camp${i}` }));
    const silent = await newGuest(t, o, { tag });
    const segment = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: `Wave test ${tag}`, definition: { field: 'acquisition_campaign', in: [tag] } }));
    const c = await t.app.tenant(o.orgId, manager, (ctx) =>
      campaigns.draftCampaign(ctx, { venueId: o.venueId, name: 'Waves', channel: 'email', segmentId: segment.id, subject: 'Hello {{first_name}}', body: 'Hi {{first_name}}, a new menu.' }),
    );
    expect(c.audienceCount).toBe(12);
    // One more guest joins between draft and send: the send counts them.
    guests.push(await newGuest(t, o, { emailConsent: true, tag, firstName: 'Late' }));
    const { approval } = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }));
    expect(approval.summary).toContain('in 2 waves of up to 10, 60 minutes apart');
    await t.app.tenant(o.orgId, manager, (ctx) => approvals.decideApproval(ctx, approval.id, { decision: 'approved' }));
    await drainJobs(t.app);

    let row = await t.db.selectFrom('campaigns').select(['status', 'audience_count', 'stats']).where('id', '=', c.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sending', audience_count: 13 });
    const wave1 = guests.filter((g) => sentTo(t, g.email).length === 1);
    expect(wave1).toHaveLength(10);
    expect(sentTo(t, wave1[0]!.email)[0]!.subject).toBe(`Hello ${wave1[0]!.firstName}`);

    // A guest still waiting for the second wave opts out.
    const waiting = guests.filter((g) => !wave1.includes(g));
    await t.app.tenant(o.orgId, guestOf(waiting[0]!.customerId), (ctx) => identity.revokeConsent(ctx, { customerId: waiting[0]!.customerId, purpose: 'marketing_email', source: 'guest_account' }));
    t.clock.advanceMinutes(59);
    await drainJobs(t.app);
    expect(guests.filter((g) => sentTo(t, g.email).length === 1)).toHaveLength(10);
    t.clock.advanceMinutes(2);
    await drainJobs(t.app);
    row = await t.db.selectFrom('campaigns').select(['status', 'audience_count', 'stats', 'sent_at']).where('id', '=', c.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sent', stats: { queued: 12, suppressed: 0, waves: 2 } });
    for (const g of guests) expect(sentTo(t, g.email)).toHaveLength(g === waiting[0] ? 0 : 1);
    expect(await messagesFor(t, silent.customerId)).toHaveLength(0);
    expect(await messagesFor(t, waiting[0]!.customerId)).toHaveLength(0);

    const results = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.getCampaignResults(ctx, { campaignId: c.id }));
    expect(results.messages).toMatchObject({ queued: 12, sent: 12 });
  });

  it('marketing SMS from a flow waits out the venue\'s quiet hours, end to end', async () => {
    const o = diner();
    const flowId = await resetFlow(t, o, 'welcome');
    const owner = await o.as('owner');
    await t.app.tenant(o.orgId, owner, (ctx) => campaigns.updateFlow(ctx, { flowKey: 'welcome', config: { channel: 'sms', welcomeDelayMinutes: 0, dailyCap: 300 } }));
    await setMode(t, o, 'welcome', 'autonomous');
    t.clock.set('2026-10-02T11:30:00Z'); // 21:30 in Sydney
    const g = await newGuest(t, o, { email: false, phone: true, smsConsent: true, firstName: 'Nora' });
    await campaigns.runFlows(t.app, o.orgId, { flowKey: 'welcome', trigger: 'test' });
    await drainJobs(t.app);
    expect(smsTo(t, g.phone)).toHaveLength(0);
    const [m] = await messagesFor(t, g.customerId, { flowId });
    expect(m).toMatchObject({ status: 'queued', channel: 'sms' });

    t.clock.set('2026-10-02T21:00:00Z'); // 07:00: still quiet
    await drainJobs(t.app);
    expect(smsTo(t, g.phone)).toHaveLength(0);
    t.clock.set('2026-10-02T23:05:00Z'); // 09:05
    await drainJobs(t.app);
    const sms = smsTo(t, g.phone);
    expect(sms).toHaveLength(1);
    expect(sms[0]!.body).toContain('thanks for joining us, Nora');
    expect(sms[0]!.body).toContain('Reply STOP to opt out.');
    expect(sms[0]!.from.smsSenderId).toBe('OAKDINER');
    expect((await t.db.selectFrom('messages').select('status').where('id', '=', m!.id).executeTakeFirstOrThrow()).status).toBe('sent');
  });
});
