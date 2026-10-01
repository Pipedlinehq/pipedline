import { z } from 'zod';
import {
  type App,
  type CanonicalTransaction,
  type ConnectionRow,
  type Ctx,
  type IdentityHint,
  type Principal,
  AppError,
  adapterFor,
  addMinutes,
  assertModule,
  audit,
  conflict,
  defineJob,
  enqueue,
  findConnectionFor,
  defineSchedule,
  formatMoney,
  invalid,
  isAppError,
  isInternal,
  json,
  notFound,
  once,
  rateLimit,
  requireStaff,
  resolveConnection,
  sha256Hex,
  sql,
  staffOf,
  taxIncluded,
  track,
} from '@ros/core';
import type { Adjustment } from './contract';
import { trackInSession } from '../events/sessions';
import { currentWordings } from '../identity/consents';
import { recordTransaction } from '../ledger/record';
import { stripCardIdentifiers } from '../ledger/strip';
import { menuItemRef } from '../menu/catalog';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { getCheckoutAdjuster } from './contract';
import { orderFlagged, orderingModule, orderPaid, orderRefunded, paymentFailed, paymentReconciled, posPushed } from './module';
import { notifyGuest, trackingUrl } from './notify';
import { type OrderView, TERMINAL, loadOrderByToken, ownOrderView, transition } from './orders';
import { type OrderItemRow, type OrderRow, type PaymentRow, adjustmentsOf, firstName, frozenModifiers, itemSummary, loadItems, loadOrder, whenLine } from './rows';
import { createTicket, moveOrder } from './tickets';

const WORKER = { kind: 'worker' as const, job: 'ordering' };

/** Who is calling an app-level function: the org comes from the host, the session or the key, never from an argument. */
export interface Actor {
  orgId: string;
  principal: Principal;
  ip?: string;
  requestId?: string;
}

const tenantOpts = (a: Actor) => ({ ip: a.ip, requestId: a.requestId });

// ── What the checkout page needs ─────────────────────────────────────────────

export interface CheckoutOptions {
  venueId: string;
  /** What the browser needs to render the processor's hosted card fields. Null when no processor is connected. */
  payment: { provider: string; applicationId: string; locationRef: string; environment: 'sandbox' | 'production' } | null;
  pickupEnabled: boolean;
  asapEnabled: boolean;
  promoCodesEnabled: boolean;
  minOrderCents: number;
  tipping: { enabled: boolean; presets: number[] };
  /** The exact words for each consent box, with the version to send back when it is ticked. */
  consentWordings: Array<{ purpose: string; version: string; body: string }>;
}

/** Public: no role check. Resolving the connection reads the secret store, so this is app-level. */
export async function getCheckoutOptions(app: App, actor: Actor, venueId: string): Promise<CheckoutOptions> {
  const id = z.string().uuid().parse(venueId);
  const r = await app.tenant(
    actor.orgId,
    actor.principal,
    async (ctx) => {
      const cfg = await assertModule(ctx, id, orderingModule);
      return { cfg, conn: await findConnectionFor(ctx, 'payment', id), wordings: await currentWordings(ctx) };
    },
    tenantOpts(actor),
  );
  let payment: CheckoutOptions['payment'] = null;
  if (r.conn) payment = adapterFor(app, 'payment', r.conn).clientConfig(await resolveConnection(app, r.conn));
  return {
    venueId: id,
    payment,
    pickupEnabled: r.cfg.pickup_enabled,
    asapEnabled: r.cfg.asap_enabled,
    promoCodesEnabled: r.cfg.promo_codes_enabled,
    minOrderCents: r.cfg.min_order_cents,
    tipping: { enabled: r.cfg.tipping_enabled, presets: r.cfg.tip_presets },
    consentWordings: r.wordings,
  };
}

// ── The ledger's view of an order ────────────────────────────────────────────

const LEDGER_CHANNEL = { pickup: 'pickup', delivery: 'delivery', 'dine-in-qr': 'dine-in' } as const;

function canonical(
  order: OrderRow,
  items: OrderItemRow[],
  args: { externalRef: string; occurredAt: Date; raw: unknown; refundedCents: number; hints: IdentityHint[]; taxInclusive: boolean; taxRateBp: number },
): CanonicalTransaction {
  const paid = order.total_cents;
  return {
    source: 'online-order',
    externalRef: args.externalRef,
    occurredAt: args.occurredAt,
    channel: LEDGER_CHANNEL[order.channel],
    status: args.refundedCents <= 0 ? 'completed' : args.refundedCents >= paid ? 'refunded' : 'partially_refunded',
    subtotalCents: order.subtotal_cents,
    discountCents: order.discount_cents,
    taxCents: order.tax_cents,
    tipCents: order.tip_cents,
    totalCents: paid,
    refundedCents: args.refundedCents,
    currency: order.currency,
    tenderType: paid > 0 ? 'card' : 'none',
    tableLabel: order.table_label,
    orderId: order.id,
    lines: items.map((i) => ({
      lineNo: i.line_no,
      externalItemId: i.menu_item_id ? menuItemRef(i.menu_item_id) : null,
      name: i.name_snapshot,
      category: i.category_snapshot,
      qty: i.qty,
      unitPriceCents: i.unit_price_cents,
      modifiers: frozenModifiers(i).map((m) => ({ name: m.name, priceCents: m.price_delta_cents })),
      discountCents: 0,
      taxCents: args.taxInclusive ? taxIncluded(i.line_total_cents, args.taxRateBp) : 0,
      totalCents: i.line_total_cents,
    })),
    discounts: adjustmentsOf(order).map((a) => ({ name: a.label, code: a.code, amountCents: a.amountCents })),
    // Card kinds only, straight from the processor. The ledger hashes them per org and keeps
    // them only for a guest who ticked the card box (docs/SCHEMA.md section 2a).
    identityHints: args.hints,
    raw: args.raw,
  };
}

// ── Paying ───────────────────────────────────────────────────────────────────

export const payInput = z
  .object({
    /** The order's tracking token: what the guest's browser holds. */
    trackingToken: z.string().max(100).optional(),
    /** For staff taking payment at the counter, or the guest signed in to their own order. */
    orderId: z.string().uuid().optional(),
    /** The single-use token from the processor's hosted card fields. Never a card number. */
    sourceToken: z.string().min(1).max(500).optional(),
  })
  .refine((v) => !!v.trackingToken !== !!v.orderId, 'Give the tracking token or the order id.');

export type PayResult =
  | { status: 'paid'; order: OrderView; replayed: boolean }
  | { status: 'declined'; reason: string; message: string; order: OrderView };

/** What once() keeps about a payment: the outcome, with every card identifier removed. */
interface StoredPayment {
  externalRef: string;
  status: 'completed' | 'failed';
  cardBrand: string | null;
  cardLast4: string | null;
  failureReason: string | null;
  raw: unknown;
}

const DECLINE_WORDS: Record<string, string> = {
  card_declined: 'The card was declined. Try another card.',
  insufficient_funds: 'The card was declined. Try another card.',
};

/**
 * An attempt that has not answered is left alone this long before the processor is asked
 * about it: a request still in flight must not be mistaken for one that never arrived.
 */
export const PAYMENT_SETTLE_MINUTES = 2;

const internalPrincipal = (p: Principal) => p.kind === 'worker' || p.kind === 'platform';

async function findOrderToPay(ctx: Ctx, input: z.infer<typeof payInput>): Promise<OrderRow> {
  if (input.trackingToken) return loadOrderByToken(ctx, input.trackingToken, { lock: true });
  const order = await loadOrder(ctx, input.orderId!, { lock: true });
  const p = ctx.principal;
  if (isInternal(ctx)) return order;
  if (staffOf(ctx)) {
    requireStaff(ctx, { venueId: order.venue_id, minRole: 'kitchen' });
    return order;
  }
  if (p.kind === 'guest' && order.customer_id === p.customerId) return order;
  throw notFound('Order not found');
}

/**
 * Checkout, step two. An app-level function, not one transaction (CLAUDE.md rule 3):
 *
 *   1. read and mark     the order is locked, the attempt is recorded as pending
 *   2. charge            PaymentAdapter.createPayment through once(), same key to the processor
 *   3. record            paid → ledger → kitchen ticket → confirmation → codes committed →
 *                        status handlers → POS push job
 *
 * A declined card leaves the order unpaid and nothing reaches the kitchen. Calling again after
 * success, or with the same token after an unknown outcome, charges once.
 */
export async function payOrder(app: App, actor: Actor, raw: z.input<typeof payInput>): Promise<PayResult> {
  const input = payInput.parse(raw);
  // Card testing is the abuse here: many tokens against one checkout. Per address, then per venue below.
  if (!internalPrincipal(actor.principal) && actor.ip) {
    await rateLimit(app, `pay:ip:${actor.ip}`, { limit: 30, windowSeconds: 600 }, 'Too many payment attempts from this device. Try again shortly.');
  }

  const prep = await app.tenant(
    actor.orgId,
    actor.principal,
    async (ctx) => {
      const order = await findOrderToPay(ctx, input);
      await assertModule(ctx, order.venue_id, orderingModule);
      if (order.payment_status === 'paid' || order.payment_status === 'refunded' || order.payment_status === 'partially_refunded') {
        return { kind: 'done' as const, view: await ownOrderView(ctx, order) };
      }
      if (order.status !== 'pending_payment') {
        // Cancelled or lapsed. If this very card was mid-charge when that happened, carry on: the
        // processor is asked again under the same key, and whatever it took is sent straight back.
        const mine = input.sourceToken
          ? await ctx.db
              .selectFrom('payments')
              .select(['status', 'failure_reason'])
              .where('order_id', '=', order.id)
              .where('idempotency_key', '=', `pay:${order.id}:${sha256Hex(input.sourceToken).slice(0, 24)}`)
              .executeTakeFirst()
          : undefined;
        const unresolved = mine && (mine.status === 'pending' || (mine.status === 'failed' && mine.failure_reason === 'unconfirmed'));
        if (!unresolved) throw conflict('This order was cancelled before it was paid. Start a new one.');
      }

      if (order.total_cents === 0) return { kind: 'go' as const, order, key: `pay:${order.id}:free`, conn: null as ConnectionRow | null, provider: 'none', push: null as PosPushPlan | null };
      if (!input.sourceToken) throw invalid('Enter a card to pay.');
      if (!isInternal(ctx)) await rateLimit(ctx.app, `pay:venue:${order.venue_id}`, { limit: 1200, windowSeconds: 600 }, 'Payments are busy at this venue. Try again shortly.');
      const conn = await findConnectionFor(ctx, 'payment', order.venue_id);
      if (!conn) throw new AppError('unavailable', 'Card payments are not set up at this venue yet.');
      const provider = adapterFor(ctx.app, 'payment', conn).key;

      // One attempt per card token. The same token again is the same attempt, replayed.
      const key = `pay:${order.id}:${sha256Hex(input.sourceToken).slice(0, 24)}`;
      const others = await ctx.db
        .selectFrom('payments')
        .select(['id', 'created_at'])
        .where('order_id', '=', order.id)
        .where('status', '=', 'pending')
        .where('idempotency_key', '!=', key)
        .orderBy('created_at')
        .execute();
      if (others.length) {
        // An earlier attempt never answered and may have charged the card. A different card is
        // refused until the processor has said what became of it, so a guest is never charged
        // twice; the processor is asked as soon as the earlier attempt has had time to land.
        const first = others[0]!;
        const due = addMinutes(first.created_at, PAYMENT_SETTLE_MINUTES);
        await enqueue(ctx, reconcilePaymentsJob, { reason: 'second_card', orderId: order.id }, { key: `reconcile-payment:${first.id}`, runAt: due > ctx.now() ? due : ctx.now() });
        return { kind: 'busy' as const };
      }
      await ctx.db
        .insertInto('payments')
        .values({
          org_id: ctx.orgId,
          venue_id: order.venue_id,
          order_id: order.id,
          provider,
          amount_cents: order.total_cents - order.tip_cents,
          tip_cents: order.tip_cents,
          currency: order.currency,
          status: 'pending',
          idempotency_key: key,
          created_at: ctx.now(),
        })
        .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
        .execute();
      // A POS that takes an order only before it is paid (Square) gets it now, so the payment can name it.
      const push = order.pos_order_ref || order.status !== 'pending_payment' ? null : await planPosPush(ctx, order, 'before_payment');
      return { kind: 'go' as const, order, key, conn: conn as ConnectionRow | null, provider, push };
    },
    tenantOpts(actor),
  );
  if (prep.kind === 'done') return { status: 'paid', order: prep.view, replayed: true };
  if (prep.kind === 'busy') throw conflict('A payment for this order is still being confirmed. Wait a moment and try again.');

  const { order, key } = prep;
  let posOrderRef = order.pos_order_ref;
  let posPushFailed = false;
  if (prep.push) {
    const pushed = await pushPlannedOrder(app, actor.orgId, prep.push, { paymentRef: null, softFail: true });
    if (pushed) posOrderRef = pushed;
    // The till not showing the order must not stop the guest paying for it: staff are told instead.
    else posPushFailed = true;
  }
  let hints: IdentityHint[] = [];
  let outcome: { result: StoredPayment; replayed: boolean };
  if (!prep.conn) {
    outcome = { result: { externalRef: `free_${order.id}`, status: 'completed', cardBrand: null, cardLast4: null, failureReason: null, raw: null }, replayed: false };
  } else {
    const adapter = adapterFor(app, 'payment', prep.conn);
    const handle = await resolveConnection(app, prep.conn);
    outcome = await once<StoredPayment>(app, { orgId: actor.orgId, key, kind: 'payment' }, async () => {
      const r = await adapter.createPayment(handle, {
        idempotencyKey: key,
        amountCents: order.total_cents - order.tip_cents,
        tipCents: order.tip_cents,
        currency: order.currency,
        sourceToken: input.sourceToken!,
        reference: order.reference,
        locationRef: String(handle.config.locationRef ?? handle.externalAccountId),
        posOrderRef,
      });
      // The card's identifiers live in memory for this request only. What once() stores, and
      // what is written to the payment row, has them removed.
      hints = (r.identityHints ?? []).filter((h) => h.kind === 'card_fingerprint' || h.kind === 'card_par');
      return {
        externalRef: r.externalRef,
        status: r.status,
        cardBrand: r.cardBrand ?? null,
        cardLast4: r.cardLast4 ?? null,
        failureReason: r.failureReason ?? null,
        raw: stripCardIdentifiers(r.raw ?? null),
      };
    });
  }

  const settled = await app.tenant(actor.orgId, actor.principal, (ctx) => settlePayment(ctx, { orderId: order.id, key, provider: prep.provider, result: outcome.result, hints, posPushFailed }), tenantOpts(actor));
  if (settled.kind === 'late') throw conflict('This order expired before the payment went through. The payment is being refunded; please order again.');
  if (settled.kind === 'declined') {
    return { status: 'declined', reason: settled.reason, message: DECLINE_WORDS[settled.reason] ?? 'The payment did not go through. Try another card.', order: settled.order };
  }
  return { status: 'paid', order: settled.order, replayed: outcome.replayed || settled.already };
}

type Settled = { kind: 'paid'; order: OrderView; already: boolean } | { kind: 'declined'; reason: string; order: OrderView } | { kind: 'late' };

/** Transaction two of a payment: record what the processor said and everything that follows from it. */
export async function settlePayment(ctx: Ctx, args: { orderId: string; key: string; provider: string; result: StoredPayment; hints: IdentityHint[]; posPushFailed?: boolean }): Promise<Settled> {
  let order = await loadOrder(ctx, args.orderId, { lock: true });
  const cfg = await assertModule(ctx, order.venue_id, orderingModule);
  const { result } = args;
  const now = ctx.now();
  const paymentValues = {
    external_ref: result.externalRef,
    card_brand: result.cardBrand,
    card_last4: result.cardLast4,
    raw: result.raw === null || result.raw === undefined ? null : json(stripCardIdentifiers(result.raw)),
  };

  if (result.status === 'failed') {
    const reason = result.failureReason ?? 'declined';
    await ctx.db.updateTable('payments').set({ ...paymentValues, status: 'failed', failure_reason: reason }).where('idempotency_key', '=', args.key).where('status', '=', 'pending').execute();
    if (order.status === 'pending_payment' && order.payment_status !== 'failed') {
      order = await ctx.db.updateTable('orders').set({ payment_status: 'failed' }).where('id', '=', order.id).returningAll().executeTakeFirstOrThrow();
      await trackInSession(ctx, paymentFailed, { order_id: order.id, reason }, { venueId: order.venue_id, customerId: order.customer_id, sessionId: order.session_id });
    }
    return { kind: 'declined', reason, order: await ownOrderView(ctx, order) };
  }

  const values = { ...paymentValues, status: 'completed' as const, failure_reason: null };
  if (order.total_cents === 0) {
    await ctx.db
      .insertInto('payments')
      .values({ org_id: ctx.orgId, venue_id: order.venue_id, order_id: order.id, provider: args.provider, amount_cents: 0, tip_cents: 0, currency: order.currency, idempotency_key: args.key, created_at: now, ...values })
      .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
      .execute();
  } else {
    await ctx.db.updateTable('payments').set(values).where('idempotency_key', '=', args.key).where('status', 'in', ['pending', 'failed']).execute();
  }

  if (order.status !== 'pending_payment') {
    if (order.payment_status !== 'unpaid' && order.payment_status !== 'failed') return { kind: 'paid', order: await ownOrderView(ctx, order), already: true };
    // The hold ran out while the card was being charged. The money goes straight back.
    if (order.total_cents > 0) {
      await enqueue(ctx, refundOrderJob, { orderId: order.id, reason: 'The order expired before the payment went through.', key: `late:${args.key}` }, { key: `refund:late:${args.key}` });
    }
    return { kind: 'late' };
  }

  // Paid.
  order = await ctx.db.updateTable('orders').set({ payment_status: 'paid' }).where('id', '=', order.id).returningAll().executeTakeFirstOrThrow();
  const items = await loadItems(ctx, order.id);
  const org = await getOrg(ctx);
  const venue = await getVenue(ctx, order.venue_id);

  // The ledger: one row per sale, keyed by the processor's payment id.
  const recorded = await recordTransaction(
    ctx,
    canonical(order, items, { externalRef: result.externalRef, occurredAt: now, raw: result.raw, refundedCents: 0, hints: args.hints, taxInclusive: org.taxInclusive, taxRateBp: org.taxRateBp }),
    { venueId: order.venue_id, customerId: order.customer_id, via: 'online-order' },
  );
  order = await ctx.db
    .updateTable('orders')
    // An anonymous order paid with a card a consenting guest linked earlier is now theirs.
    .set({ transaction_id: recorded.transaction.id, customer_id: order.customer_id ?? recorded.transaction.customerId })
    .where('id', '=', order.id)
    .returningAll()
    .executeTakeFirstOrThrow();

  // The kitchen. Only now, with the money confirmed.
  await createTicket(ctx, order, items, cfg);

  await notifyGuest(
    ctx,
    order,
    'order.confirmed',
    {
      first_name: firstName(order),
      venue_name: venue.name,
      reference: order.reference,
      summary: itemSummary(items, order.currency),
      total: formatMoney(order.total_cents, order.currency),
      when_line: whenLine(order, venue.timezone),
      tracking_url: await trackingUrl(ctx, order),
    },
    'confirmed',
  );

  // Codes are used up on confirmed payment, never on issue (docs/THREAT_MODEL.md section 9).
  order = await commitAdjustments(ctx, order);
  if (args.posPushFailed) order = await flagOrder(ctx, order, 'The order could not be put on the POS. Check it is on the kitchen screen.', 0);

  // Status handlers run inside these, and see the transaction id.
  order = (await transition(ctx, order, 'placed')).order;
  if (cfg.auto_accept) order = (await transition(ctx, order, 'accepted', { auto: true })).order;

  await trackInSession(
    ctx,
    orderPaid,
    { order_id: order.id, channel: order.channel, total_cents: order.total_cents, discount_cents: order.discount_cents, tip_cents: order.tip_cents, identified: order.customer_id !== null },
    { venueId: order.venue_id, customerId: order.customer_id, sessionId: order.session_id },
  );

  // Put the order where the venue's staff already look, when their POS takes orders once paid.
  const pos = await findConnectionFor(ctx, 'pos', order.venue_id);
  if (pos && !order.pos_order_ref && orderPushMode(ctx.app, pos) === 'after_payment') {
    await enqueue(ctx, pushOrderToPosJob, { orderId: order.id }, { key: `pos-push:${order.id}` });
  }
  return { kind: 'paid', order: await ownOrderView(ctx, order), already: false };
}

/**
 * Mark each code used. The card has already been charged, so this must not undo the payment:
 * when a code was used by another order between pricing and payment (its adjuster answers with
 * an AppError), the guest keeps the price they were shown, the venue absorbs the discount, the
 * order is flagged for staff and the decision audited. Each commit runs under a savepoint so a
 * refused one leaves nothing half-written.
 */
async function commitAdjustments(ctx: Ctx, order: OrderRow): Promise<OrderRow> {
  const absorbed: Array<{ adjustment: Adjustment; reason: string }> = [];
  for (const adjustment of adjustmentsOf(order)) {
    const adjuster = getCheckoutAdjuster(adjustment.adjuster);
    if (!adjuster) continue;
    await sql`savepoint ordering_adjuster_commit`.execute(ctx.db);
    try {
      await adjuster.commit(ctx, { orderId: order.id, venueId: order.venue_id, customerId: order.customer_id, transactionId: order.transaction_id, adjustment });
      await sql`release savepoint ordering_adjuster_commit`.execute(ctx.db);
    } catch (e) {
      await sql`rollback to savepoint ordering_adjuster_commit`.execute(ctx.db);
      if (!isAppError(e)) throw e;
      absorbed.push({ adjustment, reason: e.message });
    }
  }
  if (!absorbed.length) return order;
  const cents = absorbed.reduce((sum, a) => sum + a.adjustment.amountCents, 0);
  const codes = absorbed.map((a) => a.adjustment.code);
  const updated = await ctx.db
    .updateTable('orders')
    .set({ absorbed_discount_cents: order.absorbed_discount_cents + cents, absorbed_codes: [...new Set([...order.absorbed_codes, ...codes])] })
    .where('id', '=', order.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'order.discount_absorbed',
    entityType: 'order',
    entityId: order.id,
    venueId: order.venue_id,
    after: { absorbedCents: cents, codes: absorbed.map((a) => ({ adjuster: a.adjustment.adjuster, code: a.adjustment.code, amountCents: a.adjustment.amountCents, reason: a.reason })) },
  });
  const words = `${codes.join(', ')} had already been used when this order was paid. The guest kept the ${formatMoney(cents, order.currency)} discount they were shown; the venue bears it.`;
  return flagOrder(ctx, updated, words, cents);
}

/** Put an order in front of staff: the console lists it until someone clears it. */
export async function flagOrder(ctx: Ctx, order: OrderRow, reason: string, absorbedCents: number): Promise<OrderRow> {
  const text = order.attention_reason && order.attention_reason !== reason ? `${order.attention_reason} ${reason}` : reason;
  const updated = await ctx.db
    .updateTable('orders')
    .set({ attention_reason: text.slice(0, 1000), attention_at: ctx.now() })
    .where('id', '=', order.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await track(ctx, orderFlagged, { order_id: order.id, reason: reason.slice(0, 300), absorbed_cents: absorbedCents }, { venueId: order.venue_id });
  return updated;
}

// ── POS push ─────────────────────────────────────────────────────────────────

/**
 * When the venue's POS takes an online order (PosCapabilities.orderPush). A plug with no
 * adapter in this deployment, or an adapter with no pushOrder, takes none.
 */
export function orderPushMode(app: App, conn: Pick<ConnectionRow, 'plug_key'>): 'before_payment' | 'after_payment' | 'none' {
  try {
    const adapter = adapterFor(app, 'pos', conn);
    if (typeof adapter.pushOrder !== 'function') return 'none';
    return adapter.capabilities.orderPush ?? 'after_payment';
  } catch {
    return 'none';
  }
}

interface PosPushPlan {
  order: OrderRow;
  conn: ConnectionRow;
  items: OrderItemRow[];
  catalog: Array<{ id: string; pos_catalog_id: string | null }>;
}

/** Read what a push needs, in the caller's transaction, when the venue's POS takes orders at `when`. */
async function planPosPush(ctx: Ctx, order: OrderRow, when: 'before_payment' | 'after_payment'): Promise<PosPushPlan | null> {
  const conn = await findConnectionFor(ctx, 'pos', order.venue_id);
  if (!conn || orderPushMode(ctx.app, conn) !== when) return null;
  const items = await loadItems(ctx, order.id);
  const ids = items.map((i) => i.menu_item_id).filter((v): v is string => !!v);
  const catalog = ids.length ? await ctx.db.selectFrom('menu_items').select(['id', 'pos_catalog_id']).where('id', 'in', ids).execute() : [];
  return { order, conn, items, catalog };
}

/**
 * Send the order to the POS through once(), with the same key to the POS, and record its ref.
 * Returns the POS's ref, or null when the POS could not be reached (the caller decides what
 * that means). Never inside a tenant transaction.
 */
async function pushPlannedOrder(app: App, orgId: string, plan: PosPushPlan, opts: { paymentRef: string | null; softFail: boolean }): Promise<string | null> {
  const { paymentRef } = opts;
  const adapter = adapterFor(app, 'pos', plan.conn);
  if (!adapter.pushOrder) return null;
  const { order, items } = plan;
  const key = `pos-push:${order.id}`;
  let posOrderRef: string;
  try {
    const handle = await resolveConnection(app, plan.conn);
    const pushed = await once(app, { orgId, key, kind: 'pos_order' }, () =>
      adapter.pushOrder!(handle, {
        idempotencyKey: key,
        reference: order.reference,
        locationRef: String(handle.config.locationRef ?? handle.externalAccountId),
        channel: order.channel,
        tableLabel: order.table_label,
        customerName: order.customer_name,
        note: order.customer_note,
        readyAt: order.promised_at,
        lines: items.map((i) => ({
          name: i.name_snapshot,
          externalItemId: plan.catalog.find((c) => c.id === i.menu_item_id)?.pos_catalog_id ?? null,
          qty: i.qty,
          unitPriceCents: i.unit_price_cents,
          modifiers: frozenModifiers(i).map((m) => ({ name: m.name, priceCents: m.price_delta_cents })),
          note: i.note,
        })),
        totalCents: order.total_cents,
        paymentRef,
        discounts: adjustmentsOf(order).map((a) => ({ name: a.label, amountCents: a.amountCents })),
        serviceCharges: order.delivery_fee_cents > 0 ? [{ name: 'Delivery', amountCents: order.delivery_fee_cents }] : [],
        tipCents: order.tip_cents,
        currency: order.currency,
      }),
    );
    posOrderRef = pushed.result.posOrderRef;
  } catch (e) {
    if (!opts.softFail) throw e;
    app.log.warn('ordering: order not pushed to the POS before payment', { orgId, orderId: order.id, error: (e as Error).message?.slice(0, 300) });
    return null;
  }
  await app.tenant(orgId, WORKER, async (ctx) => {
    const set = await ctx.db.updateTable('orders').set({ pos_order_ref: posOrderRef }).where('id', '=', order.id).where('pos_order_ref', 'is', null).returning('id').executeTakeFirst();
    if (set) await track(ctx, posPushed, { order_id: order.id, provider: adapter.key }, { venueId: order.venue_id });
  });
  return posOrderRef;
}

export const pushOrderToPosJob = defineJob({
  kind: 'ordering.pos_push',
  schema: z.object({ orderId: z.string().uuid() }),
  maxAttempts: 6,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('ordering.pos_push needs an org');
    const prep = await app.tenant(orgId, WORKER, async (ctx) => {
      const order = await ctx.db.selectFrom('orders').selectAll().where('id', '=', job.payload.orderId).executeTakeFirst();
      if (!order || order.pos_order_ref || order.payment_status !== 'paid' || TERMINAL.includes(order.status)) return null;
      const plan = await planPosPush(ctx, order, 'after_payment');
      if (!plan) return null;
      const payment = await ctx.db.selectFrom('payments').select('external_ref').where('order_id', '=', order.id).where('status', '=', 'completed').executeTakeFirst();
      return { plan, paymentRef: payment?.external_ref ?? null };
    });
    if (!prep) return;
    await pushPlannedOrder(app, orgId, prep.plan, { paymentRef: prep.paymentRef, softFail: false });
  },
});

// ── Refunds ──────────────────────────────────────────────────────────────────

export const refundInput = z.object({
  orderId: z.string().uuid(),
  /** Leave out to refund everything that has not been refunded yet. */
  amountCents: z.number().int().positive().max(100_000_000).optional(),
  reason: z.string().trim().min(3).max(300),
  /** Made once per refund by the console. The same key refunds once. */
  idempotencyKey: z.string().min(8).max(100),
});

export interface RefundResult {
  refundId: string;
  status: 'completed' | 'pending' | 'failed' | 'nothing_to_refund';
  amountCents: number;
  /** True when the order is now refunded in full. */
  full: boolean;
  order: OrderView;
}

/**
 * Give money back through the processor. A manager's action with a reason, audited
 * (docs/THREAT_MODEL.md section 9). App-level like payment: mark, call the processor through
 * once(), record. Recording updates the ledger row and, on a full refund, gives codes back.
 */
export async function refundOrder(app: App, actor: Actor, raw: z.input<typeof refundInput>): Promise<RefundResult> {
  const input = refundInput.parse(raw);

  const prep = await app.tenant(
    actor.orgId,
    actor.principal,
    async (ctx) => {
      const order = await loadOrder(ctx, input.orderId, { lock: true });
      const staff = requireStaff(ctx, { venueId: order.venue_id, minRole: 'manager' });
      await assertModule(ctx, order.venue_id, orderingModule);
      const payment = await ctx.db
        .selectFrom('payments')
        .selectAll()
        .where('order_id', '=', order.id)
        .where('status', 'in', ['completed', 'partially_refunded', 'refunded'])
        .forUpdate()
        .executeTakeFirst();

      const key = `refund:${order.id}:${input.idempotencyKey}`;
      const prior = await ctx.db.selectFrom('refunds').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
      if (prior?.status === 'completed') return { kind: 'done' as const, refundId: prior.id, amountCents: prior.amount_cents, order };

      const charged = payment ? payment.amount_cents + payment.tip_cents : 0;
      const inFlight = payment
        ? await ctx.db
            .selectFrom('refunds')
            .select((eb) => eb.fn.sum<number>('amount_cents').as('n'))
            .where('payment_id', '=', payment.id)
            .where('status', '=', 'pending')
            .where('idempotency_key', '!=', key)
            .executeTakeFirst()
        : null;
      const refundable = charged - (payment?.refunded_cents ?? 0) - Number(inFlight?.n ?? 0);
      if (!payment || !payment.external_ref || refundable <= 0) return { kind: 'nothing' as const, order };
      const amount = prior?.amount_cents ?? input.amountCents ?? refundable;
      if (amount > refundable) throw invalid(`At most ${formatMoney(refundable, order.currency)} can be refunded on this order.`);

      const conn = await findConnectionFor(ctx, 'payment', order.venue_id);
      if (!conn) throw new AppError('unavailable', 'Card payments are not connected at this venue, so the refund cannot be sent.');

      let refundId = prior?.id;
      if (prior) {
        await ctx.db.updateTable('refunds').set({ status: 'pending', failure_reason: null }).where('id', '=', prior.id).execute();
      } else {
        const row = await ctx.db
          .insertInto('refunds')
          .values({ org_id: ctx.orgId, payment_id: payment.id, order_id: order.id, amount_cents: amount, reason: input.reason, status: 'pending', staff_id: staff?.staffId ?? null, idempotency_key: key, created_at: ctx.now() })
          .returning('id')
          .executeTakeFirstOrThrow();
        refundId = row.id;
        await audit(ctx, { action: 'order.refund_requested', entityType: 'order', entityId: order.id, venueId: order.venue_id, after: { refundId, amountCents: amount, reason: input.reason } });
      }
      return { kind: 'go' as const, refundId: refundId!, amount, conn, paymentRef: payment.external_ref, currency: order.currency };
    },
    tenantOpts(actor),
  );

  if (prep.kind !== 'go') {
    // Already refunded under this key, or nothing left to give back: answer with the order as it stands.
    const order = await app.tenant(actor.orgId, actor.principal, async (ctx) => ownOrderView(ctx, await loadOrder(ctx, prep.order.id)), tenantOpts(actor));
    const full = order.totalCents > 0 && order.refundedCents >= order.totalCents;
    if (prep.kind === 'done') return { refundId: prep.refundId, status: 'completed', amountCents: prep.amountCents, full, order };
    return { refundId: '', status: 'nothing_to_refund', amountCents: 0, full, order };
  }
  const p = prep;

  const adapter = adapterFor(app, 'payment', p.conn);
  const handle = await resolveConnection(app, p.conn);
  const providerKey = `refund:${p.refundId}`;
  let provider: { externalRef: string; status: 'completed' | 'pending' | 'failed' };
  try {
    provider = (
      await once(app, { orgId: actor.orgId, key: providerKey, kind: 'refund' }, () =>
        adapter.refund(handle, { idempotencyKey: providerKey, paymentRef: p.paymentRef, amountCents: p.amount, currency: p.currency, reason: input.reason }),
      )
    ).result;
  } catch (e) {
    // Unknown outcome. The refund stays on record as failed; trying again with the same key
    // reaches the processor with the same idempotency key, so it cannot pay out twice.
    await app.tenant(actor.orgId, actor.principal, (ctx) =>
      ctx.db.updateTable('refunds').set({ status: 'failed', failure_reason: (e as Error).message.slice(0, 300) }).where('id', '=', p.refundId).where('status', '=', 'pending').execute(),
    );
    throw e;
  }

  return app.tenant(actor.orgId, actor.principal, (ctx) => settleRefund(ctx, { refundId: p.refundId, orderId: input.orderId, provider }), tenantOpts(actor));
}

export async function settleRefund(ctx: Ctx, args: { refundId: string; orderId: string; provider: { externalRef: string; status: 'completed' | 'pending' | 'failed' } }): Promise<RefundResult> {
  let order = await loadOrder(ctx, args.orderId, { lock: true });
  const refund = await ctx.db.selectFrom('refunds').selectAll().where('id', '=', args.refundId).forUpdate().executeTakeFirstOrThrow();
  const payment: PaymentRow = await ctx.db.selectFrom('payments').selectAll().where('id', '=', refund.payment_id).forUpdate().executeTakeFirstOrThrow();
  const charged = payment.amount_cents + payment.tip_cents;

  if (refund.status === 'completed') {
    return { refundId: refund.id, status: 'completed', amountCents: refund.amount_cents, full: payment.refunded_cents >= charged, order: await ownOrderView(ctx, order) };
  }
  if (args.provider.status !== 'completed') {
    await ctx.db
      .updateTable('refunds')
      .set({ status: args.provider.status === 'failed' ? 'failed' : 'pending', external_ref: args.provider.externalRef, failure_reason: args.provider.status === 'failed' ? 'The processor refused the refund.' : null })
      .where('id', '=', refund.id)
      .execute();
    return { refundId: refund.id, status: args.provider.status, amountCents: refund.amount_cents, full: false, order: await ownOrderView(ctx, order) };
  }

  const refundedTotal = payment.refunded_cents + refund.amount_cents;
  const full = refundedTotal >= charged;
  await ctx.db.updateTable('refunds').set({ status: 'completed', external_ref: args.provider.externalRef, failure_reason: null }).where('id', '=', refund.id).execute();
  await ctx.db.updateTable('payments').set({ refunded_cents: refundedTotal, status: full ? 'refunded' : 'partially_refunded' }).where('id', '=', payment.id).execute();
  order = await ctx.db.updateTable('orders').set({ payment_status: full ? 'refunded' : 'partially_refunded' }).where('id', '=', order.id).returningAll().executeTakeFirstOrThrow();

  // The ledger row for the sale is updated in place: same source, same reference. A payment
  // that was sent back because its order had already lapsed never was a sale, and has no row.
  const items = await loadItems(ctx, order.id);
  const org = await getOrg(ctx);
  const wasSale = order.transaction_id !== null;
  if (wasSale) {
    await recordTransaction(
      ctx,
      canonical(order, items, {
        externalRef: payment.external_ref!,
        occurredAt: order.placed_at ?? ctx.now(),
        raw: payment.raw,
        refundedCents: refundedTotal,
        hints: [],
        taxInclusive: org.taxInclusive,
        taxRateBp: org.taxRateBp,
      }),
      { venueId: order.venue_id, customerId: order.customer_id, via: 'online-order' },
    );
  }

  if (full) {
    // Give the codes back, and take the order off the kitchen's screen if it is still there.
    // A code the venue absorbed was never marked used by this order: there is nothing to give back.
    if (wasSale) {
      for (const adjustment of adjustmentsOf(order)) {
        if (order.absorbed_codes.includes(adjustment.code)) continue;
        await getCheckoutAdjuster(adjustment.adjuster)?.release?.(ctx, { orderId: order.id, adjustment });
      }
    }
    if (!TERMINAL.includes(order.status)) order = await moveOrder(ctx, order, 'refunded', { reason: refund.reason });
  }

  const venue = await getVenue(ctx, order.venue_id);
  await trackInSession(
    ctx,
    orderRefunded,
    { order_id: order.id, channel: order.channel, refunded_cents: refund.amount_cents, full },
    { venueId: order.venue_id, customerId: order.customer_id, sessionId: order.session_id },
  );
  await notifyGuest(
    ctx,
    order,
    'order.refunded',
    { first_name: firstName(order), venue_name: venue.name, reference: order.reference, amount: formatMoney(refund.amount_cents, order.currency) },
    `refund:${refund.id}`,
  );
  await audit(ctx, {
    action: 'order.refunded',
    entityType: 'order',
    entityId: order.id,
    venueId: order.venue_id,
    before: { refundedCents: payment.refunded_cents },
    after: { refundId: refund.id, amountCents: refund.amount_cents, refundedCents: refundedTotal, full, reason: refund.reason },
  });
  return { refundId: refund.id, status: 'completed', amountCents: refund.amount_cents, full, order: await ownOrderView(ctx, order) };
}

/**
 * The refund that follows from rejecting or cancelling a paid order. The decision was a
 * person's; sending the money back is its consequence, so the worker does it.
 */
export const refundOrderJob = defineJob({
  kind: 'ordering.refund',
  schema: z.object({
    orderId: z.string().uuid(),
    reason: z.string().min(3).max(300),
    key: z.string().min(8).max(100),
    /** Part of the order only (e.g. the delivery fee). Left out: everything not yet refunded. */
    amountCents: z.number().int().positive().optional(),
  }),
  maxAttempts: 8,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ordering.refund needs an org');
    const r = await refundOrder(app, { orgId: job.orgId, principal: WORKER }, { orderId: job.payload.orderId, reason: job.payload.reason, idempotencyKey: job.payload.key, amountCents: job.payload.amountCents });
    if (r.status === 'failed') throw new Error('The processor refused the refund.');
  },
});

// ── Reconciliation: payments and refunds whose outcome was never heard ────────

export interface ReconcileResult {
  /** Attempts the processor said charged the card: settled as paid (or refunded, if the order had lapsed). */
  charged: number;
  /** Attempts the processor has no payment for: marked failed, so the guest may use another card. */
  notCharged: number;
  /** Refunds the processor has now completed or refused. */
  refundsSettled: number;
  /** Still unknown: the processor could not be asked, or cannot look payments up. Tried again next time. */
  unknown: number;
}

/**
 * Ask the processor about every card payment still pending after PAYMENT_SETTLE_MINUTES (and
 * any the lapsed-order path gave up on as 'unconfirmed'), and every refund it answered as
 * pending. What it says is recorded through the same functions as a live answer, so a charge
 * found here is exactly one sale, one ticket, one confirmation.
 *
 * App-level: reads in one transaction, asks the processor, records each answer in its own.
 * The org comes from the job row.
 */
export async function reconcilePayments(app: App, orgId: string, opts: { orderId?: string } = {}): Promise<ReconcileResult> {
  const out: ReconcileResult = { charged: 0, notCharged: 0, refundsSettled: 0, unknown: 0 };
  const work = await app.tenant(orgId, WORKER, async (ctx) => {
    const settled = addMinutes(ctx.now(), -PAYMENT_SETTLE_MINUTES);
    let pq = ctx.db
      .selectFrom('payments')
      .innerJoin('orders', 'orders.id', 'payments.order_id')
      .select(['payments.id', 'payments.order_id', 'payments.venue_id', 'payments.provider', 'payments.idempotency_key', 'payments.amount_cents', 'payments.tip_cents', 'payments.currency', 'payments.created_at', 'orders.reference'])
      .where('payments.provider', '!=', 'none')
      .where('payments.created_at', '<', settled)
      .where((eb) => eb.or([eb('payments.status', '=', 'pending'), eb.and([eb('payments.status', '=', 'failed'), eb('payments.failure_reason', '=', 'unconfirmed'), eb('payments.checked_at', 'is', null)])]))
      .orderBy('payments.created_at')
      .limit(100);
    if (opts.orderId) pq = pq.where('payments.order_id', '=', opts.orderId);
    const payments = await pq.execute();
    let rq = ctx.db
      .selectFrom('refunds')
      .innerJoin('payments', 'payments.id', 'refunds.payment_id')
      .select(['refunds.id', 'refunds.order_id', 'refunds.external_ref', 'payments.venue_id'])
      .where('refunds.status', '=', 'pending')
      .where('refunds.external_ref', 'is not', null)
      .where('refunds.created_at', '<', addMinutes(ctx.now(), -1))
      .orderBy('refunds.created_at')
      .limit(100);
    if (opts.orderId) rq = rq.where('refunds.order_id', '=', opts.orderId);
    const refunds = await rq.execute();
    const conns = new Map<string, ConnectionRow | null>();
    for (const v of new Set([...payments.map((p) => p.venue_id), ...refunds.map((r) => r.venue_id)])) conns.set(v, await findConnectionFor(ctx, 'payment', v));
    return { payments, refunds, conns };
  });

  for (const p of work.payments) {
    const conn = work.conns.get(p.venue_id);
    if (!conn || !p.order_id) {
      out.unknown++;
      continue;
    }
    const adapter = adapterFor(app, 'payment', conn);
    if (!adapter.lookupPayment) {
      out.unknown++;
      continue;
    }
    let found: Awaited<ReturnType<NonNullable<typeof adapter.lookupPayment>>>;
    let hints: IdentityHint[] = [];
    try {
      const handle = await resolveConnection(app, conn);
      found = await adapter.lookupPayment(handle, {
        idempotencyKey: p.idempotency_key,
        reference: p.reference,
        amountCents: p.amount_cents,
        tipCents: p.tip_cents,
        currency: p.currency,
        locationRef: String(handle.config.locationRef ?? handle.externalAccountId),
        attemptedAt: p.created_at,
      });
      hints = (found?.identityHints ?? []).filter((h) => h.kind === 'card_fingerprint' || h.kind === 'card_par');
    } catch (e) {
      app.log.warn('ordering: payment lookup failed', { orgId, paymentId: p.id, error: (e as Error).message?.slice(0, 300) });
      await app.tenant(orgId, WORKER, (ctx) => ctx.db.updateTable('payments').set({ checked_at: ctx.now() }).where('id', '=', p.id).execute());
      out.unknown++;
      continue;
    }
    const orderId = p.order_id;
    if (found) {
      const result: StoredPayment = {
        externalRef: found.externalRef,
        status: found.status,
        cardBrand: found.cardBrand ?? null,
        cardLast4: found.cardLast4 ?? null,
        failureReason: found.failureReason ?? null,
        raw: stripCardIdentifiers(found.raw ?? null),
      };
      await app.tenant(orgId, WORKER, async (ctx) => {
        await ctx.db.updateTable('payments').set({ checked_at: ctx.now() }).where('id', '=', p.id).execute();
        // A failed attempt the lapsed-order path already marked needs nothing more.
        const row = await ctx.db.selectFrom('payments').select('status').where('id', '=', p.id).executeTakeFirstOrThrow();
        if (result.status === 'failed' && row.status !== 'pending') return;
        await settlePayment(ctx, { orderId, key: p.idempotency_key, provider: p.provider, result, hints });
        const order = await loadOrder(ctx, orderId);
        if (result.status === 'completed') await track(ctx, paymentReconciled, { order_id: orderId, outcome: 'charged' }, { venueId: order.venue_id });
      });
      if (found.status === 'completed') out.charged++;
      else out.notCharged++;
      continue;
    }
    // The processor never received it: nothing was charged. The guest may now use another card.
    await app.tenant(orgId, WORKER, async (ctx) => {
      const marked = await ctx.db
        .updateTable('payments')
        .set({ status: 'failed', failure_reason: 'not_charged', checked_at: ctx.now() })
        .where('id', '=', p.id)
        .where((eb) => eb.or([eb('status', '=', 'pending'), eb('failure_reason', '=', 'unconfirmed')]))
        .returning('id')
        .executeTakeFirst();
      if (!marked) return;
      const order = await loadOrder(ctx, orderId, { lock: true });
      if (order.status === 'pending_payment' && order.payment_status === 'unpaid') {
        await ctx.db.updateTable('orders').set({ payment_status: 'failed' }).where('id', '=', order.id).execute();
      }
      await track(ctx, paymentReconciled, { order_id: orderId, outcome: 'not_charged' }, { venueId: order.venue_id });
    });
    out.notCharged++;
  }

  for (const r of work.refunds) {
    const conn = work.conns.get(r.venue_id);
    const adapter = conn ? adapterFor(app, 'payment', conn) : null;
    if (!conn || !adapter?.getRefund || !r.order_id) {
      out.unknown++;
      continue;
    }
    let state: Awaited<ReturnType<NonNullable<typeof adapter.getRefund>>>;
    try {
      state = await adapter.getRefund(await resolveConnection(app, conn), r.external_ref!);
    } catch (e) {
      app.log.warn('ordering: refund lookup failed', { orgId, refundId: r.id, error: (e as Error).message?.slice(0, 300) });
      out.unknown++;
      continue;
    }
    if (!state || state.status === 'pending') {
      await app.tenant(orgId, WORKER, (ctx) => ctx.db.updateTable('refunds').set({ checked_at: ctx.now() }).where('id', '=', r.id).execute());
      out.unknown++;
      continue;
    }
    const orderId = r.order_id;
    await app.tenant(orgId, WORKER, async (ctx) => {
      await ctx.db.updateTable('refunds').set({ checked_at: ctx.now() }).where('id', '=', r.id).execute();
      await settleRefund(ctx, { refundId: r.id, orderId, provider: { externalRef: state!.externalRef, status: state!.status } });
    });
    out.refundsSettled++;
  }
  return out;
}

export const reconcilePaymentsJob = defineJob({
  kind: 'ordering.reconcile_payments',
  /** With an order id: that order only (a guest waiting at checkout). Without: every pending payment in the org. */
  schema: z.object({ reason: z.string().max(40).optional(), bucket: z.string().optional(), orderId: z.string().uuid().optional() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ordering.reconcile_payments needs an org');
    await reconcilePayments(app, job.orgId, { orderId: job.payload.orderId });
  },
});

/** Lost answers are found within minutes: every org with a payment or refund still pending is looked at. */
export const reconcilePaymentsSchedule = defineSchedule({
  key: 'ordering.reconcile_payments',
  everyMinutes: 5,
  scope: 'org',
  job: reconcilePaymentsJob,
  payload: ({ bucket }) => ({ reason: 'schedule', bucket: bucket.toISOString() }),
  // Platform scheduler: asked outside any tenant, only "does this org have anything pending".
  async appliesTo(app, orgId) {
    const p = await app.db.selectFrom('payments').select('id').where('org_id', '=', orgId).where('status', '=', 'pending').limit(1).executeTakeFirst();
    if (p) return true;
    const r = await app.db.selectFrom('refunds').select('id').where('org_id', '=', orgId).where('status', '=', 'pending').limit(1).executeTakeFirst();
    return !!r;
  },
});
