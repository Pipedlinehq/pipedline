import type { Ctx } from '@ros/core';

/** Bump when the rules below change; old rows stay until reattribute() replaces them. */
export const ATTRIBUTION_VERSION = 1;
const LAST_TOUCH_WINDOW_DAYS = 30;

/**
 * Tie a sale to what brought the customer in. Two models, kept side by side:
 *
 *   acquisition   the write-once first touch stamped on the customer. Deterministic.
 *   last_touch    the most recent later marketing touch in the 30 days before the sale.
 *
 * Attribution lives beside the ledger, never in it, so the rules can be re-run and versioned
 * (docs/SCHEMA.md section 3). What leaves the org is totals only (docs/modules/hub.md section 7).
 */
export async function attributeTransaction(
  ctx: Ctx,
  txn: { id: string; customerId: string | null; occurredAt: Date },
): Promise<number> {
  if (!txn.customerId) return 0;
  const customer = await ctx.db
    .selectFrom('customers')
    .select(['acquisition_source', 'acquisition_creator_id', 'acquisition_campaign_id', 'acquisition_code'])
    .where('id', '=', txn.customerId)
    .executeTakeFirst();
  if (!customer) return 0;

  const rows: Array<{ model: string; channel: string; creator: string | null; campaign: string | null; code: string | null; confidence: number }> = [];
  if (customer.acquisition_creator_id || customer.acquisition_campaign_id || customer.acquisition_code) {
    rows.push({
      model: 'acquisition',
      channel: customer.acquisition_source,
      creator: customer.acquisition_creator_id,
      campaign: customer.acquisition_campaign_id,
      code: customer.acquisition_code,
      confidence: 1,
    });
  }

  const since = new Date(txn.occurredAt.getTime() - LAST_TOUCH_WINDOW_DAYS * 86_400_000);
  const touch = await ctx.db
    .selectFrom('customer_touchpoints')
    .select(['channel', 'creator_id', 'campaign_id', 'code'])
    .where('customer_id', '=', txn.customerId)
    .where('occurred_at', '<=', txn.occurredAt)
    .where('occurred_at', '>=', since)
    .orderBy('occurred_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (touch && (touch.creator_id || touch.campaign_id || touch.code)) {
    rows.push({ model: 'last_touch', channel: touch.channel, creator: touch.creator_id, campaign: touch.campaign_id, code: touch.code, confidence: 0.7 });
  }

  for (const r of rows) {
    await ctx.db
      .insertInto('transaction_attributions')
      .values({
        org_id: ctx.orgId,
        transaction_id: txn.id,
        customer_id: txn.customerId,
        creator_id: r.creator,
        campaign_id: r.campaign,
        code: r.code,
        channel: r.channel,
        model: r.model,
        model_version: ATTRIBUTION_VERSION,
        confidence: r.confidence,
        attributed_at: ctx.now(),
      })
      .onConflict((oc) => oc.columns(['org_id', 'transaction_id', 'model', 'model_version']).doNothing())
      .execute();
  }
  return rows.length;
}

/** Recompute attribution for sales since a date, e.g. after a merge or a rule change. Internal use. */
export async function reattribute(ctx: Ctx, args: { since: Date }): Promise<{ transactions: number }> {
  const txns = await ctx.db
    .selectFrom('transactions')
    .select(['id', 'customer_id', 'occurred_at'])
    .where('occurred_at', '>=', args.since)
    .where('customer_id', 'is not', null)
    .execute();
  if (txns.length) {
    await ctx.db
      .deleteFrom('transaction_attributions')
      .where('model_version', '=', ATTRIBUTION_VERSION)
      .where('transaction_id', 'in', txns.map((t) => t.id))
      .execute();
  }
  for (const t of txns) await attributeTransaction(ctx, { id: t.id, customerId: t.customer_id, occurredAt: t.occurred_at });
  return { transactions: txns.length };
}

/**
 * Recompute one sale's attribution. For a module that records a touch after the sale was
 * attributed (a campaign crediting a message it finds in the ledger hook). Internal use.
 */
export async function reattributeTransaction(ctx: Ctx, txn: { id: string; customerId: string | null; occurredAt: Date }): Promise<number> {
  await ctx.db.deleteFrom('transaction_attributions').where('transaction_id', '=', txn.id).where('model_version', '=', ATTRIBUTION_VERSION).execute();
  return attributeTransaction(ctx, txn);
}
