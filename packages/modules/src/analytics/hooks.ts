import { onCustomerErase, registerCustomerDataProvider } from '../identity/customers';
import { onCustomerMerge } from '../identity/merge';

/**
 * The customer snapshot is the one analytics table that holds a row about a person. It follows
 * the person: erased with them at once (not at the next roll-up), folded when two records
 * merge, and included when a guest asks for everything held about them. Every other analytics
 * table holds totals only.
 */
onCustomerErase(async (ctx, customerId) => {
  await ctx.db.deleteFrom('fact_customer').where('org_id', '=', ctx.orgId).where('customer_id', '=', customerId).execute();
});

// The winner's row is rebuilt from the merged history at the next roll-up; the loser has none.
onCustomerMerge(async (ctx, { loserId }) => {
  await ctx.db.deleteFrom('fact_customer').where('org_id', '=', ctx.orgId).where('customer_id', '=', loserId).execute();
});

registerCustomerDataProvider('analytics', async (ctx, customerId) => {
  const r = await ctx.db
    .selectFrom('fact_customer')
    .select(['orders', 'spend_cents', 'avg_order_cents', 'first_order_day', 'last_order_day', 'days_to_second_order', 'recency_days', 'r_score', 'f_score', 'm_score', 'segment', 'favourite_channel', 'computed_at'])
    .where('org_id', '=', ctx.orgId)
    .where('customer_id', '=', customerId)
    .executeTakeFirst();
  if (!r) return null;
  return {
    note: 'A summary derived from your purchases, recomputed regularly.',
    orders: r.orders,
    spendCents: r.spend_cents,
    averageOrderCents: r.avg_order_cents,
    firstOrderOn: r.first_order_day,
    lastOrderOn: r.last_order_day,
    daysToSecondOrder: r.days_to_second_order,
    daysSinceLastOrder: r.recency_days,
    scores: { recency: r.r_score, frequency: r.f_score, spend: r.m_score },
    segment: r.segment,
    favouriteChannel: r.favourite_channel,
    computedAt: r.computed_at,
  };
});
