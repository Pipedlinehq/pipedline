import type { CanonicalLine, CanonicalTransaction, IdentityHint, TxnChannel, TxnStatus } from '@ros/core';
import type { SquareOrder, SquarePayment } from './types';

const CARD_IDENTIFIER_KEYS = new Set(['fingerprint', 'payment_account_reference', 'par', 'card_fingerprint']);

/**
 * A copy of a Square payload with every card identifier removed. The adapter hands card
 * identifiers to the ledger in `identityHints` and nowhere else: not in `raw`, not in an error,
 * not in a log line (docs/SCHEMA.md section 2a).
 */
export function withoutCardIdentifiers<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withoutCardIdentifiers(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CARD_IDENTIFIER_KEYS.has(k.toLowerCase())) continue;
      out[k] = withoutCardIdentifiers(v);
    }
    return out as T;
  }
  return value;
}

const cents = (m: { amount?: number } | undefined | null): number => (Number.isInteger(m?.amount) ? (m!.amount as number) : 0);

export function squareStatus(payment: SquarePayment): TxnStatus {
  switch (payment.status) {
    case 'COMPLETED': {
      const refunded = cents(payment.refunded_money);
      const total = cents(payment.total_money) || cents(payment.amount_money) + cents(payment.tip_money);
      if (refunded > 0 && refunded >= total) return 'refunded';
      if (refunded > 0) return 'partially_refunded';
      return 'completed';
    }
    case 'CANCELED':
    case 'FAILED':
      // Never became a sale. The ledger skips these unless it already holds the payment as pending.
      return 'voided';
    default:
      // APPROVED (authorised, not yet captured) and PENDING.
      return 'pending';
  }
}

/**
 * Does this one payment pay for the whole order? Only then do the order's lines describe the
 * payment. A split bill has several tenders; its lines cannot be divided between them honestly,
 * so each of its payments is recorded by amount alone.
 */
export function paysWholeOrder(payment: SquarePayment, order: SquareOrder): boolean {
  const tenders = order.tenders ?? [];
  if (tenders.length > 1) return false;
  if (tenders.length === 1) {
    const t = tenders[0]!;
    return t.id === payment.id || t.payment_id === payment.id;
  }
  // No tenders listed yet (an order still open): fall back to the amounts.
  const orderTotal = cents(order.total_money);
  return orderTotal === cents(payment.total_money) || orderTotal === cents(payment.amount_money);
}

function channelOf(order: SquareOrder | null, fallback: TxnChannel): TxnChannel {
  const types = (order?.fulfillments ?? []).map((f) => f.type);
  if (types.includes('DELIVERY') || types.includes('SHIPMENT')) return 'delivery';
  if (types.includes('PICKUP')) return 'pickup';
  return fallback;
}

export interface SquareMapOptions {
  /** This platform's Square application id. A payment taken by it is marked `originatedHere`. */
  applicationId?: string | null;
  /** The channel of a sale with no fulfilment: 'dine-in' for a restaurant, 'retail' for a shop. */
  defaultChannel?: TxnChannel;
}

/**
 * One Square payment, with the order it paid for when there is one, as a canonical sale.
 *
 *   externalRef   the payment id: a payment is the unit of money, and what webhooks name
 *   totalCents    payment.total_money, always, so ledger totals equal Square's payment totals
 *   lines         the order's line items, when this payment pays the whole order
 *   line totals   gross_sales_money (before discounts); discounts and tax sit beside them
 */
export function squareToCanonical(payment: SquarePayment, order: SquareOrder | null, opts: SquareMapOptions = {}): CanonicalTransaction {
  if (!payment.id || !payment.created_at) throw new Error('square: payment is missing its id or created_at');
  const tip = cents(payment.tip_money);
  const amount = cents(payment.amount_money);
  const total = payment.total_money && Number.isInteger(payment.total_money.amount) ? cents(payment.total_money) : amount + tip;
  const itemised = order && paysWholeOrder(payment, order) ? order : null;

  const lines: CanonicalLine[] = (itemised?.line_items ?? []).map((l, i) => {
    const qty = Number(l.quantity ?? '1');
    const safeQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const modifiers = (l.modifiers ?? []).map((m) => ({ name: m.name ?? 'Modifier', priceCents: cents(m.base_price_money) }));
    const gross = l.gross_sales_money ? cents(l.gross_sales_money) : Math.round((cents(l.base_price_money) + modifiers.reduce((s, m) => s + m.priceCents, 0)) * safeQty);
    const name = l.name ?? 'Item';
    return {
      lineNo: i + 1,
      externalItemId: l.catalog_object_id ?? null,
      name: l.variation_name && l.variation_name !== name ? `${name} (${l.variation_name})` : name,
      category: null,
      qty: safeQty,
      unitPriceCents: Math.round(gross / safeQty),
      modifiers,
      discountCents: cents(l.total_discount_money),
      taxCents: cents(l.total_tax_money),
      totalCents: gross,
    };
  });

  const identityHints: IdentityHint[] = [];
  if (payment.customer_id) identityHints.push({ kind: 'pos_customer_id', value: payment.customer_id });
  if (payment.buyer_email_address) identityHints.push({ kind: 'email', value: payment.buyer_email_address });
  const fingerprint = payment.card_details?.card?.fingerprint;
  if (fingerprint) identityHints.push({ kind: 'card_fingerprint', value: fingerprint });

  return {
    source: 'square',
    externalRef: payment.id,
    locationRef: payment.location_id ?? null,
    occurredAt: new Date(payment.created_at),
    channel: channelOf(order, opts.defaultChannel ?? 'dine-in'),
    status: squareStatus(payment),
    subtotalCents: lines.length ? lines.reduce((s, l) => s + l.totalCents, 0) : amount,
    discountCents: lines.length ? cents(itemised?.total_discount_money) : 0,
    taxCents: lines.length ? cents(itemised?.total_tax_money) : 0,
    tipCents: tip,
    totalCents: total,
    refundedCents: cents(payment.refunded_money),
    currency: payment.total_money?.currency ?? payment.amount_money?.currency ?? 'AUD',
    tenderType: payment.source_type ? payment.source_type.toLowerCase() : null,
    staffRef: payment.team_member_id ?? payment.employee_id ?? null,
    tableLabel: null,
    originatedHere: !!opts.applicationId && payment.application_details?.application_id === opts.applicationId,
    lines,
    discounts: (itemised?.discounts ?? []).map((d) => ({ name: d.name ?? 'Discount', code: null, amountCents: cents(d.applied_money) || cents(d.amount_money) })),
    identityHints,
    raw: withoutCardIdentifiers({ payment, order: order ?? null }),
  };
}
