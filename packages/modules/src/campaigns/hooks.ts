import type { Ctx, IdentityHint } from '@ros/core';
import { enqueue, sql } from '@ros/core';
import { onApprovalDecided } from '../approvals/index';
import { onConsentChanged } from '../identity/consents';
import { onCustomerErase, registerCustomerDataProvider } from '../identity/customers';
import { onCustomerMerge } from '../identity/merge';
import { resolveCustomer } from '../identity/resolve';
import { reattributeTransaction } from '../ledger/attribution';
import { type RecordedTransaction, onTransactionRecorded } from '../ledger/record';
import { CAMPAIGN_SEND_APPROVAL, onCampaignDecision } from './campaigns';
import { FLOW_BATCH_APPROVAL, type FlowKey, enrol, exitEnrolments, flowBatchSendJob, flowTemplate, flowsByKey, homeVenueOf, reachable } from './flows';
import { getCampaignsSettings } from './settings';

/**
 * Where campaigns plug into the rest of the platform. Each handler runs inside someone else's
 * transaction, is idempotent, and returns quietly for an org that has no flows or messages.
 */

const COUNTED = ['completed', 'partially_refunded'] as const;

/** Identities the customer already holds, to name them to the identity spine. */
async function knownHints(ctx: Ctx, customerId: string): Promise<IdentityHint[]> {
  const rows = await ctx.db
    .selectFrom('customer_identities')
    .select(['kind', 'value'])
    .where('customer_id', '=', customerId)
    .where('kind', 'in', ['email', 'phone'])
    .limit(1)
    .execute();
  return rows.map((r) => ({ kind: r.kind as IdentityHint['kind'], value: r.value }));
}

/**
 * A guest ordered within the attribution window after a campaign or flow message reached them:
 * record that message as a touch (through the identity spine), carrying the guest's code from it
 * when they have one, then have the ledger work the sale's attribution out again so its
 * last-touch model sees it (the ledger attributes a sale before its hooks run). The touch is
 * dated at the sale, the moment the message is credited, so a claim in between does not hide it.
 */
async function creditMessage(ctx: Ctx, txn: RecordedTransaction): Promise<void> {
  const settings = await getCampaignsSettings(ctx);
  const since = new Date(txn.occurredAt.getTime() - settings.attributionWindowDays * 86_400_000);
  const m = await ctx.db
    .selectFrom('messages')
    .select(['id', 'campaign_id', 'flow_id', 'sent_at'])
    .where('customer_id', '=', txn.customerId!)
    .where('kind', '=', 'marketing')
    .where('status', 'in', ['sent', 'delivered'])
    .where((eb) => eb.or([eb('campaign_id', 'is not', null), eb('flow_id', 'is not', null)]))
    .where('sent_at', '<=', txn.occurredAt)
    .where('sent_at', '>=', since)
    .orderBy('sent_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!m) return;
  let touchId: string;
  let source: string;
  if (m.campaign_id) {
    touchId = m.campaign_id;
    source = `campaign:${m.campaign_id}`;
  } else {
    const f = await ctx.db.selectFrom('flows').select('key').where('id', '=', m.flow_id!).executeTakeFirst();
    if (!f) return;
    touchId = `flow:${f.key}`;
    source = `flow:${f.key}`;
  }
  const already = await ctx.db
    .selectFrom('customer_touchpoints')
    .select('id')
    .where('customer_id', '=', txn.customerId!)
    .where('campaign_id', '=', touchId)
    .where('occurred_at', '=', txn.occurredAt)
    .executeTakeFirst();
  if (already) return;
  const hints = await knownHints(ctx, txn.customerId!);
  if (!hints.length) return;
  // The guest's own code from this campaign or flow, from the offer events (the offers tables are not ours).
  const issued = await ctx.db
    .selectFrom('events')
    .select('code')
    .where('name', '=', 'offer.issued')
    .where('customer_id', '=', txn.customerId!)
    .where(sql<string>`properties->>'source'`, '=', source)
    .where('occurred_at', '<=', txn.occurredAt)
    .orderBy('occurred_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  await resolveCustomer(ctx, { hints, via: 'campaigns', createIfMissing: false, acquisition: { source: m.campaign_id ? 'campaign' : 'flow', campaignId: touchId, code: issued?.code ?? null, at: txn.occurredAt } });
  await reattributeTransaction(ctx, { id: txn.id, customerId: txn.customerId!, occurredAt: txn.occurredAt });
}

onTransactionRecorded(async (ctx, txn, info) => {
  if (!txn.customerId || !(COUNTED as readonly string[]).includes(txn.status)) return;
  if (!info.created && info.previousCustomerId === txn.customerId) return;

  await creditMessage(ctx, txn);

  const flows = await flowsByKey(ctx);
  if (!flows.size) return;
  // A purchase ends win-back and post-purchase for anyone enrolled before it.
  const exiting = [...flows.values()].filter((f) => flowTemplate(f).exitOnPurchase).map((f) => f.id);
  await exitEnrolments(ctx, { customerId: txn.customerId, flowIds: exiting, enrolledBefore: txn.occurredAt }, 'purchase');

  const post = flows.get('post_purchase');
  const vip = flows.get('vip');
  if ((!post || post.mode === 'off') && (!vip || vip.mode === 'off')) return;
  const n = await ctx.db
    .selectFrom('transactions')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('customer_id', '=', txn.customerId)
    .where('status', 'in', [...COUNTED])
    .executeTakeFirstOrThrow();
  const orders = Number(n.n);
  if (post && post.mode !== 'off' && orders === 1 && (await reachable(ctx, txn.customerId, post.config.channel))) {
    await enrol(ctx, post, { customerId: txn.customerId, venueId: txn.venueId, nextAt: new Date(txn.occurredAt.getTime() + post.config.postPurchaseDays * 86_400_000) });
  }
  if (vip && vip.mode !== 'off' && orders >= vip.config.vipOrders && (await reachable(ctx, txn.customerId, vip.config.channel))) {
    await enrol(ctx, vip, { customerId: txn.customerId, venueId: txn.venueId, nextAt: new Date(ctx.now().getTime() + 86_400_000) });
  }
});

// A guest just agreed to marketing: welcome them. A guest opted out of any marketing: every flow ends for them.
onConsentChanged(async (ctx, change) => {
  if (change.purpose !== 'marketing_email' && change.purpose !== 'marketing_sms') return;
  if (change.action === 'revoked') {
    await exitEnrolments(ctx, { customerId: change.customerId }, 'unsubscribed');
    return;
  }
  const flows = await flowsByKey(ctx);
  const welcome = flows.get('welcome' as FlowKey);
  if (!welcome || welcome.mode === 'off') return;
  const channel = change.purpose === 'marketing_email' ? 'email' : 'sms';
  if (welcome.config.channel !== channel || !(await reachable(ctx, change.customerId, channel))) return;
  await enrol(ctx, welcome, { customerId: change.customerId, venueId: await homeVenueOf(ctx, change.customerId), nextAt: new Date(ctx.now().getTime() + welcome.config.welcomeDelayMinutes * 60_000) });
});

// Two records are one guest: the winner keeps the enrolments. Where both were in the same flow, the winner's stands.
onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  const theirs = await ctx.db.selectFrom('flow_enrollments').select(['id', 'flow_id']).where('customer_id', '=', loserId).execute();
  if (!theirs.length) return;
  const mine = new Set((await ctx.db.selectFrom('flow_enrollments').select('flow_id').where('customer_id', '=', winnerId).execute()).map((r) => r.flow_id));
  for (const e of theirs) {
    if (mine.has(e.flow_id)) await ctx.db.deleteFrom('flow_enrollments').where('id', '=', e.id).execute();
    else await ctx.db.updateTable('flow_enrollments').set({ customer_id: winnerId }).where('id', '=', e.id).execute();
  }
});

// A guest asked to be forgotten: their place in every flow goes. Campaigns and segments hold no guest data.
onCustomerErase(async (ctx, customerId) => {
  await ctx.db.deleteFrom('flow_enrollments').where('customer_id', '=', customerId).execute();
});

registerCustomerDataProvider('campaigns', async (ctx, customerId) =>
  ctx.db
    .selectFrom('flow_enrollments as e')
    .innerJoin('flows as f', 'f.id', 'e.flow_id')
    .select(['f.name as flow', 'e.status', 'e.step', 'e.cycle', 'e.enrolled_at', 'e.completed_at'])
    .where('e.customer_id', '=', customerId)
    .orderBy('e.enrolled_at')
    .execute(),
);

// Approved batches are queued by a worker, so the send never runs in the manager's request.
onApprovalDecided(FLOW_BATCH_APPROVAL, async (ctx, approval, decision) => {
  // Rejected or lapsed: nothing is sent, and the guests stay due for the next run's batch.
  if (decision === 'approved') await enqueue(ctx, flowBatchSendJob, { approvalId: approval.id }, { key: approval.id });
});

onApprovalDecided(CAMPAIGN_SEND_APPROVAL, onCampaignDecision);
