import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConnectionHandle } from '@ros/core';
import { SQUARE_API_VERSION, SquareApiError, createSquareAdapter, parseSquareWebhook, squareSignature, squareToCanonical, verifySquareWebhook } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { ledger } from '@ros/modules';
import { ledgerRow, tablesContaining } from './helpers';
import { FINGERPRINT, LOCATION_ID, MERCHANT_ID, OUR_APPLICATION_ID, type StubRequest, cardPayment, cashPayment, itemisedOrder, paymentUpdatedEvent, refundUpdatedEvent, stubSquare } from './square-fixtures';

/**
 * The Square adapter against payloads built from Square's published reference. These prove the
 * adapter does what the documentation describes. They do not prove Square behaves as documented:
 * the adapter has never been run against Square or its sandbox.
 */
const TOKEN = 'EAAAl-test-access-token';
const conn = (config: Record<string, unknown> = {}): ConnectionHandle => ({
  id: 'conn-1',
  orgId: 'org-1',
  venueId: 'venue-1',
  plugKey: 'square',
  externalAccountId: MERCHANT_ID,
  scopes: ['PAYMENTS_READ', 'ORDERS_READ'],
  config: { locationRef: LOCATION_ID, environment: 'sandbox', applicationId: OUR_APPLICATION_ID, ...config },
  credentials: { accessToken: TOKEN, webhookSecret: 'signature-key' },
});

/** Answers ListPayments, GetPayment and BatchRetrieveOrders from a set of payments and orders. */
function squareWith(payments: Array<Record<string, any>>, orders: Array<Record<string, any>>, extra?: (req: StubRequest) => { status?: number; body: unknown } | undefined) {
  return stubSquare((req) => {
    const custom = extra?.(req);
    if (custom) return custom;
    if (req.method === 'GET' && req.path === '/v2/payments') return { body: { payments } };
    if (req.method === 'GET' && req.path.startsWith('/v2/payments/')) {
      const p = payments.find((x) => x.id === decodeURIComponent(req.path.split('/').pop()!));
      return p ? { body: { payment: p } } : { status: 404, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND', detail: 'Could not find payment.' }] } };
    }
    if (req.method === 'POST' && req.path === '/v2/orders/batch-retrieve') return { body: { orders: orders.filter((o) => req.body.order_ids.includes(o.id)) } };
    return { status: 500, body: { errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR' }] } };
  });
}

describe('Square adapter: reading sales (documented shapes, unverified against Square)', () => {
  it('lists payments by when they last changed, with their orders, and maps them to canonical sales', async () => {
    const sq = squareWith([cardPayment(), cashPayment()], [itemisedOrder()]);
    const adapter = createSquareAdapter({ fetch: sq.fetch });
    const since = new Date('2026-09-26T00:00:00.000Z');
    const until = new Date('2026-09-26T03:00:00.000Z');
    const page = await adapter.listTransactions(conn(), { locationRef: LOCATION_ID, since, until, limit: 500 });

    const [list, batch] = sq.calls;
    expect(list).toMatchObject({ method: 'GET', host: 'connect.squareupsandbox.com', path: '/v2/payments' });
    expect(list!.query).toEqual({
      location_id: LOCATION_ID,
      begin_time: '2025-09-25T00:00:00.000Z',
      updated_at_begin_time: '2026-09-26T00:00:00.000Z',
      updated_at_end_time: '2026-09-26T03:00:00.000Z',
      sort_field: 'UPDATED_AT',
      sort_order: 'ASC',
      limit: '100',
    });
    expect(list!.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, 'Square-Version': SQUARE_API_VERSION, 'Content-Type': 'application/json' });
    expect(batch).toMatchObject({ method: 'POST', path: '/v2/orders/batch-retrieve', body: { location_id: LOCATION_ID, order_ids: ['d7eKah653Z579f3gVtjlxpSlmUcZY', 'haOyDuHiqtAXMk0d8pDKXpL7Jg4F'] } });
    expect(sq.calls).toHaveLength(2);
    expect(page.nextCursor).toBeNull();

    const [card, cash] = page.items;
    expect(card).toMatchObject({
      source: 'square',
      externalRef: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY',
      locationRef: LOCATION_ID,
      occurredAt: new Date('2026-09-26T01:34:33.524Z'),
      channel: 'dine-in',
      status: 'completed',
      subtotalCents: 5900,
      discountCents: 590,
      taxCents: 482,
      tipCents: 500,
      totalCents: 5810,
      refundedCents: 0,
      currency: 'AUD',
      tenderType: 'card',
      staffRef: 'TMoK_ogh6rH1o4dV',
      originatedHere: false,
      discounts: [{ name: 'Locals night', code: null, amountCents: 590 }],
    });
    expect(card!.subtotalCents - card!.discountCents + card!.tipCents).toBe(card!.totalCents);
    expect(card!.lines).toEqual([
      { lineNo: 1, externalItemId: 'CATALOGVARIATIONRUMP250', name: 'Wagyu rump (250g)', category: null, qty: 1, unitPriceCents: 5100, modifiers: [{ name: 'Pepper sauce', priceCents: 300 }], discountCents: 510, taxCents: 417, totalCents: 5100 },
      { lineNo: 2, externalItemId: 'CATALOGVARIATIONFRIES', name: 'Fries', category: null, qty: 2, unitPriceCents: 400, modifiers: [], discountCents: 80, taxCents: 65, totalCents: 800 },
    ]);
    // A payment whose order could not be read is still a sale: the amount, no lines.
    expect(cash).toMatchObject({ externalRef: 'KkAkhdMsgzn59SM8A89WgKwekxLZY', tenderType: 'cash', subtotalCents: 1850, totalCents: 1850, tipCents: 0, lines: [], identityHints: [] });
  });

  it('card identifiers go into identityHints and nowhere else', async () => {
    const sq = squareWith([cardPayment()], [itemisedOrder()]);
    const [sale] = (await createSquareAdapter({ fetch: sq.fetch }).listTransactions(conn(), { locationRef: LOCATION_ID, since: new Date(0) })).items;
    expect(sale!.identityHints).toEqual([
      { kind: 'pos_customer_id', value: 'W92WH6P11H4Z77CTET0RNTGFW8' },
      { kind: 'email', value: 'Square.Guest@example.com' },
      { kind: 'card_fingerprint', value: FINGERPRINT },
    ]);
    const { identityHints: _hints, ...rest } = sale!;
    expect(JSON.stringify(rest)).not.toContain(FINGERPRINT);
    expect(JSON.stringify(rest)).not.toContain('fingerprint');
    // The rest of the card block, and the tender inside the order, are kept.
    const raw = sale!.raw as { payment: any; order: any };
    expect(raw.payment.card_details.card).toEqual({ card_brand: 'VISA', last_4: '1111', exp_month: 11, exp_year: 2028, card_type: 'DEBIT', prepaid_type: 'NOT_PREPAID', bin: '411111' });
    expect(raw.order.tenders[0].card_details.card).toEqual({ card_brand: 'VISA', last_4: '1111' });
  });

  it('passes the page cursor through and asks for orders in batches of 100', async () => {
    const payments = Array.from({ length: 100 }, (_, i) => cashPayment({ id: `pay_${i}`, order_id: `ord_${i}` }));
    const sq = squareWith([], [], (req) => (req.path === '/v2/payments' ? { body: { payments, cursor: 'NEXT-PAGE-CURSOR' } } : req.path === '/v2/orders/batch-retrieve' ? { body: { orders: [] } } : undefined));
    const page = await createSquareAdapter({ fetch: sq.fetch }).listTransactions(conn(), { locationRef: LOCATION_ID, since: new Date(0), cursor: 'PREVIOUS-CURSOR', limit: 100 });
    expect(sq.calls[0]!.query.cursor).toBe('PREVIOUS-CURSOR');
    expect(page.nextCursor).toBe('NEXT-PAGE-CURSOR');
    expect(page.items).toHaveLength(100);
    expect(sq.calls.filter((c) => c.path === '/v2/orders/batch-retrieve').map((c) => c.body.order_ids.length)).toEqual([100]);
  });

  it('maps payment status and refunds', () => {
    const status = (over: Record<string, unknown>) => squareToCanonical(cardPayment(over), null).status;
    expect(status({ status: 'COMPLETED' })).toBe('completed');
    expect(status({ status: 'APPROVED' })).toBe('pending');
    expect(status({ status: 'PENDING' })).toBe('pending');
    expect(status({ status: 'CANCELED' })).toBe('voided');
    expect(status({ status: 'FAILED' })).toBe('voided');
    expect(status({ status: 'COMPLETED', refunded_money: { amount: 1000, currency: 'AUD' } })).toBe('partially_refunded');
    expect(status({ status: 'COMPLETED', refunded_money: { amount: 5810, currency: 'AUD' } })).toBe('refunded');
    expect(squareToCanonical(cardPayment({ refunded_money: { amount: 1000, currency: 'AUD' } }), itemisedOrder())).toMatchObject({ refundedCents: 1000, totalCents: 5810 });
  });

  it('a split bill is recorded by amount: its lines are not divided between the payments', () => {
    const order = itemisedOrder({
      tenders: [
        { id: 'pay_a', type: 'CARD', amount_money: { amount: 3000, currency: 'AUD' } },
        { id: 'pay_b', type: 'CASH', amount_money: { amount: 2310, currency: 'AUD' } },
      ],
      total_money: { amount: 5310, currency: 'AUD' },
    });
    const a = squareToCanonical(cardPayment({ id: 'pay_a', amount_money: { amount: 3000, currency: 'AUD' }, tip_money: undefined, total_money: { amount: 3000, currency: 'AUD' } }), order);
    const b = squareToCanonical(cashPayment({ id: 'pay_b', amount_money: { amount: 2310, currency: 'AUD' }, total_money: { amount: 2310, currency: 'AUD' } }), order);
    expect(a).toMatchObject({ lines: [], subtotalCents: 3000, discountCents: 0, totalCents: 3000 });
    expect(b).toMatchObject({ lines: [], subtotalCents: 2310, totalCents: 2310 });
    // Together they are the order's money, once.
    expect(a.totalCents + b.totalCents).toBe(5310);
  });

  it('knows a pickup order, a retail venue, and a payment this platform took itself', () => {
    const pickup = itemisedOrder({ fulfillments: [{ uid: 'f1', type: 'PICKUP', state: 'COMPLETED', pickup_details: { recipient: { display_name: 'Sam' }, schedule_type: 'ASAP' } }] });
    expect(squareToCanonical(cardPayment(), pickup).channel).toBe('pickup');
    expect(squareToCanonical(cardPayment(), itemisedOrder(), { defaultChannel: 'retail' }).channel).toBe('retail');
    const ours = cardPayment({ application_details: { square_product: 'ECOMMERCE_API', application_id: OUR_APPLICATION_ID } });
    expect(squareToCanonical(ours, itemisedOrder(), { applicationId: OUR_APPLICATION_ID }).originatedHere).toBe(true);
    expect(squareToCanonical(cardPayment(), itemisedOrder(), { applicationId: OUR_APPLICATION_ID }).originatedHere).toBe(false);
  });

  it('fetches one payment; one Square does not have is null; an error names no secret', async () => {
    const sq = squareWith([cardPayment()], [itemisedOrder()]);
    const adapter = createSquareAdapter({ fetch: sq.fetch });
    expect(await adapter.getTransaction(conn(), 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY')).toMatchObject({ externalRef: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY', totalCents: 5810, lines: [{ name: 'Wagyu rump (250g)' }, { name: 'Fries' }] });
    expect(sq.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v2/payments/bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY', 'POST /v2/orders/batch-retrieve']);
    expect(await adapter.getTransaction(conn(), 'nope')).toBeNull();

    const denied = stubSquare(() => ({ status: 401, body: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: `The token ${TOKEN} is not valid` }] } }));
    const err = await createSquareAdapter({ fetch: denied.fetch }).listTransactions(conn(), { locationRef: LOCATION_ID, since: new Date(0) }).catch((e) => e);
    expect(err).toBeInstanceOf(SquareApiError);
    expect(err.message).toBe('square: 401 on /v2/payments (AUTHENTICATION_ERROR/UNAUTHORIZED)');
    expect(err.message).not.toContain(TOKEN);
    // Production is the default host; sandbox only when the connection says so.
    const prod = squareWith([], []);
    await createSquareAdapter({ fetch: prod.fetch }).listTransactions(conn({ environment: undefined }), { locationRef: LOCATION_ID, since: new Date(0) });
    expect(prod.calls[0]!.host).toBe('connect.squareup.com');
  });

  it('lists the merchant\'s locations', async () => {
    const sq = stubSquare(() => ({ body: { locations: [{ id: '18YC4JDH91E1H', name: 'Grant Park', timezone: 'America/Los_Angeles', status: 'ACTIVE', merchant_id: '3MYCJG5GVYQ8Q', currency: 'USD' }, { id: LOCATION_ID, name: 'Surry Hills', timezone: 'Australia/Sydney', status: 'ACTIVE' }] } }));
    expect(await createSquareAdapter({ fetch: sq.fetch }).listLocations(conn())).toEqual([
      { ref: '18YC4JDH91E1H', name: 'Grant Park', timezone: 'America/Los_Angeles' },
      { ref: LOCATION_ID, name: 'Surry Hills', timezone: 'Australia/Sydney' },
    ]);
    expect(sq.calls[0]).toMatchObject({ method: 'GET', path: '/v2/locations' });
  });
});

describe('Square adapter: webhooks (documented shapes, unverified against Square)', () => {
  const url = 'https://console.rosplatform.test/webhooks/pos/square';
  const body = JSON.stringify(paymentUpdatedEvent(cardPayment()));
  // Computed here independently of the adapter: base64(HMAC-SHA256(key, notification URL + raw body)).
  const signature = createHmac('sha256', 'signature-key').update(url + body).digest('base64');

  it('verifies the signature over the notification URL followed by the raw body', () => {
    expect(squareSignature('signature-key', url, body)).toBe(signature);
    const ok = { rawBody: body, url, signingSecret: 'signature-key', headers: { 'x-square-hmacsha256-signature': signature } };
    expect(verifySquareWebhook(ok)).toBe(true);
    expect(verifySquareWebhook({ ...ok, headers: { 'X-Square-HmacSha256-Signature': signature } })).toBe(true);
    expect(verifySquareWebhook({ ...ok, signingSecret: 'another-key' })).toBe(false);
    expect(verifySquareWebhook({ ...ok, url: `${url}/` })).toBe(false);
    expect(verifySquareWebhook({ ...ok, rawBody: body.replace('COMPLETED', 'CANCELED') })).toBe(false);
    expect(verifySquareWebhook({ ...ok, headers: {} })).toBe(false);
    expect(verifySquareWebhook({ ...ok, headers: { 'x-square-hmacsha256-signature': '' } })).toBe(false);
    // The older SHA-1 header Square also sends is not accepted in its place.
    expect(verifySquareWebhook({ ...ok, headers: { 'x-square-signature': signature } })).toBe(false);
  });

  it('reads which payment an event is about: the payment itself, or the payment a refund belongs to', () => {
    expect(parseSquareWebhook(body)).toEqual({ eventId: '6a8f5f28-54a1-4eb0-a98a-3111513fd4fc', type: 'payment.updated', accountRef: MERCHANT_ID, locationRef: LOCATION_ID, transactionRefs: ['bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY'] });
    expect(parseSquareWebhook(JSON.stringify(refundUpdatedEvent('KkAkhdMsgzn59SM8A89WgKwekxLZY')))).toEqual({
      eventId: 'bc316346-6691-4243-88ed-6d651a0d0c47',
      type: 'refund.updated',
      accountRef: MERCHANT_ID,
      locationRef: LOCATION_ID,
      transactionRefs: ['KkAkhdMsgzn59SM8A89WgKwekxLZY'],
    });
    expect(parseSquareWebhook(JSON.stringify({ merchant_id: MERCHANT_ID, type: 'order.updated', event_id: 'e1', data: { type: 'order_updated', id: 'o1' } }))).toMatchObject({ transactionRefs: [] });
    expect(parseSquareWebhook('not json')).toBeNull();
    expect(parseSquareWebhook(JSON.stringify({ type: 'payment.updated' }))).toBeNull();
  });
});

describe('Square adapter: writing (documented shapes, unverified against Square)', () => {
  it('pushes an online order as a Square order with a pickup fulfilment', async () => {
    const sq = stubSquare((req) => ({ body: { order: { id: 'CAISENgvlJ6jLWAzERDzjyHVybY', location_id: LOCATION_ID, state: 'OPEN', version: 1, reference_id: req.body.order.reference_id } } }));
    const adapter = createSquareAdapter({ fetch: sq.fetch });
    const readyAt = new Date('2026-09-30T08:30:00.000Z');
    const pushed = await adapter.pushOrder!(conn(), {
      idempotencyKey: 'order:7f6d2c1e-push',
      reference: 'A7K2QX',
      locationRef: LOCATION_ID,
      channel: 'pickup',
      customerName: 'Sam',
      note: 'No onion',
      readyAt,
      lines: [
        { name: 'Wagyu burger', qty: 2, unitPriceCents: 2600, modifiers: [{ name: 'Extra cheese', priceCents: 200 }], note: 'one without pickles' },
        { name: 'Fries', qty: 1, unitPriceCents: 900, modifiers: [] },
      ],
      totalCents: 6100,
    });
    expect(pushed).toEqual({ posOrderRef: 'CAISENgvlJ6jLWAzERDzjyHVybY' });
    expect(sq.calls).toHaveLength(1);
    expect(sq.calls[0]).toMatchObject({ method: 'POST', path: '/v2/orders' });
    expect(sq.calls[0]!.body).toEqual({
      idempotency_key: 'order:7f6d2c1e-push',
      order: {
        location_id: LOCATION_ID,
        reference_id: 'A7K2QX',
        ticket_name: 'Sam',
        line_items: [
          { name: 'Wagyu burger', quantity: '2', base_price_money: { amount: 2400, currency: 'AUD' }, modifiers: [{ name: 'Extra cheese', base_price_money: { amount: 200, currency: 'AUD' } }], note: 'one without pickles' },
          { name: 'Fries', quantity: '1', base_price_money: { amount: 900, currency: 'AUD' } },
        ],
        fulfillments: [{ type: 'PICKUP', state: 'PROPOSED', pickup_details: { recipient: { display_name: 'Sam' }, schedule_type: 'SCHEDULED', pickup_at: '2026-09-30T08:30:00.000Z', note: 'No onion' } }],
      },
    });
    // What Square will total from those lines is what the guest was charged.
    const lines = sq.calls[0]!.body.order.line_items as Array<{ quantity: string; base_price_money: { amount: number }; modifiers?: Array<{ base_price_money: { amount: number } }> }>;
    expect(lines.reduce((s, l) => s + Number(l.quantity) * (l.base_price_money.amount + (l.modifiers ?? []).reduce((m, x) => m + x.base_price_money.amount, 0)), 0)).toBe(6100);

    // No ready time: as soon as possible, with the venue's prep time. A table order says which table.
    await adapter.pushOrder!(conn({ prepMinutes: 15 }), { idempotencyKey: 'k2', reference: 'B1', locationRef: LOCATION_ID, channel: 'dine-in-qr', tableLabel: '12', lines: [{ name: 'Fries', qty: 1, unitPriceCents: 900, modifiers: [] }], totalCents: 900 });
    expect(sq.calls[1]!.body.order).toMatchObject({ ticket_name: 'Table 12', fulfillments: [{ type: 'PICKUP', pickup_details: { recipient: { display_name: 'B1' }, schedule_type: 'ASAP', prep_time_duration: 'PT15M', note: 'Table order. Table 12' } }] });
  });

  it('takes a card payment from a source token: tip apart, key within Square\'s limit, order named when there is one', async () => {
    const sq = stubSquare((req) => ({ body: { payment: cardPayment({ id: 'R2B3Z8WMVt3EAmzYWLZvz7Y69EbZY', reference_id: req.body.reference_id, amount_money: req.body.amount_money, tip_money: req.body.tip_money, total_money: { amount: 4700, currency: 'AUD' } }) } }));
    const adapter = createSquareAdapter({ fetch: sq.fetch });
    const longKey = 'pay:order:0c5e2f3a-6d1b-4a57-9d0e-3b1f5a8e7c21:attempt:1';
    const result = await adapter.createPayment(conn(), { idempotencyKey: longKey, amountCents: 4200, tipCents: 500, currency: 'AUD', sourceToken: 'cnon:card-nonce-ok', reference: 'A7K2QX', note: 'Pickup A7K2QX', posOrderRef: 'CAISENgvlJ6jLWAzERDzjyHVybY' });

    expect(sq.calls[0]).toMatchObject({ method: 'POST', path: '/v2/payments' });
    const sent = sq.calls[0]!.body;
    expect(sent).toEqual({
      source_id: 'cnon:card-nonce-ok',
      idempotency_key: sent.idempotency_key,
      amount_money: { amount: 4200, currency: 'AUD' },
      tip_money: { amount: 500, currency: 'AUD' },
      autocomplete: true,
      location_id: LOCATION_ID,
      order_id: 'CAISENgvlJ6jLWAzERDzjyHVybY',
      reference_id: 'A7K2QX',
      note: 'Pickup A7K2QX',
    });
    expect(longKey.length).toBeGreaterThan(45);
    expect(sent.idempotency_key).toHaveLength(45);
    // The same key always becomes the same value, so a retry is the same request to Square.
    await adapter.createPayment(conn(), { idempotencyKey: longKey, amountCents: 4200, tipCents: 500, currency: 'AUD', sourceToken: 'cnon:card-nonce-ok', reference: 'A7K2QX' });
    expect(sq.calls[1]!.body.idempotency_key).toBe(sent.idempotency_key);
    expect(sq.calls[1]!.body).not.toHaveProperty('order_id');

    expect(result).toMatchObject({ externalRef: 'R2B3Z8WMVt3EAmzYWLZvz7Y69EbZY', status: 'completed', cardBrand: 'VISA', cardLast4: '1111', failureReason: null, identityHints: [{ kind: 'card_fingerprint', value: FINGERPRINT }] });
    expect(JSON.stringify(result.raw)).not.toContain('fingerprint');
    expect(adapter.clientConfig(conn())).toEqual({ provider: 'square', applicationId: OUR_APPLICATION_ID, locationRef: LOCATION_ID, environment: 'sandbox' });
  });

  it('a declined card is a failed payment, not an outage; anything else is thrown', async () => {
    const declined = stubSquare(() => ({ status: 402, body: { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'GENERIC_DECLINE', detail: 'Authorization error: GENERIC_DECLINE' }] } }));
    const result = await createSquareAdapter({ fetch: declined.fetch }).createPayment(conn(), { idempotencyKey: 'k-declined', amountCents: 1000, tipCents: 0, currency: 'AUD', sourceToken: 'cnon:card-nonce-declined', reference: 'A1' });
    expect(result).toMatchObject({ status: 'failed', failureReason: 'GENERIC_DECLINE', externalRef: 'declined_k-declined', identityHints: [] });
    expect(declined.calls[0]!.body).not.toHaveProperty('tip_money');

    const down = stubSquare(() => ({ status: 503, body: { errors: [{ category: 'API_ERROR', code: 'SERVICE_UNAVAILABLE' }] } }));
    await expect(createSquareAdapter({ fetch: down.fetch }).createPayment(conn(), { idempotencyKey: 'k', amountCents: 1000, tipCents: 0, currency: 'AUD', sourceToken: 't', reference: 'A1' })).rejects.toThrow('square: 503 on /v2/payments (API_ERROR/SERVICE_UNAVAILABLE)');
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createSquareAdapter({ fetch: unreachable }).createPayment(conn(), { idempotencyKey: 'k', amountCents: 1000, tipCents: 0, currency: 'AUD', sourceToken: 't', reference: 'A1' })).rejects.toThrow('square: request to /v2/payments did not complete');
  });

  it('refunds a payment', async () => {
    const sq = stubSquare((req) => ({ body: { refund: { id: `${req.body.payment_id}_KlWP8IC1557ddwc9QWTKrCVU6m0JXDz15R2Qym5eQfR`, status: 'PENDING', amount_money: req.body.amount_money, payment_id: req.body.payment_id, location_id: LOCATION_ID } } }));
    const r = await createSquareAdapter({ fetch: sq.fetch }).refund(conn(), { idempotencyKey: 'refund:1', paymentRef: 'R2B3Z8WMVt3EAmzYWLZvz7Y69EbZY', amountCents: 1000, currency: 'AUD', reason: 'Wrong order' });
    expect(sq.calls[0]).toMatchObject({ method: 'POST', path: '/v2/refunds', body: { idempotency_key: 'refund:1', payment_id: 'R2B3Z8WMVt3EAmzYWLZvz7Y69EbZY', amount_money: { amount: 1000, currency: 'AUD' }, reason: 'Wrong order' } });
    expect(r).toEqual({ externalRef: 'R2B3Z8WMVt3EAmzYWLZvz7Y69EbZY_KlWP8IC1557ddwc9QWTKrCVU6m0JXDz15R2Qym5eQfR', status: 'pending' });
  });

  it('adds a discount to an open order at its current version, once; a refusal is an answer', async () => {
    const order = { id: 'CAISENgvlJ6jLWAzERDzjyHVybY', location_id: LOCATION_ID, state: 'OPEN', version: 3, total_money: { amount: 6100, currency: 'AUD' }, discounts: [] as Array<{ uid: string }> };
    const sq = stubSquare((req) => {
      if (req.path === '/v2/orders/batch-retrieve') return { body: { orders: [order] } };
      order.discounts.push({ uid: req.body.order.discounts[0].uid });
      return { body: { order: { ...order, version: 4 } } };
    });
    const adapter = createSquareAdapter({ fetch: sq.fetch });
    const args = { locationRef: LOCATION_ID, orderRef: order.id, name: 'Reward: $10 off', amountCents: 1000, idempotencyKey: 'redeem:abc' };
    expect(await adapter.applyDiscount!(conn(), args)).toEqual({ ok: true });
    const put = sq.calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe('/v2/orders/CAISENgvlJ6jLWAzERDzjyHVybY');
    expect(put.body).toEqual({ idempotency_key: 'redeem:abc', order: { version: 3, discounts: [{ uid: put.body.order.discounts[0].uid, name: 'Reward: $10 off', type: 'FIXED_AMOUNT', amount_money: { amount: 1000, currency: 'AUD' }, scope: 'ORDER' }] } });
    expect(put.body.order.discounts[0].uid.length).toBeLessThanOrEqual(60);
    // Asked again: the discount is already on the order, so nothing more is sent.
    expect(await adapter.applyDiscount!(conn(), args)).toEqual({ ok: true });
    expect(sq.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    const closed = stubSquare(() => ({ body: { orders: [{ ...order, state: 'COMPLETED', discounts: [] }] } }));
    expect(await createSquareAdapter({ fetch: closed.fetch }).applyDiscount!(conn(), args)).toEqual({ ok: false });
    expect(closed.calls.filter((c) => c.method === 'PUT')).toEqual([]);
    // Square refuses to update an order made in its own Point of Sale app.
    const refused = stubSquare((req) => (req.method === 'PUT' ? { status: 400, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'BAD_REQUEST' }] } } : { body: { orders: [{ ...order, discounts: [] }] } }));
    expect(await createSquareAdapter({ fetch: refused.fetch }).applyDiscount!(conn(), args)).toEqual({ ok: false });
  });
});

describe('Square through the ledger: plug, connection, ingest and webhook together (simulated Square)', () => {
  const t = useTestEnv();
  const url = 'https://console.rosplatform.test/webhooks/pos/square';
  const TOKEN_IN_VAULT = 'EAAAl-sealed-seller-token';
  const payments = [cardPayment(), cashPayment()];
  const sq = squareWith(payments, [itemisedOrder()]);

  it('a Square connection ingests into the ledger, idempotently, with no card identifier kept', async () => {
    const square = createSquareAdapter({ fetch: sq.fetch });
    t.app.adapters.register('pos', square);
    t.app.adapters.register('payment', square);
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    const view = await t.app.tenant(diner.orgId, owner, (ctx) =>
      ledger.connectPos(ctx, {
        plugKey: 'square',
        venueId: diner.venueId,
        externalAccountId: MERCHANT_ID,
        locationRef: LOCATION_ID,
        scopes: ledger.SQUARE_READ_SCOPES,
        credentials: { accessToken: TOKEN_IN_VAULT, webhookSecret: 'signature-key' },
        config: { environment: 'sandbox', applicationId: OUR_APPLICATION_ID },
      }),
    );
    expect(view).toMatchObject({ plugKey: 'square', status: 'connected', locationRef: LOCATION_ID });

    const first = await ledger.ingestConnection(t.app, { orgId: diner.orgId, connectionId: view.id });
    expect(first).toMatchObject({ status: 'done', fetched: 2, created: 2 });
    expect(sq.calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN_IN_VAULT}`);
    const second = await ledger.ingestConnection(t.app, { orgId: diner.orgId, connectionId: view.id });
    expect(second).toMatchObject({ status: 'done', created: 0, changed: 0, unchanged: 2 });

    const rows = await t.db.selectFrom('transactions').select(['external_ref', 'venue_id', 'total_cents', 'tip_cents', 'status', 'tender_type', 'customer_id']).where('source', '=', 'square').orderBy('occurred_at').execute();
    expect(rows).toEqual([
      { external_ref: 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY', venue_id: diner.venueId, total_cents: 5810, tip_cents: 500, status: 'completed', tender_type: 'card', customer_id: expect.any(String) },
      { external_ref: 'KkAkhdMsgzn59SM8A89WgKwekxLZY', venue_id: diner.venueId, total_cents: 1850, tip_cents: 0, status: 'completed', tender_type: 'cash', customer_id: null },
    ]);
    // Ledger total equals the sum of Square's payment totals.
    expect(rows.reduce((s, r) => s + r.total_cents, 0)).toBe(payments.reduce((s, p) => s + p.total_money.amount, 0));
    const identities = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('customer_id', '=', rows[0]!.customer_id!).orderBy('kind').execute();
    expect(identities).toEqual([{ kind: 'email', value: 'square.guest@example.com' }, { kind: 'pos_customer_id', value: 'W92WH6P11H4Z77CTET0RNTGFW8' }]);
    expect(await tablesContaining(t, FINGERPRINT)).toEqual([]);
    expect(await tablesContaining(t, TOKEN_IN_VAULT)).toEqual([]);
  });

  it('a Square-signed refund webhook re-fetches the payment and updates the row; a forged one is refused', async () => {
    const paymentId = 'bP9mAsEMYPUGjjGNaNO5ZDVyLhSZY';
    const body = JSON.stringify(refundUpdatedEvent(paymentId));
    const headers = { 'x-square-hmacsha256-signature': squareSignature('signature-key', url, body) };

    await expect(ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: body, url, headers: { 'x-square-hmacsha256-signature': squareSignature('guessed-key', url, body) } })).rejects.toMatchObject({ code: 'unauthenticated' });
    // Signed for a different URL than the one that was called.
    await expect(ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: body, url: 'https://evil.example/webhooks/pos/square', headers })).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await ledgerRow(t, paymentId))[0]).toMatchObject({ status: 'completed', refunded_cents: 0 });

    // Square now reports the refund on the payment. The event only says which payment to look at.
    payments[0] = cardPayment({ refunded_money: { amount: 1000, currency: 'AUD' }, updated_at: '2026-09-27T22:14:16.381Z', refund_ids: [`${paymentId}_ptNBVqHYxt5gAdfcobBe4u1AZsXhoz06KTtuq9Ls24P`] });
    expect(await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: body, url, headers })).toMatchObject({ status: 'processed', changed: 1 });
    const rows = await ledgerRow(t, paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'partially_refunded', refunded_cents: 1000, total_cents: 5810 });
    expect(await ledger.handlePosWebhook(t.app, { plugKey: 'square', rawBody: body, url, headers })).toMatchObject({ status: 'duplicate' });
    expect(await tablesContaining(t, FINGERPRINT)).toEqual([]);
  });
});
