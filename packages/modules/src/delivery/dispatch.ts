import { z } from 'zod';
import {
  type App,
  type ConnectionRow,
  type Ctx,
  type CourierDelivery,
  type CourierQuoteRequest,
  addMinutes,
  adapterFor,
  audit,
  defineJob,
  enqueue,
  formatMoney,
  isNoCourier,
  json,
  once,
  resolveConnection,
  track,
} from '@ros/core';
import { onOrderStatusChanged } from '../ordering/contract';
import {
  type FulfilmentOrder,
  cancelUndeliverableOrder,
  completeOrderByCourier,
  flagOrderForStaff,
  getOrderForFulfilment,
  refundForDelivery,
  switchOrderToPickup,
} from '../ordering/fulfilment';
import { getVenue } from '../tenancy/venues';
import { type DeliveryConfig, deliveryCancelled, deliveryDelivered, deliveryFailed, deliveryRequested } from './module';
import {
  type DeliveryRow,
  type DeliveryStatus,
  FINISHED,
  RANK,
  WORKER,
  clockText,
  courierConnections,
  deliveryConfigAt,
  deliveryForOrder,
  firstNameOf,
  loadDelivery,
  notifyGuest,
  setStatus,
} from './rows';

const LIVE_ORDER = ['placed', 'accepted', 'preparing', 'ready'];

// ── Reacting to the order ────────────────────────────────────────────────────

/**
 * Runs inside every order status change (ordering/contract.ts). An accepted delivery order gets
 * its courier request scheduled, timed to the prep time; an order stopped before the courier
 * came has its courier called off. Never calls a provider: it enqueues.
 */
onOrderStatusChanged(async (ctx, order, change) => {
  if (change.to === 'placed' && order.customerId) {
    // A card a consenting guest linked earlier can make an anonymous order theirs at payment.
    await ctx.db.updateTable('deliveries').set({ customer_id: order.customerId }).where('order_id', '=', order.id).where('customer_id', 'is', null).execute();
    return;
  }
  if (change.to === 'accepted' && order.channel === 'delivery') {
    const d = await deliveryForOrder(ctx, order.id, { lock: true });
    if (!d || d.status !== 'quoted' || d.request_at) return;
    const cfg = await deliveryConfigAt(ctx, d.venue_id);
    const now = ctx.now();
    // A courier waiting at the pass costs the venue; food waiting for a courier costs the guest.
    const due = order.promisedAt ? addMinutes(order.promisedAt, -cfg.courier_request_lead_minutes) : now;
    const requestAt = due > now ? due : now;
    await ctx.db.updateTable('deliveries').set({ request_at: requestAt }).where('id', '=', d.id).execute();
    await enqueue(ctx, requestCourierJob, { deliveryId: d.id }, { key: `courier:${d.id}`, runAt: requestAt });
    return;
  }
  if (change.to === 'rejected' || change.to === 'cancelled' || change.to === 'refunded') {
    const d = await deliveryForOrder(ctx, order.id, { lock: true });
    if (!d || FINISHED.includes(d.status) || d.status === 'picked_up') return;
    if (d.status === 'quoted') {
      await setStatus(ctx, d, 'cancelled', { source: 'venue', set: { failure_reason: `order ${change.to}` } });
      return;
    }
    await enqueue(ctx, cancelCourierJob, { deliveryId: d.id, reason: `The order was ${change.to}.` }, { key: `courier-cancel:${d.id}` });
  }
});

// ── Booking the courier ──────────────────────────────────────────────────────

interface Attempt {
  provider: string;
  conn: ConnectionRow;
}

function quoteRequest(d: DeliveryRow, order: FulfilmentOrder, venue: Awaited<ReturnType<typeof getVenue>>, readyAt: Date): CourierQuoteRequest {
  const addr = (d.dropoff_address ?? {}) as { line1?: string; line2?: string | null; suburb?: string; state?: string; postcode?: string; country?: string };
  return {
    pickup: {
      name: venue.name,
      phone: venue.phone,
      address: { line1: venue.addressLine1 ?? venue.name, line2: venue.addressLine2, suburb: venue.suburb ?? '', state: venue.state ?? '', postcode: venue.postcode ?? '', country: 'AU', lat: venue.lat, lng: venue.lng },
    },
    dropoff: {
      name: order.customerName ?? 'Guest',
      phone: order.customerPhone,
      address: { line1: addr.line1 ?? '', line2: addr.line2 ?? null, suburb: addr.suburb ?? '', state: addr.state ?? '', postcode: addr.postcode ?? '', country: addr.country ?? 'AU', lat: d.dropoff_lat, lng: d.dropoff_lng },
      notes: d.dropoff_notes,
    },
    readyAt,
    orderValueCents: d.order_value_cents,
    containsAlcohol: d.contains_alcohol,
  };
}

/**
 * Book a courier for an accepted delivery order, when its request time comes. The preferred
 * provider first (with the checkout quote while it holds, a fresh one after), then the next
 * provider when it has no courier. Each booking goes through once() with the same key given to
 * the provider, so a retry never books twice. No courier anywhere: the venue's fallback, at once.
 * A provider that cannot be reached is retried; on the last attempt the fallback applies, so an
 * accepted order is never left with no carrier and no message.
 */
export const requestCourierJob = defineJob({
  kind: 'delivery.request_courier',
  schema: z.object({ deliveryId: z.string().uuid() }),
  maxAttempts: 5,
  backoffSeconds: (attempt) => Math.min(30 * 2 ** (attempt - 1), 600),
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('delivery.request_courier needs an org');
    const prep = await app.tenant(orgId, WORKER, async (ctx) => {
      const d = await loadDelivery(ctx, job.payload.deliveryId, { lock: true });
      if (d.status !== 'quoted' || !d.order_id) return null;
      const order = await getOrderForFulfilment(ctx, d.order_id);
      if (!LIVE_ORDER.includes(order.status) || order.channel !== 'delivery') {
        await setStatus(ctx, d, 'cancelled', { source: 'dispatch', set: { failure_reason: `order ${order.status}` } });
        return null;
      }
      const cfg = await deliveryConfigAt(ctx, d.venue_id);
      const venue = await getVenue(ctx, d.venue_id);
      const others = cfg.failover_to_next_provider ? cfg.providers.filter((p) => p !== d.provider) : [];
      const attempts: Attempt[] = await courierConnections(ctx, d.venue_id, [d.provider, ...others]);
      return { d, order, cfg, venue, attempts };
    });
    if (!prep) return;
    const { d, order, cfg, venue } = prep;
    const now = app.clock();
    const readyAt = order.promisedAt && order.promisedAt > now ? order.promisedAt : now;
    const request = quoteRequest(d, order, venue, readyAt);

    let transient = 0;
    const tried: string[] = [];
    for (const { provider, conn } of prep.attempts) {
      tried.push(provider);
      let booked: CourierDelivery;
      try {
        const adapter = adapterFor(app, 'courier', conn);
        if (d.contains_alcohol && !adapter.supportsAlcohol) continue;
        const handle = await resolveConnection(app, conn);
        let quoteId = provider === d.provider && d.quote_id && d.quote_expires_at && d.quote_expires_at > addMinutes(now, 1) ? d.quote_id : null;
        if (!quoteId) {
          // The checkout quote has lapsed by the time the food is nearly ready: ask again. The
          // guest's fee was fixed at checkout; the venue pays whatever the courier now charges.
          const fresh = await adapter.quote(handle, request);
          if (!fresh) continue;
          quoteId = fresh.quoteId;
        }
        const key = `courier:${d.id}:${provider}`;
        booked = (
          await once(app, { orgId, key, kind: 'courier_request' }, () => adapter.create(handle, { ...request, quoteId: quoteId!, idempotencyKey: key, reference: order.reference }))
        ).result;
      } catch (e) {
        if (isNoCourier(e)) continue;
        transient++;
        app.log.warn('delivery: courier request failed', { orgId, deliveryId: d.id, provider, error: (e as Error).message?.slice(0, 300) });
        continue;
      }
      const recorded = await app.tenant(orgId, WORKER, (ctx) => recordBooking(ctx, d.id, { provider, conn, booked, tried, failover: provider !== d.provider }));
      if (!recorded) {
        // The order was stopped while the courier was being booked: call it off straight away.
        await app.tenant(orgId, WORKER, (ctx) => enqueue(ctx, cancelCourierJob, { deliveryId: d.id, reason: 'The order was stopped while the courier was booked.', externalRef: booked.externalRef, provider, connectionId: conn.id }, { key: `courier-cancel:${d.id}:${booked.externalRef}` }));
      }
      return;
    }

    // A provider we could not reach may have a courier on the next try; one with no courier will not.
    if (transient > 0 && job.attempt < 5) throw new Error('No courier booked yet: a provider could not be reached. Trying again.');
    await app.tenant(orgId, WORKER, (ctx) => noCourier(ctx, d.id, cfg, tried, transient > 0 ? 'provider_unreachable' : 'no_courier'));
  },
});

async function recordBooking(ctx: Ctx, deliveryId: string, a: { provider: string; conn: ConnectionRow; booked: CourierDelivery; tried: string[]; failover: boolean }): Promise<boolean> {
  const d = await loadDelivery(ctx, deliveryId, { lock: true });
  if (d.status !== 'quoted') return false;
  const b = a.booked;
  const status: DeliveryStatus = RANK[b.status] >= RANK.requested ? b.status : 'requested';
  const updated = await setStatus(ctx, d, status, {
    source: 'dispatch',
    set: {
      provider: a.provider,
      connection_id: a.conn.id,
      external_ref: b.externalRef,
      courier_fee_cents: b.feeCents,
      tracking_url: b.trackingUrl ?? null,
      pickup_eta: b.pickupEta ?? d.pickup_eta,
      dropoff_eta: b.dropoffEta ?? d.dropoff_eta,
      courier_name: b.courierName ?? null,
      requested_at: ctx.now(),
      last_checked_at: ctx.now(),
      attempted_providers: [...new Set([...d.attempted_providers, ...a.tried])],
    },
    raw: { provider: a.provider, status: b.status },
  });
  await track(ctx, deliveryRequested, { delivery_id: d.id, order_id: d.order_id!, provider: a.provider, failover: a.failover, courier_fee_cents: b.feeCents }, { venueId: d.venue_id });
  const cfg = await deliveryConfigAt(ctx, d.venue_id);
  const order = await getOrderForFulfilment(ctx, d.order_id!);
  const venue = await getVenue(ctx, d.venue_id);
  await notifyGuest(
    ctx,
    cfg,
    updated,
    order,
    'delivery.dispatched',
    {
      first_name: firstNameOf(order.customerName),
      venue_name: venue.name,
      reference: order.reference,
      eta_line: updated.dropoff_eta ? `It should reach you at about ${clockText(updated.dropoff_eta, venue.timezone)}.` : 'We will let you know when it is on its way.',
      tracking_url: updated.tracking_url ?? order.trackingUrl,
    },
    'dispatched',
  );
  return true;
}

/**
 * No courier from any provider. Never an accepted order with no carrier and no message: per the
 * venue's choice the guest is refunded in full (the order is cancelled and they are told why),
 * or the order becomes a pickup, the delivery fee is refunded, and they are told where to collect it.
 */
export async function noCourier(ctx: Ctx, deliveryId: string, cfg: DeliveryConfig, tried: string[], reason: 'no_courier' | 'provider_unreachable'): Promise<void> {
  const d = await loadDelivery(ctx, deliveryId, { lock: true });
  if (d.status !== 'quoted' || !d.order_id) return;
  const order = await getOrderForFulfilment(ctx, d.order_id);
  const failed = await setStatus(ctx, d, 'failed', { source: 'dispatch', set: { failure_reason: reason, attempted_providers: [...new Set([...d.attempted_providers, ...tried])] }, raw: { reason } });
  await applyFallback(ctx, failed, order, cfg, reason, tried);
}

/** The venue's no-courier choice, for a delivery that has no carrier and whose food has not left. */
async function applyFallback(ctx: Ctx, d: DeliveryRow, order: FulfilmentOrder, cfg: DeliveryConfig, reason: string, tried: string[]): Promise<void> {
  if (!d.order_id) return;
  const pickup = cfg.no_courier_fallback === 'offer_pickup' && LIVE_ORDER.includes(order.status);
  await audit(ctx, { action: 'delivery.no_courier', entityType: 'delivery', entityId: d.id, venueId: d.venue_id, after: { orderId: d.order_id, reason, providers: tried, fallback: pickup ? 'offer_pickup' : 'refund' } });
  await track(ctx, deliveryFailed, { delivery_id: d.id, order_id: d.order_id, reason, status: 'failed', refund: pickup ? 'switched_to_pickup' : 'full' }, { venueId: d.venue_id });
  if (!pickup) {
    await cancelUndeliverableOrder(ctx, { orderId: d.order_id, reason: 'Sorry, no courier was available to deliver your order.' });
    return;
  }
  const venue = await getVenue(ctx, d.venue_id);
  await switchOrderToPickup(ctx, { orderId: d.order_id, reason: 'No courier was available.' });
  if (order.deliveryFeeCents > 0) await refundForDelivery(ctx, { orderId: d.order_id, reason: 'No courier: the delivery fee is refunded.', key: `delivery-fee:${d.id}`, amountCents: order.deliveryFeeCents });
  await flagOrderForStaff(ctx, { orderId: d.order_id, reason: 'No courier could take this delivery. The guest was asked to collect it instead.' });
  await notifyGuest(
    ctx,
    cfg,
    d,
    order,
    'delivery.no_courier_pickup',
    {
      first_name: firstNameOf(order.customerName),
      venue_name: venue.name,
      reference: order.reference,
      where_line: [venue.addressLine1, venue.suburb].filter(Boolean).join(', ') || venue.name,
      refund_line: order.deliveryFeeCents > 0 ? `The ${formatMoney(order.deliveryFeeCents, order.currency)} delivery fee is being refunded to your card.` : '',
    },
    'no_courier',
  );
}

// ── Calling a courier off ────────────────────────────────────────────────────

export const cancelCourierJob = defineJob({
  kind: 'delivery.cancel_courier',
  schema: z.object({
    deliveryId: z.string().uuid(),
    reason: z.string().max(300),
    /** Set when the booking landed after the delivery was already stopped (it is not on the row). */
    externalRef: z.string().max(200).optional(),
    provider: z.string().max(60).optional(),
    connectionId: z.string().uuid().optional(),
  }),
  maxAttempts: 6,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('delivery.cancel_courier needs an org');
    const prep = await app.tenant(orgId, WORKER, async (ctx) => {
      const d = await loadDelivery(ctx, job.payload.deliveryId);
      const ref = job.payload.externalRef ?? d.external_ref;
      const connectionId = job.payload.connectionId ?? d.connection_id;
      if (!ref || !connectionId) return null;
      if (!job.payload.externalRef && (FINISHED.includes(d.status) || d.status === 'quoted')) return null;
      const conn = await ctx.db
        .selectFrom('connections')
        .select(['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'])
        .where('id', '=', connectionId)
        .executeTakeFirst();
      return conn ? { d, ref, conn } : null;
    });
    if (!prep) return;
    const adapter = adapterFor(app, 'courier', prep.conn);
    const handle = await resolveConnection(app, prep.conn);
    const key = `courier-cancel:${prep.d.id}:${prep.ref}`;
    const r = (await once(app, { orgId, key, kind: 'courier_cancel' }, () => adapter.cancel(handle, prep.ref))).result;
    if (job.payload.externalRef) return; // a stray booking: called off, nothing on the row to change
    await app.tenant(orgId, WORKER, async (ctx) => {
      const d = await loadDelivery(ctx, prep.d.id, { lock: true });
      if (FINISHED.includes(d.status)) return;
      if (!r.cancelled) {
        // Too late: the courier has the food. Staff decide what happens next.
        if (d.order_id) await flagOrderForStaff(ctx, { orderId: d.order_id, reason: 'The order was stopped but the courier could not be called off: it has already been collected.' });
        return;
      }
      await setStatus(ctx, d, 'cancelled', { source: 'venue', set: { cancellation_fee_cents: r.feeCents, failure_reason: job.payload.reason }, raw: { fee_cents: r.feeCents } });
      await track(ctx, deliveryCancelled, { delivery_id: d.id, order_id: d.order_id, cancellation_fee_cents: r.feeCents }, { venueId: d.venue_id });
      await audit(ctx, { action: 'delivery.cancelled', entityType: 'delivery', entityId: d.id, venueId: d.venue_id, after: { reason: job.payload.reason, cancellationFeeCents: r.feeCents, paidBy: 'venue' } });
    });
  },
});

// ── What the courier service says ────────────────────────────────────────────

/**
 * Record the provider's view of a delivery, as re-fetched (a webhook is only a hint) or found by
 * reconciliation. Late news never moves a delivery backwards. Each step's consequence happens
 * once, because it follows the status change and the change happens once.
 */
export async function applyProviderState(ctx: Ctx, deliveryId: string, state: CourierDelivery, source: 'webhook' | 'reconcile', hint: Record<string, unknown> | null): Promise<DeliveryRow> {
  const d = await loadDelivery(ctx, deliveryId, { lock: true });
  const now = ctx.now();
  const details = {
    last_checked_at: now,
    tracking_url: state.trackingUrl ?? d.tracking_url,
    pickup_eta: state.pickupEta ?? d.pickup_eta,
    dropoff_eta: state.dropoffEta ?? d.dropoff_eta,
    courier_name: state.courierName ?? d.courier_name,
  };
  if (FINISHED.includes(d.status) || d.status === 'quoted' || RANK[state.status] <= RANK[d.status]) {
    return ctx.db.updateTable('deliveries').set(FINISHED.includes(d.status) ? { last_checked_at: now } : details).where('id', '=', d.id).returningAll().executeTakeFirstOrThrow();
  }
  const to = state.status;
  const extra: Record<string, unknown> = { ...details };
  if (to === 'delivered') {
    extra.delivered_at = now;
    if (state.proof !== undefined && state.proof !== null) extra.proof = json(state.proof);
  }
  if (to === 'failed' || to === 'returned' || to === 'cancelled') {
    extra.failure_reason = state.failureReason ?? to;
    if (state.cancellationFeeCents) extra.cancellation_fee_cents = state.cancellationFeeCents;
  }
  const updated = await setStatus(ctx, d, to, { source, set: extra, raw: hint });
  if (!d.order_id) return updated;

  const cfg = await deliveryConfigAt(ctx, d.venue_id);
  const order = await getOrderForFulfilment(ctx, d.order_id);
  const venue = await getVenue(ctx, d.venue_id);
  const base = { first_name: firstNameOf(order.customerName), venue_name: venue.name, reference: order.reference };

  if (to === 'picked_up') {
    await notifyGuest(ctx, cfg, updated, order, 'delivery.picked_up', { ...base, eta_line: updated.dropoff_eta ? `It should reach you at about ${clockText(updated.dropoff_eta, venue.timezone)}.` : '', tracking_url: updated.tracking_url ?? order.trackingUrl }, 'picked_up');
  } else if (to === 'delivered') {
    await completeOrderByCourier(ctx, d.order_id);
    await track(ctx, deliveryDelivered, { delivery_id: d.id, order_id: d.order_id, minutes_from_request: d.requested_at ? Math.round((now.getTime() - d.requested_at.getTime()) / 60_000) : null }, { venueId: d.venue_id });
    await notifyGuest(ctx, cfg, updated, order, 'delivery.delivered', base, 'delivered');
  } else if (to === 'failed' || to === 'returned' || to === 'cancelled') {
    await deliveryFellThrough(ctx, cfg, updated, order, venue, d.status);
  }
  return updated;
}

/**
 * The courier service cancelled, or the delivery failed or came back. Before the food left, it
 * is the no-courier case (the venue's fallback). After, the venue's refund policy applies, less
 * any cancellation fee when the venue passes those on, and staff are told.
 */
async function deliveryFellThrough(ctx: Ctx, cfg: DeliveryConfig, d: DeliveryRow, order: FulfilmentOrder, venue: Awaited<ReturnType<typeof getVenue>>, from: DeliveryStatus): Promise<void> {
  const collected = from === 'picked_up';
  const reason = d.failure_reason ?? d.status;
  if (!collected && LIVE_ORDER.includes(order.status)) {
    // The courier service gave up before anyone collected the food: the venue's no-courier choice.
    await applyFallback(ctx, d, order, cfg, reason, []);
    return;
  }
  const fee = d.cancellation_fee_cents;
  let refund: 'full' | 'delivery_fee' | 'none' = cfg.failed_delivery_refund;
  let amount: number | undefined;
  if (refund === 'delivery_fee') amount = order.deliveryFeeCents;
  if (refund === 'full' && cfg.cancellation_fee_policy === 'deduct_from_refund' && fee > 0) amount = Math.max(0, order.totalCents - fee);
  if (amount === 0) refund = 'none';
  if (refund !== 'none') await refundForDelivery(ctx, { orderId: order.id, reason: `The delivery ${d.status === 'returned' ? 'was returned' : 'failed'}.`, key: `delivery-failed:${d.id}`, amountCents: amount });
  await flagOrderForStaff(ctx, { orderId: order.id, reason: `The delivery ${d.status}: ${reason}.${fee ? ` The courier charged a ${formatMoney(fee, order.currency)} cancellation fee.` : ''}` });
  await audit(ctx, { action: 'delivery.failed', entityType: 'delivery', entityId: d.id, venueId: d.venue_id, after: { status: d.status, reason, refund, refundCents: amount ?? (refund === 'full' ? order.totalCents : 0), cancellationFeeCents: fee, feePaidBy: cfg.cancellation_fee_policy === 'deduct_from_refund' ? 'guest' : 'venue' } });
  await track(ctx, deliveryFailed, { delivery_id: d.id, order_id: order.id, reason: reason.slice(0, 200), status: d.status, refund }, { venueId: d.venue_id });
  const refundLine =
    refund === 'none'
      ? 'The venue will be in touch about what happens next.'
      : refund === 'delivery_fee'
        ? `The ${formatMoney(amount ?? 0, order.currency)} delivery fee is being refunded to your card.`
        : amount !== undefined
          ? `${formatMoney(amount, order.currency)} is being refunded to your card.`
          : 'Your payment is being refunded in full to your card.';
  await notifyGuest(ctx, cfg, d, order, 'delivery.failed', { first_name: firstNameOf(order.customerName), venue_name: venue.name, reference: order.reference, reason: 'The courier service could not complete the delivery.', refund_line: refundLine }, 'failed');
}
