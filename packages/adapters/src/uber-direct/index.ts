import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type Address,
  type ConnectionHandle,
  type CourierAdapter,
  type CourierDelivery,
  type CourierEvent,
  type CourierQuote,
  type CourierQuoteRequest,
  type CourierStatus,
  type WebhookVerifyArgs,
  NoCourierError,
} from '@ros/core';

/**
 * Uber Direct (the Uber Deliveries API) behind the courier port, over plain `fetch`.
 *
 * UNVERIFIED AGAINST UBER. Checked on 2026-10-01 against developer.uber.com/docs/deliveries
 * (authentication, webhooks, proof of delivery) and the OpenAPI types shipped in Uber's own
 * SDK (github.com/uber/uber-direct-sdk, src/types/deliveries.d.ts): paths, the JSON-string
 * address format, `fee` in cents, `expires`, `dropoff_eta`, the status values, `tracking_url`,
 * `courier.name`, `idempotency_key` and `external_id` in the create body, and the webhook
 * signature (HMAC-SHA256 hex of the raw body, `x-uber-signature` / `x-postmates-signature`).
 * NOT confirmed: the exact webhook body shape (its event id field), the error codes that mean
 * "no courier", and whether cancel reports a fee (it is taken as 0). There were no
 * credentials: this has never talked to Uber. Its tests replay payloads built from the
 * documented shapes. Verify against a sandbox customer before a venue depends on it.
 *
 * What an Uber Direct connection holds:
 *   externalAccountId          the Direct customer id (the path's {customer_id})
 *   credentials.clientId, clientSecret   client-credentials grant, scope eats.deliveries
 *   credentials.webhookSecret  the webhook signing key
 */
export interface UberDirectOptions {
  fetch?: typeof fetch;
  clock?: () => Date;
  timeoutMs?: number;
  apiBase?: string;
  tokenUrl?: string;
}

export const UBER_SIGNATURE_HEADERS = ['x-uber-signature', 'x-postmates-signature'];
const NO_COURIER_CODES = new Set(['couriers_busy', 'no_couriers_available', 'address_undeliverable', 'address_undeliverable_limited_couriers', 'courier_unavailable']);

export class UberApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, path: string) {
    super(`uber-direct: ${status} on ${path} (${code ?? 'no error code'})`);
    this.name = 'UberApiError';
  }
}

interface UberDelivery {
  id?: string;
  quote_id?: string;
  status?: string;
  fee?: number;
  currency?: string;
  tracking_url?: string;
  pickup_eta?: string;
  dropoff_eta?: string;
  courier?: { name?: string } | null;
  dropoff?: { verification?: unknown } | null;
  undeliverable_reason?: string;
  undeliverable_action?: string;
}

const STATUS: Record<string, CourierStatus> = {
  pending: 'requested',
  pickup: 'courier_assigned',
  pickup_complete: 'picked_up',
  dropoff: 'picked_up',
  delivered: 'delivered',
  canceled: 'cancelled',
  returned: 'returned',
};

export function uberStatus(s: string | undefined): CourierStatus {
  return (s && STATUS[s]) || 'requested';
}

/** Uber takes an address as a JSON-encoded string. */
export function uberAddress(a: Address): string {
  return JSON.stringify({
    street_address: [a.line1, ...(a.line2 ? [a.line2] : [])],
    city: a.suburb,
    state: a.state,
    zip_code: a.postcode,
    country: a.country ?? 'AU',
  });
}

const date = (s: string | undefined | null) => (s ? new Date(s) : null);

export function uberSignature(signingKey: string, rawBody: string): string {
  return createHmac('sha256', signingKey).update(rawBody).digest('hex');
}

export function createUberDirectAdapter(opts: UberDirectOptions = {}): CourierAdapter {
  const doFetch = opts.fetch ?? fetch;
  const now = () => (opts.clock ? opts.clock() : new Date());
  const apiBase = opts.apiBase ?? 'https://api.uber.com';
  const tokenUrl = opts.tokenUrl ?? 'https://auth.uber.com/oauth/v2/token';
  // Tokens last 30 days and the token endpoint allows ~100 requests an hour: cache them.
  const tokens = new Map<string, { token: string; expiresAt: number }>();

  async function token(conn: ConnectionHandle): Promise<string> {
    const { clientId, clientSecret } = conn.credentials;
    if (!clientId || !clientSecret) throw new UberApiError(401, 'missing_credentials', '/oauth/v2/token');
    const cached = tokens.get(clientId);
    if (cached && cached.expiresAt > now().getTime() + 60_000) return cached.token;
    const res = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'eats.deliveries' }).toString(),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
    if (!res.ok || !body?.access_token) throw new UberApiError(res.status, body?.error ?? null, '/oauth/v2/token');
    tokens.set(clientId, { token: body.access_token, expiresAt: now().getTime() + (body.expires_in ?? 2_592_000) * 1000 });
    return body.access_token;
  }

  async function call<T>(conn: ConnectionHandle, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${apiBase}/v1/customers/${encodeURIComponent(conn.externalAccountId)}${path}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method,
        headers: { Authorization: `Bearer ${await token(conn)}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      if (e instanceof UberApiError) throw e;
      throw new Error(`uber-direct: request to ${path} did not complete (${(e as Error).name})`);
    }
    const parsed = (await res.json().catch(() => null)) as (T & { code?: string }) | null;
    if (!res.ok) throw new UberApiError(res.status, parsed?.code ?? null, path);
    return (parsed ?? {}) as T;
  }

  const view = (d: UberDelivery, fallbackRef?: string): CourierDelivery => ({
    externalRef: d.id ?? fallbackRef ?? '',
    status: uberStatus(d.status),
    trackingUrl: d.tracking_url ?? null,
    pickupEta: date(d.pickup_eta),
    dropoffEta: date(d.dropoff_eta),
    courierName: d.courier?.name ?? null,
    feeCents: Number.isInteger(d.fee) ? d.fee! : 0,
    proof: d.dropoff?.verification ?? null,
    failureReason: d.undeliverable_reason ?? null,
  });

  const addressFields = (req: CourierQuoteRequest) => ({
    pickup_address: uberAddress(req.pickup.address),
    dropoff_address: uberAddress(req.dropoff.address),
    ...(typeof req.pickup.address.lat === 'number' ? { pickup_latitude: req.pickup.address.lat, pickup_longitude: req.pickup.address.lng } : {}),
    ...(typeof req.dropoff.address.lat === 'number' ? { dropoff_latitude: req.dropoff.address.lat, dropoff_longitude: req.dropoff.address.lng } : {}),
    ...(req.pickup.phone ? { pickup_phone_number: req.pickup.phone } : {}),
    ...(req.dropoff.phone ? { dropoff_phone_number: req.dropoff.phone } : {}),
    manifest_total_value: req.orderValueCents,
    pickup_ready_dt: req.readyAt.toISOString(),
  });

  return {
    key: 'uber-direct',
    // ID checks for restricted items are supported (dropoff_verification.identification); the
    // venue's alcohol_enabled switch still decides, and Australian availability is unconfirmed.
    supportsAlcohol: true,

    /** POST /v1/customers/{customer_id}/delivery_quotes. No courier for the address: null. */
    async quote(conn, req): Promise<CourierQuote | null> {
      let q: { id?: string; fee?: number; currency_type?: string; currency?: string; expires?: string; dropoff_eta?: string; pickup_duration?: number };
      try {
        q = await call(conn, 'POST', '/delivery_quotes', addressFields(req));
      } catch (e) {
        if (e instanceof UberApiError && e.code && NO_COURIER_CODES.has(e.code)) return null;
        throw e;
      }
      if (!q.id || !Number.isInteger(q.fee) || !q.expires) throw new Error('uber-direct: quote answered without an id, fee or expiry');
      const at = now();
      return {
        quoteId: q.id,
        feeCents: q.fee!,
        currency: (q.currency_type ?? q.currency ?? 'AUD').toUpperCase(),
        pickupEta: new Date(at.getTime() + (q.pickup_duration ?? 0) * 60_000),
        dropoffEta: date(q.dropoff_eta) ?? at,
        expiresAt: new Date(q.expires),
      };
    },

    /** POST /v1/customers/{customer_id}/deliveries, idempotent on `idempotency_key`. */
    async create(conn, req): Promise<CourierDelivery> {
      let d: UberDelivery;
      try {
        d = await call(conn, 'POST', '/deliveries', {
          ...addressFields(req),
          quote_id: req.quoteId,
          pickup_name: req.pickup.name,
          dropoff_name: req.dropoff.name,
          ...(req.dropoff.notes ? { dropoff_notes: req.dropoff.notes.slice(0, 280) } : {}),
          manifest_items: [{ name: `Order ${req.reference}`, quantity: 1, size: 'small', price: req.orderValueCents }],
          external_id: req.reference,
          idempotency_key: req.idempotencyKey,
          ...(req.containsAlcohol ? { dropoff_verification: { identification: { min_age: 18 } } } : {}),
        });
      } catch (e) {
        if (e instanceof UberApiError && e.code && NO_COURIER_CODES.has(e.code)) throw new NoCourierError();
        throw e;
      }
      if (!d.id) throw new Error('uber-direct: create answered without a delivery id');
      return view(d);
    },

    /** GET /v1/customers/{customer_id}/deliveries/{delivery_id}. Unknown: null. */
    async get(conn, externalRef) {
      try {
        return view(await call<UberDelivery>(conn, 'GET', `/deliveries/${encodeURIComponent(externalRef)}`), externalRef);
      } catch (e) {
        if (e instanceof UberApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** POST /v1/customers/{customer_id}/deliveries/{delivery_id}/cancel. A refusal (already collected) is `cancelled: false`. */
    async cancel(conn, externalRef) {
      try {
        const d = await call<UberDelivery>(conn, 'POST', `/deliveries/${encodeURIComponent(externalRef)}/cancel`);
        return { cancelled: uberStatus(d.status) === 'cancelled', feeCents: 0 };
      } catch (e) {
        if (e instanceof UberApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) return { cancelled: false, feeCents: 0 };
        throw e;
      }
    },

    verifyWebhook(args: WebhookVerifyArgs): boolean {
      const header = Object.entries(args.headers).find(([k]) => UBER_SIGNATURE_HEADERS.includes(k.toLowerCase()))?.[1];
      if (!header || !args.signingSecret || !args.rawBody) return false;
      const want = Buffer.from(uberSignature(args.signingSecret, args.rawBody));
      const got = Buffer.from(header.trim().toLowerCase());
      return want.length === got.length && timingSafeEqual(want, got);
    },

    /** event.delivery_status and event.courier_update. Only the delivery id is used; the delivery is fetched again. */
    parseWebhook(rawBody): CourierEvent | null {
      let body: { id?: string; event_id?: string; kind?: string; delivery_id?: string; status?: string; created?: string; data?: UberDelivery };
      try {
        body = JSON.parse(rawBody);
      } catch {
        return null;
      }
      const ref = body?.delivery_id ?? body?.data?.id;
      if (!ref || typeof ref !== 'string') return null;
      const status = body.status ?? body.data?.status;
      const eventId = body.id ?? body.event_id ?? `${body.kind ?? 'event'}:${status ?? ''}:${body.created ?? ''}`;
      return { eventId, externalRef: ref, status: uberStatus(status), occurredAt: date(body.created) ?? now(), raw: { kind: body.kind ?? null, status: status ?? null } };
    },
  };
}
