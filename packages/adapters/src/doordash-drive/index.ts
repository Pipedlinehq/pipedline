import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
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
 * DoorDash Drive (API v2) behind the courier port, over plain `fetch`.
 *
 * UNVERIFIED AGAINST DOORDASH. Checked on 2026-10-01 against developer.doordash.com: the JWT
 * (HS256, header `dd-ver: DD-JWT-V1`, claims aud/iss/kid/iat/exp, at most 30 minutes, signed
 * with the base64url-decoded signing secret), the base URL and the quote / delivery / get /
 * cancel paths, `external_delivery_id` as the idempotency key (a duplicate answers 409),
 * `fee` in cents, `order_contains.alcohol`, the proof-of-delivery image fields, the webhook
 * event names, and that webhooks are authenticated by an Authorization header the developer
 * configures (Basic auth), not a signature. NOT confirmed: the complete delivery_status enum,
 * `dasher_name`, `tracking_url`, the ETA field names, the quote lifetime, the webhook body's
 * field names, and any cancellation fee field (taken as 0). DoorDash's FAQ lists Australia;
 * a third-party note suggests AU may need "Drive (classic)": confirm before building on it.
 * There were no credentials: this has never talked to DoorDash. Its tests replay payloads
 * built from the documented shapes.
 *
 * Drive quotes can be accepted (POST /quotes/{id}/accept) within their lifetime to lock the
 * price; this adapter instead creates the delivery directly when the courier is due, because
 * that is usually after a checkout quote has lapsed. The price may differ from the quote; the
 * guest's fee was fixed at checkout and the venue pays the difference.
 *
 * What a DoorDash Drive connection holds:
 *   credentials.developerId, keyId, signingSecret   the JWT access key
 *   credentials.webhookSecret   the exact Authorization header value set for the webhook endpoint
 */
export interface DoorDashOptions {
  fetch?: typeof fetch;
  clock?: () => Date;
  timeoutMs?: number;
  apiBase?: string;
}

const NO_COURIER = /no.?dasher|unavailable|outside.*delivery.?area|not.?deliverable/i;

export class DoorDashApiError extends Error {
  constructor(readonly status: number, readonly code: string | null, path: string) {
    super(`doordash-drive: ${status} on ${path} (${code ?? 'no error code'})`);
    this.name = 'DoorDashApiError';
  }
}

interface DriveDelivery {
  external_delivery_id?: string;
  delivery_status?: string;
  fee?: number;
  currency?: string;
  tracking_url?: string;
  pickup_time_estimated?: string;
  dropoff_time_estimated?: string;
  dasher_name?: string;
  cancellation_reason?: string;
  dropoff_verification_image_url?: string;
  dropoff_signature_image_url?: string;
}

const STATUS: Record<string, CourierStatus> = {
  quote: 'requested',
  created: 'requested',
  scheduled: 'requested',
  accepted: 'requested',
  confirmed: 'courier_assigned',
  enroute_to_pickup: 'courier_assigned',
  arrived_at_pickup: 'courier_assigned',
  pickup_arrived: 'courier_assigned',
  picked_up: 'picked_up',
  enroute_to_dropoff: 'picked_up',
  arrived_at_dropoff: 'picked_up',
  dropoff_arrived: 'picked_up',
  enroute_to_return: 'picked_up',
  delivered: 'delivered',
  cancelled: 'cancelled',
  returned: 'returned',
};

export function driveStatus(s: string | undefined): CourierStatus {
  return (s && STATUS[s.toLowerCase()]) || 'requested';
}

const EVENT_STATUS: Record<string, CourierStatus> = {
  DASHER_CONFIRMED: 'courier_assigned',
  DASHER_CONFIRMED_PICKUP_ARRIVAL: 'courier_assigned',
  DASHER_PICKED_UP: 'picked_up',
  DASHER_CONFIRMED_DROPOFF_ARRIVAL: 'picked_up',
  DASHER_DROPPED_OFF: 'delivered',
  DELIVERY_CANCELLED: 'cancelled',
  DELIVERY_RETURN_INITIALIZED: 'picked_up',
  DASHER_CONFIRMED_RETURN_ARRIVAL: 'picked_up',
  DELIVERY_RETURNED: 'returned',
};

export function driveAddress(a: Address): string {
  return [a.line1, a.line2, `${a.suburb} ${a.state} ${a.postcode}`.trim(), a.country ?? 'AU'].filter(Boolean).join(', ');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A Drive access token: HS256, `dd-ver: DD-JWT-V1`, valid for five minutes. */
export function driveJwt(creds: { developerId: string; keyId: string; signingSecret: string }, at: Date): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' }));
  const iat = Math.floor(at.getTime() / 1000);
  const payload = b64url(JSON.stringify({ aud: 'doordash', iss: creds.developerId, kid: creds.keyId, iat, exp: iat + 300 }));
  const sig = createHmac('sha256', Buffer.from(creds.signingSecret, 'base64url')).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/** external_delivery_id: our idempotency key, in the characters DoorDash accepts. */
export function driveExternalId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
}

const date = (s: string | undefined | null) => (s ? new Date(s) : null);

export function createDoorDashDriveAdapter(opts: DoorDashOptions = {}): CourierAdapter {
  const doFetch = opts.fetch ?? fetch;
  const now = () => (opts.clock ? opts.clock() : new Date());
  const apiBase = opts.apiBase ?? 'https://openapi.doordash.com';

  async function call<T>(conn: ConnectionHandle, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const { developerId, keyId, signingSecret } = conn.credentials;
    if (!developerId || !keyId || !signingSecret) throw new DoorDashApiError(401, 'missing_credentials', path);
    let res: Response;
    try {
      res = await doFetch(`${apiBase}${path}`, {
        method,
        headers: { Authorization: `Bearer ${driveJwt({ developerId, keyId, signingSecret }, now())}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new Error(`doordash-drive: request to ${path} did not complete (${(e as Error).name})`);
    }
    const parsed = (await res.json().catch(() => null)) as (T & { code?: string; message?: string }) | null;
    if (!res.ok) throw new DoorDashApiError(res.status, parsed?.code ?? null, path);
    return (parsed ?? {}) as T;
  }

  const view = (d: DriveDelivery, ref: string): CourierDelivery => ({
    externalRef: d.external_delivery_id ?? ref,
    status: driveStatus(d.delivery_status),
    trackingUrl: d.tracking_url ?? null,
    pickupEta: date(d.pickup_time_estimated),
    dropoffEta: date(d.dropoff_time_estimated),
    courierName: d.dasher_name ?? null,
    feeCents: Number.isInteger(d.fee) ? d.fee! : 0,
    proof: d.dropoff_verification_image_url || d.dropoff_signature_image_url ? { photo_url: d.dropoff_verification_image_url ?? null, signature_url: d.dropoff_signature_image_url ?? null } : null,
    failureReason: d.cancellation_reason ?? null,
  });

  const body = (req: CourierQuoteRequest, externalId: string) => ({
    external_delivery_id: externalId,
    pickup_address: driveAddress(req.pickup.address),
    pickup_business_name: req.pickup.name,
    ...(req.pickup.phone ? { pickup_phone_number: req.pickup.phone } : {}),
    dropoff_address: driveAddress(req.dropoff.address),
    dropoff_contact_given_name: req.dropoff.name,
    ...(req.dropoff.phone ? { dropoff_phone_number: req.dropoff.phone } : {}),
    ...(req.dropoff.notes ? { dropoff_instructions: req.dropoff.notes.slice(0, 280) } : {}),
    order_value: req.orderValueCents,
    currency: 'AUD',
    pickup_time: req.readyAt.toISOString(),
    order_contains: { alcohol: req.containsAlcohol },
  });

  const noCourier = (e: unknown) => e instanceof DoorDashApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 409 && e.status !== 429 && !!e.code && NO_COURIER.test(e.code);

  return {
    key: 'doordash-drive',
    supportsAlcohol: true,

    /** POST /drive/v2/quotes. The quote's external_delivery_id is its id. */
    async quote(conn, req): Promise<CourierQuote | null> {
      const id = `q-${randomUUID()}`;
      let q: DriveDelivery & { expires_at?: string };
      try {
        q = await call(conn, 'POST', '/drive/v2/quotes', body(req, id));
      } catch (e) {
        if (noCourier(e)) return null;
        throw e;
      }
      if (!Number.isInteger(q.fee)) throw new Error('doordash-drive: quote answered without a fee');
      const at = now();
      return {
        quoteId: q.external_delivery_id ?? id,
        feeCents: q.fee!,
        currency: (q.currency ?? 'AUD').toUpperCase(),
        pickupEta: date(q.pickup_time_estimated) ?? req.readyAt,
        dropoffEta: date(q.dropoff_time_estimated) ?? new Date(req.readyAt.getTime() + 30 * 60_000),
        // Quotes are short-lived; five minutes where the answer does not say.
        expiresAt: date(q.expires_at) ?? new Date(at.getTime() + 5 * 60_000),
      };
    },

    /** POST /drive/v2/deliveries with external_delivery_id = our key. A 409 means it exists: fetched instead. */
    async create(conn, req): Promise<CourierDelivery> {
      const id = driveExternalId(req.idempotencyKey);
      try {
        return view(await call<DriveDelivery>(conn, 'POST', '/drive/v2/deliveries', body(req, id)), id);
      } catch (e) {
        if (e instanceof DoorDashApiError && e.status === 409) {
          const existing = await call<DriveDelivery>(conn, 'GET', `/drive/v2/deliveries/${encodeURIComponent(id)}`);
          return view(existing, id);
        }
        if (noCourier(e)) throw new NoCourierError();
        throw e;
      }
    },

    async get(conn, externalRef) {
      try {
        return view(await call<DriveDelivery>(conn, 'GET', `/drive/v2/deliveries/${encodeURIComponent(externalRef)}`), externalRef);
      } catch (e) {
        if (e instanceof DoorDashApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** PUT /drive/v2/deliveries/{id}/cancel. Refused once the Dasher has the food: `cancelled: false`. */
    async cancel(conn, externalRef) {
      try {
        const d = await call<DriveDelivery>(conn, 'PUT', `/drive/v2/deliveries/${encodeURIComponent(externalRef)}/cancel`);
        return { cancelled: driveStatus(d.delivery_status) === 'cancelled', feeCents: 0 };
      } catch (e) {
        if (e instanceof DoorDashApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 429) return { cancelled: false, feeCents: 0 };
        throw e;
      }
    },

    /** DoorDash sends the Authorization header configured for the endpoint. `signingSecret` is that exact value. */
    verifyWebhook(args: WebhookVerifyArgs): boolean {
      const header = Object.entries(args.headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
      if (!header || !args.signingSecret) return false;
      const a = Buffer.from(header);
      const b = Buffer.from(args.signingSecret);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    parseWebhook(rawBody): CourierEvent | null {
      let b: { event_name?: string; external_delivery_id?: string; created_at?: string; delivery_status?: string };
      try {
        b = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (!b?.external_delivery_id || !b.event_name) return null;
      const status = EVENT_STATUS[b.event_name] ?? driveStatus(b.delivery_status);
      return { eventId: `${b.event_name}:${b.created_at ?? ''}`, externalRef: b.external_delivery_id, status, occurredAt: date(b.created_at) ?? now(), raw: { event_name: b.event_name } };
    },
  };
}
