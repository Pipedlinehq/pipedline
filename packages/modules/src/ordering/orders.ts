import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type Ctx,
  ROLE_RANK,
  actorOf,
  addMinutes,
  assertModule,
  conflict,
  defineJob,
  enqueue,
  forbidden,
  invalid,
  isInternal,
  json,
  newCode,
  notFound,
  rateLimit,
  requireGuest,
  requireStaff,
  staffOf,
  visibleVenueIds,
} from '@ros/core';
import { getSessionAttribution, linkSessionToCustomer, trackInSession, type SessionAttribution } from '../events/sessions';
import { grantConsent } from '../identity/consents';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import { type Acquisition, resolveCustomer } from '../identity/resolve';
import { getVenue } from '../tenancy/venues';
import { type OrderStatus, getDeliveryPricing, getTableOrdering, orderStatusHandlers } from './contract';
import {
  orderAccepted,
  orderCancelled,
  orderCompleted,
  orderingModule,
  orderPlaced,
  orderPreparing,
  orderReady,
  orderRecalled,
  orderRejected,
} from './module';
import { notifyGuest } from './notify';
import { buildCart, cartInput } from './pricing';
import { type OrderItemRow, type OrderRow, adjustmentsOf, firstName, frozenModifiers, loadItems, loadOrder, snapshot } from './rows';
import { lockVenueSlots } from './slots';

const WORKER = { kind: 'worker' as const, job: 'ordering' };

// ── Status: one place every change goes through ─────────────────────────────

const NEXT: Record<OrderStatus, OrderStatus[]> = {
  draft: ['pending_payment', 'cancelled'],
  pending_payment: ['placed', 'cancelled'],
  placed: ['accepted', 'rejected', 'cancelled', 'refunded'],
  accepted: ['preparing', 'cancelled', 'refunded'],
  preparing: ['ready', 'cancelled', 'refunded'],
  ready: ['completed', 'cancelled', 'refunded'],
  // Back to ready only as a recall: bumps are mis-tapped constantly on a busy line.
  completed: ['ready', 'refunded'],
  rejected: [],
  cancelled: [],
  refunded: [],
};

const PLAIN: Record<OrderStatus, string> = {
  draft: 'a draft',
  pending_payment: 'waiting for payment',
  placed: 'waiting to be accepted',
  accepted: 'accepted',
  preparing: 'being prepared',
  ready: 'ready',
  completed: 'completed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

export const TERMINAL: OrderStatus[] = ['rejected', 'cancelled', 'refunded'];

export interface TransitionOptions {
  reason?: string | null;
  /** True when the platform moved it without a person (auto_accept). */
  auto?: boolean;
}

/**
 * Move an order to a new status: the row, its history, the handlers other modules registered
 * (ordering/contract.ts), the event, and the ready notice, all in this transaction. No role
 * check: callers are the service functions in this module, each of which has made its own.
 */
export async function transition(ctx: Ctx, order: OrderRow, to: OrderStatus, opts: TransitionOptions = {}): Promise<{ order: OrderRow; historyId: string | null }> {
  const from = order.status;
  if (from === to) return { order, historyId: null };
  if (!NEXT[from].includes(to)) throw conflict(`This order is ${PLAIN[from]}, so it cannot be marked ${PLAIN[to]}.`);
  const now = ctx.now();
  const actor = actorOf(ctx.principal);

  const updated = await ctx.db
    .updateTable('orders')
    .set({
      status: to,
      ...(to === 'placed' ? { placed_at: now } : {}),
      ...(to === 'accepted' ? { accepted_at: now } : {}),
      ...(to === 'ready' ? { ready_at: from === 'completed' ? order.ready_at : now, completed_at: null } : {}),
      ...(to === 'completed' ? { completed_at: now } : {}),
      ...(to === 'cancelled' ? { cancelled_at: now } : {}),
      ...(to === 'rejected' || to === 'cancelled' ? { rejected_reason: opts.reason ?? null } : {}),
    })
    .where('id', '=', order.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const history = await ctx.db
    .insertInto('order_status_history')
    .values({ org_id: ctx.orgId, order_id: order.id, from_status: from, to_status: to, at: now, by_kind: actor.kind, by_id: actor.id, reason: opts.reason ?? null })
    .returning('id')
    .executeTakeFirstOrThrow();

  for (const handler of orderStatusHandlers()) await handler(ctx, snapshot(updated), { from, to });

  const at = { venueId: updated.venue_id, customerId: updated.customer_id, sessionId: updated.session_id };
  const ref = { order_id: updated.id, channel: updated.channel };
  if (to === 'accepted') await trackInSession(ctx, orderAccepted, { ...ref, auto: opts.auto ?? false }, at);
  else if (to === 'preparing') await trackInSession(ctx, orderPreparing, ref, at);
  else if (to === 'completed') await trackInSession(ctx, orderCompleted, ref, at);
  else if (to === 'rejected') await trackInSession(ctx, orderRejected, { ...ref, reason: opts.reason ?? '' }, at);
  else if (to === 'cancelled') await trackInSession(ctx, orderCancelled, { ...ref, reason: opts.reason ?? '', paid: updated.payment_status !== 'unpaid' && updated.payment_status !== 'failed' }, at);
  else if (to === 'ready' && from === 'completed') await trackInSession(ctx, orderRecalled, ref, at);
  else if (to === 'ready') {
    const minutes = (a: Date | null, b: Date) => (a ? Math.round((b.getTime() - a.getTime()) / 60_000) : null);
    await trackInSession(ctx, orderReady, { ...ref, minutes_from_paid: minutes(updated.placed_at, now), minutes_late: minutes(updated.promised_at, now) }, at);
    // Pickup only: a table order is carried over, and delivery tells the guest itself.
    if (updated.channel === 'pickup') {
      const venue = await getVenue(ctx, updated.venue_id);
      const where = [venue.addressLine1, venue.suburb].filter(Boolean).join(', ');
      await notifyGuest(ctx, updated, 'order.ready', { first_name: firstName(updated), venue_name: venue.name, reference: updated.reference, where_line: where }, 'ready');
    }
  }
  return { order: updated, historyId: history.id };
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface OrderItemView {
  menuItemId: string | null;
  name: string;
  category: string | null;
  qty: number;
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: Array<{ group: string; name: string; priceDeltaCents: number }>;
  /** Guest-written. Text, never markup. */
  note: string | null;
  allergens: string[];
  isAlcohol: boolean;
}

export interface OrderView {
  id: string;
  venueId: string;
  reference: string;
  channel: OrderRow['channel'];
  status: OrderStatus;
  paymentStatus: OrderRow['payment_status'];
  requestedAsap: boolean;
  pickupSlotStart: Date | null;
  pickupSlotEnd: Date | null;
  promisedAt: Date | null;
  tableLabel: string | null;
  tableSessionId: string | null;
  items: OrderItemView[];
  itemCount: number;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  refundedCents: number;
  currency: string;
  adjustments: Array<{ adjuster: string; code: string; label: string; amountCents: number }>;
  customerId: string | null;
  customerName: string | null;
  /** Null for staff roles that do not deal with guests. */
  customerEmail: string | null;
  customerPhone: string | null;
  /** Guest-written. Text, never markup. */
  customerNote: string | null;
  flags: string[];
  rejectedReason: string | null;
  posOrderRef: string | null;
  /** Why staff should look at this order, or null. e.g. a discount the venue absorbed. */
  attentionReason: string | null;
  attentionAt: Date | null;
  /** A discount the guest was shown and kept, whose code another order used first. The venue bears it. */
  absorbedDiscountCents: number;
  createdAt: Date;
  placedAt: Date | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
  /** The guest's handle on the order. Whoever holds it can follow the order and pay for it. */
  trackingToken: string | null;
}

const itemView = (i: OrderItemRow): OrderItemView => ({
  menuItemId: i.menu_item_id,
  name: i.name_snapshot,
  category: i.category_snapshot,
  qty: i.qty,
  unitPriceCents: i.unit_price_cents,
  lineTotalCents: i.line_total_cents,
  modifiers: frozenModifiers(i).map((m) => ({ group: m.group, name: m.name, priceDeltaCents: m.price_delta_cents })),
  note: i.note,
  allergens: i.allergens,
  isAlcohol: i.is_alcohol,
});

function orderView(o: OrderRow, items: OrderItemRow[], refundedCents: number, contacts: boolean): OrderView {
  return {
    id: o.id,
    venueId: o.venue_id,
    reference: o.reference,
    channel: o.channel,
    status: o.status,
    paymentStatus: o.payment_status,
    requestedAsap: o.requested_asap,
    pickupSlotStart: o.pickup_slot_start,
    pickupSlotEnd: o.pickup_slot_end,
    promisedAt: o.promised_at,
    tableLabel: o.table_label,
    tableSessionId: o.table_session_id,
    items: items.map(itemView),
    itemCount: o.item_count,
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    taxCents: o.tax_cents,
    tipCents: o.tip_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    totalCents: o.total_cents,
    refundedCents,
    currency: o.currency,
    adjustments: adjustmentsOf(o).map((a) => ({ adjuster: a.adjuster, code: a.code, label: a.label, amountCents: a.amountCents })),
    customerId: o.customer_id,
    customerName: o.customer_name,
    customerEmail: contacts ? o.customer_email : null,
    customerPhone: contacts ? o.customer_phone : null,
    customerNote: o.customer_note,
    flags: o.flags,
    rejectedReason: o.rejected_reason,
    posOrderRef: o.pos_order_ref,
    attentionReason: o.attention_reason,
    attentionAt: o.attention_at,
    absorbedDiscountCents: o.absorbed_discount_cents,
    createdAt: o.created_at,
    placedAt: o.placed_at,
    acceptedAt: o.accepted_at,
    readyAt: o.ready_at,
    completedAt: o.completed_at,
    trackingToken: contacts ? o.tracking_token : null,
  };
}

async function refundedFor(ctx: Ctx, orderIds: string[]): Promise<Map<string, number>> {
  if (!orderIds.length) return new Map();
  const rows = await ctx.db
    .selectFrom('payments')
    .select((eb) => ['order_id', eb.fn.sum<number>('refunded_cents').as('refunded')])
    .where('order_id', 'in', orderIds)
    .groupBy('order_id')
    .execute();
  return new Map(rows.map((r) => [r.order_id!, Number(r.refunded ?? 0)]));
}

/** Kitchen and read-only roles see what to cook and what it came to, not how to contact the guest. */
function seesContacts(ctx: Ctx, venueId: string): boolean {
  if (isInternal(ctx)) return true;
  const staff = staffOf(ctx);
  if (!staff) return false;
  const role = staff.venueRoles[venueId];
  return !!role && (role === 'front_of_house' || role === 'host' || ROLE_RANK[role] >= ROLE_RANK.manager);
}

/** The view of an order for whoever just created or paid for it (they hold its token already). */
export async function ownOrderView(ctx: Ctx, order: OrderRow): Promise<OrderView> {
  const refunded = await refundedFor(ctx, [order.id]);
  return orderView(order, await loadItems(ctx, order.id), refunded.get(order.id) ?? 0, true);
}

/** One order, for the console. Staff at the order's venue. */
export async function getOrder(ctx: Ctx, orderId: string): Promise<OrderView> {
  const order = await loadOrder(ctx, z.string().uuid().parse(orderId));
  requireStaff(ctx, { venueId: order.venue_id, minRole: 'read_only' });
  await assertModule(ctx, order.venue_id, orderingModule);
  const refunded = await refundedFor(ctx, [order.id]);
  return orderView(order, await loadItems(ctx, order.id), refunded.get(order.id) ?? 0, seesContacts(ctx, order.venue_id));
}

const STATUS = z.enum(['draft', 'pending_payment', 'placed', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled', 'refunded']);

export const listOrdersInput = z.object({
  venueId: z.string().uuid(),
  statuses: z.array(STATUS).max(10).optional(),
  /** True = paid orders still in the kitchen's hands: placed, accepted, preparing, ready. */
  live: z.boolean().optional(),
  channel: z.enum(['pickup', 'delivery', 'dine-in-qr']).optional(),
  from: z.date().optional(),
  to: z.date().optional(),
  tableSessionId: z.string().uuid().optional(),
  /** True = only orders flagged for staff to look at. */
  needsAttention: z.boolean().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  /** created_at of the last row of the previous page. */
  before: z.date().optional(),
});

/** The console's order list, newest first. Unpaid checkouts are left out unless asked for by status. */
export async function listOrders(ctx: Ctx, raw: z.input<typeof listOrdersInput>): Promise<OrderView[]> {
  const input = listOrdersInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  await assertModule(ctx, input.venueId, orderingModule);
  let q = ctx.db.selectFrom('orders').selectAll().where('venue_id', '=', input.venueId).orderBy('created_at', 'desc').limit(input.limit);
  if (input.statuses?.length) q = q.where('status', 'in', input.statuses);
  else if (input.live) q = q.where('status', 'in', ['placed', 'accepted', 'preparing', 'ready']);
  else q = q.where('status', 'not in', ['draft', 'pending_payment']);
  if (input.channel) q = q.where('channel', '=', input.channel);
  if (input.from) q = q.where('created_at', '>=', input.from);
  if (input.to) q = q.where('created_at', '<', input.to);
  if (input.before) q = q.where('created_at', '<', input.before);
  if (input.tableSessionId) q = q.where('table_session_id', '=', input.tableSessionId);
  if (input.needsAttention) q = q.where('attention_at', 'is not', null);
  const orders = await q.execute();
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const items = await ctx.db.selectFrom('order_items').selectAll().where('order_id', 'in', ids).orderBy('line_no').execute();
  const refunded = await refundedFor(ctx, ids);
  const contacts = seesContacts(ctx, input.venueId);
  return orders.map((o) => orderView(o, items.filter((i) => i.order_id === o.id), refunded.get(o.id) ?? 0, contacts));
}

export interface TrackedOrder {
  reference: string;
  venueId: string;
  venueName: string;
  channel: OrderRow['channel'];
  status: OrderStatus;
  paymentStatus: OrderRow['payment_status'];
  /** True while the order is waiting for a card. */
  awaitingPayment: boolean;
  requestedAsap: boolean;
  promisedAt: Date | null;
  pickupSlotStart: Date | null;
  pickupSlotEnd: Date | null;
  tableLabel: string | null;
  firstName: string | null;
  items: OrderItemView[];
  subtotalCents: number;
  discountCents: number;
  adjustments: Array<{ label: string; amountCents: number }>;
  taxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  refundedCents: number;
  currency: string;
  rejectedReason: string | null;
  createdAt: Date;
  placedAt: Date | null;
  acceptedAt: Date | null;
  readyAt: Date | null;
  completedAt: Date | null;
}

const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{32,64}$/);

export async function loadOrderByToken(ctx: Ctx, token: string, opts: { lock?: boolean } = {}): Promise<OrderRow> {
  const parsed = TOKEN.safeParse(token);
  if (!parsed.success) throw notFound('Order not found');
  let q = ctx.db.selectFrom('orders').selectAll().where('tracking_token', '=', parsed.data);
  if (opts.lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Order not found');
  return row;
}

/**
 * Order tracking for the guest, by the unguessable token in their confirmation link. No sign-in:
 * holding the token is the permission. It shows the order and nothing else about the guest.
 */
export async function trackOrder(ctx: Ctx, token: string): Promise<TrackedOrder> {
  // A tracking page polls; a script guessing tokens does not get far.
  if (!isInternal(ctx) && ctx.ip) await rateLimit(ctx.app, `track:ip:${ctx.ip}`, { limit: 120, windowSeconds: 600 }, 'Too many requests from this device. Try again shortly.');
  const o = await loadOrderByToken(ctx, token);
  await assertModule(ctx, o.venue_id, orderingModule);
  if (!isInternal(ctx)) await rateLimit(ctx.app, `track:venue:${o.venue_id}`, { limit: 6000, windowSeconds: 600 });
  const venue = await getVenue(ctx, o.venue_id);
  const refunded = await refundedFor(ctx, [o.id]);
  return {
    reference: o.reference,
    venueId: o.venue_id,
    venueName: venue.name,
    channel: o.channel,
    status: o.status,
    paymentStatus: o.payment_status,
    awaitingPayment: o.status === 'pending_payment',
    requestedAsap: o.requested_asap,
    promisedAt: o.promised_at,
    pickupSlotStart: o.pickup_slot_start,
    pickupSlotEnd: o.pickup_slot_end,
    tableLabel: o.table_label,
    firstName: o.customer_name ? firstName(o) : null,
    items: (await loadItems(ctx, o.id)).map(itemView),
    subtotalCents: o.subtotal_cents,
    discountCents: o.discount_cents,
    adjustments: adjustmentsOf(o).map((a) => ({ label: a.label, amountCents: a.amountCents })),
    taxCents: o.tax_cents,
    tipCents: o.tip_cents,
    deliveryFeeCents: o.delivery_fee_cents,
    totalCents: o.total_cents,
    refundedCents: refunded.get(o.id) ?? 0,
    currency: o.currency,
    rejectedReason: o.rejected_reason,
    createdAt: o.created_at,
    placedAt: o.placed_at,
    acceptedAt: o.accepted_at,
    readyAt: o.ready_at,
    completedAt: o.completed_at,
  };
}

export interface MyOrder {
  reference: string;
  venueId: string;
  channel: OrderRow['channel'];
  status: OrderStatus;
  paymentStatus: OrderRow['payment_status'];
  createdAt: Date;
  promisedAt: Date | null;
  tableLabel: string | null;
  items: Array<{ name: string; qty: number }>;
  itemCount: number;
  totalCents: number;
  currency: string;
  /** The guest's own handle on the order, for its tracking page. */
  trackingToken: string;
}

export const myOrdersInput = z.object({ limit: z.number().int().min(1).max(100).default(20), before: z.coerce.date().optional() });

/**
 * The signed-in guest's own orders, newest first, for their account page. It takes no customer
 * id: a guest can only ever read the orders their session belongs to.
 */
export async function listMyOrders(ctx: Ctx, raw: z.input<typeof myOrdersInput> = {}): Promise<MyOrder[]> {
  const input = myOrdersInput.parse(raw);
  const customerId = requireGuest(ctx);
  let q = ctx.db
    .selectFrom('orders')
    .selectAll()
    .where('customer_id', '=', customerId)
    .where('status', '!=', 'draft')
    .where('tracking_token', 'is not', null)
    .orderBy('created_at', 'desc')
    .limit(input.limit);
  if (input.before) q = q.where('created_at', '<', input.before);
  const orders = await q.execute();
  if (!orders.length) return [];
  const items = await ctx.db
    .selectFrom('order_items')
    .select(['order_id', 'name_snapshot', 'qty'])
    .where('order_id', 'in', orders.map((o) => o.id))
    .orderBy('line_no')
    .execute();
  return orders.map((o) => ({
    reference: o.reference,
    venueId: o.venue_id,
    channel: o.channel,
    status: o.status,
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    promisedAt: o.promised_at,
    tableLabel: o.table_label,
    items: items.filter((i) => i.order_id === o.id).map((i) => ({ name: i.name_snapshot, qty: i.qty })),
    itemCount: o.item_count,
    totalCents: o.total_cents,
    currency: o.currency,
    trackingToken: o.tracking_token!,
  }));
}

/** What a table has ordered across its rounds, for the qr module (which does not read orders). */
export async function tableSessionTotals(ctx: Ctx, sessionIds: string[]): Promise<Map<string, { orders: number; totalCents: number; lastOrderAt: Date | null }>> {
  const out = new Map<string, { orders: number; totalCents: number; lastOrderAt: Date | null }>();
  if (!sessionIds.length) return out;
  const visible = visibleVenueIds(ctx);
  let q = ctx.db
    .selectFrom('orders')
    .select((eb) => ['table_session_id', eb.fn.countAll<number>().as('orders'), eb.fn.sum<number>('total_cents').as('total'), eb.fn.max('placed_at').as('last')])
    .where('table_session_id', 'in', sessionIds)
    .where('status', 'in', ['placed', 'accepted', 'preparing', 'ready', 'completed'])
    .groupBy('table_session_id');
  if (visible) {
    if (!visible.length) return out;
    q = q.where('venue_id', 'in', visible);
  }
  for (const r of await q.execute()) out.set(r.table_session_id!, { orders: Number(r.orders), totalCents: Number(r.total ?? 0), lastOrderAt: r.last ?? null });
  return out;
}

// ── Checkout ─────────────────────────────────────────────────────────────────

const PURPOSES = ['card_recognition', 'marketing_email', 'marketing_sms', 'ad_platform_sharing'] as const;

export const createOrderInput = cartInput.extend({
  /** Made once by the browser for this checkout. The same key always answers with the same order. */
  idempotencyKey: z.string().min(16).max(100),
  customer: z
    .object({
      name: z.string().trim().max(100).nullish(),
      email: z.string().trim().max(254).nullish(),
      phone: z.string().trim().max(30).nullish(),
    })
    .default({}),
  /** Guest-written. Shown to the kitchen as text. */
  note: z.string().trim().max(500).nullish(),
  /** The visitor session, for attribution. */
  sessionId: z.string().uuid().nullish(),
  /** One entry per box the guest ticked, with the wording version they were shown. */
  consents: z.array(z.object({ purpose: z.enum(PURPOSES), wordingVersion: z.string().max(40).optional() })).max(4).default([]),
  /** Choices another module acts on, e.g. 'loyalty_join'. Stored and passed on, not interpreted. */
  flags: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)).max(10).default([]),
});

function acquisitionFrom(s: SessionAttribution | null, qrCodeId: string | null): Acquisition | undefined {
  if (!s) return qrCodeId ? { source: 'qr', qrCodeId } : undefined;
  const utm = (s.utmSource ?? '').toLowerCase();
  const source = s.creatorId
    ? 'criota'
    : /meta|facebook|instagram/.test(utm)
      ? 'meta'
      : utm.includes('google')
        ? 'google'
        : (s.qrCodeId ?? qrCodeId)
          ? 'qr'
          : utm
            ? 'referral'
            : 'organic';
  return { source, creatorId: s.creatorId, campaignId: s.campaignId, code: s.code, landingPath: s.landingPath, qrCodeId: s.qrCodeId ?? qrCodeId };
}

async function newReference(ctx: Ctx, venueId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reference = newCode(attempt < 5 ? 5 : 8);
    const taken = await ctx.db.selectFrom('orders').select('id').where('venue_id', '=', venueId).where('reference', '=', reference).executeTakeFirst();
    if (!taken) return reference;
  }
  throw conflict('Could not give the order a reference. Try again.');
}

/**
 * Checkout, step one: the order is priced by the server, the guest is resolved, the boxes they
 * ticked are recorded, and the order holds its slot while it waits for payment. Nothing is
 * charged and nothing reaches the kitchen here (docs/THREAT_MODEL.md section 6). Replaying the
 * same idempotency key returns the same order.
 */
export async function createOrder(ctx: Ctx, raw: z.input<typeof createOrderInput>): Promise<OrderView> {
  const input = createOrderInput.parse(raw);
  const p = ctx.principal;
  if (p.kind === 'device') throw forbidden('This screen cannot place orders.');
  if (staffOf(ctx)) requireStaff(ctx, { venueId: input.venueId, minRole: 'kitchen' });
  const cfg = await assertModule(ctx, input.venueId, orderingModule);

  // One checkout at a time per venue: a slot cannot be oversold, and a double-submitted form
  // finds the order its first copy made rather than racing it.
  await lockVenueSlots(ctx, input.venueId);
  const existing = await ctx.db.selectFrom('orders').selectAll().where('idempotency_key', '=', input.idempotencyKey).executeTakeFirst();
  if (existing) {
    if (existing.venue_id !== input.venueId) throw conflict('That checkout has already been used.');
    return ownOrderView(ctx, existing);
  }

  if (!isInternal(ctx)) {
    if (ctx.ip) await rateLimit(ctx.app, `order:ip:${ctx.ip}`, { limit: 20, windowSeconds: 600 }, 'Too many orders from this device. Try again shortly.');
    await rateLimit(ctx.app, `order:venue:${input.venueId}`, { limit: 600, windowSeconds: 600 });
  }

  // Who is ordering.
  let name = input.customer.name?.length ? input.customer.name : null;
  let email: string | null = null;
  let phone: string | null = null;
  if (input.customer.email) {
    email = normaliseEmail(input.customer.email);
    if (!email) throw invalid('That email address does not look right.');
  }
  if (input.customer.phone) {
    phone = normalisePhone(input.customer.phone);
    if (!phone) throw invalid('That phone number does not look right.');
  }

  const sessionId = input.sessionId ?? (p.kind === 'anon' ? (p.sessionId ?? null) : null);
  const session = await getSessionAttribution(ctx, sessionId);
  let qrCodeId: string | null = null;
  if (input.channel === 'dine-in-qr') {
    const tables = getTableOrdering();
    if (!tables || !input.qrCode) throw notFound('That table code was not found.');
    qrCodeId = (await tables.resolveForOrder(ctx, { venueId: input.venueId, code: input.qrCode })).qrCodeId;
  }

  let customerId: string | null = null;
  if (p.kind === 'guest') {
    customerId = p.customerId;
    const c = await ctx.db.selectFrom('customers').select(['first_name', 'last_name', 'primary_email', 'primary_phone', 'status']).where('id', '=', customerId).executeTakeFirst();
    if (!c || c.status !== 'active') throw notFound('Customer not found');
    name ??= [c.first_name, c.last_name].filter(Boolean).join(' ') || null;
    email ??= c.primary_email;
    phone ??= c.primary_phone;
  } else if (email || phone) {
    const [first, ...rest] = (name ?? '').split(/\s+/).filter(Boolean);
    const resolved = await resolveCustomer(ctx, {
      hints: [...(email ? [{ kind: 'email' as const, value: email }] : []), ...(phone ? [{ kind: 'phone' as const, value: phone }] : [])],
      via: input.channel === 'dine-in-qr' ? 'qr-order' : 'online-order',
      venueId: input.venueId,
      profile: { firstName: first ?? null, lastName: rest.join(' ') || null },
      acquisition: acquisitionFrom(session, qrCodeId),
    });
    customerId = resolved.customerId;
  }
  // A pickup needs someone to tell when it is ready. A table order does not: the guest is at the table.
  if (input.channel !== 'dine-in-qr' && (!name || (!email && !phone))) {
    throw invalid('Add your name and a phone number or email so we can tell you when your order is ready.');
  }

  // Price it and check capacity.
  const cart = await buildCart(ctx, input, { customerId });
  if (cart.rejectedCodes.length) throw invalid(cart.rejectedCodes[0]!.reason, { rejectedCodes: cart.rejectedCodes });
  if (cart.issues.length || !cart.timing) throw invalid(cart.issues[0]?.message ?? 'That order cannot be placed right now.', { issues: cart.issues });

  // The boxes the guest ticked. Each needs someone to attach it to, and the address it is about.
  for (const c of input.consents) {
    if (!customerId) throw invalid('Add an email address or phone number so we can remember that choice.');
    if (c.purpose === 'marketing_email' && !email) throw invalid('Add an email address to get offers by email.');
    if (c.purpose === 'marketing_sms' && !phone) throw invalid('Add a mobile number to get offers by SMS.');
    if (c.wordingVersion) {
      // The record must name words that were really shown: a version the client made up is refused.
      const shown = await ctx.db.selectFrom('consent_wordings').select('id').where('purpose', '=', c.purpose).where('version', '=', c.wordingVersion).executeTakeFirst();
      if (!shown) throw invalid('That page is out of date. Reload it and try again.');
    }
  }

  let tableSessionId: string | null = null;
  const table = cart.tableContext;
  if (table?.tableLabel) tableSessionId = await getTableOrdering()!.openSession(ctx, { venueId: input.venueId, qrCodeId: table.qrCodeId, tableLabel: table.tableLabel });

  const now = ctx.now();
  const order = await ctx.db
    .insertInto('orders')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      customer_id: customerId,
      reference: await newReference(ctx, input.venueId),
      channel: input.channel,
      status: 'pending_payment',
      payment_status: 'unpaid',
      requested_asap: cart.timing.requestedAsap,
      pickup_slot_start: cart.timing.slotStart,
      pickup_slot_end: cart.timing.slotEnd,
      promised_at: cart.timing.promisedAt,
      table_session_id: tableSessionId,
      table_label: table?.tableLabel ?? null,
      qr_code_id: table?.qrCodeId ?? null,
      subtotal_cents: cart.subtotalCents,
      discount_cents: cart.discountCents,
      tax_cents: cart.taxCents,
      tip_cents: cart.tipCents,
      delivery_fee_cents: cart.deliveryFeeCents,
      total_cents: cart.totalCents,
      currency: cart.currency,
      promo_code: cart.adjustments[0]?.code ?? null,
      adjustments: json(cart.adjustments),
      flags: [...new Set(input.flags)],
      customer_name: name,
      customer_email: email,
      customer_phone: phone,
      customer_note: input.note?.length ? input.note : null,
      session_id: session ? sessionId : null,
      idempotency_key: input.idempotencyKey,
      tracking_token: randomBytes(24).toString('base64url'),
      item_count: cart.itemCount,
      created_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  await ctx.db
    .insertInto('order_items')
    .values(
      cart.lines.map((l, i) => ({
        org_id: ctx.orgId,
        order_id: order.id,
        line_no: i + 1,
        menu_item_id: l.menuItemId,
        name_snapshot: l.name,
        category_snapshot: l.category,
        qty: l.qty,
        unit_price_cents: l.unitPriceCents,
        modifiers: json(l.modifiers.map((m) => ({ group: m.group, name: m.name, price_delta_cents: m.priceDeltaCents }))),
        modifier_ids: l.modifiers.map((m) => m.id),
        note: l.note,
        allergens: l.allergens,
        is_alcohol: l.isAlcohol,
        prep_minutes: l.prepMinutes,
        line_total_cents: l.lineTotalCents,
      })),
    )
    .execute();

  const actor = actorOf(p);
  await ctx.db
    .insertInto('order_status_history')
    .values({ org_id: ctx.orgId, order_id: order.id, from_status: null, to_status: 'pending_payment', at: now, by_kind: actor.kind, by_id: actor.id })
    .execute();
  for (const handler of orderStatusHandlers()) await handler(ctx, snapshot(order), { from: null, to: 'pending_payment' });

  if (cart.deliveryId) await getDeliveryPricing()!.attachToOrder(ctx, { deliveryId: cart.deliveryId, orderId: order.id });

  for (const c of input.consents) {
    await grantConsent(ctx, {
      customerId: customerId!,
      purpose: c.purpose,
      source: input.channel === 'dine-in-qr' ? 'qr_checkout' : 'checkout',
      sourceDetail: `order ${order.reference}`,
      wordingVersion: c.wordingVersion,
    });
  }

  if (customerId && session) await linkSessionToCustomer(ctx, sessionId, customerId);
  await trackInSession(
    ctx,
    orderPlaced,
    { order_id: order.id, channel: order.channel, total_cents: order.total_cents, item_count: order.item_count, asap: order.requested_asap, codes: cart.adjustments.length },
    { venueId: order.venue_id, customerId, sessionId: order.session_id, source: 'web' },
  );

  await enqueue(ctx, expireUnpaidOrderJob, { orderId: order.id }, { key: `expire:${order.id}`, runAt: addMinutes(now, cfg.payment_hold_minutes) });
  return ownOrderView(ctx, order);
}

/**
 * An order nobody paid for gives its slot back. Runs when the hold ends; an order with a payment
 * still unconfirmed at the processor is left alone and looked at again later.
 */
export const expireUnpaidOrderJob = defineJob({
  kind: 'ordering.expire_unpaid',
  schema: z.object({ orderId: z.string().uuid(), round: z.number().int().optional() }),
  async handler(app, job) {
    if (!job.orgId) throw new Error('ordering.expire_unpaid needs an org');
    await app.tenant(job.orgId, WORKER, async (ctx) => {
      const order = await ctx.db.selectFrom('orders').selectAll().where('id', '=', job.payload.orderId).forUpdate().executeTakeFirst();
      if (!order || order.status !== 'pending_payment') return;
      const pending = await ctx.db.selectFrom('payments').select(['id', 'created_at']).where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
      const round = (job.payload.round ?? 0) + 1;
      if (pending && round <= 12) {
        await enqueue(ctx, expireUnpaidOrderJob, { orderId: order.id, round }, { key: `expire:${order.id}:${round}`, runAt: addMinutes(ctx.now(), 10) });
        return;
      }
      if (pending) await ctx.db.updateTable('payments').set({ status: 'failed', failure_reason: 'unconfirmed' }).where('id', '=', pending.id).execute();
      await transition(ctx, order, 'cancelled', { reason: 'Not paid in time.' });
    });
  },
});
