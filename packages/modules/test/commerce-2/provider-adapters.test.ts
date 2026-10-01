import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ConnectionHandle, type CourierQuoteRequest, isNoCourier } from '@ros/core';
import { createDoorDashDriveAdapter, createSquareAdapter, createUberDirectAdapter, driveJwt } from '@ros/adapters';

/**
 * The real courier adapters and the Square payment additions, against payloads built from the
 * providers' documented shapes (see each adapter's header for what was and was not confirmed).
 * None of this has run against the real services: there are no credentials.
 */

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stub(route: (req: Seen) => { status?: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? (init.body.startsWith('{') ? JSON.parse(init.body) : init.body) : null,
    };
    seen.push(req);
    const r = route(req);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fetchFn, seen };
}

const handle = (over: Partial<ConnectionHandle> = {}): ConnectionHandle => ({
  id: 'c1',
  orgId: 'o1',
  venueId: null,
  plugKey: 'x',
  externalAccountId: 'cus_123',
  scopes: [],
  config: {},
  credentials: {},
  ...over,
});

const request: CourierQuoteRequest = {
  pickup: { name: 'Oak Diner', phone: '+61290000000', address: { line1: '1 Fixture Street', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', country: 'AU', lat: -33.8861, lng: 151.2111 } },
  dropoff: { name: 'Dee Livery', phone: '+61400222333', address: { line1: '12 Test Street', line2: 'Unit 4', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', country: 'AU', lat: -33.88, lng: 151.215 }, notes: 'Gate code 1234' },
  readyAt: new Date('2026-10-01T08:20:00.000Z'),
  orderValueCents: 2600,
  containsAlcohol: false,
};
const clock = () => new Date('2026-10-01T08:00:00.000Z');

describe('Uber Direct adapter (unverified live)', () => {
  const conn = handle({ plugKey: 'uber-direct', credentials: { clientId: 'cid', clientSecret: 'csecret', webhookSecret: 'uber-signing-key' } });

  it('gets a client-credentials token once, quotes with JSON-string addresses, and books idempotently', async () => {
    const api = stub((req) => {
      if (req.url.endsWith('/oauth/v2/token')) return { body: { access_token: 'tok-1', expires_in: 2592000, token_type: 'Bearer' } };
      if (req.url.endsWith('/delivery_quotes')) return { body: { kind: 'delivery_quote', id: 'dqt_abc', fee: 895, currency_type: 'AUD', expires: '2026-10-01T08:15:00.000Z', dropoff_eta: '2026-10-01T08:45:00.000Z', pickup_duration: 12 } };
      if (req.url.endsWith('/deliveries') && req.method === 'POST')
        return { body: { kind: 'delivery', id: 'del_xyz', status: 'pending', fee: 895, tracking_url: 'https://www.ubereats.com/orders/del_xyz', pickup_eta: '2026-10-01T08:20:00.000Z', dropoff_eta: '2026-10-01T08:45:00.000Z' } };
      return { status: 404, body: { code: 'not_found' } };
    });
    const uber = createUberDirectAdapter({ fetch: api.fetch, clock });
    const q = await uber.quote(conn, request);
    expect(q).toEqual({ quoteId: 'dqt_abc', feeCents: 895, currency: 'AUD', pickupEta: new Date('2026-10-01T08:12:00.000Z'), dropoffEta: new Date('2026-10-01T08:45:00.000Z'), expiresAt: new Date('2026-10-01T08:15:00.000Z') });
    const token = api.seen[0]!;
    expect(token.url).toBe('https://auth.uber.com/oauth/v2/token');
    expect(token.body).toBe('client_id=cid&client_secret=csecret&grant_type=client_credentials&scope=eats.deliveries');
    const quoteReq = api.seen[1]!;
    expect(quoteReq.url).toBe('https://api.uber.com/v1/customers/cus_123/delivery_quotes');
    expect(quoteReq.headers.Authorization).toBe('Bearer tok-1');
    expect(JSON.parse((quoteReq.body as { dropoff_address: string }).dropoff_address)).toEqual({ street_address: ['12 Test Street', 'Unit 4'], city: 'Surry Hills', state: 'NSW', zip_code: '2010', country: 'AU' });
    expect(quoteReq.body).toMatchObject({ manifest_total_value: 2600, pickup_ready_dt: '2026-10-01T08:20:00.000Z', dropoff_latitude: -33.88 });

    const d = await uber.create(conn, { ...request, quoteId: 'dqt_abc', idempotencyKey: 'courier:d1:uber-direct', reference: 'A7K2Q' });
    expect(d).toMatchObject({ externalRef: 'del_xyz', status: 'requested', feeCents: 895, trackingUrl: 'https://www.ubereats.com/orders/del_xyz' });
    expect(api.seen[2]!.body).toMatchObject({ quote_id: 'dqt_abc', idempotency_key: 'courier:d1:uber-direct', external_id: 'A7K2Q', dropoff_name: 'Dee Livery', dropoff_notes: 'Gate code 1234' });
    // One token for all three calls.
    expect(api.seen.filter((s) => s.url.endsWith('/oauth/v2/token'))).toHaveLength(1);
  });

  it('maps Uber statuses, reads proof, treats "no couriers" as no courier, and verifies webhook signatures on the raw body', async () => {
    const statuses: Array<[string, string]> = [['pending', 'requested'], ['pickup', 'courier_assigned'], ['pickup_complete', 'picked_up'], ['dropoff', 'picked_up'], ['delivered', 'delivered'], ['canceled', 'cancelled'], ['returned', 'returned']];
    for (const [theirs, ours] of statuses) {
      const api = stub((req) => (req.url.endsWith('/token') ? { body: { access_token: 't' } } : { body: { id: 'del_1', status: theirs, courier: { name: 'Ana' }, dropoff: { verification: { picture: { image_url: 'https://x/p.jpg' } } } } }));
      const got = await createUberDirectAdapter({ fetch: api.fetch, clock }).get(conn, 'del_1');
      expect(got).toMatchObject({ status: ours, courierName: 'Ana' });
      if (theirs === 'delivered') expect(got!.proof).toEqual({ picture: { image_url: 'https://x/p.jpg' } });
    }
    const busy = stub((req) => (req.url.endsWith('/token') ? { body: { access_token: 't' } } : { status: 400, body: { code: 'couriers_busy', message: 'busy' } }));
    const uber = createUberDirectAdapter({ fetch: busy.fetch, clock });
    expect(await uber.quote(conn, request)).toBeNull();
    const e = await uber.create(conn, { ...request, quoteId: 'q', idempotencyKey: 'k', reference: 'R' }).catch((x) => x);
    expect(isNoCourier(e)).toBe(true);

    const raw = JSON.stringify({ kind: 'event.delivery_status', id: 'evt_1', delivery_id: 'del_1', status: 'pickup_complete', created: '2026-10-01T08:30:00Z' });
    const sig = createHmac('sha256', 'uber-signing-key').update(raw).digest('hex');
    expect(uber.verifyWebhook({ rawBody: raw, headers: { 'X-Uber-Signature': sig }, url: '', signingSecret: 'uber-signing-key' })).toBe(true);
    expect(uber.verifyWebhook({ rawBody: raw, headers: { 'x-postmates-signature': sig }, url: '', signingSecret: 'uber-signing-key' })).toBe(true);
    expect(uber.verifyWebhook({ rawBody: raw + ' ', headers: { 'x-uber-signature': sig }, url: '', signingSecret: 'uber-signing-key' })).toBe(false);
    expect(uber.verifyWebhook({ rawBody: raw, headers: {}, url: '', signingSecret: 'uber-signing-key' })).toBe(false);
    expect(uber.parseWebhook(raw)).toMatchObject({ eventId: 'evt_1', externalRef: 'del_1', status: 'picked_up' });
    expect(uber.parseWebhook('not json')).toBeNull();
  });
});

describe('DoorDash Drive adapter (unverified live)', () => {
  const secret = Buffer.from('a-signing-secret-of-some-length!').toString('base64url');
  const conn = handle({ plugKey: 'doordash-drive', credentials: { developerId: 'dev-1', keyId: 'key-1', signingSecret: secret, webhookSecret: 'Basic dXNlcjpwYXNz' } });

  it('signs a DD-JWT-V1 token, quotes, and books with our key as external_delivery_id (a 409 finds the existing one)', async () => {
    const jwt = driveJwt({ developerId: 'dev-1', keyId: 'key-1', signingSecret: secret }, clock());
    const [h, p, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' });
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(claims).toMatchObject({ aud: 'doordash', iss: 'dev-1', kid: 'key-1' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(1800);
    expect(s).toBe(createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${h}.${p}`).digest('base64url'));

    let creates = 0;
    const api = stub((req) => {
      if (req.url.endsWith('/drive/v2/quotes')) return { body: { external_delivery_id: (req.body as { external_delivery_id: string }).external_delivery_id, fee: 975, currency: 'AUD', delivery_status: 'quote' } };
      if (req.url.endsWith('/drive/v2/deliveries') && req.method === 'POST') return ++creates === 1 ? { body: { external_delivery_id: 'courier-d1-doordash-drive', delivery_status: 'created', fee: 975, tracking_url: 'https://doordash.com/t/1' } } : { status: 409, body: { code: 'duplicate_delivery_id' } };
      if (req.url.includes('/drive/v2/deliveries/') && req.method === 'GET') return { body: { external_delivery_id: 'courier-d1-doordash-drive', delivery_status: 'enroute_to_pickup', fee: 975, dasher_name: 'Jo' } };
      return { status: 404, body: {} };
    });
    const dd = createDoorDashDriveAdapter({ fetch: api.fetch, clock });
    const q = await dd.quote(conn, request);
    expect(q).toMatchObject({ feeCents: 975, currency: 'AUD', expiresAt: new Date('2026-10-01T08:05:00.000Z') });
    expect(api.seen[0]!.url).toBe('https://openapi.doordash.com/drive/v2/quotes');
    expect(api.seen[0]!.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(api.seen[0]!.body).toMatchObject({ dropoff_address: '12 Test Street, Unit 4, Surry Hills NSW 2010, AU', dropoff_phone_number: '+61400222333', order_value: 2600, order_contains: { alcohol: false }, dropoff_instructions: 'Gate code 1234' });

    const args = { ...request, quoteId: q!.quoteId, idempotencyKey: 'courier:d1:doordash-drive', reference: 'A7K2Q' };
    expect(await dd.create(conn, args)).toMatchObject({ externalRef: 'courier-d1-doordash-drive', status: 'requested', feeCents: 975 });
    expect(await dd.create(conn, args)).toMatchObject({ externalRef: 'courier-d1-doordash-drive', status: 'courier_assigned', courierName: 'Jo' });
  });

  it('webhooks are checked against the configured Authorization header, and event names map to statuses', async () => {
    const dd = createDoorDashDriveAdapter({ clock });
    const raw = JSON.stringify({ event_name: 'DASHER_PICKED_UP', external_delivery_id: 'courier-d1', created_at: '2026-10-01T08:30:00Z' });
    expect(dd.verifyWebhook({ rawBody: raw, headers: { authorization: 'Basic dXNlcjpwYXNz' }, url: '', signingSecret: 'Basic dXNlcjpwYXNz' })).toBe(true);
    expect(dd.verifyWebhook({ rawBody: raw, headers: { authorization: 'Basic d3Jvbmc6d3Jvbmc=' }, url: '', signingSecret: 'Basic dXNlcjpwYXNz' })).toBe(false);
    expect(dd.parseWebhook(raw)).toMatchObject({ externalRef: 'courier-d1', status: 'picked_up', eventId: 'DASHER_PICKED_UP:2026-10-01T08:30:00Z' });
    expect(dd.parseWebhook(JSON.stringify({ event_name: 'DASHER_DROPPED_OFF', external_delivery_id: 'x' }))!.status).toBe('delivered');
    expect(dd.parseWebhook(JSON.stringify({ event_name: 'DELIVERY_RETURNED', external_delivery_id: 'x' }))!.status).toBe('returned');
  });
});

describe('Square: finding a payment whose answer was lost, and refund status (unverified live)', () => {
  const conn = handle({ plugKey: 'square', externalAccountId: 'MERCHANT', credentials: { accessToken: 'sq-token' }, config: { locationRef: 'LOC1' } });
  const lookup = { idempotencyKey: 'pay:o1:abc', reference: 'A7K2Q', amountCents: 4200, tipCents: 500, currency: 'AUD', locationRef: 'LOC1', attemptedAt: new Date('2026-10-01T08:00:00.000Z') };

  it('lists payments at the location around the attempt, filtered by total, and matches our reference', async () => {
    const api = stub(() => ({
      body: {
        payments: [
          { id: 'P-other', status: 'COMPLETED', reference_id: 'ZZZ', amount_money: { amount: 4200, currency: 'AUD' } },
          { id: 'P-failed', status: 'FAILED', reference_id: 'A7K2Q', amount_money: { amount: 4200, currency: 'AUD' } },
          { id: 'P-ours', status: 'COMPLETED', reference_id: 'A7K2Q', amount_money: { amount: 4200, currency: 'AUD' }, card_details: { card: { card_brand: 'VISA', last_4: '1111', fingerprint: 'sq-fp-secret' } } },
        ],
      },
    }));
    const sq = createSquareAdapter({ fetch: api.fetch });
    const found = await sq.lookupPayment!(conn, lookup);
    expect(found).toMatchObject({ externalRef: 'P-ours', status: 'completed', cardLast4: '1111', identityHints: [{ kind: 'card_fingerprint', value: 'sq-fp-secret' }] });
    expect(JSON.stringify(found!.raw)).not.toContain('sq-fp-secret');
    const url = new URL(api.seen[0]!.url);
    expect(url.pathname).toBe('/v2/payments');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ location_id: 'LOC1', total: '4700', begin_time: '2026-10-01T07:50:00.000Z', end_time: '2026-10-01T09:00:00.000Z' });

    const none = stub(() => ({ body: { payments: [{ id: 'P-failed', status: 'FAILED', reference_id: 'A7K2Q', amount_money: { amount: 4200 } }] } }));
    expect(await createSquareAdapter({ fetch: none.fetch }).lookupPayment!(conn, lookup)).toBeNull();
    const pending = stub(() => ({ body: { payments: [{ id: 'P-x', status: 'APPROVED', reference_id: 'A7K2Q', amount_money: { amount: 4200 } }] } }));
    await expect(createSquareAdapter({ fetch: pending.fetch }).lookupPayment!(conn, lookup)).rejects.toThrow('still pending');
  });

  it('reads a refund\'s status, pushes orders before payment with their discounts and delivery fee', async () => {
    const api = stub((req) => (req.url.includes('/v2/refunds/') ? { body: { refund: { id: 'R1', status: 'COMPLETED' } } } : { body: { order: { id: 'ORD1' } } }));
    const sq = createSquareAdapter({ fetch: api.fetch });
    expect(sq.capabilities.orderPush).toBe('before_payment');
    expect(await sq.getRefund!(conn, 'R1')).toEqual({ externalRef: 'R1', status: 'completed' });
    await sq.pushOrder!(conn, {
      idempotencyKey: 'pos-push:o1',
      reference: 'A7K2Q',
      locationRef: 'LOC1',
      channel: 'delivery',
      lines: [{ name: 'Cheeseburger', qty: 1, unitPriceCents: 2600, modifiers: [] }],
      totalCents: 2200,
      discounts: [{ name: 'Welcome: $10 off', amountCents: 1000 }],
      serviceCharges: [{ name: 'Delivery', amountCents: 600 }],
    });
    const order = (api.seen[1]!.body as { order: Record<string, unknown> }).order;
    expect(order.discounts).toEqual([{ uid: 'ros-discount-1', name: 'Welcome: $10 off', type: 'FIXED_AMOUNT', amount_money: { amount: 1000, currency: 'AUD' }, scope: 'ORDER' }]);
    expect(order.service_charges).toEqual([{ uid: 'ros-charge-1', name: 'Delivery', amount_money: { amount: 600, currency: 'AUD' }, calculation_phase: 'TOTAL_PHASE' }]);
  });
});
