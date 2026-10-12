import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/ordering.md section 6. Key names are the ones the doc and the
 * other pacing surfaces use, so a manager learns them once (docs/modules/kds.md section 8).
 * Extend this schema; never hardcode a venue's choice.
 */
export const orderingConfig = z.object({
  pickup_enabled: z
    .boolean()
    .default(true)
    .describe('Whether guests can order for pickup from the venue\'s site. Off pauses new pickup orders without changing any other setting. Default on.'),

  // Pacing: a kitchen has a throughput ceiling.
  slot_minutes: z
    .number()
    .int()
    .min(5)
    .max(120)
    .default(15)
    .describe('Pickup times are offered in steps of this many minutes, e.g. 12:00, 12:15, 12:30 with 15. Default 15.'),
  max_orders_per_slot: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(6)
    .describe('Kitchen pacing: the most orders that may be due in one pickup slot. A full slot is not offered to guests. Default 6.'),
  /** Units across all orders in a slot. Null = no item cap. */
  max_items_per_slot: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .nullable()
    .default(null)
    .describe('Kitchen pacing: the most items, counted across every order, that may be due in one pickup slot. Empty (the default): no item limit, only the order limit.'),
  /** The least time between an order and its pickup. A longer item prep time extends it. */
  lead_time_minutes: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .default(20)
    .describe('The least time between an order being placed and its pickup, in minutes. An item with a longer preparation time pushes it out further. Default 20.'),
  /** No pickup this close to the end of a trading period. */
  cutoff_before_close_minutes: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(15)
    .describe('No pickup time is offered this close to the end of a trading period, in minutes. Default 15.'),
  asap_enabled: z
    .boolean()
    .default(true)
    .describe('Whether guests may choose "as soon as possible" instead of a set pickup time. Table orders are always as soon as possible. Default on.'),
  /** How far ahead a pickup may be scheduled. 0 = today only. */
  max_days_ahead: z.number().int().min(0).max(30).default(2).describe('How many days ahead a pickup may be ordered. 0 means today only. Default 2.'),

  tipping_enabled: z.boolean().default(false).describe('Whether guests are offered a tip at checkout. Default off.'),
  /** Percentages offered at checkout. */
  tip_presets: z
    .array(z.number().int().min(0).max(100).describe('One tip choice, as a percentage of the order (0 to 100).'))
    .max(6)
    .default([5, 10, 15])
    .describe('The tip choices offered at checkout, as percentages of the order. Up to six. Default 5, 10 and 15.'),
  max_tip_percent: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(50)
    .describe('The largest tip accepted, as a percentage of the order. A guest typing a bigger one is asked to lower it. Default 50.'),

  min_order_cents: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('The smallest pickup order accepted, in cents (2000 is $20.00), before any discount. 0: no minimum. Default 0.'),
  /** Leave alcohol out of pickup and delivery orders (a venue without a takeaway licence). */
  exclude_alcohol: z
    .boolean()
    .default(false)
    .describe('Leave alcohol out of pickup and delivery orders, e.g. a venue without a takeaway licence. Default off.'),
  promo_codes_enabled: z.boolean().default(true).describe('Whether guests may enter an offer or reward code at checkout. Default on.'),

  /** Where a new order is announced. The screen is the kitchen order screen. */
  kitchen_routing: z
    .array(z.enum(['screen', 'email', 'sms']).describe('"screen", "email" or "sms".'))
    .default(['screen'])
    .describe('Where a new paid order is announced: "screen" (the kitchen order screen), "email" (sent to kitchen_email) and "sms" (a text to manager_sms). Any mix. Default: the screen only.'),
  kitchen_email: z
    .string()
    .email()
    .nullable()
    .default(null)
    .describe('The email address new paid orders are sent to when kitchen_routing includes "email". Empty: no email is sent.'),
  manager_sms: z
    .string()
    .min(6)
    .max(30)
    .nullable()
    .default(null)
    .describe('The mobile number texted about new paid orders when kitchen_routing includes "sms". Empty: no text is sent.'),
  /** The new-order alert on the screen repeats this often until someone acknowledges the ticket. */
  alert_repeat_seconds: z
    .number()
    .int()
    .min(5)
    .max(600)
    .default(30)
    .describe('How often the new-order alert repeats on the kitchen screen until someone taps the ticket, in seconds. Default 30.'),
  /** Accept paid orders without a person confirming them. */
  auto_accept: z
    .boolean()
    .default(false)
    .describe('Accept every paid order straight away, without a person pressing accept. Off: each order waits on the kitchen screen to be accepted or turned down. Default off.'),
  /** A paired kitchen screen may turn a paid order down. Off: only staff signed in can reject. */
  screen_can_reject: z
    .boolean()
    .default(true)
    .describe('Whether a paired kitchen screen may turn a paid order down. Off: only staff signed in to the console can. Default on.'),

  /** How long an unpaid order holds its slot before it is cancelled. */
  payment_hold_minutes: z
    .number()
    .int()
    .min(2)
    .max(120)
    .default(15)
    .describe('How long an order that has not been paid keeps its pickup slot before it is cancelled, in minutes. Default 15.'),
  /** When an unpaid checkout with a contact counts as "didn't finish". */
  abandoned_after_minutes: z
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(10)
    .describe('An order a guest started (with an email or phone) but had not paid after this many minutes is listed under "Didn\'t finish", where staff can send one nudge. Default 10.'),
});
export type OrderingConfig = z.infer<typeof orderingConfig>;

export const orderingModule = defineModule({
  key: 'ordering',
  name: 'Online ordering',
  description: 'Pickup and table orders: cart pricing, slot pacing, checkout, payment, status, the kitchen order screen.',
  dependsOn: [],
  manifest: {
    name: 'Online ordering',
    purpose: 'Pickup and table orders from the venue\'s own site: guests choose a time, pay online, and the docket appears on the kitchen screen. Orders are paced to what the kitchen can do.',
    category: 'channels',
    kind: 'channel',
    needs: ['A menu with prices', 'Opening hours', 'A payment account connected (Square), so guests can pay online', 'Someone watching the kitchen order screen, or auto_accept switched on'],
    reads: ['the menu', 'opening hours', 'guest records (a guest who orders is recorded)'],
    writes: ['orders and payments', 'kitchen dockets', 'sales (each paid order enters the sales record)', 'order confirmations and ready messages'],
    publicAddress: ({ siteOrigin }) => (siteOrigin ? `${siteOrigin}/order` : null),
  },
  tables: ['orders', 'order_items', 'order_status_history', 'payments', 'refunds', 'kitchen_tickets', 'ticket_events'],
  configSchema: orderingConfig,
  configVersion: 1,
  defaultConfig: orderingConfig.parse({}),
});

// ── Events. The order funnel continues from session.started (1) and menu.viewed (2). ──

const channel = z.enum(['pickup', 'delivery', 'dine-in-qr']);

export const cartItemAdded = defineEvent({
  name: 'cart.item_added',
  module: 'ordering',
  description: 'A guest added an item to their cart.',
  properties: z.object({ menu_item_id: z.string().uuid(), name: z.string().max(200), qty: z.number().int().min(1).max(99) }),
  client: true,
  funnel: { name: 'order', step: 3 },
});

export const cartItemRemoved = defineEvent({
  name: 'cart.item_removed',
  module: 'ordering',
  description: 'A guest took an item out of their cart.',
  properties: z.object({ menu_item_id: z.string().uuid(), name: z.string().max(200) }),
  client: true,
});

export const checkoutStarted = defineEvent({
  name: 'checkout.started',
  module: 'ordering',
  description: 'A guest opened the checkout with items in their cart.',
  properties: z.object({ channel, item_count: z.number().int().min(1).max(5000) }),
  client: true,
  funnel: { name: 'order', step: 4 },
});

export const orderPlaced = defineEvent({
  name: 'order.placed',
  module: 'ordering',
  description: 'A guest submitted an order. It is priced and holds its slot, and is waiting for payment.',
  properties: z.object({ order_id: z.string(), channel, total_cents: z.number().int(), item_count: z.number().int(), asap: z.boolean(), codes: z.number().int() }),
  funnel: { name: 'order', step: 5 },
});

export const paymentFailed = defineEvent({
  name: 'payment.failed',
  module: 'ordering',
  description: 'A card payment for an order was declined. Nothing reached the kitchen.',
  properties: z.object({ order_id: z.string(), reason: z.string() }),
});

export const orderPaid = defineEvent({
  name: 'order.paid',
  module: 'ordering',
  description: 'An order was paid and sent to the kitchen.',
  properties: z.object({
    order_id: z.string(),
    channel,
    total_cents: z.number().int(),
    discount_cents: z.number().int(),
    tip_cents: z.number().int(),
    identified: z.boolean().describe('Whether the order is tied to a known customer'),
  }),
  funnel: { name: 'order', step: 6 },
});

const orderRef = z.object({ order_id: z.string(), channel });

export const orderAccepted = defineEvent({ name: 'order.accepted', module: 'ordering', description: 'The venue accepted a paid order.', properties: orderRef.extend({ auto: z.boolean() }) });
export const orderPreparing = defineEvent({ name: 'order.preparing', module: 'ordering', description: 'The kitchen started on an order.', properties: orderRef });
export const orderReady = defineEvent({
  name: 'order.ready',
  module: 'ordering',
  description: 'An order is ready to collect or to take to the table.',
  properties: orderRef.extend({ minutes_from_paid: z.number().int().nullable(), minutes_late: z.number().int().nullable() }),
  funnel: { name: 'order', step: 7 },
});
export const orderCompleted = defineEvent({
  name: 'order.completed',
  module: 'ordering',
  description: 'An order was collected or handed over.',
  properties: orderRef,
  funnel: { name: 'order', step: 8 },
});
export const orderRecalled = defineEvent({ name: 'order.recalled', module: 'ordering', description: 'A completed order was put back to ready: the bump was a mis-tap.', properties: orderRef });
export const orderRejected = defineEvent({ name: 'order.rejected', module: 'ordering', description: 'The venue turned a paid order down. It is refunded in full.', properties: orderRef.extend({ reason: z.string() }) });
export const orderCancelled = defineEvent({
  name: 'order.cancelled',
  module: 'ordering',
  description: 'An order was cancelled: by the venue, by the guest before paying, or because it was never paid.',
  properties: orderRef.extend({ reason: z.string(), paid: z.boolean() }),
});
export const orderRefunded = defineEvent({
  name: 'order.refunded',
  module: 'ordering',
  description: 'Money for an order was returned to the guest, in full or in part.',
  properties: orderRef.extend({ refunded_cents: z.number().int(), full: z.boolean() }),
});

export const ticketAcknowledged = defineEvent({
  name: 'ticket.acknowledged',
  module: 'ordering',
  description: 'The kitchen acknowledged a new ticket, which stops the new-order alert.',
  properties: z.object({ ticket_id: z.string(), order_id: z.string(), seconds_to_acknowledge: z.number().int() }),
});

export const posPushed = defineEvent({
  name: 'order.pushed_to_pos',
  module: 'ordering',
  description: 'A paid order was put into the venue\'s own POS so it shows where staff already look.',
  properties: z.object({ order_id: z.string(), provider: z.string() }),
});

export const orderFlagged = defineEvent({
  name: 'order.flagged',
  module: 'ordering',
  description: 'A paid order needs a person to look at it: a discount the venue absorbed, a POS that could not take it, a delivery that fell through.',
  properties: z.object({ order_id: z.string(), reason: z.string(), absorbed_cents: z.number().int() }),
});

export const paymentReconciled = defineEvent({
  name: 'payment.reconciled',
  module: 'ordering',
  description: 'A card payment whose outcome was never heard was looked up at the processor and settled: charged, or not charged.',
  properties: z.object({ order_id: z.string(), outcome: z.enum(['charged', 'not_charged']) }),
});

// ── Didn't finish (docs/COMMERCE_ADMIN_PATTERNS.md pattern 7) ──────────────────

export const orderAbandoned = defineEvent({
  name: 'order.abandoned',
  module: 'ordering',
  description: 'A guest started an order and gave a contact but had not paid after the venue\'s "didn\'t finish" threshold. It is listed for staff, who may send one nudge.',
  properties: z.object({ order_id: z.string(), channel, total_cents: z.number().int(), minutes_since_started: z.number().int() }),
});

export const orderNudged = defineEvent({
  name: 'order.nudged',
  module: 'ordering',
  description: 'Staff sent the one nudge about an unfinished order: a transactional message to the guest about their own order. `status` is what the outbox did with it.',
  properties: z.object({ order_id: z.string(), via: z.enum(['email', 'sms']), status: z.enum(['queued', 'suppressed']) }),
});

export const orderRecovered = defineEvent({
  name: 'order.recovered',
  module: 'ordering',
  description: 'An unfinished order was recovered: the guest paid it after all, or placed and paid a new order at the venue.',
  properties: z.object({ order_id: z.string(), by: z.enum(['same_order', 'new_order']), recovered_order_id: z.string() }),
});

export const orderPurged = defineEvent({
  name: 'order.purged',
  module: 'ordering',
  description: 'An unfinished order three months old had the guest\'s details removed and left the "Didn\'t finish" list.',
  properties: z.object({ order_id: z.string() }),
});

// ── Phone and function orders (pattern 10) ─────────────────────────────────────

export const orderDrafted = defineEvent({
  name: 'order.drafted',
  module: 'ordering',
  description: 'Staff built an order by hand for a guest who phoned or asked in person, or for a function. Nothing is charged until the guest pays the link or staff mark it paid.',
  properties: z.object({ order_id: z.string(), channel, total_cents: z.number().int(), item_count: z.number().int(), custom_items: z.number().int(), has_hold: z.boolean() }),
});

export const payLinkSent = defineEvent({
  name: 'order.pay_link_sent',
  module: 'ordering',
  description: 'Staff sent the guest a link to pay for a phone or function order on the venue\'s own order page.',
  properties: z.object({ order_id: z.string(), via: z.enum(['email', 'sms']) }),
});

export const orderMarkedPaid = defineEvent({
  name: 'order.marked_paid',
  module: 'ordering',
  description: 'A manager marked a phone or function order as paid by other means (cash, bank transfer). It enters the sales record and goes to the kitchen like a card payment.',
  properties: z.object({ order_id: z.string(), method: z.enum(['cash', 'bank', 'other']), total_cents: z.number().int() }),
});

export const draftExpired = defineEvent({
  name: 'order.draft_expired',
  module: 'ordering',
  description: 'A phone or function order left untouched for a year was cleared.',
  properties: z.object({ order_id: z.string() }),
});
