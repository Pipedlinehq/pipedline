import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/delivery.md "Config surface". Key names are the doc's. Extend
 * this schema; never hardcode a venue's choice.
 */

const cents = z.number().int().min(0).max(1_000_000);

/** What the guest pays for delivery, from what the courier charges the venue. */
const baseFeeRule = z.discriminatedUnion('kind', [
  /** The guest pays what the courier charges. */
  z.object({ kind: z.literal('pass_through').describe('"pass_through".') }).describe('The guest pays exactly what the courier charges the venue.'),
  /** The guest pays a flat fee whatever the courier charges. */
  z
    .object({ kind: z.literal('flat').describe('"flat".'), cents: cents.describe('The flat delivery fee the guest pays, in cents (800 is $8.00).') })
    .describe('The guest pays one flat fee whatever the courier charges; the venue keeps or covers the difference.'),
  /** The venue pays up to a cap of the courier's fee; the guest pays the rest. */
  z
    .object({
      kind: z.literal('subsidised').describe('"subsidised".'),
      venue_pays_up_to_cents: cents.describe('The most of the courier\'s fee the venue covers, in cents (500 is $5.00). The guest pays whatever is left.'),
    })
    .describe('The venue covers the courier\'s fee up to a cap; the guest pays the rest.'),
]).describe('One fee rule: "pass_through" (the guest pays the courier\'s fee), "flat" (one set fee) or "subsidised" (the venue covers the fee up to a cap).');
export const feeRule = z
  .union([
    baseFeeRule,
    /** Free at or above a spend (after discounts); otherwise the rule given. */
    z
      .object({
        kind: z.literal('free_above').describe('"free_above".'),
        threshold_cents: cents.describe('Delivery is free for an order of at least this much, in cents (5000 is $50.00), after discounts.'),
        otherwise: baseFeeRule.describe('The rule for orders below the threshold: pass_through, flat or subsidised.'),
      })
      .describe('Free delivery at or above a spend; below it, another rule applies.'),
  ])
  .describe('How the guest\'s delivery fee is worked out from what the courier charges the venue. "kind" is one of "pass_through" (the guest pays the courier\'s fee), "flat" (one set fee), "subsidised" (the venue covers the fee up to a cap) or "free_above" (free over a spend, otherwise one of the others).');
export type FeeRule = z.infer<typeof feeRule>;

export const deliveryConfig = z.object({
  /** Delivery offered at checkout. Off pauses it without touching zones or history. */
  delivery_enabled: z
    .boolean()
    .default(true)
    .describe('Whether delivery is offered at checkout. Off pauses delivery without touching the zones or past deliveries. Default on.'),
  /** Courier plug keys, preferred first. The next is the failover when the first has no courier. */
  providers: z
    .array(z.string().min(1).max(60).describe('The key of one courier service, as shown on the Connections page.'))
    .max(5)
    .default([])
    .describe('The courier services to book, most preferred first, by the key shown on the Connections page, e.g. "uber-direct", "doordash-drive". The next is tried when the first has no courier (see failover_to_next_provider). Up to five. Default: none.'),
  /** Used where a zone has no rule of its own. */
  fee_rule: feeRule
    .default({ kind: 'pass_through' })
    .describe('How the guest\'s delivery fee is set from what the courier charges, for zones that do not set a rule of their own. Default: the guest pays what the courier charges.'),
  /** Smallest order delivered, after discounts, where a zone sets none. */
  min_order_cents: cents
    .default(0)
    .describe('The smallest order delivered, in cents (2500 is $25.00), after discounts, for zones that set no minimum of their own. 0: no minimum. Default 0.'),
  /** A courier is asked for this long before the food is due to be ready, not at order time. */
  courier_request_lead_minutes: z
    .number()
    .int()
    .min(0)
    .max(180)
    .default(10)
    .describe('A courier is booked this many minutes before the food is due to be ready, not when the order comes in, so nobody waits around. Default 10.'),
  /** When the preferred provider has no courier, ask the next one. */
  failover_to_next_provider: z
    .boolean()
    .default(true)
    .describe('When the preferred courier service has no courier available, ask the next one listed in providers. Default on.'),
  /** No courier from any provider: refund the order in full, or offer the guest pickup and refund the delivery fee. */
  no_courier_fallback: z
    .enum(['refund', 'offer_pickup'])
    .default('refund')
    .describe('What happens when no courier service can take the delivery: "refund" the whole order, or "offer_pickup" (the guest is offered pickup instead and the delivery fee is refunded). Default "refund".'),
  /** A delivery that failed or was returned after pickup: what goes back to the guest. */
  failed_delivery_refund: z
    .enum(['full', 'delivery_fee', 'none'])
    .default('full')
    .describe('What goes back to the guest when a delivery fails or is returned after the courier picked it up: "full" (the whole order), "delivery_fee" (the fee only) or "none". Default "full".'),
  /** A cancellation fee charged by the courier after assignment: the venue absorbs it, or it comes off a refund to the guest. */
  cancellation_fee_policy: z
    .enum(['venue_absorbs', 'deduct_from_refund'])
    .default('venue_absorbs')
    .describe('When a courier that was already booked charges a fee for cancelling: "venue_absorbs" (the venue pays it) or "deduct_from_refund" (it comes off the guest\'s refund). Default "venue_absorbs".'),
  /** Alcohol needs ID at the door and a provider that supports it. Off by default. */
  alcohol_enabled: z
    .boolean()
    .default(false)
    .describe('Whether alcohol may be delivered. Needs a courier service that checks ID at the door. Default off.'),
  /** Food-safety limit: nothing is delivered further than this from the venue, whatever the zones say. */
  max_radius_m: z
    .number()
    .int()
    .min(100)
    .max(50_000)
    .default(8000)
    .describe('Food-safety limit: nothing is delivered further than this from the venue, in metres, whatever the zones say. Default 8000 (8 km).'),
  /** How the guest gets the tracking link and updates. auto = email if they gave one, else SMS. */
  tracking_channel: z
    .enum(['auto', 'email', 'sms', 'none'])
    .default('auto')
    .describe('How the guest gets their tracking link and progress updates: "auto" (email if they gave one, otherwise a text), "email", "sms" (a text) or "none". Default "auto".'),
});
export type DeliveryConfig = z.infer<typeof deliveryConfig>;

export const deliveryModule = defineModule({
  key: 'delivery',
  name: 'Delivery',
  description: 'First-party delivery: zones, courier quotes, dispatch timed to the kitchen, tracking.',
  dependsOn: ['ordering'],
  manifest: {
    name: 'Delivery',
    purpose: 'Delivery from the venue\'s own site: delivery zones, a courier price at checkout, a courier booked to arrive when the food is ready, and a tracking link for the guest.',
    category: 'channels',
    kind: 'channel',
    needs: ['A courier service connected', 'Delivery zones drawn around the venue'],
    reads: ['orders', 'the delivery address a guest gave for that order'],
    writes: ['deliveries and their progress', 'refunds when a delivery falls through', 'tracking messages to the guest'],
    publicAddress: ({ siteOrigin }) => (siteOrigin ? `${siteOrigin}/order` : null),
  },
  tables: ['delivery_zones', 'deliveries', 'delivery_status_history'],
  configSchema: deliveryConfig,
  configVersion: 1,
  defaultConfig: deliveryConfig.parse({}),
});

const status = z.enum(['quoted', 'requested', 'courier_assigned', 'picked_up', 'delivered', 'failed', 'returned', 'cancelled']);

export const deliveryQuoted = defineEvent({
  name: 'delivery.quoted',
  module: 'delivery',
  description: 'A guest checked an address at checkout and got a delivery price from a courier.',
  properties: z.object({ delivery_id: z.string(), provider: z.string(), courier_fee_cents: z.number().int(), customer_fee_cents: z.number().int() }),
});

export const deliveryRequested = defineEvent({
  name: 'delivery.requested',
  module: 'delivery',
  description: 'A courier was booked for an accepted delivery order, timed to the prep time.',
  properties: z.object({ delivery_id: z.string(), order_id: z.string(), provider: z.string(), failover: z.boolean(), courier_fee_cents: z.number().int() }),
});

export const deliveryStatusChanged = defineEvent({
  name: 'delivery.status_changed',
  module: 'delivery',
  description: 'The courier service reported a delivery moved on (assigned, picked up, delivered, failed, returned, cancelled).',
  properties: z.object({ delivery_id: z.string(), order_id: z.string().nullable(), from: status, to: status, source: z.enum(['webhook', 'reconcile', 'dispatch', 'venue']) }),
});

export const deliveryDelivered = defineEvent({
  name: 'delivery.delivered',
  module: 'delivery',
  description: 'A delivery reached the guest. The order is completed.',
  properties: z.object({ delivery_id: z.string(), order_id: z.string(), minutes_from_request: z.number().int().nullable() }),
});

export const deliveryFailed = defineEvent({
  name: 'delivery.failed',
  module: 'delivery',
  description: 'A delivery did not happen: no courier anywhere, or it failed, was returned or was cancelled by the courier service.',
  properties: z.object({ delivery_id: z.string(), order_id: z.string().nullable(), reason: z.string(), status, refund: z.enum(['full', 'delivery_fee', 'none', 'switched_to_pickup']) }),
});

export const deliveryCancelled = defineEvent({
  name: 'delivery.cancelled',
  module: 'delivery',
  description: 'The venue called off a courier because the order was cancelled or refunded. Carries any cancellation fee.',
  properties: z.object({ delivery_id: z.string(), order_id: z.string().nullable(), cancellation_fee_cents: z.number().int() }),
});
