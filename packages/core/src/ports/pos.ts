import type { ConnectionHandle, WebhookVerifyArgs } from './connection';

/** docs/modules/pos-adapters.md — the adapter contract. */
export interface PosCapabilities {
  itemisedLines: boolean;
  customerIdentity: 'none' | 'card_fingerprint' | 'customer_id' | 'both';
  writeBack: 'none' | 'discount' | 'order';
  webhooks: boolean;
  realtime: boolean;
  /**
   * When an online order can be put on the POS (docs/modules/pos-adapters.md):
   *   before_payment  pushed first, and the payment names it (PaymentRequest.posOrderRef).
   *                   Square works this way: an order shows on the till only once a payment
   *                   that named it at creation has completed.
   *   after_payment   pushed once paid, carrying the payment's ref (PosOrderPush.paymentRef).
   *   none            the POS cannot take orders.
   * Left out: 'after_payment' when the adapter has pushOrder, else 'none'.
   */
  orderPush?: 'before_payment' | 'after_payment' | 'none';
}

export type TxnSource = 'square' | 'lightspeed' | 'online-order' | 'pos' | 'manual' | 'aggregator' | 'sim';
export type TxnChannel = 'dine-in' | 'pickup' | 'delivery' | 'catering' | 'retail';
export type TxnStatus = 'pending' | 'completed' | 'refunded' | 'partially_refunded' | 'voided';

export interface CanonicalLine {
  lineNo: number;
  /** The provider's catalogue id, matched to menu_items.pos_catalog_id when present. */
  externalItemId?: string | null;
  name: string;
  category?: string | null;
  qty: number;
  unitPriceCents: number;
  modifiers: Array<{ name: string; priceCents: number }>;
  discountCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * Something that may identify who paid. Card kinds carry the provider's raw value here; the
 * ledger hashes them per org, and only when the guest has consented, before anything is stored
 * (docs/SCHEMA.md section 2a). Adapters pass them through and never persist them.
 */
export interface IdentityHint {
  kind: 'email' | 'phone' | 'pos_customer_id' | 'card_fingerprint' | 'card_par' | 'loyalty_qr';
  value: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface CanonicalTransaction {
  source: TxnSource;
  externalRef: string;
  /** The provider's location id; resolved to a venue through the connection. */
  locationRef?: string | null;
  occurredAt: Date;
  channel: TxnChannel;
  status: TxnStatus;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  totalCents: number;
  refundedCents: number;
  currency: string;
  tenderType?: string | null;
  staffRef?: string | null;
  tableLabel?: string | null;
  /** Our own order id when the sale began on this platform and was pushed to the POS. */
  orderId?: string | null;
  /**
   * True when the provider shows this sale was taken by this platform's own integration (an
   * online order paid through the payment port). The module that took it records it itself, so
   * POS ingest skips it rather than count the same money twice.
   */
  originatedHere?: boolean;
  lines: CanonicalLine[];
  /** Discounts applied at the till, by name. Lets an offer or reward redeemed in venue be matched to the sale. */
  discounts?: Array<{ name: string; code?: string | null; amountCents: number }>;
  identityHints: IdentityHint[];
  /** The provider's payload. The ledger strips card identifiers from it before storing. */
  raw?: unknown;
}

export interface PosWebhookEvent {
  eventId: string;
  type: string;
  /** The provider's merchant/account id, used to find the connection. */
  accountRef: string;
  locationRef?: string | null;
  /** Webhooks are hints: the ledger re-fetches each of these before acting. */
  transactionRefs: string[];
}

export interface PosOrderPush {
  idempotencyKey: string;
  reference: string;
  locationRef: string;
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  tableLabel?: string | null;
  customerName?: string | null;
  note?: string | null;
  readyAt?: Date | null;
  lines: Array<{
    name: string;
    externalItemId?: string | null;
    qty: number;
    unitPriceCents: number;
    modifiers: Array<{ name: string; priceCents: number }>;
    note?: string | null;
  }>;
  totalCents: number;
  /** The payment already taken online, so the POS shows the order as paid. */
  paymentRef?: string | null;
  /**
   * Order-level amounts beside the lines, so the POS order totals what the guest pays (a POS
   * that is paid against the order, such as Square, refuses a payment that does not match).
   */
  discounts?: Array<{ name: string; amountCents: number }>;
  /** e.g. the delivery fee. */
  serviceCharges?: Array<{ name: string; amountCents: number }>;
  /** The guest's tip, which the payment carries separately. */
  tipCents?: number;
  currency?: string;
}

export interface PosAdapter {
  key: string;
  source: TxnSource;
  capabilities: PosCapabilities;
  listLocations(conn: ConnectionHandle): Promise<Array<{ ref: string; name: string; timezone?: string }>>;
  /**
   * One page of sales at a location. `since` and `until` bound when a sale last CHANGED at the
   * provider, not when it was made, so a poll also sees a refund or a late capture on an older
   * sale. Oldest change first. `cursor` continues the same query. Callers overlap successive
   * windows and record idempotently, so a sale on a boundary may be returned twice, never missed.
   */
  listTransactions(
    conn: ConnectionHandle,
    args: { locationRef: string; since: Date; until?: Date; cursor?: string | null; limit?: number },
  ): Promise<{ items: CanonicalTransaction[]; nextCursor: string | null }>;
  getTransaction(conn: ConnectionHandle, externalRef: string): Promise<CanonicalTransaction | null>;
  verifyWebhook(args: WebhookVerifyArgs): boolean;
  parseWebhook(rawBody: string): PosWebhookEvent | null;
  /** Tier 1 only: put an online order where the venue's staff already look. */
  pushOrder?(conn: ConnectionHandle, order: PosOrderPush): Promise<{ posOrderRef: string }>;
  /** Tier 1 only: one-tap in-venue redemption. */
  applyDiscount?(
    conn: ConnectionHandle,
    args: { locationRef: string; orderRef: string; name: string; amountCents: number; idempotencyKey: string },
  ): Promise<{ ok: boolean }>;
}
