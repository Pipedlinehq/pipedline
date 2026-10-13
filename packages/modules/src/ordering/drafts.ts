import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type Ctx,
  GUEST_FACING_ROLES,
  ROLE_RANK,
  actorOf,
  addMinutes,
  assertModule,
  audit,
  conflict,
  defineJob,
  defineSchedule,
  enqueue,
  findConnectionFor,
  forbidden,
  formatMoney,
  invalid,
  json,
  newCode,
  notFound,
  requireStaff,
  staffOf,
  taxIncluded,
  taxOn,
  track,
} from '@ros/core';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import { resolveCustomer } from '../identity/resolve';
import { getOrderableItems } from '../menu/public';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { surchargesFor } from './bill';
import { type AppliedSurcharge, orderStatusHandlers } from './contract';
import { draftExpired, orderDrafted, orderMarkedPaid, orderingModule, payLinkSent } from './module';
import { notifyGuest, trackingUrl } from './notify';
import { type OrderView, expireUnpaidOrderJob, getOrder, transition } from './orders';
import { MANUAL_PROVIDER, settlePayment } from './payment';
import { type OrderRow, firstName, itemSummary, loadItems, loadOrder, localClock, snapshot } from './rows';

/**
 * Phone and function orders (docs/COMMERCE_ADMIN_PATTERNS.md section 2.2, pattern 10): an order
 * staff build by hand for a guest who phoned, asked at the counter, or is booking a function.
 * Menu items are priced from the menu, as at checkout; a manager may add a custom item with its
 * own name and price. The guest pays the whole amount through the venue's own order page (the
 * same checkout every online order uses: the order's tracking link opens its pay panel), or a
 * manager marks it paid by cash or bank. Drafts untouched for a year are cleared.
 *
 * Not built: deposits ("deposit now, balance on the day"). The payment path charges an order's
 * whole total once and settles the order as paid; a partial amount would need a second payment
 * state, a second charge and a ledger row that is not yet a sale. See CLAUDE.md.
 */

const WORKER = { kind: 'worker' as const, job: 'ordering.drafts' };
/** A pay link with no hold date works this long. */
const DEFAULT_LINK_DAYS = 30;
const DRAFT_LIFETIME_DAYS = 365;

const requireGuestFacing = (ctx: Ctx, venueId: string) => requireStaff(ctx, { venueId, minRole: 'host', anyOf: GUEST_FACING_ROLES });

export const draftLineInput = z.object({
  menuItemId: z.string().uuid(),
  qty: z.number().int().min(1).max(99),
  modifierIds: z.array(z.string().uuid()).max(30).default([]),
  /** Shown to the kitchen as text. */
  note: z.string().trim().max(200).nullish(),
});

export const customItemInput = z.object({
  name: z.string().trim().min(1, 'Give the item a name.').max(100),
  /** The price staff agreed, in cents. The one price the server does not set itself: only a manager may give it. */
  priceCents: z.number().int().min(0).max(100_000_000),
  qty: z.number().int().min(1).max(99).default(1),
  note: z.string().trim().max(200).nullish(),
});

export const createDraftInput = z
  .object({
    venueId: z.string().uuid(),
    /** How it leaves: pickup (also a function collected or set up), or at a table. */
    channel: z.enum(['pickup', 'dine-in-qr']).default('pickup'),
    tableLabel: z.string().trim().max(40).nullish(),
    lines: z.array(draftLineInput).max(60).default([]),
    customItems: z.array(customItemInput).max(20).default([]),
    customer: z.object({
      name: z.string().trim().min(1, 'Whose order is it? Add a name.').max(100),
      email: z.string().trim().max(254).nullish(),
      phone: z.string().trim().max(30).nullish(),
    }),
    /** Notes for the kitchen and the record. Shown on the docket as text. */
    note: z.string().trim().max(500).nullish(),
    /** When it is wanted: the pickup time, or the function's date and time. */
    wantedAt: z.string().datetime().nullish(),
    /** Keep the order (and its pay link) until this instant. Omitted: 30 days after the link is sent. */
    holdUntil: z.string().datetime().nullish(),
  })
  .strict()
  .refine((v) => v.lines.length + v.customItems.length > 0, 'Add at least one item.');

export interface DraftPlan {
  venue: { id: string; name: string; timezone: string };
  channel: 'pickup' | 'dine-in-qr';
  tableLabel: string | null;
  lines: Array<{ menuItemId: string | null; name: string; category: string | null; qty: number; unitPriceCents: number; lineTotalCents: number; modifiers: Array<{ id: string; group: string; name: string; price_delta_cents: number }>; note: string | null; allergens: string[]; isAlcohol: boolean; prepMinutes: number }>;
  itemCount: number;
  subtotalCents: number;
  /** The surcharges in force for the day the order is wanted (else today), each its own line. No automatic offer is applied to a staff-built order. */
  surcharges: AppliedSurcharge[];
  surchargeCents: number;
  taxCents: number;
  totalCents: number;
  currency: string;
  customer: { name: string; email: string | null; phone: string | null };
  note: string | null;
  wantedAt: Date | null;
  holdUntil: Date | null;
}

/**
 * Everything `createDraftOrder` checks and prices, without the write: the tools ask with it.
 * Host, front of house, managers. A custom item needs a manager. Items are priced from the menu
 * as it stands at the wanted time; an item that is 86'd is refused (add it as a custom item if
 * the kitchen says yes); a venue that keeps alcohol out of pickup keeps it out here too. Slots,
 * minimums and the booking window are not applied: staff are the judge of what the kitchen can do.
 */
export async function planDraftOrder(ctx: Ctx, raw: z.input<typeof createDraftInput>): Promise<DraftPlan> {
  const input = createDraftInput.parse(raw);
  requireGuestFacing(ctx, input.venueId);
  const cfg = await assertModule(ctx, input.venueId, orderingModule);
  if (input.customItems.length) {
    const staff = staffOf(ctx);
    if (staff && ROLE_RANK[staff.venueRoles[input.venueId] ?? 'read_only'] < ROLE_RANK.manager) throw forbidden('Only a manager can add a custom item with its own price. Ask one, or pick items from the menu.');
  }
  const venue = await getVenue(ctx, input.venueId);
  const org = await getOrg(ctx);
  const now = ctx.now();
  const wantedAt = input.wantedAt ? new Date(input.wantedAt) : null;
  const holdUntil = input.holdUntil ? new Date(input.holdUntil) : null;
  if (wantedAt && wantedAt < addMinutes(now, -15)) throw invalid('That time has passed. Pick a time still to come.');
  if (holdUntil && holdUntil <= now) throw invalid('The hold date has passed. Pick a day still to come.');
  if (holdUntil && wantedAt && holdUntil > addMinutes(wantedAt, 24 * 60)) throw invalid('The hold ends more than a day after the order is wanted. Hold it until the day, at most.');
  if (input.channel === 'dine-in-qr' && !input.tableLabel) throw invalid('Which table? Add the table name or number.');

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

  // Priced on the order's own channel (the pickup price list, or the QR menu's), as at checkout.
  const items = await getOrderableItems(ctx, input.venueId, input.lines.map((l) => l.menuItemId), { surface: input.channel === 'dine-in-qr' ? 'qr' : 'pickup', at: wantedAt ?? now });
  const lines: DraftPlan['lines'] = [];
  for (const l of input.lines) {
    const item = items.get(l.menuItemId);
    if (!item) throw notFound('Menu item not found');
    if (!item.isAvailable) throw invalid(`${item.name} is 86'd right now. Take it off, or add it as a custom item if the kitchen can make it.`);
    if (cfg.exclude_alcohol && input.channel === 'pickup' && item.isAlcohol) throw invalid(`${item.name} cannot go on a pickup order here (alcohol is not sold to take away).`);
    const wanted = new Set(l.modifierIds);
    const chosen: DraftPlan['lines'][number]['modifiers'] = [];
    for (const g of item.modifierGroups) {
      const picked = g.modifiers.filter((m) => wanted.has(m.id));
      for (const m of picked) {
        wanted.delete(m.id);
        if (!m.isAvailable) throw invalid(`${m.name} is not available with ${item.name} right now.`);
        chosen.push({ id: m.id, group: g.name, name: m.name, price_delta_cents: m.priceDeltaCents });
      }
      if (picked.length < g.minSelections) throw invalid(g.minSelections === 1 ? `Choose an option for "${g.name}" on ${item.name}.` : `Choose at least ${g.minSelections} for "${g.name}" on ${item.name}.`);
      if (picked.length > g.maxSelections) throw invalid(`Choose at most ${g.maxSelections} for "${g.name}" on ${item.name}.`);
    }
    if (wanted.size) throw notFound('Modifier not found');
    const unit = Math.max(0, item.priceCents + chosen.reduce((s, m) => s + m.price_delta_cents, 0));
    lines.push({ menuItemId: item.id, name: item.name, category: item.category, qty: l.qty, unitPriceCents: unit, lineTotalCents: unit * l.qty, modifiers: chosen, note: l.note?.length ? l.note : null, allergens: item.allergens, isAlcohol: item.isAlcohol, prepMinutes: item.prepMinutes });
  }
  for (const c of input.customItems) {
    lines.push({ menuItemId: null, name: c.name, category: 'Custom', qty: c.qty, unitPriceCents: c.priceCents, lineTotalCents: c.priceCents * c.qty, modifiers: [], note: c.note?.length ? c.note : null, allergens: [], isAlcohol: false, prepMinutes: 0 });
  }
  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  // A Sunday or public-holiday surcharge is for the day the order is for, as on every bill.
  const surcharges = await surchargesFor(ctx, input.venueId, wantedAt ?? now, subtotal);
  const surcharge = surcharges.reduce((s, x) => s + x.amountCents, 0);
  const taxable = subtotal + surcharge;
  const tax = org.taxInclusive ? taxIncluded(taxable, org.taxRateBp) : taxOn(taxable, org.taxRateBp);
  return {
    venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
    channel: input.channel,
    tableLabel: input.channel === 'dine-in-qr' ? (input.tableLabel ?? null) : null,
    lines,
    itemCount: lines.reduce((s, l) => s + l.qty, 0),
    subtotalCents: subtotal,
    surcharges,
    surchargeCents: surcharge,
    taxCents: tax,
    totalCents: taxable + (org.taxInclusive ? 0 : tax),
    currency: org.currency,
    customer: { name: input.customer.name, email, phone },
    note: input.note?.length ? input.note : null,
    wantedAt,
    holdUntil,
  };
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
 * Build a phone or function order. Host, front of house, managers; a custom item needs a
 * manager. The order is a draft: nothing is charged and nothing reaches the kitchen until the
 * guest pays the link or a manager marks it paid. Audited `order.draft_created`.
 */
export async function createDraftOrder(ctx: Ctx, raw: z.input<typeof createDraftInput>): Promise<OrderView> {
  const plan = await planDraftOrder(ctx, raw);
  const now = ctx.now();
  let customerId: string | null = null;
  if (plan.customer.email || plan.customer.phone) {
    const [first, ...rest] = plan.customer.name.split(/\s+/).filter(Boolean);
    const resolved = await resolveCustomer(ctx, {
      hints: [...(plan.customer.email ? [{ kind: 'email' as const, value: plan.customer.email }] : []), ...(plan.customer.phone ? [{ kind: 'phone' as const, value: plan.customer.phone }] : [])],
      via: 'phone-order',
      venueId: plan.venue.id,
      profile: { firstName: first ?? null, lastName: rest.join(' ') || null },
    });
    customerId = resolved.customerId;
  }
  const order = await ctx.db
    .insertInto('orders')
    .values({
      org_id: ctx.orgId,
      venue_id: plan.venue.id,
      customer_id: customerId,
      reference: await newReference(ctx, plan.venue.id),
      channel: plan.channel,
      status: 'draft',
      payment_status: 'unpaid',
      source: 'phone',
      requested_asap: false,
      promised_at: plan.wantedAt,
      hold_until: plan.holdUntil,
      table_label: plan.tableLabel,
      subtotal_cents: plan.subtotalCents,
      discount_cents: 0,
      surcharge_cents: plan.surchargeCents,
      surcharges: json(plan.surcharges),
      tax_cents: plan.taxCents,
      tip_cents: 0,
      delivery_fee_cents: 0,
      total_cents: plan.totalCents,
      currency: plan.currency,
      adjustments: json([]),
      flags: [],
      customer_name: plan.customer.name,
      customer_email: plan.customer.email,
      customer_phone: plan.customer.phone,
      customer_note: plan.note,
      idempotency_key: `draft:${randomUUID()}`,
      tracking_token: randomBytes(24).toString('base64url'),
      item_count: plan.itemCount,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.db
    .insertInto('order_items')
    .values(
      plan.lines.map((l, i) => ({
        org_id: ctx.orgId,
        order_id: order.id,
        line_no: i + 1,
        menu_item_id: l.menuItemId,
        name_snapshot: l.name,
        category_snapshot: l.category,
        qty: l.qty,
        unit_price_cents: l.unitPriceCents,
        modifiers: json(l.modifiers.map((m) => ({ group: m.group, name: m.name, price_delta_cents: m.price_delta_cents }))),
        modifier_ids: l.modifiers.map((m) => m.id),
        note: l.note,
        allergens: l.allergens,
        is_alcohol: l.isAlcohol,
        prep_minutes: l.prepMinutes,
        line_total_cents: l.lineTotalCents,
      })),
    )
    .execute();
  const actor = actorOf(ctx.principal);
  await ctx.db.insertInto('order_status_history').values({ org_id: ctx.orgId, order_id: order.id, from_status: null, to_status: 'draft', at: now, by_kind: actor.kind, by_id: actor.id }).execute();
  for (const handler of orderStatusHandlers()) await handler(ctx, snapshot(order), { from: null, to: 'draft' });
  const custom = plan.lines.filter((l) => l.menuItemId === null).length;
  await audit(ctx, {
    action: 'order.draft_created',
    entityType: 'order',
    entityId: order.id,
    venueId: order.venue_id,
    after: { reference: order.reference, channel: order.channel, totalCents: order.total_cents, items: order.item_count, customItems: custom, wantedAt: plan.wantedAt, holdUntil: plan.holdUntil, tableLabel: plan.tableLabel },
  });
  await track(ctx, orderDrafted, { order_id: order.id, channel: order.channel, total_cents: order.total_cents, item_count: order.item_count, custom_items: custom, has_hold: plan.holdUntil !== null }, { venueId: order.venue_id, customerId });
  return getOrder(ctx, order.id);
}

export const orderIdInput = z.object({ orderId: z.string().uuid() }).strict();

/** A phone or function order still waiting to be paid, for staff at its venue. Anything else is not a draft. */
async function loadDraft(ctx: Ctx, orderId: string, opts: { lock?: boolean } = {}): Promise<OrderRow> {
  const order = await loadOrder(ctx, orderId, opts);
  requireGuestFacing(ctx, order.venue_id);
  await assertModule(ctx, order.venue_id, orderingModule);
  if (order.source !== 'phone') throw invalid(`Order ${order.reference} was not built by staff; it is not a phone or function order.`);
  if (order.status !== 'draft' && order.status !== 'pending_payment') throw conflict(`Order ${order.reference} is no longer waiting to be paid.`);
  if (order.payment_status !== 'unpaid' && order.payment_status !== 'failed') throw conflict(`Order ${order.reference} has already been paid.`);
  return order;
}

export interface PayLinkResult {
  order: OrderView;
  payUrl: string;
  via: 'email' | 'sms';
  status: 'queued' | 'suppressed';
  /** Until when the link pays the order. */
  until: Date;
}

/** The checks `sendPayLink` makes, without sending. */
export async function checkPayLink(ctx: Ctx, orderId: string): Promise<{ order: OrderView; until: Date }> {
  const order = await loadDraft(ctx, z.string().uuid().parse(orderId));
  if (order.total_cents <= 0) throw invalid(`Order ${order.reference} comes to nothing, so there is nothing to pay. Mark it paid instead.`);
  if (!order.customer_email && !order.customer_phone) throw invalid(`Order ${order.reference} has no email or phone to send the link to.`);
  const pending = await ctx.db.selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
  if (pending) throw conflict('A payment for this order is being confirmed. Try again in a moment.');
  if (!(await findConnectionFor(ctx, 'payment', order.venue_id))) throw invalid('Card payments are not set up at this venue yet, so a pay link would open nothing. Connect a payment account under Plugins, or mark the order paid by other means.');
  const until = order.hold_until ?? order.promised_at ?? addMinutes(ctx.now(), DEFAULT_LINK_DAYS * 24 * 60);
  if (until <= ctx.now()) throw invalid(`Order ${order.reference} was wanted for a time that has passed. Build it again with a new time.`);
  return { order: await getOrder(ctx, order.id), until };
}

/**
 * Send the guest a link to pay for a phone or function order on the venue's own order page: the
 * order's tracking link, whose pay panel is the same checkout every online order uses
 * (`payOrder` by tracking token). The order waits for payment until the hold date (or the
 * wanted time, or 30 days), then lapses like any unpaid checkout. Sending again sends again.
 */
export async function sendPayLink(ctx: Ctx, raw: z.input<typeof orderIdInput>): Promise<PayLinkResult> {
  const input = orderIdInput.parse(raw);
  let order = await loadDraft(ctx, input.orderId, { lock: true });
  const { until } = await checkPayLink(ctx, order.id);
  const venue = await getVenue(ctx, order.venue_id);
  const now = ctx.now();
  if (order.status === 'draft') {
    order = (await transition(ctx, order, 'pending_payment')).order;
    await enqueue(ctx, expireUnpaidOrderJob, { orderId: order.id }, { key: `expire:${order.id}`, runAt: until });
  }
  const items = await loadItems(ctx, order.id);
  const payUrl = await trackingUrl(ctx, order);
  const when = order.promised_at ? (order.channel === 'dine-in-qr' ? `For table ${order.table_label ?? ''} at ${localClock(order.promised_at, venue.timezone)}.` : `For ${localClock(order.promised_at, venue.timezone)}.`) : '';
  const sent = await notifyGuest(
    ctx,
    order,
    'order.pay_link',
    {
      first_name: firstName(order),
      venue_name: venue.name,
      reference: order.reference,
      summary: itemSummary(items, order.currency),
      total: formatMoney(order.total_cents, order.currency),
      when_line: when,
      pay_url: payUrl,
      hold_line: `The link works until ${localClock(until, venue.timezone)}.`,
    },
    `paylink:${now.getTime()}`,
  );
  if (!sent) throw invalid(`Order ${order.reference} has no email or phone to send the link to.`);
  await ctx.db.updateTable('orders').set({ pay_link_sent_at: now }).where('id', '=', order.id).execute();
  await audit(ctx, { action: 'order.pay_link_sent', entityType: 'order', entityId: order.id, venueId: order.venue_id, after: { reference: order.reference, via: sent.via, status: sent.status, until } });
  await track(ctx, payLinkSent, { order_id: order.id, via: sent.via }, { venueId: order.venue_id, customerId: order.customer_id });
  return { order: await getOrder(ctx, order.id), payUrl, via: sent.via, status: sent.status, until };
}

export const markPaidInput = z
  .object({
    orderId: z.string().uuid(),
    method: z.enum(['cash', 'bank', 'other']),
    /** Why it is being marked paid here rather than paid by card. Kept on the record. */
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

/** The checks `markDraftPaid` makes, without the write. Manager. */
export async function checkMarkPaid(ctx: Ctx, orderId: string): Promise<OrderView> {
  const order = await loadDraft(ctx, z.string().uuid().parse(orderId));
  requireStaff(ctx, { venueId: order.venue_id, minRole: 'manager' });
  const pending = await ctx.db.selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
  if (pending) throw conflict('A card payment for this order is being confirmed. Wait for it rather than marking the order paid.');
  return getOrder(ctx, order.id);
}

/**
 * A manager records that a phone or function order was paid by other means (cash at the counter,
 * a bank transfer). The order is settled exactly as a card payment is: the sale enters the
 * ledger (tender: the method), the kitchen gets its docket, the guest their confirmation, and the
 * order is placed (and accepted, if the venue auto-accepts). No processor is involved, so a
 * refund later has to be given the same way (refundOrder says so). Audited with the reason.
 */
export async function markDraftPaid(ctx: Ctx, raw: z.input<typeof markPaidInput>): Promise<OrderView> {
  const input = markPaidInput.parse(raw);
  let order = await loadDraft(ctx, input.orderId, { lock: true });
  await checkMarkPaid(ctx, order.id);
  const now = ctx.now();
  if (order.status === 'draft') order = (await transition(ctx, order, 'pending_payment')).order;
  order = await ctx.db.updateTable('orders').set({ paid_by: input.method }).where('id', '=', order.id).returningAll().executeTakeFirstOrThrow();
  const key = `pay:${order.id}:manual`;
  if (order.total_cents > 0) {
    await ctx.db
      .insertInto('payments')
      .values({ org_id: ctx.orgId, venue_id: order.venue_id, order_id: order.id, provider: MANUAL_PROVIDER, amount_cents: order.total_cents - order.tip_cents, tip_cents: order.tip_cents, currency: order.currency, status: 'pending', idempotency_key: key, created_at: now })
      .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
      .execute();
  }
  const settled = await settlePayment(ctx, {
    orderId: order.id,
    key,
    provider: MANUAL_PROVIDER,
    result: { externalRef: `manual:${order.id}`, status: 'completed', cardBrand: null, cardLast4: null, failureReason: null, raw: { method: input.method, reason: input.reason } },
    hints: [],
  });
  if (settled.kind !== 'paid') throw conflict(`Order ${order.reference} could not be marked paid.`);
  await audit(ctx, { action: 'order.marked_paid', entityType: 'order', entityId: order.id, venueId: order.venue_id, before: { paymentStatus: 'unpaid' }, after: { reference: order.reference, method: input.method, reason: input.reason, totalCents: order.total_cents } });
  await track(ctx, orderMarkedPaid, { order_id: order.id, method: input.method, total_cents: order.total_cents }, { venueId: order.venue_id, customerId: order.customer_id });
  return getOrder(ctx, order.id);
}

export const cancelDraftInput = z.object({ orderId: z.string().uuid(), reason: z.string().trim().min(3).max(300) }).strict();

/** Drop a phone or function order nobody paid. Host, front of house, managers. The guest is not written to: nothing was charged. */
export async function cancelDraftOrder(ctx: Ctx, raw: z.input<typeof cancelDraftInput>): Promise<OrderView> {
  const input = cancelDraftInput.parse(raw);
  const order = await loadDraft(ctx, input.orderId, { lock: true });
  const pending = await ctx.db.selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
  if (pending) throw conflict('A payment for this order is being confirmed. Try again in a moment.');
  await transition(ctx, order, 'cancelled', { reason: input.reason });
  await audit(ctx, { action: 'order.draft_cancelled', entityType: 'order', entityId: order.id, venueId: order.venue_id, before: { status: order.status }, after: { reference: order.reference, reason: input.reason } });
  return getOrder(ctx, order.id);
}

/** Drafts nobody touched for a year are cleared. Daily, per org with a draft. */
export const expireDraftsJob = defineJob({
  kind: 'ordering.expire_drafts',
  schema: z.object({ bucket: z.string().optional() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ordering.expire_drafts needs an org');
    await app.tenant(job.orgId, WORKER, async (ctx) => {
      const cutoff = addMinutes(ctx.now(), -DRAFT_LIFETIME_DAYS * 24 * 60);
      const stale = await ctx.db.selectFrom('orders').selectAll().where('status', '=', 'draft').where('updated_at', '<', cutoff).limit(200).execute();
      for (const o of stale) {
        await transition(ctx, o, 'cancelled', { reason: 'Not used for a year.' });
        await audit(ctx, { action: 'order.draft_expired', entityType: 'order', entityId: o.id, venueId: o.venue_id, after: { reference: o.reference } });
        await track(ctx, draftExpired, { order_id: o.id }, { venueId: o.venue_id });
      }
    });
  },
});

export const expireDraftsSchedule = defineSchedule({
  key: 'ordering.expire_drafts',
  everyMinutes: 24 * 60,
  scope: 'org',
  job: expireDraftsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  // Platform scheduler: asked outside any tenant, only "does this org have a draft".
  async appliesTo(app, orgId) {
    const row = await app.db.selectFrom('orders').select('id').where('org_id', '=', orgId).where('status', '=', 'draft').limit(1).executeTakeFirst();
    return !!row;
  },
});
