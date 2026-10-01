import { createHmac } from 'node:crypto';
import { type PosWebhookEvent, type WebhookVerifyArgs, safeEqual } from '@ros/core';
import type { SquareWebhookEvent } from './types';

export const SQUARE_SIGNATURE_HEADER = 'x-square-hmacsha256-signature';

/**
 * The signature Square puts on a webhook: HMAC-SHA256, keyed with the subscription's signature
 * key, over the notification URL followed directly by the raw body, base64-encoded.
 * (developer.squareup.com/docs/webhooks/step3validate; construction confirmed against Square's
 * own SDK helper, which computes `notificationUrl + requestBody`.)
 */
export function squareSignature(signatureKey: string, notificationUrl: string, rawBody: string): string {
  return createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64');
}

/**
 * `signingSecret` is the signature key of the webhook subscription. `url` must be the
 * notification URL exactly as registered with Square: a different scheme, host or trailing
 * slash gives a different signature.
 */
export function verifySquareWebhook(args: WebhookVerifyArgs): boolean {
  const header = Object.entries(args.headers).find(([k]) => k.toLowerCase() === SQUARE_SIGNATURE_HEADER)?.[1];
  if (!header || !args.signingSecret || !args.rawBody) return false;
  return safeEqual(header, squareSignature(args.signingSecret, args.url, args.rawBody));
}

/**
 * Which payments an event is about. Payment events name the payment; refund events name the
 * payment that was refunded. Anything else (orders, customers, …) names none and is ignored.
 * The payment object inside the event is not read: the ledger fetches the payment again.
 */
export function parseSquareWebhook(rawBody: string): PosWebhookEvent | null {
  let body: SquareWebhookEvent;
  try {
    body = JSON.parse(rawBody) as SquareWebhookEvent;
  } catch {
    return null;
  }
  if (!body || typeof body.event_id !== 'string' || typeof body.merchant_id !== 'string') return null;
  const data = body.data ?? {};
  const refs: string[] = [];
  let locationRef: string | null = typeof body.location_id === 'string' ? body.location_id : null;
  if (data.type === 'payment') {
    if (typeof data.id === 'string') refs.push(data.id);
    locationRef ??= data.object?.payment?.location_id ?? null;
  } else if (data.type === 'refund') {
    const paymentId = data.object?.refund?.payment_id;
    if (typeof paymentId === 'string') refs.push(paymentId);
    locationRef ??= data.object?.refund?.location_id ?? null;
  }
  return {
    eventId: body.event_id,
    type: typeof body.type === 'string' ? body.type : 'unknown',
    accountRef: body.merchant_id,
    locationRef,
    transactionRefs: refs,
  };
}
