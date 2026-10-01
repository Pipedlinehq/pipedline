import type { Selectable } from 'kysely';
import { type Ctx, type ConnectionRow, type CourierStatus, type DB, getModule, json, notFound, track } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import type { FulfilmentOrder } from '../ordering/fulfilment';
import { type DeliveryConfig, deliveryModule, deliveryStatusChanged } from './module';

export type DeliveryRow = Selectable<DB['deliveries']>;
export type DeliveryStatus = DeliveryRow['status'];

export const WORKER = { kind: 'worker' as const, job: 'delivery' };

/** Statuses a delivery can still move on from. */
export const IN_FLIGHT: DeliveryStatus[] = ['requested', 'courier_assigned', 'picked_up'];
export const FINISHED: DeliveryStatus[] = ['delivered', 'failed', 'returned', 'cancelled'];

/** How far along a delivery is. A report of an earlier stage than we hold is late news, never a step back. */
export const RANK: Record<DeliveryStatus, number> = { quoted: 0, requested: 1, courier_assigned: 2, picked_up: 3, delivered: 4, failed: 4, returned: 4, cancelled: 4 };

export async function loadDelivery(ctx: Ctx, deliveryId: string, opts: { lock?: boolean } = {}): Promise<DeliveryRow> {
  let q = ctx.db.selectFrom('deliveries').selectAll().where('id', '=', deliveryId);
  if (opts.lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Delivery not found');
  return row;
}

export async function deliveryForOrder(ctx: Ctx, orderId: string, opts: { lock?: boolean } = {}): Promise<DeliveryRow | null> {
  let q = ctx.db.selectFrom('deliveries').selectAll().where('order_id', '=', orderId).orderBy('created_at', 'desc');
  if (opts.lock) q = q.forUpdate();
  return (await q.executeTakeFirst()) ?? null;
}

export async function deliveryConfigAt(ctx: Ctx, venueId: string): Promise<DeliveryConfig> {
  return (await getModule(ctx, venueId, deliveryModule)).config;
}

/**
 * Move a delivery's status and keep its history. What is kept of the provider's payload is
 * minimal on purpose: the history is append-only, so nothing personal may go in it.
 */
export async function setStatus(
  ctx: Ctx,
  d: DeliveryRow,
  to: DeliveryStatus,
  args: { source: 'webhook' | 'reconcile' | 'dispatch' | 'venue'; set?: Partial<Record<string, unknown>>; raw?: Record<string, unknown> | null },
): Promise<DeliveryRow> {
  const updated = await ctx.db
    .updateTable('deliveries')
    .set({ ...(args.set ?? {}), status: to } as never)
    .where('id', '=', d.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  if (d.status !== to) {
    await ctx.db
      .insertInto('delivery_status_history')
      .values({ org_id: ctx.orgId, delivery_id: d.id, from_status: d.status, to_status: to, at: ctx.now(), source: args.source, raw: args.raw ? json(args.raw) : null })
      .execute();
    await track(ctx, deliveryStatusChanged, { delivery_id: d.id, order_id: d.order_id, from: d.status, to, source: args.source }, { venueId: d.venue_id });
  }
  return updated;
}

/** The courier connections for a venue, in the venue's order of preference. A venue's own connection wins over the org's. */
export async function courierConnections(ctx: Ctx, venueId: string, providers: string[]): Promise<Array<{ provider: string; conn: ConnectionRow }>> {
  if (!providers.length) return [];
  const rows = await ctx.db
    .selectFrom('connections')
    .select(['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'])
    .where('plug_key', 'in', providers)
    .where('status', '=', 'connected')
    .where((eb) => eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]))
    .execute();
  const out: Array<{ provider: string; conn: ConnectionRow }> = [];
  for (const p of providers) {
    const conn = rows.find((r) => r.plug_key === p && r.venue_id === venueId) ?? rows.find((r) => r.plug_key === p);
    if (conn) out.push({ provider: p, conn });
  }
  return out;
}

type DeliveryTemplate = 'delivery.dispatched' | 'delivery.picked_up' | 'delivery.delivered' | 'delivery.failed' | 'delivery.no_courier_pickup';

/** A delivery update to the guest, on the venue's tracking channel. Once per delivery per `what`. Transactional. */
export async function notifyGuest(ctx: Ctx, cfg: DeliveryConfig, d: DeliveryRow, order: FulfilmentOrder, template: DeliveryTemplate, variables: Record<string, unknown>, what: string): Promise<void> {
  if (cfg.tracking_channel === 'none') return;
  const email = order.customerEmail;
  const phone = order.customerPhone;
  const channel =
    cfg.tracking_channel === 'email' ? (email ? 'email' : null) : cfg.tracking_channel === 'sms' ? (phone ? 'sms' : email ? 'email' : null) : email ? 'email' : phone ? 'sms' : null;
  if (!channel) return;
  await queueMessage(ctx, {
    templateKey: template,
    channel,
    idempotencyKey: `delivery:${d.id}:${what}`,
    variables,
    customerId: order.customerId,
    to: channel === 'email' ? email : phone,
    venueId: d.venue_id,
  });
}

export const firstNameOf = (name: string | null) => name?.trim().split(/\s+/)[0] || 'there';

export function clockText(at: Date | null, timezone: string): string {
  if (!at) return 'soon';
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
}

export function isCourierStatus(s: string): s is CourierStatus {
  return ['requested', 'courier_assigned', 'picked_up', 'delivered', 'failed', 'returned', 'cancelled'].includes(s);
}
