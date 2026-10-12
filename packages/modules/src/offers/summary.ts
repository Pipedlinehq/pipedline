import { z } from 'zod';
import { type Ctx, defineTool, requireStaff, sql } from '@ros/core';
import { type OfferMethod, type OfferStatus, assertOffersOn, listOffers } from './definitions';

export interface OfferStats {
  offerId: string;
  name: string;
  kind: string;
  active: boolean;
  method: OfferMethod;
  status: OfferStatus;
  /** The server-written plain words. */
  summary: string;
  issued: number;
  claimed: number;
  redeemed: number;
  expired: number;
  /** Still usable. */
  live: number;
  /** Times the offer was used: codes redeemed plus automatic uses (less any released by a refund). */
  uses: number;
  /** What the uses took off. */
  discountCents: number;
  /** The total of the sales the offer was used on, net of refunds: "sales attributed". */
  revenueCents: number;
  /** redeemed / issued, 0 to 1 (code offers). */
  redemptionRate: number;
}

export interface OffersSummary {
  /** Null = all time. */
  periodDays: number | null;
  totals: Omit<OfferStats, 'offerId' | 'name' | 'kind' | 'active' | 'method' | 'status' | 'summary'>;
  offers: OfferStats[];
}

export const offersSummaryInput = z.object({ days: z.number().int().min(1).max(730).optional() });

/**
 * Codes issued, claimed and redeemed, automatic uses, and the revenue on the sales each offer
 * was used on, by offer. Status and the plain-words summary ride along for the console's table.
 */
export async function getOffersSummary(ctx: Ctx, raw: z.input<typeof offersSummaryInput> = {}): Promise<OffersSummary> {
  const input = offersSummaryInput.parse(raw);
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  const now = ctx.now();
  const since = input.days ? new Date(now.getTime() - input.days * 86_400_000) : new Date(0);

  const rows = (
    await sql<{ id: string; issued: number; claimed: number; redeemed: number; expired: number; live: number; discount_cents: number; revenue_cents: number; uses: number; use_discount_cents: number; use_revenue_cents: number }>`
      with codes as (
        select o.id,
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
      ), uses as (
        select o.id,
               count(u.id)::int as uses,
               coalesce(sum(u.discount_cents), 0)::bigint as use_discount_cents,
               coalesce(sum(t.total_cents - t.refunded_cents), 0)::bigint as use_revenue_cents
        from offers o
        left join offer_uses u on u.offer_id = o.id and u.released_at is null and u.used_at >= ${since}
        left join transactions t on t.id = u.transaction_id
        group by o.id
      )
      select c.*, u.uses, u.use_discount_cents, u.use_revenue_cents
      from codes c join uses u on u.id = c.id`.execute(ctx.db)
  ).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const views = await listOffers(ctx, { includeInactive: true });

  const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
  const offers: OfferStats[] = views.map((v) => {
    const r = byId.get(v.id);
    const redeemed = r?.redeemed ?? 0;
    const issued = r?.issued ?? 0;
    const autoUses = r?.uses ?? 0;
    return {
      offerId: v.id,
      name: v.name,
      kind: v.kind,
      active: v.isActive,
      method: v.method,
      status: v.status,
      summary: v.summary,
      issued,
      claimed: r?.claimed ?? 0,
      redeemed,
      expired: r?.expired ?? 0,
      live: r?.live ?? 0,
      uses: redeemed + autoUses,
      discountCents: Number(r?.discount_cents ?? 0) + Number(r?.use_discount_cents ?? 0),
      revenueCents: Number(r?.revenue_cents ?? 0) + Number(r?.use_revenue_cents ?? 0),
      redemptionRate: ratio(redeemed, issued),
    };
  });
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
      uses: sum((o) => o.uses),
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
  uses: z.number().describe('Times the offer was used: codes redeemed plus automatic uses, less any refunded'),
  discount_given_cents: z.number(),
  revenue_on_redeemed_sales_cents: z.number().describe('Sales attributed: the total of the sales the offer was used on, net of refunds'),
  redemption_rate: z.number().describe('Redeemed divided by issued, 0 to 1'),
});

/** Offers in numbers, for a venue's own assistant. Pinned to the function the console calls; totals only. */
export const offersSummaryTool = defineTool({
  name: 'offers_summary',
  module: 'offers',
  title: 'Offers summary',
  description:
    'How each offer is doing: codes issued, claimed, redeemed and expired, automatic uses, the discount given, and the revenue on the sales the offer was used on. Each offer comes with its status (active, scheduled, expired, off), whether it works by code or automatically, and its plain-words summary. Totals only; no guest is named.',
  effect: 'read',
  scope: 'offers:read',
  input: z.object({
    days: z.number().int().min(1).max(730).optional().describe('Only codes and uses in the last this-many days. Leave out for all time'),
    status: z.enum(['active', 'scheduled', 'expired', 'off']).optional().describe('Only offers in this state now'),
  }),
  output: z.object({
    period_days: z.number().nullable(),
    totals: stats,
    offers: z.array(
      stats.extend({
        offer_id: z.string(),
        name: z.string(),
        kind: z.string(),
        active: z.boolean(),
        method: z.enum(['code', 'automatic']),
        status: z.enum(['active', 'scheduled', 'expired', 'off']),
        summary: z.string(),
      }),
    ),
  }),
  async run({ ctx }, input) {
    const s = await getOffersSummary(ctx, { days: input.days });
    const shape = (o: OffersSummary['totals']) => ({
      issued: o.issued,
      claimed: o.claimed,
      redeemed: o.redeemed,
      expired: o.expired,
      live: o.live,
      uses: o.uses,
      discount_given_cents: o.discountCents,
      revenue_on_redeemed_sales_cents: o.revenueCents,
      redemption_rate: o.redemptionRate,
    });
    const offers = s.offers.filter((o) => !input.status || o.status === input.status);
    return {
      period_days: s.periodDays,
      totals: shape(s.totals),
      offers: offers.map((o) => ({ ...shape(o), offer_id: o.offerId, name: o.name, kind: o.kind, active: o.active, method: o.method, status: o.status, summary: o.summary })),
    };
  },
});
