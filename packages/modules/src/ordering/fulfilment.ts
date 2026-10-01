import { z } from 'zod';
import { type Ctx, assertModule, audit, conflict, enqueue, forbidden, isInternal, requireStaff } from '@ros/core';
import { orderingModule } from './module';
import { trackingUrl } from './notify';
import { TERMINAL, loadOrderByToken } from './orders';
import { flagOrder, refundOrderJob } from './payment';
import { type OrderRow, loadItems, loadOrder } from './rows';
import { updateOrderStatus } from './status';
import { moveOrder } from './tickets';

/**
 * What another module that fulfils an order (delivery) may ask of ordering, and do to an
 * order, without reading or writing the orders table itself (docs/MODULES.md contract item 4).
 * The writes are the platform's own consequences of something a courier or a job reported, so
 * they are for internal callers (workers, webhooks) only; each says so.
 */

export interface FulfilmentOrder {
  id: string;
  venueId: string;
  reference: string;
  channel: OrderRow['channel'];
  status: OrderRow['status'];
  paymentStatus: OrderRow['payment_status'];
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  promisedAt: Date | null;
  subtotalCents: number;
  discountCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  currency: string;
  containsAlcohol: boolean;
  /** The guest's tracking page for the order. */
  trackingUrl: string;
  items: Array<{ name: string; qty: number; unitPriceCents: number }>;
}

function requireInternal(ctx: Ctx): void {
  if (!isInternal(ctx)) throw forbidden('Only the platform does that.');
}

/** An order as a fulfilling module needs it. Internal callers, or staff of the order's venue. Another org's id is not found. */
export async function getOrderForFulfilment(ctx: Ctx, orderId: string): Promise<FulfilmentOrder> {
  const o = await loadOrder(ctx, z.string().uuid().parse(orderId));
  if (!isInternal(ctx)) requireStaff(ctx, { venueId: o.venue_id, minRole: 'read_only' });
  const items = await loadItems(ctx, o.id);
  return {
    id: o.id,
    venueId: o.venue_id,
    reference: o.reference,
    channel: o.channel,
    status: o.status,
    paymentStatus: o.payment_status,
    customerId: o.customer_id,
    customerName: o.customer_name,
    customerEmail: o.customer_email,
    customerPhone: o.customer_phone,
    promisedAt: o.promised_at,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    totalCents: o.total_cents,
    currency: o.currency,
    containsAlcohol: items.some((i) => i.is_alcohol),
    trackingUrl: await trackingUrl(ctx, o),
    items: items.map((i) => ({ name: i.name_snapshot, qty: i.qty, unitPriceCents: i.unit_price_cents })),
  };
}

/**
 * The money facts of an order, for the delivery module to keep beside its quote in the
 * transaction that creates the order. No role check and nothing personal: what the guest pays
 * for delivery, what the goods came to, and the customer id.
 */
export async function orderAmounts(ctx: Ctx, orderId: string): Promise<{ deliveryFeeCents: number; goodsCents: number; customerId: string | null; venueId: string }> {
  const o = await loadOrder(ctx, orderId);
  return { deliveryFeeCents: o.delivery_fee_cents, goodsCents: o.subtotal_cents - o.discount_cents, customerId: o.customer_id, venueId: o.venue_id };
}

/** The order a guest's tracking token names. Public: holding the token is the permission. Unknown or another org's: not found. */
export async function orderByTrackingToken(ctx: Ctx, token: string): Promise<{ orderId: string; venueId: string; channel: OrderRow['channel'] }> {
  const o = await loadOrderByToken(ctx, token);
  await assertModule(ctx, o.venue_id, orderingModule);
  return { orderId: o.id, venueId: o.venue_id, channel: o.channel };
}

/** The courier handed it over: the order is completed, one recorded step at a time. Internal only. */
export async function completeOrderByCourier(ctx: Ctx, orderId: string): Promise<void> {
  requireInternal(ctx);
  let order = await loadOrder(ctx, orderId, { lock: true });
  const chain: Array<OrderRow['status']> = ['accepted', 'preparing', 'ready', 'completed'];
  if (TERMINAL.includes(order.status) || order.status === 'completed') return;
  if (order.status === 'placed') order = await moveOrder(ctx, order, 'accepted');
  while (order.status !== 'completed') {
    const next = chain[chain.indexOf(order.status) + 1];
    if (!next) throw conflict('That order cannot be completed from where it is.');
    order = await moveOrder(ctx, order, next);
  }
}

/**
 * The order cannot be carried and the venue refunds rather than offering pickup: cancelled,
 * taken off the kitchen screen, the guest told why and refunded in full by the worker.
 * Internal only.
 */
export async function cancelUndeliverableOrder(ctx: Ctx, args: { orderId: string; reason: string }): Promise<void> {
  requireInternal(ctx);
  const order = await loadOrder(ctx, args.orderId);
  if (TERMINAL.includes(order.status) || order.status === 'completed' || order.status === 'pending_payment') return;
  await updateOrderStatus(ctx, { orderId: order.id, status: 'cancelled', reason: args.reason });
}

/** Send back part or all of what was paid for an order (a failed delivery, a delivery fee). Internal only; the worker sends it. */
export async function refundForDelivery(ctx: Ctx, args: { orderId: string; reason: string; key: string; amountCents?: number }): Promise<void> {
  requireInternal(ctx);
  const order = await loadOrder(ctx, args.orderId);
  if (order.payment_status !== 'paid' && order.payment_status !== 'partially_refunded') return;
  const amount = args.amountCents === undefined ? undefined : Math.min(args.amountCents, order.total_cents);
  if (amount !== undefined && amount <= 0) return;
  await enqueue(ctx, refundOrderJob, { orderId: order.id, reason: args.reason, key: args.key, ...(amount ? { amountCents: amount } : {}) }, { key: `refund:${args.key}` });
  await audit(ctx, { action: 'order.refund_requested', entityType: 'order', entityId: order.id, venueId: order.venue_id, after: { reason: args.reason, amountCents: amount ?? 'remaining', by: 'delivery' } });
}

/**
 * No courier can take a delivery order and the venue offers pickup instead: the order becomes
 * a pickup order (the guest is told when it is ready, as for any pickup). Internal only.
 */
export async function switchOrderToPickup(ctx: Ctx, args: { orderId: string; reason: string }): Promise<void> {
  requireInternal(ctx);
  const order = await loadOrder(ctx, args.orderId, { lock: true });
  if (order.channel !== 'delivery' || TERMINAL.includes(order.status)) return;
  await ctx.db.updateTable('orders').set({ channel: 'pickup' }).where('id', '=', order.id).execute();
  await ctx.db.updateTable('kitchen_tickets').set({ channel: 'pickup' }).where('order_id', '=', order.id).execute();
  await audit(ctx, { action: 'order.switched_to_pickup', entityType: 'order', entityId: order.id, venueId: order.venue_id, before: { channel: 'delivery' }, after: { channel: 'pickup', reason: args.reason } });
}

/** Put a paid order in front of staff with a reason. Internal only (staff flag things by talking to each other). */
export async function flagOrderForStaff(ctx: Ctx, args: { orderId: string; reason: string }): Promise<void> {
  requireInternal(ctx);
  const order = await loadOrder(ctx, args.orderId, { lock: true });
  await flagOrder(ctx, order, args.reason, 0);
}

/** A manager has dealt with a flagged order. Audited with what the flag said. */
export async function clearOrderAttention(ctx: Ctx, orderId: string): Promise<void> {
  const order = await loadOrder(ctx, z.string().uuid().parse(orderId), { lock: true });
  requireStaff(ctx, { venueId: order.venue_id, minRole: 'manager' });
  await assertModule(ctx, order.venue_id, orderingModule);
  if (!order.attention_at) return;
  await ctx.db.updateTable('orders').set({ attention_at: null }).where('id', '=', order.id).execute();
  await audit(ctx, { action: 'order.attention_cleared', entityType: 'order', entityId: order.id, venueId: order.venue_id, before: { reason: order.attention_reason } });
}
