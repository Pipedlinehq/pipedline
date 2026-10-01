import type { ConnectionHandle, WebhookVerifyArgs } from './connection';
import type { IdentityHint } from './pos';

/**
 * Online card payments, merchant-direct. The card is entered in the provider's hosted fields;
 * we receive a single-use token, never a card number (docs/modules/ordering.md section 4).
 */
export interface PaymentRequest {
  idempotencyKey: string;
  amountCents: number;
  tipCents: number;
  currency: string;
  /** Single-use token from the provider's client SDK. */
  sourceToken: string;
  reference: string;
  note?: string | null;
  locationRef?: string | null;
  /**
   * The POS order this payment settles, when the order was pushed to the POS before paying
   * (PosAdapter.pushOrder). Some providers only show an order on the till once a payment that
   * names it has completed; adapters that have no such link ignore this.
   */
  posOrderRef?: string | null;
}

export interface PaymentResult {
  externalRef: string;
  status: 'completed' | 'failed';
  cardBrand?: string | null;
  cardLast4?: string | null;
  failureReason?: string | null;
  /** Stored with card identifiers stripped. */
  raw?: unknown;
  /**
   * The card that paid, as the provider identifies it (card kinds only). Passed straight to the
   * ledger, which hashes it per org and keeps it only for a consenting guest. Never stored raw,
   * never logged, and never part of what once() records (docs/SCHEMA.md section 2a).
   */
  identityHints?: IdentityHint[];
}

export interface RefundRequest {
  idempotencyKey: string;
  paymentRef: string;
  amountCents: number;
  currency: string;
  reason: string;
}

/** What is known about an attempt whose outcome was never heard: enough to find it at the processor. */
export interface PaymentLookup {
  /** The idempotency key the attempt was made with. */
  idempotencyKey: string;
  /** The order reference the attempt carried. */
  reference: string;
  amountCents: number;
  tipCents: number;
  currency: string;
  locationRef?: string | null;
  /** When the attempt was made (our clock). Providers that search by time window use it. */
  attemptedAt: Date;
}

export interface PaymentAdapter {
  key: string;
  /** What the browser needs to render the provider's hosted card fields. */
  clientConfig(conn: ConnectionHandle): { provider: string; applicationId: string; locationRef: string; environment: 'sandbox' | 'production' };
  createPayment(conn: ConnectionHandle, req: PaymentRequest): Promise<PaymentResult>;
  refund(conn: ConnectionHandle, req: RefundRequest): Promise<{ externalRef: string; status: 'completed' | 'pending' | 'failed' }>;
  /**
   * Find an attempt whose outcome was never heard (a timeout, a crash). The payment as the
   * processor holds it, or null when the processor has no payment for that attempt, which
   * means it did not charge. Throws when the processor cannot be asked. Without this an
   * unknown attempt stays unknown until the guest retries the same card.
   */
  lookupPayment?(conn: ConnectionHandle, req: PaymentLookup): Promise<PaymentResult | null>;
  /** The current state of a refund the processor answered as pending. */
  getRefund?(conn: ConnectionHandle, refundRef: string): Promise<{ externalRef: string; status: 'completed' | 'pending' | 'failed' } | null>;
  verifyWebhook?(args: WebhookVerifyArgs): boolean;
}
