import { z } from 'zod';
import { type Ctx, defineTool, requireStaff, sql } from '@ros/core';
import { assertOffersOn } from './definitions';

export interface OfferStats {
  offerId: string;
  name: string;
  kind: string;
  active: boolean;
  issued: number;
  claimed: number;
  redeemed: number;
  expired: number;
  /** Still usable. */
  live: number;
  /** What the redeemed codes took off. */
  discountCents: number;
  /** The total of the sales those codes were used on, net of refunds. */
  revenueCents: number;
  /** redeemed / issued, 0 to 1. */
  redemptionRate: number;
}

export interface OffersSummary {
  /** Null = all time. */
  periodDays: number | null;
  totals: Omit<OfferStats, 'offerId' | 'name' | 'kind' | 'active'>;
  offers: OfferStats[];
}

export const offersSummaryInput = z.object({ days: z.number().int().min(1).max(730).optional() });

/** Codes issued, claimed and redeemed, and the revenue on the sales they were used on, by offer. */
export async function getOffersSummary(ctx: Ctx, raw: z.input<typeof offersSummaryInput> = {}): Promise<OffersSummary> {
  const input = offersSummaryInput.parse(raw);
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  const now = ctx.now();
  const since = input.days ? new Date(now.getTime() - input.days * 86_400_000) : new Date(0);

  const rows = (
    await sql<{ id: string; name: string; kind: string; is_active: boolean; issued: number; claimed: number; redeemed: number; expired: number; live: number; discount_cents: number; revenue_cents: number }>`
      select o.id, o.name, o.kind::text as kind, o.is_active,
             count(c.id) filter (where c.status <> 'voided')::int as issued,
             count(c.id) filter (where c.claimed_at is not null and c.status <> 'voided')::int as claimed,
             count(c.id) filter (where c.status = 'redeemed')::int as redeemed,
             count(c.id) filter (where c.status = 'expired' or (c.status in ('issued', 'claimed') and c.expires_at <= ${now}))::int as expired,
             count(c.id) filter (where c.status in ('issued', 'claimed') and c.expires_at > ${now})::int as live,
             coalesce(sum(c.discount_applied_cents) filter (where c.status = 'redeemed'), 0)::bigint as discount_cents,
             coalesce(sum(t.total_cents - t.refunded_cents) filter (where c.status = 'redeemed'), 0)::bigint as revenue_cents
      from offers o
      left join offer_codes c on c.offer_id = o.id and c.issued_at >= ${since}
      left join transactions t on t.id = c.redeemed_transaction_id
      group by o.id
      order by o.created_at`.execute(ctx.db)
  ).rows;

  const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
  const offers: OfferStats[] = rows.map((r) => ({
    offerId: r.id,
    name: r.name,
    kind: r.kind,
    active: r.is_active,
    issued: r.issued,
    claimed: r.claimed,
    redeemed: r.redeemed,
    expired: r.expired,
    live: r.live,
    discountCents: Number(r.discount_cents),
    revenueCents: Number(r.revenue_cents),
    redemptionRate: ratio(r.redeemed, r.issued),
  }));
  const sum = (f: (o: OfferStats) => number) => offers.reduce((s, o) => s + f(o), 0);
  const issued = sum((o) => o.issued);
  const redeemed = sum((o) => o.redeemed);
  return {
    periodDays: input.days ?? null,
    totals: {
      issued,
      claimed: sum((o) => o.claimed),
      redeemed,
      expired: sum((o) => o.expired),
      live: sum((o) => o.live),
      discountCents: sum((o) => o.discountCents),
      revenueCents: sum((o) => o.revenueCents),
      redemptionRate: ratio(redeemed, issued),
    },
    offers,
  };
}

const stats = z.object({
  issued: z.number(),
  claimed: z.number(),
  redeemed: z.number(),
  expired: z.number(),
  live: z.number(),
  discount_given_cents: z.number(),
  revenue_on_redeemed_sales_cents: z.number(),
  redemption_rate: z.number().describe('Redeemed divided by issued, 0 to 1'),
});

/** Offers in numbers, for a venue's own assistant. Pinned to the function the console calls; totals only. */
export const offersSummaryTool = defineTool({
  name: 'offers_summary',
  module: 'offers',
  title: 'Offers summary',
  description:
    'How each offer is doing: codes issued, claimed, redeemed and expired, the discount given, and the revenue on the sales the codes were used on. Totals only; no guest is named.',
  effect: 'read',
  scope: 'offers:read',
  input: z.object({ days: z.number().int().min(1).max(730).optional().describe('Only codes issued in the last this-many days. Leave out for all time') }),
  output: z.object({
    period_days: z.number().nullable(),
    totals: stats,
    offers: z.array(stats.extend({ name: z.string(), kind: z.string(), active: z.boolean() })),
  }),
  async run({ ctx }, input) {
    const s = await getOffersSummary(ctx, { days: input.days });
    const shape = (o: OffersSummary['totals']) => ({
      issued: o.issued,
      claimed: o.claimed,
      redeemed: o.redeemed,
      expired: o.expired,
      live: o.live,
      discount_given_cents: o.discountCents,
      revenue_on_redeemed_sales_cents: o.revenueCents,
      redemption_rate: o.redemptionRate,
    });
    return { period_days: s.periodDays, totals: shape(s.totals), offers: s.offers.map((o) => ({ ...shape(o), name: o.name, kind: o.kind, active: o.active })) };
  },
});
