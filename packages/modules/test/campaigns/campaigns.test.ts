import { describe, expect, it } from 'vitest';
import { type WriteTool, drainJobs, enqueue, getTool, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { approvals, campaigns, offers, website } from '@ros/modules';
import { type TestGuest, WORKER, agentFor, eventsNamed, guestOf, messagesFor, newGuest, record, sentTo, unique } from './helpers';

describe('campaigns: one-off campaigns', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;

  async function taggedSegment(org = diner(), n = 3, o: { consent?: boolean } = {}) {
    const tag = unique('camp');
    const guests: TestGuest[] = [];
    for (let i = 0; i < n; i++) guests.push(await newGuest(t, org, { emailConsent: o.consent ?? true, tag, firstName: `G${i}`, venueId: org.venueId }));
    const owner = await org.as('owner');
    const seg = await t.app.tenant(org.orgId, owner, (ctx) => campaigns.saveSegment(ctx, { name: `Seg ${tag}`, definition: { field: 'acquisition_campaign', in: [tag] } }));
    return { tag, guests, segmentId: seg.id };
  }

  async function draft(segmentId: string, org = diner(), over: Partial<Parameters<typeof campaigns.draftCampaign>[1]> = {}) {
    const manager = await org.as(org === diner() ? 'manager' : 'owner');
    return t.app.tenant(org.orgId, manager, (ctx) =>
      campaigns.draftCampaign(ctx, { venueId: org.venueId, name: 'Spring', channel: 'email', segmentId, subject: 'Spring, {{first_name}}', body: 'Hi {{first_name}}, the spring menu is on.', ...over }),
    );
  }

  it('a draft counts its audience, is audited, and sends nothing; front of house cannot draft', async () => {
    const { guests, segmentId } = await taggedSegment();
    await newGuest(t, diner(), { tag: undefined });
    const c = await draft(segmentId);
    expect(c).toMatchObject({ status: 'draft', audienceCount: 3, createdByKind: 'staff', segmentName: expect.stringContaining('Seg ') });
    expect((await eventsNamed(t, diner().orgId, 'campaign.drafted', { campaign_id: c.id }))[0]!.properties).toMatchObject({ by: 'staff', audience_count: 3 });
    expect(await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', c.id).execute()).toEqual([{ action: 'campaign.drafted' }]);
    await drainJobs(t.app);
    for (const g of guests) expect(await messagesFor(t, g.customerId)).toHaveLength(0);
    const host = await diner().as('host');
    await expect(t.app.tenant(diner().orgId, host, (ctx) => campaigns.draftCampaign(ctx, { venueId: diner().venueId, name: 'x', channel: 'email', segmentId, subject: 's', body: 'b' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(draft(segmentId, diner(), { subject: null })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('sending always needs a manager: rejected or lapsed goes back to draft and sends nothing; approved sends once', async () => {
    const { guests, segmentId } = await taggedSegment();
    const c = await draft(segmentId);
    const manager = await diner().as('manager');
    const submit = () => t.app.tenant(diner().orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }));

    let s = await submit();
    expect(s.campaign.status).toBe('pending_approval');
    expect(s.approval).toMatchObject({ kind: 'campaigns.campaign_send', venueId: diner().venueId, status: 'pending' });
    expect(s.approval.summary).toMatch(/^Send "Spring" by email from Oak Diner to the 3 guests in "Seg [^"]+" who have agreed to hear from you\. Anyone who opts out before their message goes is skipped\.$/);
    await expect(submit()).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.updateCampaign(ctx, { campaignId: c.id, body: 'changed' }))).rejects.toMatchObject({ code: 'conflict' });

    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, s.approval.id, { decision: 'rejected' }));
    await drainJobs(t.app);
    expect((await t.db.selectFrom('campaigns').select('status').where('id', '=', c.id).executeTakeFirstOrThrow()).status).toBe('draft');
    for (const g of guests) expect(await messagesFor(t, g.customerId)).toHaveLength(0);

    s = await submit();
    t.clock.advanceMinutes(49 * 60);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => approvals.expireApprovals(ctx));
    await drainJobs(t.app);
    expect((await t.db.selectFrom('campaigns').select('status').where('id', '=', c.id).executeTakeFirstOrThrow()).status).toBe('draft');
    for (const g of guests) expect(sentTo(t, g.email)).toHaveLength(0);

    s = await submit();
    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, s.approval.id, { decision: 'approved' }));
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, s.approval.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'conflict' });
    await drainJobs(t.app);
    // Replay the wave job and the wave itself: nobody gets a second message.
    await t.app.tenant(diner().orgId, WORKER, (ctx) => enqueue(ctx, campaigns.campaignSendJob, { campaignId: c.id, wave: 1 }, { key: 'replay' }));
    await drainJobs(t.app);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => campaigns.sendCampaignWave(ctx, c.id, 1));
    await drainJobs(t.app);
    for (const g of guests) {
      const mail = sentTo(t, g.email);
      expect(mail).toHaveLength(1);
      expect(mail[0]!.subject).toBe(`Spring, ${g.firstName}`);
      expect(mail[0]!.body).toContain(`Hi ${g.firstName}, the spring menu is on.`);
      expect(mail[0]!.body).toContain('Unsubscribe:');
      expect(await messagesFor(t, g.customerId, { campaignId: c.id })).toHaveLength(1);
    }
    const row = await t.db.selectFrom('campaigns').select(['status', 'approved_by_staff_id', 'sent_at']).where('id', '=', c.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'sent', approved_by_staff_id: diner().staff.manager!.staffId, sent_at: expect.any(Date) });
    expect(await eventsNamed(t, diner().orgId, 'campaign.sent', { campaign_id: c.id })).toHaveLength(1);
  });

  it('an assistant drafts through message_draft and nothing more: it can neither send for approval nor approve', async () => {
    const { guests, segmentId } = await taggedSegment();
    const seg = await t.db.selectFrom('segments').select('name').where('id', '=', segmentId).executeTakeFirstOrThrow();
    const manager = await diner().as('manager');
    const agent = agentFor(manager);
    const tool = getTool('message_draft') as WriteTool<any, any>;
    const input = tool.input.parse({ name: 'Assistant spring', segment: seg.name, channel: 'email', subject: 'Spring at Oak', body: 'Hi {{first_name}}, the spring menu starts Thursday.' });
    const before = await t.db.selectFrom('campaigns').select('id').where('org_id', '=', diner().orgId).execute();
    const proposal = await t.app.tenant(diner().orgId, agent, (ctx) => tool.propose({ ctx, venueId: diner().venueId }, input));
    expect(proposal.question).toBe(
      `Save a draft email campaign "Assistant spring" from Oak Diner to the "${seg.name}" segment (3 guests can receive it): an email with the subject "Spring at Oak" and the message "Hi {{first_name}}, the spring menu starts Thursday."? Nothing is sent; a manager approves the send in the console.`,
    );
    expect(await t.db.selectFrom('campaigns').select('id').where('org_id', '=', diner().orgId).execute()).toHaveLength(before.length);

    const out = await t.app.tenant(diner().orgId, agent, async (ctx) => (await tool.propose({ ctx, venueId: diner().venueId }, input)).commit());
    const shaped = tool.output.parse(out);
    expect(shaped).toEqual({ campaign_id: expect.any(String), status: 'draft', audience_count: 3, next_step: expect.any(String) });
    const row = await t.db.selectFrom('campaigns').select(['status', 'created_by_kind', 'created_by_id']).where('id', '=', shaped.campaign_id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'draft', created_by_kind: 'agent', created_by_id: agent.keyId });

    await expect(t.app.tenant(diner().orgId, agent, (ctx) => campaigns.submitCampaign(ctx, { campaignId: shaped.campaign_id }))).rejects.toMatchObject({ code: 'forbidden' });
    const s = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: shaped.campaign_id }));
    await expect(t.app.tenant(diner().orgId, agent, (ctx) => approvals.decideApproval(ctx, s.approval.id, { decision: 'approved' }))).rejects.toMatchObject({ code: 'invalid' });
    await drainJobs(t.app);
    expect((await t.db.selectFrom('approvals').select('status').where('id', '=', s.approval.id).executeTakeFirstOrThrow()).status).toBe('pending');
    for (const g of guests) expect(await messagesFor(t, g.customerId)).toHaveLength(0);
  });

  it('the model drafts copy from the tone of voice and the segment\'s name and size, and never sees an email, a phone or a card', async () => {
    const { segmentId } = await taggedSegment(diner(), 4);
    const owner = await diner().as('owner');
    await t.app.tenant(diner().orgId, owner, (ctx) => website.setBrand(ctx, { toneOfVoice: 'Warm and a little cheeky. Questions to our owner at jo.owner@oakdiner.example or 0412 345 678.' }));
    const guest = await t.db.selectFrom('customers').select(['primary_email', 'primary_phone']).where('org_id', '=', diner().orgId).where('primary_phone', 'is not', null).executeTakeFirstOrThrow();
    t.sim.llm.respond('campaigns.draft_copy', () => ({ subject: 'Spring is on', body: 'Hi {{first_name}}, asparagus season.', smsBody: 'Spring menu is on this week.' }));
    const manager = await diner().as('manager');
    const copy = await campaigns.draftCampaignCopy(t.app, {
      orgId: diner().orgId,
      principal: manager,
      input: { venueId: diner().venueId, segmentId, channel: 'email', brief: `Spring menu launch. Mention ${guest.primary_email} and call ${guest.primary_phone} for bookings.` },
    });
    expect(copy).toEqual({ subject: 'Spring is on', body: 'Hi {{first_name}}, asparagus season.', smsBody: 'Spring menu is on this week.' });

    const call = t.sim.llm.calls.filter((c) => c.purpose === 'campaigns.draft_copy').at(-1)!;
    const seen = `${call.system}\n${call.input}`;
    expect(call.orgId).toBe(diner().orgId);
    expect(seen).toContain('Warm and a little cheeky');
    expect(JSON.parse(call.input)).toMatchObject({ venue: 'Oak Diner', audience: { segment: expect.stringContaining('Seg '), guests: 4 }, channel: 'email' });
    expect(seen).not.toMatch(/@/);
    expect(seen).not.toContain('0412');
    const contacts = await t.db.selectFrom('customers').select(['primary_email', 'primary_phone']).where('org_id', '=', diner().orgId).execute();
    for (const c of contacts) {
      if (c.primary_email) expect(seen).not.toContain(c.primary_email);
      if (c.primary_phone) expect(seen).not.toContain(c.primary_phone);
    }
    const cards = await t.db.selectFrom('customer_identities').select('value').where('org_id', '=', diner().orgId).where('kind', 'in', ['card_fingerprint', 'card_par']).execute();
    for (const c of cards) expect(seen).not.toContain(c.value);
    expect(await t.db.selectFrom('audit_log').select('action').where('org_id', '=', diner().orgId).where('action', '=', 'campaign.copy_drafted').execute()).toHaveLength(1);

    // A reply of the wrong shape is refused, not saved.
    t.sim.llm.respond('campaigns.draft_copy', () => ({ subject: '', body: 'x' }));
    await expect(campaigns.draftCampaignCopy(t.app, { orgId: diner().orgId, principal: manager, input: { venueId: diner().venueId, segmentId, channel: 'sms', brief: 'Anything' } })).rejects.toThrow();
    // Front of house cannot ask for copy, and the model is not called for them.
    const n = t.sim.llm.calls.length;
    const host = await diner().as('host');
    await expect(campaigns.draftCampaignCopy(t.app, { orgId: diner().orgId, principal: host, input: { venueId: diner().venueId, segmentId, channel: 'sms', brief: 'Anything' } })).rejects.toMatchObject({ code: 'forbidden' });
    expect(t.sim.llm.calls.length).toBe(n);
  });

  it('a sale within the window after a campaign message is credited to it: touchpoint, last-touch attribution, results', async () => {
    const { guests, segmentId } = await taggedSegment(diner(), 3);
    const owner = await diner().as('owner');
    const comeback = (await t.app.tenant(diner().orgId, owner, (ctx) => offers.listOffers(ctx))).find((o) => o.kind === 'comeback')!;
    const c = await draft(segmentId, diner(), { offerId: comeback.id });
    const manager = await diner().as('manager');
    const s = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }));
    expect(s.approval.summary).toContain('each with their own code (15% off)');
    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, s.approval.id, { decision: 'approved' }));
    await drainJobs(t.app);
    const [a, b, late] = guests;
    const code = await t.db.selectFrom('offer_codes').select('code').where('customer_id', '=', a!.customerId).where('source', '=', `campaign:${c.id}`).executeTakeFirstOrThrow();
    expect(sentTo(t, a!.email)[0]!.body).toContain(`Your own code is ${code.code}: 15% off`);

    // Click-to-claim: the guest claims the code from the email, then uses it at the till.
    t.clock.advanceDays(1);
    await t.app.tenant(diner().orgId, guestOf(a!.customerId), (ctx) => offers.claimCode(ctx, { code: code.code }));
    t.clock.advanceDays(1);
    const withCode = await record(t, diner(), a!.customerId, { discountCents: 885, totalCents: 5015, discounts: [{ name: 'Spring', code: code.code, amountCents: 885 }] });
    t.clock.advanceDays(1);
    const plain = await record(t, diner(), b!.customerId);
    t.clock.advanceDays(6);
    const outside = await record(t, diner(), late!.customerId);

    for (const [g, txn] of [[a!, withCode], [b!, plain]] as const) {
      const touch = await t.db.selectFrom('customer_touchpoints').select(['channel', 'campaign_id']).where('customer_id', '=', g.customerId).where('campaign_id', '=', c.id).execute();
      expect(touch).toEqual([{ channel: 'campaign', campaign_id: c.id }]);
      const attr = await t.db.selectFrom('transaction_attributions').select(['model', 'campaign_id', 'channel']).where('transaction_id', '=', txn.transaction.id).where('model', '=', 'last_touch').execute();
      expect(attr).toEqual([{ model: 'last_touch', campaign_id: c.id, channel: 'campaign' }]);
    }
    expect(await t.db.selectFrom('customer_touchpoints').select('id').where('customer_id', '=', late!.customerId).where('campaign_id', '=', c.id).execute()).toHaveLength(0);
    expect(await t.db.selectFrom('transaction_attributions').select('id').where('transaction_id', '=', outside.transaction.id).where('model', '=', 'last_touch').execute()).toHaveLength(0);

    // A replayed sale adds no second touch.
    const replayed = await t.app.tenant(diner().orgId, WORKER, async (ctx) => {
      const { ledger } = await import('@ros/modules');
      const row = await ctx.db.selectFrom('transactions').select(['external_ref', 'occurred_at']).where('id', '=', plain.transaction.id).executeTakeFirstOrThrow();
      return ledger.recordTransaction(ctx, { ...(await import('./helpers')).sale(t, { externalRef: row.external_ref, occurredAt: row.occurred_at }) }, { venueId: diner().venueId, customerId: b!.customerId });
    });
    expect(replayed.created).toBe(false);
    expect(await t.db.selectFrom('customer_touchpoints').select('id').where('customer_id', '=', b!.customerId).where('campaign_id', '=', c.id).execute()).toHaveLength(1);

    const r = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.getCampaignResults(ctx, { campaignId: c.id }));
    expect(r).toMatchObject({ status: 'sent', audienceCount: 3, messages: { queued: 3, sent: 3 }, codes: { issued: 3, redeemed: 1 }, attributed: { orders: 2, guests: 2, revenueCents: 5015 + 5900 } });

    // The assistant's summary gives totals; guest-level sales stay hidden below the privacy floor.
    const tool = getTool('campaigns_summary')!;
    const built = await t.app.tenant(diner().orgId, agentFor(manager, { canWrite: false }), (ctx) => (tool as any).run({ ctx, venueId: diner().venueId }, tool.input.parse({})));
    const shaped = tool.output.parse(built) as { campaigns: Array<{ name: string; results: Record<string, unknown> }>; flows: Array<{ key: string; mode: string }> };
    const mine = shaped.campaigns.find((x) => x.results.codes_issued === 3 && x.results.codes_redeemed === 1)!;
    expect(mine.results).toMatchObject({ queued: 3, attributed_orders: null, attributed_revenue_cents: null });
    expect(shaped.flows.map((f) => f.key)).toEqual(['welcome', 'post_purchase', 'winback', 'vip', 'birthday']);
    expect(JSON.stringify(shaped)).not.toMatch(/@/);
  });

  it('another org\'s campaign, a venue without a role, and a venue with the module off are all not found', async () => {
    const { segmentId } = await taggedSegment();
    const c = await draft(segmentId);
    const gm = await group().as('manager');
    await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.getCampaign(ctx, c.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.cancelCampaign(ctx, { campaignId: c.id }))).rejects.toMatchObject({ code: 'not_found' });
    const groupSeg = (await t.db.selectFrom('segments').select('id').where('org_id', '=', group().orgId).executeTakeFirstOrThrow()).id;
    await expect(
      t.app.tenant(group().orgId, gm, (ctx) => campaigns.draftCampaign(ctx, { venueId: group().venues.bondi!.id, name: 'x', channel: 'email', segmentId: groupSeg, subject: 's', body: 'b' })),
    ).rejects.toMatchObject({ code: 'not_found' });
    // A segment id from another org is not found either.
    await expect(
      t.app.tenant(group().orgId, gm, (ctx) => campaigns.draftCampaign(ctx, { venueId: group().venues.cbd!.id, name: 'x', channel: 'email', segmentId, subject: 's', body: 'b' })),
    ).rejects.toMatchObject({ code: 'not_found' });

    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: diner().venueId, enabled: false }));
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.getCampaign(ctx, c.id))).rejects.toMatchObject({ code: 'module_disabled', status: 404 });
    await expect(draft(segmentId)).rejects.toMatchObject({ status: 404 });
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }))).rejects.toMatchObject({ status: 404 });
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: diner().venueId, enabled: true }));
    expect((await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.getCampaign(ctx, c.id))).status).toBe('draft');
  });

  it('the fixtures: module on, system segments, flows in shadow with runs, one sent campaign with events, one waiting for approval', async () => {
    for (const org of [diner(), group()]) {
      const on = await t.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', org.orgId).where('module_key', '=', 'campaigns').where('enabled', '=', true).execute();
      expect(on).toHaveLength(Object.keys(org.venues).length);
      expect((await t.db.selectFrom('segments').select('id').where('org_id', '=', org.orgId).where('is_system', '=', true).execute()).length).toBe(6);
      const runs = await t.db.selectFrom('agent_runs').select(['agent_key', 'mode', 'trigger']).where('org_id', '=', org.orgId).where('trigger', '=', 'fixture').execute();
      expect(runs.filter((r) => r.agent_key === 'flow_winback').length).toBe(3 * Object.keys(org.venues).length);
      expect(runs.every((r) => r.mode === 'shadow')).toBe(true);
    }
    const sent = await t.db.selectFrom('campaigns').select(['id', 'status', 'audience_count']).where('org_id', '=', diner().orgId).where('name', '=', 'Spring menu for our regulars').executeTakeFirstOrThrow();
    expect(sent.status).toBe('sent');
    const manager = await diner().as('manager');
    const r = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.getCampaignResults(ctx, { campaignId: sent.id }));
    expect(r.messages.sent).toBe(sent.audience_count);
    expect(r.messages.delivered).toBe(r.messages.sent);
    expect(r.messages.opened).toBeGreaterThan(0);
    expect(r.messages.clicked).toBeGreaterThan(0);
    expect(r.codes.issued).toBeGreaterThan(0);
    const pending = await t.db.selectFrom('approvals').select(['kind', 'venue_id', 'status']).where('org_id', '=', group().orgId).where('kind', '=', 'campaigns.campaign_send').execute();
    expect(pending).toEqual([{ kind: 'campaigns.campaign_send', venue_id: group().venues.cbd!.id, status: 'pending' }]);
  });
});
