import { AppError } from '../errors';
import type { ConnectionHandle, WebhookVerifyArgs } from './connection';

/** docs/modules/delivery.md part A — courier dispatched by API for orders placed on the venue's own site. */
export interface Address {
  line1: string;
  line2?: string | null;
  suburb: string;
  state: string;
  postcode: string;
  country?: string;
  lat?: number | null;
  lng?: number | null;
}

export interface CourierQuoteRequest {
  pickup: { name: string; phone?: string | null; address: Address };
  dropoff: { name: string; phone?: string | null; address: Address; notes?: string | null };
  readyAt: Date;
  orderValueCents: number;
  containsAlcohol: boolean;
}

export interface CourierQuote {
  quoteId: string;
  feeCents: number;
  currency: string;
  pickupEta: Date;
  dropoffEta: Date;
  expiresAt: Date;
}

export type CourierStatus = 'requested' | 'courier_assigned' | 'picked_up' | 'delivered' | 'failed' | 'returned' | 'cancelled';

export interface CourierDelivery {
  externalRef: string;
  status: CourierStatus;
  trackingUrl?: string | null;
  pickupEta?: Date | null;
  dropoffEta?: Date | null;
  courierName?: string | null;
  feeCents: number;
  /** Photo, signature or PIN, as the provider returns it. Never a card identifier. */
  proof?: unknown;
  /** The provider's reason for a failed, returned or cancelled delivery, in its own words. */
  failureReason?: string | null;
  /** A cancellation fee the provider charged, in cents, when it reports one. */
  cancellationFeeCents?: number;
}

export interface CourierEvent {
  eventId: string;
  externalRef: string;
  status: CourierStatus;
  occurredAt: Date;
  pickupEta?: Date | null;
  dropoffEta?: Date | null;
  courierName?: string | null;
  proof?: unknown;
  raw?: unknown;
}

/**
 * The provider has no courier for this delivery right now. Thrown by `create` (a quote answers
 * `null` instead). Callers try the next provider, then the venue's fallback; they never retry it.
 */
export class NoCourierError extends AppError {
  constructor(message = 'No courier is available right now.') {
    super('unavailable', message, { noCourier: true });
    this.name = 'NoCourierError';
  }
}

export function isNoCourier(e: unknown): boolean {
  return e instanceof AppError && e.code === 'unavailable' && (e.details as { noCourier?: boolean } | undefined)?.noCourier === true;
}

export interface CourierAdapter {
  key: string;
  supportsAlcohol: boolean;
  quote(conn: ConnectionHandle, req: CourierQuoteRequest): Promise<CourierQuote | null>;
  create(
    conn: ConnectionHandle,
    req: CourierQuoteRequest & { quoteId: string; idempotencyKey: string; reference: string },
  ): Promise<CourierDelivery>;
  get(conn: ConnectionHandle, externalRef: string): Promise<CourierDelivery | null>;
  cancel(conn: ConnectionHandle, externalRef: string): Promise<{ cancelled: boolean; feeCents: number }>;
  verifyWebhook(args: WebhookVerifyArgs): boolean;
  parseWebhook(rawBody: string): CourierEvent | null;
}
