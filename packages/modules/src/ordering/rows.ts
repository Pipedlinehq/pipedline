import type { Selectable } from 'kysely';
import { type Ctx, type DB, formatMoney, notFound } from '@ros/core';
import type { Adjustment, OrderSnapshot } from './contract';

export type OrderRow = Selectable<DB['orders']>;
export type OrderItemRow = Selectable<DB['order_items']>;
export type PaymentRow = Selectable<DB['payments']>;

export interface FrozenModifier {
  group: string;
  name: string;
  price_delta_cents: number;
}

export const frozenModifiers = (row: Pick<OrderItemRow, 'modifiers'>): FrozenModifier[] => (Array.isArray(row.modifiers) ? (row.modifiers as unknown as FrozenModifier[]) : []);
export const adjustmentsOf = (row: Pick<OrderRow, 'adjustments'>): Adjustment[] => (Array.isArray(row.adjustments) ? (row.adjustments as unknown as Adjustment[]) : []);

/** Load an order in this org. An id from another org is not found (row-level security). */
export async function loadOrder(ctx: Ctx, orderId: string, opts: { lock?: boolean } = {}): Promise<OrderRow> {
  let q = ctx.db.selectFrom('orders').selectAll().where('id', '=', orderId);
  if (opts.lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Order not found');
  return row;
}

export async function loadItems(ctx: Ctx, orderId: string): Promise<OrderItemRow[]> {
  return ctx.db.selectFrom('order_items').selectAll().where('order_id', '=', orderId).orderBy('line_no').execute();
}

/** What other modules are told about an order (ordering/contract.ts). */
export function snapshot(o: OrderRow): OrderSnapshot {
  return {
    id: o.id,
    venueId: o.venue_id,
    customerId: o.customer_id,
    reference: o.reference,
    channel: o.channel,
    status: o.status,
    totalCents: o.total_cents,
    subtotalCents: o.subtotal_cents,
    promisedAt: o.promised_at,
    transactionId: o.transaction_id,
    sessionId: o.session_id,
    flags: o.flags,
  };
}

export function firstName(o: Pick<OrderRow, 'customer_name'>): string {
  return o.customer_name?.trim().split(/\s+/)[0] || 'there';
}

/** One line per item with its choices, for a message. Names only: no markup, no guest notes. */
export function itemSummary(items: OrderItemRow[], currency: string, opts: { prices?: boolean } = {}): string {
  return items
    .map((i) => {
      const mods = frozenModifiers(i).map((m) => m.name);
      const line = `${i.qty} x ${i.name_snapshot}${mods.length ? ` (${mods.join(', ')})` : ''}`;
      return opts.prices === false ? line : `${line}  ${formatMoney(i.line_total_cents, currency)}`;
    })
    .join('\n');
}

export function localClock(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(at);
}

export const CHANNEL_LABEL: Record<OrderRow['channel'], string> = { pickup: 'pickup', delivery: 'delivery', 'dine-in-qr': 'table' };

export function whenLine(o: Pick<OrderRow, 'channel' | 'promised_at' | 'table_label' | 'requested_asap'>, timezone: string): string {
  const at = o.promised_at ? localClock(o.promised_at, timezone) : null;
  if (o.channel === 'dine-in-qr') return o.table_label ? `We will bring it to table ${o.table_label}.` : 'We will bring it over.';
  if (o.channel === 'delivery') return at ? `Estimated to leave the kitchen at ${at}.` : 'We will let you know when it is on its way.';
  return at ? `${o.requested_asap ? 'Ready for pickup at about' : 'Pickup at'} ${at}.` : 'We will let you know when it is ready.';
}
