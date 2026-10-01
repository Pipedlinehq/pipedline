import { createHash, randomUUID } from 'node:crypto';
import {
  type ConnectionHandle,
  type CourierAdapter,
  type CourierDelivery,
  type CourierEvent,
  type CourierQuote,
  type CourierQuoteRequest,
  type CourierStatus,
  NoCourierError,
  definePlug,
} from '@ros/core';
import { signedWebhook, simVerify } from './signing';

export const SIM_COURIER_A = 'sim-courier-a';
export const SIM_COURIER_B = 'sim-courier-b';

/** One delivery as the simulated courier service holds it. */
export interface SimCourierJob {
  externalRef: string;
  idempotencyKey: string;
  accountRef: string;
  quoteId: string;
  reference: string;
  status: CourierStatus;
  feeCents: number;
  cancellationFeeCents: number;
  trackingUrl: string;
  courierName: string | null;
  pickupEta: Date;
  dropoffEta: Date;
  request: CourierQuoteRequest;
  proof: { photo_url: string; pin_verified: boolean } | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface SimCourierQuote {
  quoteId: string;
  accountRef: string;
  feeCents: number;
  expiresAt: Date;
  request: CourierQuoteRequest;
}

export interface SimCourierWebhook {
  eventId: string;
  rawBody: string;
  headers: Record<string, string>;
}

export interface SimCourierAdapter extends CourierAdapter {
  /** Quotes handed out, in order. */
  readonly quotes: SimCourierQuote[];
  /** Deliveries created, in order. A repeat create with the same key does not add one. */
  readonly jobs: SimCourierJob[];
  readonly calls: Record<'quote' | 'create' | 'get' | 'cancel', number>;
  /** No courier anywhere: quotes answer null and creates are refused. */
  setNoCourier(on: boolean): void;
  /** The fee quoted for the next deliveries, in cents. */
  setFee(cents: number): void;
  /** How long a quote holds. */
  setQuoteMinutes(minutes: number): void;
  /** Make the next n calls fail as an outage. */
  failNext(n: number, message?: string): void;
  /**
   * Move a delivery on at the provider, as the courier does, and build the signed webhook the
   * provider would post about it. Moving it does not deliver the webhook: the test decides
   * whether it arrives, twice, late, or never.
   */
  advance(externalRef: string, status: CourierStatus, secret: string, opts?: { failureReason?: string }): SimCourierWebhook;
  /** A webhook naming a delivery with whatever status the test likes, true or not (a hint, not a fact). */
  webhook(secret: string, args: { externalRef: string; status: CourierStatus; eventId?: string }): SimCourierWebhook;
  job(externalRef: string): SimCourierJob | undefined;
  reset(): void;
}

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const addMin = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

/** Only these moves happen at a real courier service; anything else is refused. */
const ALLOWED: Record<CourierStatus, CourierStatus[]> = {
  requested: ['courier_assigned', 'cancelled', 'failed'],
  courier_assigned: ['picked_up', 'cancelled', 'failed'],
  picked_up: ['delivered', 'returned', 'failed'],
  delivered: [],
  failed: [],
  returned: [],
  cancelled: [],
};

/**
 * A courier-as-a-service that exists only in memory. It behaves like the real ones where it
 * matters to dispatch: quotes expire, a create is idempotent on its key, a delivery moves
 * through the provider's states, webhooks are signed over the raw body and can be replayed,
 * and cancelling after a courier is assigned costs a fee.
 */
export function createSimCourierAdapter(opts: { key: string; feeCents?: number; quoteMinutes?: number; cancellationFeeCents?: number; clock?: () => Date }): SimCourierAdapter {
  const quotes: SimCourierQuote[] = [];
  const jobs: SimCourierJob[] = [];
  const byKey = new Map<string, SimCourierJob>();
  const calls = { quote: 0, create: 0, get: 0, cancel: 0 };
  let noCourier = false;
  let fee = opts.feeCents ?? 900;
  let quoteMinutes = opts.quoteMinutes ?? 10;
  let failures = 0;
  let failureMessage = `${opts.key}: simulated outage`;
  const now = () => (opts.clock ? opts.clock() : new Date());

  const reach = (method: keyof typeof calls) => {
    calls[method]++;
    if (failures > 0) {
      failures--;
      throw new Error(failureMessage);
    }
  };

  const view = (j: SimCourierJob): CourierDelivery => ({
    externalRef: j.externalRef,
    status: j.status,
    trackingUrl: j.trackingUrl,
    pickupEta: j.pickupEta,
    dropoffEta: j.dropoffEta,
    courierName: j.courierName,
    feeCents: j.feeCents,
    proof: j.proof,
    failureReason: j.failureReason,
    cancellationFeeCents: j.cancellationFeeCents,
  });

  const own = (conn: ConnectionHandle, ref: string) => {
    const j = jobs.find((x) => x.externalRef === ref);
    return j && j.accountRef === conn.externalAccountId ? j : undefined;
  };

  const eventBody = (j: SimCourierJob, status: CourierStatus, eventId: string) => ({
    event_id: eventId,
    type: 'delivery.status',
    delivery_id: j.externalRef,
    status,
    occurred_at: now().toISOString(),
  });

  return {
    key: opts.key,
    supportsAlcohol: false,
    quotes,
    jobs,
    calls,

    async quote(conn, req): Promise<CourierQuote | null> {
      reach('quote');
      if (noCourier) return null;
      const at = now();
      const q: SimCourierQuote = { quoteId: `${opts.key}_q_${short(randomUUID())}`, accountRef: conn.externalAccountId, feeCents: fee, expiresAt: addMin(at, quoteMinutes), request: structuredClone(req) };
      quotes.push(q);
      const pickup = req.readyAt > at ? req.readyAt : addMin(at, 8);
      return { quoteId: q.quoteId, feeCents: q.feeCents, currency: 'AUD', pickupEta: pickup, dropoffEta: addMin(pickup, 20), expiresAt: q.expiresAt };
    },

    async create(conn, req): Promise<CourierDelivery> {
      reach('create');
      const prior = byKey.get(`${conn.externalAccountId}:${req.idempotencyKey}`);
      if (prior) return view(prior);
      if (noCourier) throw new NoCourierError();
      const q = quotes.find((x) => x.quoteId === req.quoteId && x.accountRef === conn.externalAccountId);
      if (!q) throw new Error(`${opts.key}: 400 unknown quote`);
      if (q.expiresAt <= now()) throw new Error(`${opts.key}: 400 quote expired`);
      const at = now();
      const externalRef = `${opts.key}_d_${short(`${conn.externalAccountId}:${req.idempotencyKey}`)}`;
      const pickup = req.readyAt > at ? req.readyAt : addMin(at, 8);
      const j: SimCourierJob = {
        externalRef,
        idempotencyKey: req.idempotencyKey,
        accountRef: conn.externalAccountId,
        quoteId: req.quoteId,
        reference: req.reference,
        status: 'requested',
        feeCents: q.feeCents,
        cancellationFeeCents: 0,
        trackingUrl: `https://track.${opts.key}.test/${externalRef}`,
        courierName: null,
        pickupEta: pickup,
        dropoffEta: addMin(pickup, 20),
        request: structuredClone(req),
        proof: null,
        failureReason: null,
        createdAt: at,
      };
      jobs.push(j);
      byKey.set(`${conn.externalAccountId}:${req.idempotencyKey}`, j);
      return view(j);
    },

    async get(conn, externalRef) {
      reach('get');
      const j = own(conn, externalRef);
      return j ? view(j) : null;
    },

    async cancel(conn, externalRef) {
      reach('cancel');
      const j = own(conn, externalRef);
      if (!j) return { cancelled: false, feeCents: 0 };
      if (j.status === 'cancelled') return { cancelled: true, feeCents: j.cancellationFeeCents };
      if (j.status !== 'requested' && j.status !== 'courier_assigned') return { cancelled: false, feeCents: 0 };
      // A courier already on the way is paid for the trip.
      j.cancellationFeeCents = j.status === 'courier_assigned' ? (opts.cancellationFeeCents ?? 500) : 0;
      j.status = 'cancelled';
      return { cancelled: true, feeCents: j.cancellationFeeCents };
    },

    verifyWebhook: simVerify,

    parseWebhook(rawBody): CourierEvent | null {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (!body || typeof body.event_id !== 'string' || typeof body.delivery_id !== 'string' || typeof body.status !== 'string') return null;
      return {
        eventId: body.event_id,
        externalRef: body.delivery_id,
        status: body.status as CourierStatus,
        occurredAt: new Date(String(body.occurred_at ?? now().toISOString())),
        raw: { event_id: body.event_id, status: body.status },
      };
    },

    advance(externalRef, status, secret, o = {}) {
      const j = jobs.find((x) => x.externalRef === externalRef);
      if (!j) throw new Error(`${opts.key}: no delivery ${externalRef}`);
      if (!ALLOWED[j.status].includes(status)) throw new Error(`${opts.key}: cannot move ${j.status} to ${status}`);
      j.status = status;
      if (status === 'courier_assigned') j.courierName = 'Sam Courier';
      if (status === 'picked_up') j.dropoffEta = addMin(now(), 18);
      if (status === 'delivered') j.proof = { photo_url: `https://proof.${opts.key}.test/${externalRef}.jpg`, pin_verified: false };
      if (status === 'failed' || status === 'returned') j.failureReason = o.failureReason ?? 'Guest could not be reached at the door.';
      const eventId = randomUUID();
      return { eventId, ...signedWebhook(secret, eventBody(j, status, eventId)) };
    },

    webhook(secret, args) {
      const j = jobs.find((x) => x.externalRef === args.externalRef);
      const eventId = args.eventId ?? randomUUID();
      const body = j ? eventBody(j, args.status, eventId) : { event_id: eventId, type: 'delivery.status', delivery_id: args.externalRef, status: args.status, occurred_at: now().toISOString() };
      return { eventId, ...signedWebhook(secret, body) };
    },

    job(externalRef) {
      return jobs.find((x) => x.externalRef === externalRef);
    },

    setNoCourier(on) {
      noCourier = on;
    },
    setFee(cents) {
      fee = cents;
    },
    setQuoteMinutes(minutes) {
      quoteMinutes = minutes;
    },
    failNext(n, message) {
      failures = n;
      if (message) failureMessage = message;
    },
    reset() {
      quotes.length = 0;
      jobs.length = 0;
      byKey.clear();
      for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k] = 0;
      noCourier = false;
      fee = opts.feeCents ?? 900;
      quoteMinutes = opts.quoteMinutes ?? 10;
      failures = 0;
    },
  };
}

const simCourierPlug = (key: string, name: string) =>
  definePlug({
    key,
    name,
    description: 'A courier service that sends nobody. For development, tests and the fixture venues.',
    kind: 'adapter',
    tier: 'first_party',
    adapters: { courier: key },
    auth: 'none',
    scopes: ['deliveries:write'],
    // A courier account usually belongs to the business, but a venue may have its own.
    venueScoped: false,
    simulated: true,
  });

export const simCourierAPlug = simCourierPlug(SIM_COURIER_A, 'Simulated courier A');
export const simCourierBPlug = simCourierPlug(SIM_COURIER_B, 'Simulated courier B');
