import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalLine,
  CanonicalTransaction,
  ConnectionHandle,
  IdentityHint,
  PosAdapter,
  PosOrderPush,
  PosWebhookEvent,
  TxnChannel,
  TxnStatus,
} from '@ros/core';
import { signedWebhook, simVerify } from './signing';

export const SIM_POS_KEY = 'sim-pos';

/** The access token the simulated POS accepts for an account. Anything else is answered as a 401. */
export function simPosToken(accountRef: string): string {
  return `simpos-token-${accountRef}`;
}

interface Money {
  amount: number;
  currency: string;
}

export interface SimPosLineItem {
  uid: string;
  catalog_object_id: string | null;
  name: string;
  category: string | null;
  /** A decimal string, as real POS APIs send it: "1", "0.35". */
  quantity: string;
  /** One unit, before modifiers. */
  base_price_money: Money;
  modifiers: Array<{ name: string; base_price_money: Money }>;
  /** (base + modifiers) x quantity, before discounts. */
  gross_sales_money: Money;
  total_discount_money: Money;
  total_tax_money: Money;
}

/**
 * A payment as the simulated provider holds and returns it. Shaped like a real POS payload on
 * purpose: money objects, a nested order with line items, and a card block that carries a
 * fingerprint and a payment account reference, so the ledger's stripping is exercised on every
 * sale (docs/SCHEMA.md section 2a rule 3).
 */
export interface SimPosPayment {
  id: string;
  account_id: string;
  location_id: string;
  created_at: string;
  updated_at: string;
  status: 'PENDING' | 'COMPLETED' | 'CANCELED';
  source_type: 'CARD' | 'CASH';
  channel: TxnChannel;
  /** Subtotal less discounts, without the tip. */
  amount_money: Money;
  tip_money: Money;
  /** amount_money + tip_money: what the guest paid. */
  total_money: Money;
  refunded_money: Money;
  tax_money: Money;
  discount_money: Money;
  card_details?: { card: { card_brand: string; last_4: string; fingerprint: string; payment_account_reference?: string } };
  customer?: { id: string; email_address: string | null; phone_number: string | null; given_name: string | null; family_name: string | null };
  team_member_id: string | null;
  table: string | null;
  /** 'platform' when the sale was taken by this platform's own integration rather than at the till. */
  application: 'pos' | 'platform';
  order: {
    id: string;
    reference_id: string | null;
    line_items: SimPosLineItem[];
    discounts: Array<{ name: string; code: string | null; amount_money: Money }>;
  };
}

export interface SimPosSaleInput {
  accountRef: string;
  locationRef: string;
  /** When the sale happened. Defaults to the simulator's clock. */
  at?: Date;
  /** Defaults to a main and a side, $59.00. */
  lines?: Array<{
    name: string;
    unitPriceCents: number;
    qty?: number;
    category?: string | null;
    externalItemId?: string | null;
    modifiers?: Array<{ name: string; priceCents: number }>;
  }>;
  discount?: { name: string; code?: string | null; amountCents: number };
  tipCents?: number;
  tender?: 'card' | 'cash';
  /** Card sales always carry a fingerprint and a PAR; name them to pay twice with "the same card". */
  card?: { fingerprint?: string; par?: string | null; brand?: string; last4?: string };
  customer?: { id?: string; email?: string | null; phone?: string | null; firstName?: string | null; lastName?: string | null };
  channel?: TxnChannel;
  table?: string | null;
  staffRef?: string | null;
  status?: 'completed' | 'pending';
  originatedHere?: boolean;
  currency?: string;
}

export interface SimPosOrder {
  posOrderRef: string;
  accountRef: string;
  state: 'open' | 'paid';
  order: PosOrderPush;
  discounts: Array<{ name: string; amountCents: number; idempotencyKey: string }>;
  /** The payment that settled it, once paid at the till. */
  paymentId: string | null;
  at: Date;
}

export interface SimPosWebhook {
  eventId: string;
  rawBody: string;
  headers: Record<string, string>;
}

export interface SimPosTotals {
  /** Payments that were not cancelled. */
  count: number;
  /** What guests paid, tips included, before refunds. */
  totalCents: number;
  refundedCents: number;
  tipCents: number;
  netCents: number;
}

export interface SimPosAdapter extends PosAdapter {
  /** Ring up a sale at a location. The account and location are created on first use. */
  createSale(input: SimPosSaleInput): SimPosPayment;
  /** Refund a sale in full, or by an amount. Moves its updated_at to now, as a real provider does. */
  refund(paymentId: string, amountCents?: number): SimPosPayment;
  /** Cancel a sale that never completed. */
  voidSale(paymentId: string): SimPosPayment;
  /** Capture a pending sale. */
  complete(paymentId: string): SimPosPayment;
  /** Make the next n API calls fail as an outage. */
  failNext(n: number, message?: string): void;
  /** Every page cursor handed out so far stops working, as a provider's cursors eventually do. */
  expireCursors(): void;
  /**
   * Build the signed webhook the provider would post for these payments. With `changeOnly` the
   * event names one payment id and nothing else: no amounts, no location.
   */
  webhook(secret: string, args: { accountRef: string; paymentIds: string[]; type?: string; eventId?: string; changeOnly?: boolean }): SimPosWebhook;
  /** The same delivery again, byte for byte: a provider retry. Defaults to the last one built. */
  duplicate(eventId?: string): SimPosWebhook;
  addLocation(accountRef: string, location: { ref: string; name: string; timezone?: string }): void;
  /**
   * When this POS takes online orders: 'after_payment' (the default; pushed once paid, with the
   * payment's ref) or 'before_payment' (pushed first; the payment names the order, as Square
   * requires). Tests switch it to exercise both paths.
   */
  setOrderPush(mode: 'before_payment' | 'after_payment' | 'none'): void;
  /**
   * The online payment that named a pushed order has completed (the simulated processor calls
   * this). The order is paid and the POS lists the payment as a sale taken by this platform.
   */
  settleOnlinePayment(posOrderRef: string, payment: { amountCents: number; tipCents: number; paymentRef: string; at?: Date }): SimPosPayment | null;
  /** Pay an order that was pushed to the POS, at the till, with whatever discounts were applied to it. */
  settleOrder(posOrderRef: string, opts?: Pick<SimPosSaleInput, 'tender' | 'card' | 'customer' | 'tipCents' | 'at' | 'staffRef'>): SimPosPayment;
  /** A copy of one payment, or undefined. */
  get(paymentId: string): SimPosPayment | undefined;
  /** Copies of the payments held for an account, oldest first. */
  sales(filter: { accountRef: string; locationRef?: string }): SimPosPayment[];
  /** The provider's own totals, for checking the ledger against. */
  totals(filter: { accountRef: string; locationRef?: string }): SimPosTotals;
  readonly pushedOrders: SimPosOrder[];
  /** How many times each API method was reached, so a test can prove a re-fetch happened. */
  readonly calls: Record<'listLocations' | 'listTransactions' | 'getTransaction' | 'pushOrder' | 'applyDiscount', number>;
  reset(): void;
}

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const GST_DIVISOR = 11; // prices include 10% GST

function statusOf(p: SimPosPayment): TxnStatus {
  if (p.status === 'CANCELED') return 'voided';
  if (p.status === 'PENDING') return 'pending';
  const refunded = p.refunded_money.amount;
  if (refunded > 0 && refunded >= p.total_money.amount) return 'refunded';
  if (refunded > 0) return 'partially_refunded';
  return 'completed';
}

/** The provider's payment as the ledger's canonical sale. The raw payload rides along, card block and all. */
export function simPosToCanonical(p: SimPosPayment): CanonicalTransaction {
  const lines: CanonicalLine[] = p.order.line_items.map((l, i) => {
    const modifiers = l.modifiers.map((m) => ({ name: m.name, priceCents: m.base_price_money.amount }));
    return {
      lineNo: i + 1,
      externalItemId: l.catalog_object_id,
      name: l.name,
      category: l.category,
      qty: Number(l.quantity),
      unitPriceCents: l.base_price_money.amount + modifiers.reduce((s, m) => s + m.priceCents, 0),
      modifiers,
      discountCents: l.total_discount_money.amount,
      taxCents: l.total_tax_money.amount,
      totalCents: l.gross_sales_money.amount,
    };
  });
  const identityHints: IdentityHint[] = [];
  if (p.customer) {
    const name = { firstName: p.customer.given_name, lastName: p.customer.family_name };
    identityHints.push({ kind: 'pos_customer_id', value: p.customer.id, ...name });
    if (p.customer.email_address) identityHints.push({ kind: 'email', value: p.customer.email_address, ...name });
    if (p.customer.phone_number) identityHints.push({ kind: 'phone', value: p.customer.phone_number, ...name });
  }
  const card = p.card_details?.card;
  if (card) {
    identityHints.push({ kind: 'card_fingerprint', value: card.fingerprint });
    if (card.payment_account_reference) identityHints.push({ kind: 'card_par', value: card.payment_account_reference });
  }
  return {
    source: 'sim',
    externalRef: p.id,
    locationRef: p.location_id,
    occurredAt: new Date(p.created_at),
    channel: p.channel,
    status: statusOf(p),
    subtotalCents: lines.reduce((s, l) => s + l.totalCents, 0),
    discountCents: p.discount_money.amount,
    taxCents: p.tax_money.amount,
    tipCents: p.tip_money.amount,
    totalCents: p.total_money.amount,
    refundedCents: p.refunded_money.amount,
    currency: p.total_money.currency,
    tenderType: p.source_type.toLowerCase(),
    staffRef: p.team_member_id,
    tableLabel: p.table,
    originatedHere: p.application === 'platform',
    lines,
    discounts: p.order.discounts.map((d) => ({ name: d.name, code: d.code, amountCents: d.amount_money.amount })),
    identityHints,
    raw: structuredClone(p),
  };
}

/**
 * A point of sale that exists only in memory. It behaves like a real one where it matters to
 * ingest: payments are scoped to an account and a location, change over time (a refund moves
 * updated_at), are listed oldest change first behind a page cursor, and are announced by signed
 * webhooks that may arrive twice, arrive thin, or not arrive at all.
 */
export function createSimPosAdapter(opts: { clock?: () => Date } = {}): SimPosAdapter {
  interface Held {
    seq: number;
    payment: SimPosPayment;
  }
  const payments = new Map<string, Held>();
  const locations = new Map<string, Map<string, { ref: string; name: string; timezone?: string }>>();
  const pushedOrders: SimPosOrder[] = [];
  const pushByKey = new Map<string, string>();
  const emitted: SimPosWebhook[] = [];
  const calls = { listLocations: 0, listTransactions: 0, getTransaction: 0, pushOrder: 0, applyDiscount: 0 };
  let seq = 0;
  let failures = 0;
  let failureMessage = 'simulated POS outage';
  let cursorEpoch = 0;
  const now = () => (opts.clock ? opts.clock() : new Date());

  const ensureLocation = (accountRef: string, locationRef: string) => {
    let m = locations.get(accountRef);
    if (!m) locations.set(accountRef, (m = new Map()));
    if (!m.has(locationRef)) m.set(locationRef, { ref: locationRef, name: locationRef, timezone: 'Australia/Sydney' });
  };

  /** Every API call passes through here: outages first, then the access token. */
  const reach = (conn: ConnectionHandle, method: keyof typeof calls) => {
    calls[method]++;
    if (failures > 0) {
      failures--;
      throw new Error(failureMessage);
    }
    if (conn.credentials.accessToken !== simPosToken(conn.externalAccountId)) {
      throw new Error('sim-pos: 401 the access token was not accepted');
    }
  };

  const held = (paymentId: string): Held => {
    const h = payments.get(paymentId);
    if (!h) throw new Error(`sim-pos: no payment ${paymentId}`);
    return h;
  };

  const touch = (h: Held): SimPosPayment => {
    h.payment.updated_at = now().toISOString();
    // A change moves the payment to the end of the change-ordered list.
    h.seq = ++seq;
    return structuredClone(h.payment);
  };

  const inScope = (filter: { accountRef: string; locationRef?: string }) =>
    [...payments.values()]
      .filter((h) => h.payment.account_id === filter.accountRef && (!filter.locationRef || h.payment.location_id === filter.locationRef))
      .sort((a, b) => a.seq - b.seq);

  let orderPushMode: 'before_payment' | 'after_payment' | 'none' = 'after_payment';
  const capabilities: PosAdapter['capabilities'] = { itemisedLines: true, customerIdentity: 'both', writeBack: 'order', webhooks: true, realtime: true, orderPush: orderPushMode };

  /** An online order the platform has already been paid for, as this POS would list the sale. */
  const paidOnline = (pushed: SimPosOrder, pay: { tipCents: number; at?: Date }): SimPosPayment => {
    const o = pushed.order;
    const discount = (o.discounts ?? []).reduce((sum, d) => sum + d.amountCents, 0);
    const payment = createSale({
      accountRef: pushed.accountRef,
      locationRef: o.locationRef,
      at: pay.at,
      lines: [
        ...o.lines.map((l) => ({ name: l.name, unitPriceCents: l.unitPriceCents - l.modifiers.reduce((sum, m) => sum + m.priceCents, 0), qty: l.qty, externalItemId: l.externalItemId ?? null, modifiers: l.modifiers })),
        ...(o.serviceCharges ?? []).map((c) => ({ name: c.name, unitPriceCents: c.amountCents })),
      ],
      discount: discount > 0 ? { name: (o.discounts ?? []).map((d) => d.name).join(', '), amountCents: discount } : undefined,
      tipCents: pay.tipCents,
      channel: o.channel === 'dine-in-qr' ? 'dine-in' : o.channel,
      table: o.tableLabel ?? null,
      orderRef: pushed.posOrderRef,
      originatedHere: true,
    });
    held(payment.id).payment.order.reference_id = o.reference;
    pushed.state = 'paid';
    pushed.paymentId = payment.id;
    return structuredClone(held(payment.id).payment);
  };

  const createSale = (input: SimPosSaleInput & { orderRef?: string | null }): SimPosPayment => {
    ensureLocation(input.accountRef, input.locationRef);
    const currency = input.currency ?? 'AUD';
    const money = (amount: number): Money => ({ amount, currency });
    const at = (input.at ?? now()).toISOString();
    const id = `simpos_${short(`${input.accountRef}:${++seq}:${randomUUID()}`)}`;
    const discount = input.discount?.amountCents ?? 0;
    const specs = input.lines ?? [
      { name: 'Wagyu rump 250g', unitPriceCents: 4800, category: 'Mains', modifiers: [{ name: 'Medium rare', priceCents: 0 }] },
      { name: 'Fries, aioli', unitPriceCents: 1100, category: 'Sides' },
    ];
    const line_items: SimPosLineItem[] = specs.map((l, i) => {
      const qty = l.qty ?? 1;
      const modifiers = (l.modifiers ?? []).map((m) => ({ name: m.name, base_price_money: money(m.priceCents) }));
      const unit = l.unitPriceCents + modifiers.reduce((s, m) => s + m.base_price_money.amount, 0);
      const gross = Math.round(unit * qty);
      return {
        uid: `line-${i + 1}`,
        catalog_object_id: l.externalItemId ?? null,
        name: l.name,
        category: l.category ?? null,
        quantity: String(qty),
        base_price_money: money(l.unitPriceCents),
        modifiers,
        gross_sales_money: money(gross),
        total_discount_money: money(0),
        total_tax_money: money(Math.round(gross / GST_DIVISOR)),
      };
    });
    const subtotal = line_items.reduce((s, l) => s + l.gross_sales_money.amount, 0);
    if (!Number.isInteger(discount) || discount < 0 || discount > subtotal) throw new Error('sim-pos: discount must be whole cents, no more than the subtotal');
    const tip = input.tipCents ?? 0;
    const amount = subtotal - discount;
    const tender = input.tender ?? 'card';
    const payment: SimPosPayment = {
      id,
      account_id: input.accountRef,
      location_id: input.locationRef,
      created_at: at,
      updated_at: at,
      status: input.status === 'pending' ? 'PENDING' : 'COMPLETED',
      source_type: tender === 'cash' ? 'CASH' : 'CARD',
      channel: input.channel ?? 'dine-in',
      amount_money: money(amount),
      tip_money: money(tip),
      total_money: money(amount + tip),
      refunded_money: money(0),
      tax_money: money(Math.round(amount / GST_DIVISOR)),
      discount_money: money(discount),
      team_member_id: input.staffRef ?? null,
      table: input.table ?? null,
      application: input.originatedHere ? 'platform' : 'pos',
      order: {
        id: input.orderRef ?? `simord_${short(id)}`,
        reference_id: null,
        line_items,
        discounts: input.discount ? [{ name: input.discount.name, code: input.discount.code ?? null, amount_money: money(discount) }] : [],
      },
    };
    if (tender === 'card') {
      const par = input.card?.par === null ? undefined : (input.card?.par ?? `sim-par-${short(id)}`);
      payment.card_details = {
        card: {
          card_brand: input.card?.brand ?? 'VISA',
          last_4: input.card?.last4 ?? '4242',
          fingerprint: input.card?.fingerprint ?? `sim-fp-${short(id)}`,
          ...(par ? { payment_account_reference: par } : {}),
        },
      };
    }
    if (input.customer) {
      payment.customer = {
        id: input.customer.id ?? `simcust_${short(`${input.accountRef}:${input.customer.email ?? input.customer.phone ?? id}`)}`,
        email_address: input.customer.email ?? null,
        phone_number: input.customer.phone ?? null,
        given_name: input.customer.firstName ?? null,
        family_name: input.customer.lastName ?? null,
      };
    }
    payments.set(id, { seq, payment });
    return structuredClone(payment);
  };

  const rememberWebhook = (eventId: string, body: unknown, secret: string): SimPosWebhook => {
    const w = { eventId, ...signedWebhook(secret, body) };
    emitted.push(w);
    return { ...w, headers: { ...w.headers } };
  };

  return {
    key: SIM_POS_KEY,
    source: 'sim',
    capabilities,
    pushedOrders,
    calls,

    async listLocations(conn) {
      reach(conn, 'listLocations');
      return [...(locations.get(conn.externalAccountId)?.values() ?? [])].map((l) => ({ ...l }));
    },

    async listTransactions(conn, args) {
      reach(conn, 'listTransactions');
      let after = 0;
      if (args.cursor) {
        const [epoch, s] = Buffer.from(args.cursor, 'base64url').toString('utf8').split(':').map(Number);
        if (epoch !== cursorEpoch || !Number.isInteger(s)) throw new Error('sim-pos: 400 the page cursor is no longer valid');
        after = s!;
      }
      const limit = Math.max(1, Math.min(args.limit ?? 50, 100));
      const since = args.since.getTime();
      const until = args.until?.getTime() ?? Number.POSITIVE_INFINITY;
      const matching = inScope({ accountRef: conn.externalAccountId, locationRef: args.locationRef }).filter((h) => {
        const changed = new Date(h.payment.updated_at).getTime();
        // Both bounds are inclusive, so a sale rung up at the very instant of the poll is not missed.
        return h.seq > after && changed >= since && changed <= until;
      });
      const page = matching.slice(0, limit);
      const more = matching.length > limit;
      return {
        items: page.map((h) => simPosToCanonical(h.payment)),
        nextCursor: more ? Buffer.from(`${cursorEpoch}:${page[page.length - 1]!.seq}`).toString('base64url') : null,
      };
    },

    async getTransaction(conn, externalRef) {
      reach(conn, 'getTransaction');
      const h = payments.get(externalRef);
      // Another account's payment does not exist as far as this caller is concerned.
      if (!h || h.payment.account_id !== conn.externalAccountId) return null;
      return simPosToCanonical(h.payment);
    },

    verifyWebhook: simVerify,

    parseWebhook(rawBody): PosWebhookEvent | null {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (!body || typeof body.event_id !== 'string' || typeof body.account_id !== 'string') return null;
      const data = (body.data ?? {}) as { id?: unknown; ids?: unknown };
      const refs = Array.isArray(data.ids) ? data.ids : data.id ? [data.id] : [];
      return {
        eventId: body.event_id,
        type: typeof body.type === 'string' ? body.type : 'unknown',
        accountRef: body.account_id,
        locationRef: typeof body.location_id === 'string' ? body.location_id : null,
        transactionRefs: refs.filter((r): r is string => typeof r === 'string'),
      };
    },

    async pushOrder(conn, order) {
      reach(conn, 'pushOrder');
      const key = `${conn.externalAccountId}:${order.idempotencyKey}`;
      const prior = pushByKey.get(key);
      if (prior) return { posOrderRef: prior };
      ensureLocation(conn.externalAccountId, order.locationRef);
      const posOrderRef = `simord_${short(key)}`;
      pushByKey.set(key, posOrderRef);
      const pushed: SimPosOrder = { posOrderRef, accountRef: conn.externalAccountId, state: 'open', order: structuredClone(order), discounts: [], paymentId: null, at: now() };
      pushedOrders.push(pushed);
      // Paid online already: the POS records the sale as the platform's own.
      if (order.paymentRef) paidOnline(pushed, { tipCents: order.tipCents ?? 0 });
      return { posOrderRef };
    },

    async applyDiscount(conn, args) {
      reach(conn, 'applyDiscount');
      const order = pushedOrders.find((o) => o.posOrderRef === args.orderRef && o.accountRef === conn.externalAccountId && o.order.locationRef === args.locationRef);
      if (!order || order.state !== 'open') return { ok: false };
      if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) return { ok: false };
      if (!order.discounts.some((d) => d.idempotencyKey === args.idempotencyKey)) {
        order.discounts.push({ name: args.name, amountCents: args.amountCents, idempotencyKey: args.idempotencyKey });
      }
      return { ok: true };
    },

    createSale: (input) => createSale(input),

    refund(paymentId, amountCents) {
      const h = held(paymentId);
      const p = h.payment;
      if (p.status !== 'COMPLETED') throw new Error('sim-pos: only a completed payment can be refunded');
      const left = p.total_money.amount - p.refunded_money.amount;
      const amount = amountCents ?? left;
      if (!Number.isInteger(amount) || amount <= 0 || amount > left) throw new Error('sim-pos: refund must be whole cents, no more than what is left');
      p.refunded_money.amount += amount;
      return touch(h);
    },

    voidSale(paymentId) {
      const h = held(paymentId);
      h.payment.status = 'CANCELED';
      return touch(h);
    },

    complete(paymentId) {
      const h = held(paymentId);
      if (h.payment.status !== 'PENDING') throw new Error('sim-pos: only a pending payment can be completed');
      h.payment.status = 'COMPLETED';
      return touch(h);
    },

    failNext(n, message) {
      failures = n;
      if (message) failureMessage = message;
    },

    expireCursors() {
      cursorEpoch++;
    },

    webhook(secret, args) {
      const eventId = args.eventId ?? randomUUID();
      const base = { event_id: eventId, type: args.type ?? 'payment.updated', account_id: args.accountRef, created_at: now().toISOString() };
      if (args.changeOnly) {
        if (args.paymentIds.length !== 1) throw new Error('sim-pos: a change-only event names exactly one payment');
        return rememberWebhook(eventId, { ...base, data: { type: 'payment', id: args.paymentIds[0] } }, secret);
      }
      const snapshots = args.paymentIds.map((id) => payments.get(id)?.payment).filter((p): p is SimPosPayment => !!p);
      return rememberWebhook(
        eventId,
        { ...base, location_id: snapshots[0]?.location_id ?? null, data: { type: 'payment', ids: args.paymentIds, object: { payments: structuredClone(snapshots) } } },
        secret,
      );
    },

    duplicate(eventId) {
      const w = eventId ? emitted.find((e) => e.eventId === eventId) : emitted[emitted.length - 1];
      if (!w) throw new Error('sim-pos: no webhook has been built to duplicate');
      return { ...w, headers: { ...w.headers } };
    },

    addLocation(accountRef, location) {
      let m = locations.get(accountRef);
      if (!m) locations.set(accountRef, (m = new Map()));
      m.set(location.ref, { ...location });
    },

    setOrderPush(mode) {
      orderPushMode = mode;
      capabilities.orderPush = mode;
    },

    settleOnlinePayment(posOrderRef, pay) {
      const order = pushedOrders.find((x) => x.posOrderRef === posOrderRef);
      if (!order || order.state !== 'open') return null;
      return paidOnline(order, { tipCents: pay.tipCents, at: pay.at });
    },

    settleOrder(posOrderRef, o = {}) {
      const order = pushedOrders.find((x) => x.posOrderRef === posOrderRef);
      if (!order) throw new Error(`sim-pos: no order ${posOrderRef}`);
      if (order.state !== 'open') throw new Error('sim-pos: that order is already paid');
      const discount = order.discounts.reduce((s, d) => s + d.amountCents, 0);
      const payment = createSale({
        accountRef: order.accountRef,
        locationRef: order.order.locationRef,
        lines: order.order.lines.map((l) => ({ name: l.name, unitPriceCents: l.unitPriceCents - l.modifiers.reduce((s, m) => s + m.priceCents, 0), qty: l.qty, externalItemId: l.externalItemId ?? null, modifiers: l.modifiers })),
        discount: discount > 0 ? { name: order.discounts.map((d) => d.name).join(', '), amountCents: discount } : undefined,
        channel: order.order.channel === 'dine-in-qr' ? 'dine-in' : order.order.channel,
        table: order.order.tableLabel ?? null,
        orderRef: posOrderRef,
        ...o,
      });
      held(payment.id).payment.order.reference_id = order.order.reference;
      order.state = 'paid';
      order.paymentId = payment.id;
      return structuredClone(held(payment.id).payment);
    },

    get(paymentId) {
      const h = payments.get(paymentId);
      return h ? structuredClone(h.payment) : undefined;
    },

    sales(filter) {
      return inScope(filter).map((h) => structuredClone(h.payment));
    },

    totals(filter) {
      const live = inScope(filter)
        .map((h) => h.payment)
        .filter((p) => p.status !== 'CANCELED');
      const sum = (f: (p: SimPosPayment) => number) => live.reduce((s, p) => s + f(p), 0);
      const totalCents = sum((p) => p.total_money.amount);
      const refundedCents = sum((p) => p.refunded_money.amount);
      return { count: live.length, totalCents, refundedCents, tipCents: sum((p) => p.tip_money.amount), netCents: totalCents - refundedCents };
    },

    reset() {
      payments.clear();
      locations.clear();
      pushedOrders.length = 0;
      pushByKey.clear();
      emitted.length = 0;
      for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;
      failures = 0;
      cursorEpoch = 0;
      orderPushMode = 'after_payment';
      capabilities.orderPush = orderPushMode;
    },
  };
}
