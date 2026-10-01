import { z } from 'zod';
import { defineTool } from '@ros/core';
import { getLoyaltySummary } from './reads';

/**
 * The programme in numbers, for a venue's own assistant. Pinned to the same function the
 * console's loyalty dashboard calls; totals only, no guest is named.
 */
export const loyaltySummaryTool = defineTool({
  name: 'loyalty_summary',
  module: 'loyalty',
  title: 'Loyalty summary',
  description:
    'How the loyalty programme is doing: members, points issued and redeemed, the points still outstanding and what they would cost to honour, the redemption rate, and earn coverage (the share of sales by known guests that earned points). Totals only.',
  effect: 'read',
  scope: 'loyalty:read',
  input: z.object({ days: z.number().int().min(1).max(730).default(30).describe('The period to report on, in days back from now') }),
  output: z.object({
    program: z.object({ name: z.string(), active: z.boolean() }).nullable(),
    period_days: z.number(),
    members: z.object({ total: z.number(), joined_in_period: z.number(), never_earned: z.number() }),
    points: z.object({
      issued: z.number(),
      redeemed: z.number(),
      expired: z.number(),
      outstanding: z.number(),
      issued_in_period: z.number(),
      redeemed_in_period: z.number(),
    }),
    outstanding_liability_cents: z.number(),
    redemption_rate: z.number().describe('Points redeemed divided by points issued, all time, 0 to 1'),
    redemptions_in_period: z.object({ issued: z.number(), redeemed: z.number(), expired: z.number(), forced: z.number() }),
    earn_coverage: z.object({
      identified_sales: z.number(),
      member_sales: z.number(),
      earned_sales: z.number(),
      share_of_identified_sales: z.number().describe('0 to 1'),
      share_of_member_sales: z.number().describe('0 to 1. Should be at or near 1; lower means members are paying without earning'),
    }),
    tiers: z.array(z.object({ name: z.string(), members: z.number() })),
  }),
  async run({ ctx }, input) {
    const s = await getLoyaltySummary(ctx, { days: input.days });
    return {
      program: s.program,
      period_days: s.periodDays,
      members: { total: s.members.total, joined_in_period: s.members.joinedInPeriod, never_earned: s.members.neverEarned },
      points: {
        issued: s.points.issued,
        redeemed: s.points.redeemed,
        expired: s.points.expired,
        outstanding: s.points.outstanding,
        issued_in_period: s.points.issuedInPeriod,
        redeemed_in_period: s.points.redeemedInPeriod,
      },
      outstanding_liability_cents: s.liabilityCents,
      redemption_rate: s.redemptionRate,
      redemptions_in_period: s.redemptions,
      earn_coverage: {
        identified_sales: s.earnCoverage.identifiedSales,
        member_sales: s.earnCoverage.memberSales,
        earned_sales: s.earnCoverage.earnedSales,
        share_of_identified_sales: s.earnCoverage.share,
        share_of_member_sales: s.earnCoverage.memberShare,
      },
      tiers: s.tiers,
    };
  },
});
