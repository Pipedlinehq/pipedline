import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

const SALE_CHANNELS = ['dine-in', 'pickup', 'delivery', 'catering', 'retail'] as const;

/**
 * Per-venue choices (venue_modules.config). The programme itself (earn rate, tiers, rewards,
 * expiry) is org-wide and lives in the loyalty tables, so a guest earns at one venue and burns
 * at another. docs/modules/loyalty.md section 6.
 */
export const loyaltyConfig = z.object({
  /** Sales at this venue earn points. */
  earnHere: z.boolean().default(true),
  /** Which kinds of sale earn. */
  earnChannels: z.array(z.enum(SALE_CHANNELS)).default([...SALE_CHANNELS]),
  /** A sale made this many hours before the guest joined still earns (pay first, join at the counter after). */
  earnLookbackHours: z.number().int().min(0).max(720).default(24),
  /** Rewards can be redeemed at this venue. */
  redeemHere: z.boolean().default(true),
  /** How long a counter redemption code stays usable. */
  redemptionExpiryMinutes: z.number().int().min(2).max(240).default(15),
  /** How long after a code lapses we keep waiting for a sale that was made in time but reported late. */
  lateSaleGraceMinutes: z.number().int().min(0).max(120).default(10),
  /** When the till sale carries no code, match a redemption by venue, time window and discount amount. */
  matchByAmount: z.boolean().default(true),
  /** A manager may confirm a redemption whose sale never arrived. When off, only an owner may. */
  allowStaffForceConfirm: z.boolean().default(true),
  /** How staff may find a guest at the counter. */
  identifyBy: z.array(z.enum(['phone', 'email', 'qr', 'name'])).default(['phone', 'email', 'qr', 'name']),
  /** Staff may enrol a guest at the counter with the guest's phone or email. */
  counterEnrolment: z.boolean().default(true),
  /** A manual points adjustment larger than this needs an owner. */
  ownerAdjustmentAbovePoints: z.number().int().min(0).default(500),
});
export type LoyaltyConfig = z.infer<typeof loyaltyConfig>;

export const loyaltyModule = defineModule({
  key: 'loyalty',
  name: 'Loyalty',
  description: 'Org-wide points ledger, tiers, rewards and counter redemption.',
  dependsOn: ['identity', 'ledger', 'comms'],
  tables: ['loyalty_programs', 'loyalty_tiers', 'loyalty_accounts', 'loyalty_transactions', 'rewards', 'redemptions'],
  configSchema: loyaltyConfig,
  configVersion: 1,
  defaultConfig: loyaltyConfig.parse({}),
});

/** The order flag a guest sets at checkout to join the programme. Ordering passes it on untouched. */
export const LOYALTY_JOIN_FLAG = 'loyalty_join';

export const loyaltyEnrolled = defineEvent({
  name: 'loyalty.enrolled',
  module: 'loyalty',
  description: 'A guest joined the loyalty programme.',
  properties: z.object({
    account_id: z.string(),
    via: z.enum(['guest', 'checkout', 'counter', 'import']).describe('Who did the joining: the guest online, a checkout tick box, staff at the counter, or an import'),
    bonus_points: z.number().int(),
  }),
});

export const loyaltyEarned = defineEvent({
  name: 'loyalty.earned',
  module: 'loyalty',
  description: 'A sale in the ledger earned points for a member. Happens by itself; nothing at the till is needed.',
  properties: z.object({
    account_id: z.string(),
    transaction_id: z.string(),
    points: z.number().int(),
    multiplier: z.number(),
    spend_cents: z.number().int(),
  }),
});

export const loyaltyEarnReversed = defineEvent({
  name: 'loyalty.earn_reversed',
  module: 'loyalty',
  description: 'A refund took back the share of points the refunded amount had earned.',
  properties: z.object({ account_id: z.string(), transaction_id: z.string(), points: z.number().int() }),
});

export const loyaltyRedemptionIssued = defineEvent({
  name: 'loyalty.redemption_issued',
  module: 'loyalty',
  description: 'A single-use counter code was issued for a reward. Points are held, not yet spent.',
  properties: z.object({ account_id: z.string(), redemption_id: z.string(), reward_id: z.string(), points: z.number().int() }),
});

export const loyaltyRedeemed = defineEvent({
  name: 'loyalty.redeemed',
  module: 'loyalty',
  description: 'A reward was used on a paid sale and its points were spent.',
  properties: z.object({
    account_id: z.string(),
    redemption_id: z.string(),
    reward_id: z.string(),
    points: z.number().int(),
    channel: z.enum(['counter', 'online']),
    matched_by: z.enum(['code', 'amount', 'order', 'forced']).describe('How the paid sale was tied to the redemption'),
    discount_cents: z.number().int().nullable(),
  }),
});

export const loyaltyRedemptionExpired = defineEvent({
  name: 'loyalty.redemption_expired',
  module: 'loyalty',
  description: 'A counter code lapsed with no matching sale. No points were spent.',
  properties: z.object({ account_id: z.string(), redemption_id: z.string(), reward_id: z.string(), points: z.number().int() }),
});

export const loyaltyRedemptionReleased = defineEvent({
  name: 'loyalty.redemption_released',
  module: 'loyalty',
  description: 'A redemption was undone (the sale was refunded, or the code was cancelled) and any spent points were returned.',
  properties: z.object({ account_id: z.string(), redemption_id: z.string(), points_returned: z.number().int(), reason: z.string() }),
});

export const loyaltyExpired = defineEvent({
  name: 'loyalty.expired',
  module: 'loyalty',
  description: 'Points lapsed under the programme\'s expiry rule.',
  properties: z.object({ account_id: z.string(), points: z.number().int(), policy: z.enum(['rolling', 'fixed']) }),
});

export const loyaltyAdjusted = defineEvent({
  name: 'loyalty.adjusted',
  module: 'loyalty',
  description: 'A manager or owner added or removed points by hand, with a reason.',
  properties: z.object({ account_id: z.string(), points: z.number().int() }),
});

export const loyaltyBonusAwarded = defineEvent({
  name: 'loyalty.bonus_awarded',
  module: 'loyalty',
  description: 'Bonus points were given for joining or for a birthday.',
  properties: z.object({ account_id: z.string(), points: z.number().int(), reason: z.enum(['enrolment', 'birthday']) }),
});

export const loyaltyTierChanged = defineEvent({
  name: 'loyalty.tier_changed',
  module: 'loyalty',
  description: 'A member moved up or down a tier.',
  properties: z.object({ account_id: z.string(), from: z.string().nullable(), to: z.string().nullable() }),
});
