import { type App, type CanonicalTransaction, type Principal, setModule, taxIncluded } from '@ros/core';
import type { SimMessageAdapter } from '@ros/adapters';
import { SIM_WEBHOOK_SECRET } from '@ros/adapters';
import { analytics, approvals, campaigns, comms, hub, ledger, offers } from '@ros/modules';
import type { SeedOptions } from '../base';
import type { ModuleSeeder } from '../index';
import type { Fixture, FixtureOrg } from '../load';
import { createRng } from '../rng';

/**
 * Campaigns for the fixture orgs (docs/MODULES.md contract item 5).
 *
 *   - the module on at every fixture venue; the system segments; the five lifecycle flows in
 *     shadow, the win-back carrying the comeback offer, with three recorded shadow runs each
 *   - oak-diner: a verified marketing identity (email and SMS), and one campaign to its
 *     regulars sent ten days ago, with delivery, open, click and unsubscribe events from the
 *     provider and a few guests who came back with their code
 *   - oak-group: a campaign at the CBD venue waiting for a manager's approval
 *
 * Everything goes through the modules' own functions. The sent campaign's messages are handed
 * to the outbox's own send job by hand, so nothing else queued in the template is sent.
 */

const WORKER: Principal = { kind: 'worker', job: 'fixtures' };
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function switchOn(app: App, org: FixtureOrg): Promise<void> {
  await app.tenant(org.orgId, WORKER, async (ctx) => {
    for (const v of Object.values(org.venues)) await setModule(ctx, campaigns.campaignsModule, { venueId: v.id, enabled: true });
    // A flow runs at a venue only as far as that venue's assistant settings allow its agent
    // (campaigns.effectiveModeAt). The fixture venues switch every flow agent on up to its own
    // ceiling, so the org's flow mode alone decides, as it did before the venue setting was read.
    const flowAgents = Object.values(campaigns.FLOW_AGENTS);
    for (const v of Object.values(org.venues)) {
      await setModule(ctx, hub.hubModule, {
        venueId: v.id,
        enabled: true,
        config: { hosted_agents: flowAgents.map((a) => a.key), autonomy_level_per_agent: Object.fromEntries(flowAgents.map((a) => [a.key, a.ceiling])) },
      });
    }
    await campaigns.ensureSystemSegments(ctx);
    await campaigns.ensureFlows(ctx);
    // The segments read the analytics customer snapshot; make it current before counting anyone.
    await analytics.snapshotCustomers(ctx);
  });
  const owner = await org.as('owner');
  await app.tenant(org.orgId, owner, async (ctx) => {
    const comeback = (await offers.listOffers(ctx)).find((o) => o.kind === 'comeback');
    if (comeback) await campaigns.updateFlow(ctx, { flowKey: 'winback', offerId: comeback.id });
  });
}

async function shadowRuns(app: App, org: FixtureOrg, opts: SeedOptions): Promise<void> {
  for (const daysAgo of [2, 1, 0]) {
    opts.setNow(new Date(opts.now.getTime() - daysAgo * DAY - 3 * HOUR));
    await campaigns.runFlows(app, org.orgId, { trigger: 'fixture' });
  }
  opts.setNow(opts.now);
}

async function sentCampaign(app: App, org: FixtureOrg, opts: SeedOptions): Promise<void> {
  const rng = createRng(3501);
  const owner = await org.as('owner');
  const manager = await org.as('manager');
  const venueId = org.venueId;

  // The venue's own marketing identity, verified by the provider during onboarding.
  const email = await app.tenant(org.orgId, owner, (ctx) => comms.addSendingIdentity(ctx, { channel: 'email', domain: `mail.${org.slug}.example`, fromName: 'Oak Diner' }, { key: 'sim-email' }));
  const sms = await app.tenant(org.orgId, owner, (ctx) => comms.addSendingIdentity(ctx, { channel: 'sms', smsSenderId: 'OAKDINER' }, { key: 'sim-sms' }));
  await app.tenant(org.orgId, WORKER, async (ctx) => {
    await comms.setSendingIdentityStatus(ctx, email.id, 'verified');
    await comms.setSendingIdentityStatus(ctx, sms.id, 'verified');
  });

  const sentAt = new Date(opts.now.getTime() - 10 * DAY);
  opts.setNow(sentAt);
  const { campaignId, approvalId } = await app.tenant(org.orgId, manager, async (ctx) => {
    const segments = await campaigns.listSegments(ctx);
    const regulars = segments.find((s) => s.name === 'Regulars')!;
    const comeback = (await offers.listOffers(ctx)).find((o) => o.kind === 'comeback');
    const c = await campaigns.draftCampaign(ctx, {
      venueId,
      name: 'Spring menu for our regulars',
      channel: 'email',
      segmentId: regulars.id,
      subject: 'The spring menu is here, {{first_name}}',
      body: `Hi {{first_name}},\n\nThe spring menu starts this week: asparagus from Cowra, the first soft-shell crab, and the lamb shoulder is back.\n\nYou have been in often enough that we wanted you to hear first.`,
      offerId: comeback?.id ?? null,
    });
    const s = await campaigns.submitCampaign(ctx, { campaignId: c.id });
    return { campaignId: c.id, approvalId: s.approval.id };
  });
  opts.setNow(new Date(sentAt.getTime() + 2 * HOUR));
  await app.tenant(org.orgId, owner, (ctx) => approvals.decideApproval(ctx, approvalId, { decision: 'approved', note: 'Good to go.' }));
  await app.tenant(org.orgId, WORKER, (ctx) => campaigns.sendCampaignWave(ctx, campaignId, 1));

  // Send each message through the outbox's own job handler; the queued job finds it sent and does nothing.
  const queued = await app.db.selectFrom('messages').select(['id', 'customer_id']).where('org_id', '=', org.orgId).where('campaign_id', '=', campaignId).where('status', '=', 'queued').execute();
  for (const m of queued) await comms.sendMessageJob.handler(app, { id: m.id, orgId: org.orgId, payload: { messageId: m.id }, attempt: 1 });

  // What the provider reported back over the next two days.
  const adapter = app.adapters.get('message', app.config.comms.emailAdapter) as SimMessageAdapter;
  const sent = await app.db.selectFrom('messages').select(['id', 'customer_id', 'provider_message_id']).where('org_id', '=', org.orgId).where('campaign_id', '=', campaignId).where('status', '=', 'sent').execute();
  const events: Array<{ providerMessageId: string; event: 'delivered' | 'opened' | 'clicked' | 'unsubscribed'; occurredAt: Date }> = [];
  const buyers: string[] = [];
  for (const m of sent) {
    if (!m.provider_message_id) continue;
    const at = (h: number) => new Date(sentAt.getTime() + (2 + h) * HOUR);
    events.push({ providerMessageId: m.provider_message_id, event: 'delivered', occurredAt: at(0.1) });
    if (!rng.chance(0.55)) continue;
    events.push({ providerMessageId: m.provider_message_id, event: 'opened', occurredAt: at(rng.int(1, 30)) });
    if (rng.chance(0.03)) {
      events.push({ providerMessageId: m.provider_message_id, event: 'unsubscribed', occurredAt: at(rng.int(31, 40)) });
      continue;
    }
    if (!rng.chance(0.3)) continue;
    events.push({ providerMessageId: m.provider_message_id, event: 'clicked', occurredAt: at(rng.int(31, 44)) });
    if (m.customer_id && rng.chance(0.5)) buyers.push(m.customer_id);
  }
  opts.setNow(new Date(sentAt.getTime() + 2 * DAY));
  for (let i = 0; i < events.length; i += 50) {
    const hook = adapter.webhook(SIM_WEBHOOK_SECRET, events.slice(i, i + 50));
    await comms.handleMessageWebhook(app, { adapterKey: adapter.key, ...hook, url: `http://fixtures/webhooks/${adapter.key}` });
  }

  // A few regulars came in with their code in the days after.
  const codes = await app.db
    .selectFrom('offer_codes')
    .select(['customer_id', 'code'])
    .where('org_id', '=', org.orgId)
    .where('source', '=', `campaign:${campaignId}`)
    .where('status', 'in', ['issued', 'claimed'])
    .execute();
  let n = 0;
  for (const customerId of buyers.slice(0, 6)) {
    const code = codes.find((c) => c.customer_id === customerId);
    const at = new Date(sentAt.getTime() + (3 + rng.int(0, 5)) * DAY + 8 * HOUR + rng.int(0, 120) * 60_000);
    opts.setNow(at);
    const subtotal = 6400 + rng.int(0, 40) * 100;
    const discount = code ? Math.round(subtotal * 0.15) : 0;
    const total = subtotal - discount;
    const txn: CanonicalTransaction = {
      source: 'sim',
      externalRef: `fx-${org.slug}-campaign-${++n}`,
      occurredAt: at,
      channel: 'dine-in',
      status: 'completed',
      subtotalCents: subtotal,
      discountCents: discount,
      taxCents: taxIncluded(total, 1000),
      tipCents: 0,
      totalCents: total,
      refundedCents: 0,
      currency: 'AUD',
      tenderType: 'card',
      lines: [{ lineNo: 1, name: 'Spring lamb shoulder to share', category: 'Mains', qty: 1, unitPriceCents: subtotal, modifiers: [], discountCents: 0, taxCents: taxIncluded(subtotal, 1000), totalCents: subtotal }],
      identityHints: [],
      discounts: code ? [{ name: 'Spring 15%', code: code.code, amountCents: discount }] : undefined,
    };
    await app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId, customerId, via: 'pos' }));
  }
  opts.setNow(opts.now);
}

async function pendingCampaign(app: App, org: FixtureOrg, opts: SeedOptions): Promise<void> {
  opts.setNow(new Date(opts.now.getTime() - DAY));
  const manager = await org.as('manager');
  const venueId = org.venues.cbd!.id;
  await app.tenant(org.orgId, manager, async (ctx) => {
    const lapsed = (await campaigns.listSegments(ctx)).find((s) => s.name === 'Lapsed 60+')!;
    const c = await campaigns.draftCampaign(ctx, {
      venueId,
      name: 'Winter menu: come back to the CBD',
      channel: 'email',
      segmentId: lapsed.id,
      subject: 'We have missed you, {{first_name}}',
      body: `Hi {{first_name}},\n\nIt has been a while. The winter menu is on at Oak Group CBD, and the fire is lit.\n\nWe would love to see you again.`,
    });
    await campaigns.submitCampaign(ctx, { campaignId: c.id });
  });
  opts.setNow(opts.now);
}

const seeder: ModuleSeeder = {
  module: 'campaigns',
  async seed(app, fixture: Fixture, opts) {
    for (const org of [fixture.diner, fixture.group]) {
      opts.setNow(opts.now);
      await switchOn(app, org);
      await shadowRuns(app, org, opts);
    }
    await sentCampaign(app, fixture.diner, opts);
    await pendingCampaign(app, fixture.group, opts);
    opts.setNow(opts.now);
  },
};

export default seeder;
