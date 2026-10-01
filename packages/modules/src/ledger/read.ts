import { type Ctx, notFound, requireStaff, visibleVenueIds } from '@ros/core';

export interface TransactionSummary {
  id: string;
  venueId: string;
  occurredAt: Date;
  source: string;
  channel: string;
  status: string;
  totalCents: number;
  refundedCents: number;
  customerId: string | null;
  tenderType: string | null;
}

export interface TransactionFilter {
  venueId?: string;
  from?: Date;
  to?: Date;
  customerId?: string;
  limit?: number;
  /** occurred_at of the last row of the previous page. */
  before?: Date;
}

export async function listTransactions(ctx: Ctx, filter: TransactionFilter = {}): Promise<TransactionSummary[]> {
  requireStaff(ctx, { venueId: filter.venueId, minRole: 'read_only' });
  const visible = visibleVenueIds(ctx);
  let q = ctx.db
    .selectFrom('transactions')
    .select(['id', 'venue_id', 'occurred_at', 'source', 'channel', 'status', 'total_cents', 'refunded_cents', 'customer_id', 'tender_type'])
    .orderBy('occurred_at', 'desc')
    .limit(Math.min(filter.limit ?? 50, 200));
  if (filter.venueId) q = q.where('venue_id', '=', filter.venueId);
  else if (visible) {
    if (!visible.length) return [];
    q = q.where('venue_id', 'in', visible);
  }
  if (filter.from) q = q.where('occurred_at', '>=', filter.from);
  if (filter.to) q = q.where('occurred_at', '<', filter.to);
  if (filter.before) q = q.where('occurred_at', '<', filter.before);
  if (filter.customerId) q = q.where('customer_id', '=', filter.customerId);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    occurredAt: r.occurred_at,
    source: r.source,
    channel: r.channel,
    status: r.status,
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    customerId: r.customer_id,
    tenderType: r.tender_type,
  }));
}

export interface TransactionDetail extends TransactionSummary {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  tipCents: number;
  currency: string;
  tableLabel: string | null;
  orderId: string | null;
  lines: Array<{
    lineNo: number;
    name: string;
    category: string | null;
    qty: number;
    unitPriceCents: number;
    modifiers: unknown;
    totalCents: number;
    menuItemId: string | null;
  }>;
}

export async function getTransaction(ctx: Ctx, id: string): Promise<TransactionDetail> {
  const r = await ctx.db.selectFrom('transactions').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw notFound('Transaction not found');
  requireStaff(ctx, { venueId: r.venue_id, minRole: 'read_only' });
  const lines = await ctx.db.selectFrom('transaction_lines').selectAll().where('transaction_id', '=', id).orderBy('line_no').execute();
  return {
    id: r.id,
    venueId: r.venue_id,
    occurredAt: r.occurred_at,
    source: r.source,
    channel: r.channel,
    status: r.status,
    totalCents: r.total_cents,
    refundedCents: r.refunded_cents,
    customerId: r.customer_id,
    tenderType: r.tender_type,
    subtotalCents: r.subtotal_cents,
    discountCents: r.discount_cents,
    taxCents: r.tax_cents,
    tipCents: r.tip_cents,
    currency: r.currency,
    tableLabel: r.table_label,
    orderId: r.order_id,
    lines: lines.map((l) => ({
      lineNo: l.line_no,
      name: l.name_snapshot,
      category: l.category_snapshot,
      qty: l.qty,
      unitPriceCents: l.unit_price_cents,
      modifiers: l.modifiers,
      totalCents: l.total_cents,
      menuItemId: l.menu_item_id,
    })),
  };
}
