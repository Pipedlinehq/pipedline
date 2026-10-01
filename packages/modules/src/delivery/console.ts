import { z } from 'zod';
import { type Ctx, assertModule, getModule, invalid, isInternal, notFound, rateLimit, requireStaff, setModule } from '@ros/core';
import { orderByTrackingToken } from '../ordering/fulfilment';
import { type DeliveryConfig, deliveryModule } from './module';
import { type DeliveryRow, type DeliveryStatus, deliveryForOrder, loadDelivery } from './rows';

// ── Settings ─────────────────────────────────────────────────────────────────

export interface DeliverySettings {
  venueId: string;
  enabled: boolean;
  config: DeliveryConfig;
}

export async function getDeliverySettings(ctx: Ctx, venueId: string): Promise<DeliverySettings> {
  const id = z.string().uuid().parse(venueId);
  requireStaff(ctx, { venueId: id, minRole: 'read_only' });
  const state = await getModule(ctx, id, deliveryModule);
  return { venueId: id, enabled: state.enabled, config: state.config };
}

export const deliverySettingsInput = z.object({
  venueId: z.string().uuid(),
  /** The module switch. Off: delivery does not exist at the venue; zones and history are kept. */
  enabled: z.boolean().optional(),
  /** Only the keys being changed. Merged over what is stored and validated whole (a partial schema would fill in defaults). */
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Change a venue's delivery settings. A manager. Validated whole against the schema and audited (core setModule). */
export async function updateDeliverySettings(ctx: Ctx, raw: z.input<typeof deliverySettingsInput>): Promise<DeliverySettings> {
  const parsed = deliverySettingsInput.safeParse(raw);
  if (!parsed.success) throw invalid('That setting is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const state = await setModule(ctx, deliveryModule, { venueId: input.venueId, enabled: input.enabled, config: input.config as Partial<DeliveryConfig> | undefined });
  return { venueId: input.venueId, enabled: state.enabled, config: state.config };
}

// ── The console's view of deliveries: the support path ───────────────────────

export interface DeliveryView {
  id: string;
  venueId: string;
  orderId: string | null;
  provider: string;
  status: DeliveryStatus;
  /** What the venue pays the courier, and what the guest paid for delivery. */
  courierFeeCents: number;
  customerFeeCents: number;
  cancellationFeeCents: number;
  trackingUrl: string | null;
  pickupEta: Date | null;
  dropoffEta: Date | null;
  courierName: string | null;
  /** Suburb and postcode only on lists; the full address on the single view. */
  dropoffArea: string;
  dropoffAddress: Record<string, unknown> | null;
  /** Guest-written, for the courier. Text, never markup. */
  dropoffNotes: string | null;
  /** Photo, signature or PIN as the provider returned it. */
  proof: unknown;
  failureReason: string | null;
  requestAt: Date | null;
  requestedAt: Date | null;
  deliveredAt: Date | null;
  attemptedProviders: string[];
  createdAt: Date;
  timeline: Array<{ from: DeliveryStatus | null; to: DeliveryStatus; at: Date; source: string }>;
}

const area = (d: DeliveryRow) => {
  const a = (d.dropoff_address ?? {}) as { suburb?: string; postcode?: string };
  return [a.suburb, a.postcode].filter(Boolean).join(' ');
};

function view(d: DeliveryRow, full: boolean, timeline: DeliveryView['timeline']): DeliveryView {
  return {
    id: d.id,
    venueId: d.venue_id,
    orderId: d.order_id,
    provider: d.provider,
    status: d.status,
    courierFeeCents: d.courier_fee_cents,
    customerFeeCents: d.customer_fee_cents,
    cancellationFeeCents: d.cancellation_fee_cents,
    trackingUrl: d.tracking_url,
    pickupEta: d.pickup_eta,
    dropoffEta: d.dropoff_eta,
    courierName: d.courier_name,
    dropoffArea: area(d),
    dropoffAddress: full ? ((d.dropoff_address ?? null) as Record<string, unknown> | null) : null,
    dropoffNotes: full ? d.dropoff_notes : null,
    proof: full ? d.proof : null,
    failureReason: d.failure_reason,
    requestAt: d.request_at,
    requestedAt: d.requested_at,
    deliveredAt: d.delivered_at,
    attemptedProviders: d.attempted_providers,
    createdAt: d.created_at,
    timeline,
  };
}

async function timelineOf(ctx: Ctx, deliveryId: string): Promise<DeliveryView['timeline']> {
  const rows = await ctx.db.selectFrom('delivery_status_history').select(['from_status', 'to_status', 'at', 'source']).where('delivery_id', '=', deliveryId).orderBy('at').execute();
  return rows.map((r) => ({ from: r.from_status, to: r.to_status, at: r.at, source: r.source }));
}

/** One delivery with its timeline and proof, for "where is my food". Staff at the venue who deal with guests, or managers. Another org's id: not found. */
export async function getDelivery(ctx: Ctx, deliveryId: string): Promise<DeliveryView> {
  const d = await loadDelivery(ctx, z.string().uuid().parse(deliveryId));
  requireStaff(ctx, { venueId: d.venue_id, minRole: 'kitchen', anyOf: ['front_of_house', 'host', 'kitchen'] });
  await assertModule(ctx, d.venue_id, deliveryModule);
  return view(d, true, await timelineOf(ctx, d.id));
}

/** The delivery for an order, for the order screen in the console. */
export async function getDeliveryForOrder(ctx: Ctx, orderId: string): Promise<DeliveryView | null> {
  const d = await deliveryForOrder(ctx, z.string().uuid().parse(orderId));
  if (!d) return null;
  return getDelivery(ctx, d.id);
}

export const listDeliveriesInput = z.object({
  venueId: z.string().uuid(),
  statuses: z.array(z.enum(['quoted', 'requested', 'courier_assigned', 'picked_up', 'delivered', 'failed', 'returned', 'cancelled'])).max(8).optional(),
  /** Quotes that never became an order are left out unless asked for by status. */
  limit: z.number().int().min(1).max(200).default(50),
  before: z.date().optional(),
});

export async function listDeliveries(ctx: Ctx, raw: z.input<typeof listDeliveriesInput>): Promise<DeliveryView[]> {
  const input = listDeliveriesInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  await assertModule(ctx, input.venueId, deliveryModule);
  let q = ctx.db.selectFrom('deliveries').selectAll().where('venue_id', '=', input.venueId).orderBy('created_at', 'desc').limit(input.limit);
  q = input.statuses?.length ? q.where('status', 'in', input.statuses) : q.where('order_id', 'is not', null);
  if (input.before) q = q.where('created_at', '<', input.before);
  return (await q.execute()).map((d) => view(d, false, []));
}

// ── The guest's tracking page ────────────────────────────────────────────────

export interface DeliveryTracking {
  status: DeliveryStatus;
  /** Plain words for the status. */
  label: string;
  trackingUrl: string | null;
  pickupEta: Date | null;
  dropoffEta: Date | null;
  courierFirstName: string | null;
  deliveredAt: Date | null;
  steps: Array<{ status: DeliveryStatus; at: Date }>;
}

const LABEL: Record<DeliveryStatus, string> = {
  quoted: 'Waiting for the kitchen',
  requested: 'Finding a courier',
  courier_assigned: 'A courier is on the way to the venue',
  picked_up: 'On its way to you',
  delivered: 'Delivered',
  failed: 'Could not be delivered',
  returned: 'Returned to the venue',
  cancelled: 'Cancelled',
};

/**
 * The delivery half of the guest's tracking page, by the order's unguessable token. Public:
 * holding the token is the permission. No address, no contact details. Rate-limited per address.
 */
export async function getDeliveryTracking(ctx: Ctx, trackingToken: string): Promise<DeliveryTracking | null> {
  if (!isInternal(ctx) && ctx.ip) await rateLimit(ctx.app, `track:ip:${ctx.ip}`, { limit: 120, windowSeconds: 600 }, 'Too many requests from this device. Try again shortly.');
  const { orderId, venueId } = await orderByTrackingToken(ctx, trackingToken);
  await assertModule(ctx, venueId, deliveryModule);
  const d = await deliveryForOrder(ctx, orderId);
  if (!d) return null;
  if (!d.order_id) throw notFound('Order not found');
  const steps = (await timelineOf(ctx, d.id)).map((s) => ({ status: s.to, at: s.at }));
  return {
    status: d.status,
    label: LABEL[d.status],
    trackingUrl: d.tracking_url,
    pickupEta: d.pickup_eta,
    dropoffEta: d.dropoff_eta,
    courierFirstName: d.courier_name?.trim().split(/\s+/)[0] ?? null,
    deliveredAt: d.delivered_at,
    steps,
  };
}
