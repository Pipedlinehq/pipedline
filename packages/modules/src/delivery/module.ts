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
  z.object({ kind: z.literal('pass_through') }),
  /** The guest pays a flat fee whatever the courier charges. */
  z.object({ kind: z.literal('flat'), cents }),
  /** The venue pays up to a cap of the courier's fee; the guest pays the rest. */
  z.object({ kind: z.literal('subsidised'), venue_pays_up_to_cents: cents }),
]);
export const feeRule = z.union([
  baseFeeRule,
  /** Free at or above a spend (after discounts); otherwise the rule given. */
  z.object({ kind: z.literal('free_above'), threshold_cents: cents, otherwise: baseFeeRule }),
]);
export type FeeRule = z.infer<typeof feeRule>;

export const deliveryConfig = z.object({
  /** Delivery offered at checkout. Off pauses it without touching zones or history. */
  delivery_enabled: z.boolean().default(true),
  /** Courier plug keys, preferred first. The next is the failover when the first has no courier. */
  providers: z.array(z.string().min(1).max(60)).max(5).default([]),
  /** Used where a zone has no rule of its own. */
  fee_rule: feeRule.default({ kind: 'pass_through' }),
  /** Smallest order delivered, after discounts, where a zone sets none. */
  min_order_cents: cents.default(0),
  /** A courier is asked for this long before the food is due to be ready, not at order time. */
  courier_request_lead_minutes: z.number().int().min(0).max(180).default(10),
  /** When the preferred provider has no courier, ask the next one. */
  failover_to_next_provider: z.boolean().default(true),
  /** No courier from any provider: refund the order in full, or offer the guest pickup and refund the delivery fee. */
  no_courier_fallback: z.enum(['refund', 'offer_pickup']).default('refund'),
  /** A delivery that failed or was returned after pickup: what goes back to the guest. */
  failed_delivery_refund: z.enum(['full', 'delivery_fee', 'none']).default('full'),
  /** A cancellation fee charged by the courier after assignment: the venue absorbs it, or it comes off a refund to the guest. */
  cancellation_fee_policy: z.enum(['venue_absorbs', 'deduct_from_refund']).default('venue_absorbs'),
  /** Alcohol needs ID at the door and a provider that supports it. Off by default. */
  alcohol_enabled: z.boolean().default(false),
  /** Food-safety limit: nothing is delivered further than this from the venue, whatever the zones say. */
  max_radius_m: z.number().int().min(100).max(50_000).default(8000),
  /** How the guest gets the tracking link and updates. auto = email if they gave one, else SMS. */
  tracking_channel: z.enum(['auto', 'email', 'sms', 'none']).default('auto'),
});
export type DeliveryConfig = z.infer<typeof deliveryConfig>;

export const deliveryModule = defineModule({
  key: 'delivery',
  name: 'Delivery',
  description: 'First-party delivery: zones, courier quotes, dispatch timed to the kitchen, tracking.',
  dependsOn: ['ordering'],
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
