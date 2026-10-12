import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Per-venue choices (venue_modules.config). Offer definitions and codes are org-wide, so a code
 * issued by one venue of a group can be used at another unless the offer says otherwise.
 */
export const offersConfig = z.object({
  /** Codes can be redeemed at this venue. */
  acceptHere: z.boolean().default(true).describe('Whether offer codes can be used at this venue. Off: a code is refused here, online and at the counter. Default on.'),
  /** When a till sale carries a code in its discounts, mark that code redeemed. */
  matchTillDiscounts: z
    .boolean()
    .default(true)
    .describe('When a sale from the till carries one of your codes in its discounts, mark that code as used. Default on.'),
  /** Front of house may mark a code redeemed by hand against a sale. */
  staffRedeem: z.boolean().default(true).describe('Whether front of house may mark a code as used by hand, against a sale. Default on.'),
  /** The most codes one bulk issue may create. */
  bulkIssueMax: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .default(5000)
    .describe('The most guests one bulk send may issue codes to at once. A longer list is refused and has to be split. Default 5000.'),
  /** A code that lapsed between pricing an order and paying for it is still honoured for this long. */
  paymentGraceMinutes: z
    .number()
    .int()
    .min(0)
    .max(240)
    .default(30)
    .describe('A code that expires between a guest pricing their order and paying for it is still honoured for this many minutes. Default 30.'),
});
export type OffersConfig = z.infer<typeof offersConfig>;

export const offersModule = defineModule({
  key: 'offers',
  name: 'Offers',
  description: 'Unique per-customer codes: click-to-claim offers, vouchers, creator offers.',
  dependsOn: ['identity', 'ledger', 'comms'],
  manifest: {
    name: 'Offers',
    purpose: 'One-off codes for a guest: welcome offers, vouchers, come-back offers, creator offers. Redeemed at online checkout, matched from a till sale, or marked off by front of house.',
    category: 'marketing',
    kind: 'module',
    needs: ['Nothing to connect. Till discounts are matched to codes when the till is connected.'],
    reads: ['sales (to see a code used at the till)', 'guest records'],
    writes: ['offers and codes', 'redemptions'],
  },
  tables: ['offers', 'offer_codes'],
  configSchema: offersConfig,
  configVersion: 1,
  defaultConfig: offersConfig.parse({}),
});

const OFFER_KIND = z.enum(['welcome', 'comeback', 'voucher', 'birthday', 'creator', 'manual']);
const codeProps = z.object({ offer_id: z.string(), offer_kind: OFFER_KIND, code_id: z.string() });

export const offerIssued = defineEvent({
  name: 'offer.issued',
  module: 'offers',
  description: 'A unique code was issued to a guest for an offer.',
  properties: codeProps.extend({ source: z.string().describe('What issued it: flow:welcome, campaign:<id>, signup, staff …') }),
});

export const offerClaimed = defineEvent({
  name: 'offer.claimed',
  module: 'offers',
  description: 'The guest claimed their code (clicked through from the message, or asked for it on a sign-up page).',
  properties: codeProps.extend({ via: z.enum(['link', 'signup', 'redeem']) }),
});

export const offerRedeemed = defineEvent({
  name: 'offer.redeemed',
  module: 'offers',
  description: 'A code was used on a paid sale.',
  properties: codeProps.extend({
    via: z.enum(['online', 'till', 'staff']).describe('Online checkout, a till sale carrying the code, or staff marking it against a sale'),
    discount_cents: z.number().int().nullable(),
  }),
});

export const offerReleased = defineEvent({
  name: 'offer.released',
  module: 'offers',
  description: 'The sale a code was used on was cancelled or refunded in full, so the code can be used again.',
  properties: codeProps,
});

export const offerExpired = defineEvent({
  name: 'offer.expired',
  module: 'offers',
  description: 'A code passed its expiry unused.',
  properties: codeProps.extend({ claimed: z.boolean() }),
});

export const offerVoided = defineEvent({
  name: 'offer.voided',
  module: 'offers',
  description: 'A code was cancelled by the venue.',
  properties: codeProps,
});

export const offerRedemptionRefused = defineEvent({
  name: 'offer.redemption_refused',
  module: 'offers',
  description: 'A till sale carried a code that could not be redeemed (expired, already used, another guest\'s, or not valid at that venue). The discount was given at the till; the code was not marked used.',
  properties: codeProps.extend({ reason: z.enum(['expired', 'used', 'voided', 'other_customer', 'venue']), transaction_id: z.string() }),
});
