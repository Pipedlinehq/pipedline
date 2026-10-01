import { createHash } from 'node:crypto';
import type {
  CanonicalTransaction,
  ConnectionHandle,
  IdentityHint,
  PaymentAdapter,
  PaymentLookup,
  PaymentRequest,
  PaymentResult,
  PosAdapter,
  PosOrderPush,
  RefundRequest,
  TxnChannel,
} from '@ros/core';
import { type SquareClientOptions, SquareApiError, squareCall, squareEnvironment, squareIdempotencyKey } from './client';
import { type SquareMapOptions, squareToCanonical, withoutCardIdentifiers } from './map';
import type { SquareLocation, SquareOrder, SquarePayment, SquareRefund } from './types';
import { parseSquareWebhook, verifySquareWebhook } from './webhook';

export * from './client';
export * from './map';
export * from './types';
export * from './webhook';
export * from './oauth';

/**
 * Square, behind the POS port and the payment port, over plain `fetch`.
 *
 * UNVERIFIED AGAINST SQUARE. Every endpoint, parameter and field here was checked against
 * developer.squareup.com/reference/square on 2026-10-01, but there were no credentials to run
 * it with: it has never talked to Square or its sandbox. Its tests replay payloads built from
 * the documented shapes. Verify each method against the sandbox before a venue depends on it.
 *
 * What a Square connection holds:
 *   credentials.accessToken     the seller's OAuth access token
 *   credentials.webhookSecret   the signature key of our webhook subscription
 *   config.locationRef          the Square location that is this venue
 *   config.environment          'sandbox' | 'production' (default)
 *   config.applicationId        our Square application id (hosted card fields; spotting our own payments)
 *   config.defaultChannel       channel of a sale with no fulfilment: 'dine-in' (default), 'retail', …
 *   config.currency             currency of orders we create (default 'AUD')
 *   config.prepMinutes          prep time given for an ASAP pickup order (default 20)
 */
export type SquareAdapter = PosAdapter & PaymentAdapter;

const LIST_LIMIT_MAX = 100; // ListPayments: "The maximum results per page is 100."
const BATCH_ORDERS_MAX = 100; // BatchRetrieveOrders: "A maximum of 100 orders can be retrieved per request."
/** Square refunds a payment for up to a year after it was taken; a change to a sale can be that much later than the sale. */
const CHANGE_HORIZON_MS = 366 * 86_400_000;

const CHANNELS: TxnChannel[] = ['dine-in', 'pickup', 'delivery', 'catering', 'retail'];

function mapOptions(conn: ConnectionHandle): SquareMapOptions {
  const channel = conn.config.defaultChannel;
  return {
    applicationId: typeof conn.config.applicationId === 'string' ? conn.config.applicationId : null,
    defaultChannel: CHANNELS.includes(channel as TxnChannel) ? (channel as TxnChannel) : 'dine-in',
  };
}

const currencyOf = (conn: ConnectionHandle) => (typeof conn.config.currency === 'string' ? conn.config.currency : 'AUD');
const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, max));

export function createSquareAdapter(opts: SquareClientOptions = {}): SquareAdapter {
  /** POST /v2/orders/batch-retrieve, in chunks of 100. Orders that cannot be read are simply absent. */
  async function ordersById(conn: ConnectionHandle, locationRef: string | null, orderIds: string[]): Promise<Map<string, SquareOrder>> {
    const out = new Map<string, SquareOrder>();
    const unique = [...new Set(orderIds)];
    for (let i = 0; i < unique.length; i += BATCH_ORDERS_MAX) {
      const res = await squareCall<{ orders?: SquareOrder[] }>(opts, conn, {
        method: 'POST',
        path: '/v2/orders/batch-retrieve',
        body: { ...(locationRef ? { location_id: locationRef } : {}), order_ids: unique.slice(i, i + BATCH_ORDERS_MAX) },
      });
      for (const o of res.orders ?? []) if (o.id) out.set(o.id, o);
    }
    return out;
  }

  return {
    key: 'square',
    source: 'square',
    // Discounts can be written only to orders created through the API: Square's UpdateOrder
    // "cannot update orders made in the Square Point of Sale application". So write-back is
    // 'order' (we can put an order on the POS), not a one-tap discount on a bill opened at the till.
    // An online order shows on Square's POS only once a payment that named it completes, so it
    // is pushed before the payment (PaymentRequest.posOrderRef), never after.
    capabilities: { itemisedLines: true, customerIdentity: 'both', writeBack: 'order', webhooks: true, realtime: true, orderPush: 'before_payment' },

    // ── POS port ───────────────────────────────────────────────────────────

    /** GET /v2/locations (MERCHANT_PROFILE_READ). */
    async listLocations(conn) {
      const res = await squareCall<{ locations?: SquareLocation[] }>(opts, conn, { method: 'GET', path: '/v2/locations' });
      return (res.locations ?? [])
        .filter((l): l is SquareLocation & { id: string } => typeof l.id === 'string')
        .map((l) => ({ ref: l.id, name: l.name ?? l.id, ...(l.timezone ? { timezone: l.timezone } : {}) }));
    },

    /**
     * GET /v2/payments (PAYMENTS_READ), filtered and sorted on updated_at so a refund on an old
     * payment is seen, then the payments' orders in one batch call (ORDERS_READ).
     *
     * `begin_time` filters on created_at and defaults to one year back; it is set explicitly to
     * a year before `since`, so a long back-fill is not cut off at twelve months and a payment
     * changed inside the window is still returned however old it is.
     */
    async listTransactions(conn, args) {
      const res = await squareCall<{ payments?: SquarePayment[]; cursor?: string }>(opts, conn, {
        method: 'GET',
        path: '/v2/payments',
        query: {
          location_id: args.locationRef,
          begin_time: new Date(args.since.getTime() - CHANGE_HORIZON_MS).toISOString(),
          updated_at_begin_time: args.since.toISOString(),
          updated_at_end_time: args.until?.toISOString(),
          sort_field: 'UPDATED_AT',
          sort_order: 'ASC',
          limit: Math.max(1, Math.min(args.limit ?? LIST_LIMIT_MAX, LIST_LIMIT_MAX)),
          cursor: args.cursor,
        },
      });
      const payments = (res.payments ?? []).filter((p) => p.id && p.created_at);
      const orders = await ordersById(conn, args.locationRef, payments.map((p) => p.order_id).filter((id): id is string => !!id));
      const map = mapOptions(conn);
      return {
        items: payments.map((p) => squareToCanonical(p, (p.order_id && orders.get(p.order_id)) || null, map)),
        nextCursor: res.cursor ? res.cursor : null,
      };
    },

    /** GET /v2/payments/{payment_id} (PAYMENTS_READ), then its order. A payment Square does not know is null. */
    async getTransaction(conn, externalRef): Promise<CanonicalTransaction | null> {
      let payment: SquarePayment | undefined;
      try {
        payment = (await squareCall<{ payment?: SquarePayment }>(opts, conn, { method: 'GET', path: `/v2/payments/${encodeURIComponent(externalRef)}` })).payment;
      } catch (e) {
        if (e instanceof SquareApiError && e.status === 404) return null;
        throw e;
      }
      if (!payment?.id || !payment.created_at) return null;
      const order = payment.order_id ? ((await ordersById(conn, payment.location_id ?? null, [payment.order_id])).get(payment.order_id) ?? null) : null;
      return squareToCanonical(payment, order, mapOptions(conn));
    },

    verifyWebhook: verifySquareWebhook,
    parseWebhook: parseSquareWebhook,

    /**
     * POST /v2/orders (ORDERS_WRITE): an order with a PICKUP fulfilment, ad hoc line items at
     * the prices the guest was charged.
     *
     * Square shows an order on the POS only once it is paid ("An order appears in the Square
     * Dashboard or Square products if … the order includes fulfillment [and] the order is
     * paid"), and a payment pays an order only by naming it when the payment is created. So the
     * order must be pushed first and its ref passed as `PaymentRequest.posOrderRef`. A
     * `paymentRef` for a payment already taken cannot be attached afterwards; it is kept in
     * the order's metadata for a person to follow, and the order will not appear on the till.
     */
    async pushOrder(conn, order: PosOrderPush) {
      const currency = currencyOf(conn);
      const money = (amount: number) => ({ amount, currency });
      const notes = [order.channel === 'pickup' ? null : order.channel === 'delivery' ? 'Delivery' : 'Table order', order.tableLabel ? `Table ${order.tableLabel}` : null, order.note ?? null].filter(Boolean);
      const prepMinutes = typeof conn.config.prepMinutes === 'number' && conn.config.prepMinutes > 0 ? Math.round(conn.config.prepMinutes) : 20;
      const res = await squareCall<{ order?: SquareOrder }>(opts, conn, {
        method: 'POST',
        path: '/v2/orders',
        body: {
          idempotency_key: squareIdempotencyKey(order.idempotencyKey, 192),
          order: {
            location_id: order.locationRef,
            reference_id: clip(order.reference, 40),
            ticket_name: clip(order.tableLabel ? `Table ${order.tableLabel}` : (order.customerName ?? order.reference), 255),
            line_items: order.lines.map((l) => ({
              name: clip(l.name, 512),
              quantity: String(l.qty),
              // The port's unit price includes the chosen modifiers; Square adds modifiers to the base price.
              base_price_money: money(l.unitPriceCents - l.modifiers.reduce((s, m) => s + m.priceCents, 0)),
              ...(l.modifiers.length ? { modifiers: l.modifiers.map((m) => ({ name: clip(m.name, 255), base_price_money: money(m.priceCents) })) } : {}),
              ...(l.note ? { note: clip(l.note, 2000) } : {}),
            })),
            fulfillments: [
              {
                type: 'PICKUP',
                state: 'PROPOSED',
                pickup_details: {
                  recipient: { display_name: clip(order.customerName ?? order.reference, 255) },
                  ...(order.readyAt ? { schedule_type: 'SCHEDULED', pickup_at: order.readyAt.toISOString() } : { schedule_type: 'ASAP', prep_time_duration: `PT${prepMinutes}M` }),
                  ...(notes.length ? { note: clip(notes.join('. '), 500) } : {}),
                },
              },
            ],
            // Order-level amounts, so the order's total is what the payment will be (Square refuses
            // a payment for an order whose total differs). A service charge carries the delivery fee.
            ...(order.discounts?.length
              ? { discounts: order.discounts.map((d, i) => ({ uid: `ros-discount-${i + 1}`, name: clip(d.name, 255), type: 'FIXED_AMOUNT', amount_money: money(d.amountCents), scope: 'ORDER' })) }
              : {}),
            ...(order.serviceCharges?.length
              ? { service_charges: order.serviceCharges.map((c, i) => ({ uid: `ros-charge-${i + 1}`, name: clip(c.name, 255), amount_money: money(c.amountCents), calculation_phase: 'TOTAL_PHASE' })) }
              : {}),
            ...(order.paymentRef ? { metadata: { ros_payment_ref: clip(order.paymentRef, 255) } } : {}),
          },
        },
      });
      if (!res.order?.id) throw new Error('square: CreateOrder answered without an order id');
      return { posOrderRef: res.order.id };
    },

    /**
     * Add a fixed-amount discount to an OPEN order: read its version (batch-retrieve), then
     * PUT /v2/orders/{order_id} with that version and the new discount (ORDERS_WRITE).
     * Works for orders created through the API. Square refuses updates to orders made in its
     * own Point of Sale app; that, and any other refusal, is answered `{ ok: false }`.
     */
    async applyDiscount(conn, args) {
      const order = (await ordersById(conn, args.locationRef, [args.orderRef])).get(args.orderRef);
      if (!order || order.state !== 'OPEN' || typeof order.version !== 'number') return { ok: false };
      const uid = `ros-${createHash('sha256').update(args.idempotencyKey).digest('hex').slice(0, 40)}`;
      if ((order.discounts ?? []).some((d) => d.uid === uid)) return { ok: true };
      try {
        await squareCall<{ order?: SquareOrder }>(opts, conn, {
          method: 'PUT',
          path: `/v2/orders/${encodeURIComponent(args.orderRef)}`,
          body: {
            idempotency_key: squareIdempotencyKey(args.idempotencyKey, 192),
            order: {
              version: order.version,
              discounts: [{ uid, name: clip(args.name, 255), type: 'FIXED_AMOUNT', amount_money: { amount: args.amountCents, currency: order.total_money?.currency ?? currencyOf(conn) }, scope: 'ORDER' }],
            },
          },
        });
        return { ok: true };
      } catch (e) {
        // A refusal (4xx) is an answer; an outage is not.
        if (e instanceof SquareApiError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 401) return { ok: false };
        throw e;
      }
    },

    // ── Payment port ───────────────────────────────────────────────────────

    clientConfig(conn) {
      return {
        provider: 'square',
        applicationId: typeof conn.config.applicationId === 'string' ? conn.config.applicationId : '',
        locationRef: typeof conn.config.locationRef === 'string' ? conn.config.locationRef : '',
        environment: squareEnvironment(conn),
      };
    },

    /**
     * POST /v2/payments (PAYMENTS_WRITE) from a single-use token made by Square's hosted card
     * fields. `amount_money` excludes the tip; the tip goes in `tip_money`. A decline comes
     * back from Square as an error of category PAYMENT_METHOD_ERROR and is answered here as a
     * failed payment, not thrown: it is the card's answer, not an outage.
     */
    async createPayment(conn, req: PaymentRequest): Promise<PaymentResult> {
      const idempotencyKey = squareIdempotencyKey(req.idempotencyKey, 45);
      const locationRef = req.locationRef ?? (typeof conn.config.locationRef === 'string' ? conn.config.locationRef : null);
      let payment: SquarePayment | undefined;
      try {
        payment = (
          await squareCall<{ payment?: SquarePayment }>(opts, conn, {
            method: 'POST',
            path: '/v2/payments',
            body: {
              source_id: req.sourceToken,
              idempotency_key: idempotencyKey,
              amount_money: { amount: req.amountCents, currency: req.currency },
              ...(req.tipCents > 0 ? { tip_money: { amount: req.tipCents, currency: req.currency } } : {}),
              autocomplete: true,
              ...(locationRef ? { location_id: locationRef } : {}),
              ...(req.posOrderRef ? { order_id: req.posOrderRef } : {}),
              reference_id: clip(req.reference, 40),
              ...(req.note ? { note: clip(req.note, 500) } : {}),
            },
          })
        ).payment;
      } catch (e) {
        if (e instanceof SquareApiError && e.has('PAYMENT_METHOD_ERROR')) {
          const failed = (e.body as { payment?: SquarePayment } | null)?.payment;
          return {
            // Square does not always return a payment for a decline; the ref then names the attempt.
            externalRef: failed?.id ?? `declined_${idempotencyKey}`,
            status: 'failed',
            cardBrand: failed?.card_details?.card?.card_brand ?? null,
            cardLast4: failed?.card_details?.card?.last_4 ?? null,
            failureReason: e.errors.find((x) => x.category === 'PAYMENT_METHOD_ERROR')?.code ?? 'declined',
            raw: e.body,
            identityHints: [],
          };
        }
        throw e;
      }
      if (!payment?.id) throw new Error('square: CreatePayment answered without a payment id');
      const completed = payment.status === 'COMPLETED';
      const fingerprint = payment.card_details?.card?.fingerprint;
      const identityHints: IdentityHint[] = completed && fingerprint ? [{ kind: 'card_fingerprint', value: fingerprint }] : [];
      return {
        externalRef: payment.id,
        status: completed ? 'completed' : 'failed',
        cardBrand: payment.card_details?.card?.card_brand ?? null,
        cardLast4: payment.card_details?.card?.last_4 ?? null,
        failureReason: completed ? null : `status_${(payment.status ?? 'unknown').toLowerCase()}`,
        raw: withoutCardIdentifiers(payment),
        identityHints,
      };
    },

    /**
     * Find an attempt whose CreatePayment never answered. Square has no lookup by idempotency
     * key and ListPayments cannot filter on reference_id, so: GET /v2/payments (PAYMENTS_READ)
     * at the location, created in a window around the attempt, filtered by `total` (the exact
     * amount including the tip), and matched here on the reference_id this adapter set.
     *
     *   a COMPLETED match   the attempt charged the card: that payment
     *   an APPROVED/PENDING  still in flight at Square: thrown, so the caller asks again later
     *   none, or only FAILED/CANCELED ones   nothing was charged for this order: null
     *
     * Only one attempt per order can be unresolved at a time (ordering refuses a second card
     * meanwhile), so a completed payment for this order and amount is this attempt's.
     */
    async lookupPayment(conn, req: PaymentLookup): Promise<PaymentResult | null> {
      const locationRef = req.locationRef ?? (typeof conn.config.locationRef === 'string' ? conn.config.locationRef : null);
      const reference = clip(req.reference, 40);
      const matches: SquarePayment[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res: { payments?: SquarePayment[]; cursor?: string } = await squareCall(opts, conn, {
          method: 'GET',
          path: '/v2/payments',
          query: {
            location_id: locationRef,
            begin_time: new Date(req.attemptedAt.getTime() - 10 * 60_000).toISOString(),
            end_time: new Date(req.attemptedAt.getTime() + 60 * 60_000).toISOString(),
            total: req.amountCents + req.tipCents,
            sort_order: 'ASC',
            limit: LIST_LIMIT_MAX,
            cursor,
          },
        });
        for (const p of res.payments ?? []) if (p.reference_id === reference && p.amount_money?.amount === req.amountCents) matches.push(p);
        cursor = res.cursor ?? null;
        if (!cursor) break;
      }
      const done = matches.find((p) => p.status === 'COMPLETED');
      if (done?.id) {
        const fingerprint = done.card_details?.card?.fingerprint;
        return {
          externalRef: done.id,
          status: 'completed',
          cardBrand: done.card_details?.card?.card_brand ?? null,
          cardLast4: done.card_details?.card?.last_4 ?? null,
          failureReason: null,
          raw: withoutCardIdentifiers(done),
          identityHints: fingerprint ? [{ kind: 'card_fingerprint', value: fingerprint }] : [],
        };
      }
      if (matches.some((p) => p.status === 'APPROVED' || p.status === 'PENDING')) throw new Error('square: the payment is still pending at Square');
      return null;
    },

    /** GET /v2/refunds/{refund_id} (PAYMENTS_READ). PENDING | COMPLETED | REJECTED | FAILED. */
    async getRefund(conn, refundRef) {
      let refund: SquareRefund | undefined;
      try {
        refund = (await squareCall<{ refund?: SquareRefund }>(opts, conn, { method: 'GET', path: `/v2/refunds/${encodeURIComponent(refundRef)}` })).refund;
      } catch (e) {
        if (e instanceof SquareApiError && e.status === 404) return null;
        throw e;
      }
      if (!refund?.id) return null;
      const status = refund.status === 'COMPLETED' ? ('completed' as const) : refund.status === 'PENDING' ? ('pending' as const) : ('failed' as const);
      return { externalRef: refund.id, status };
    },

    /** POST /v2/refunds (PAYMENTS_WRITE). Square answers PENDING first; COMPLETED arrives later by webhook. */
    async refund(conn, req: RefundRequest) {
      const res = await squareCall<{ refund?: SquareRefund }>(opts, conn, {
        method: 'POST',
        path: '/v2/refunds',
        body: {
          idempotency_key: squareIdempotencyKey(req.idempotencyKey, 45),
          payment_id: req.paymentRef,
          amount_money: { amount: req.amountCents, currency: req.currency },
          reason: clip(req.reason, 192),
        },
      });
      if (!res.refund?.id) throw new Error('square: RefundPayment answered without a refund id');
      const status = res.refund.status === 'COMPLETED' ? ('completed' as const) : res.refund.status === 'PENDING' ? ('pending' as const) : ('failed' as const);
      return { externalRef: res.refund.id, status };
    },
  };
}
