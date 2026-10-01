import { z } from 'zod';
import { type Ctx, assertModule, requireStaff } from '@ros/core';
import { orderingModule } from './module';
import { loadOrder } from './rows';

/** One refund on an order, for the console's order timeline. Money and words; no card details exist here. */
export interface OrderRefundView {
  id: string;
  amountCents: number;
  /** pending: with the processor. completed: money is on its way back. failed: nothing was taken back. */
  status: 'pending' | 'completed' | 'failed';
  /** Written by staff (a manual refund) or by the system (a rejected or undeliverable order). */
  reason: string;
  failureReason: string | null;
  /** The staff member who sent it. Null for a refund that followed automatically from a rejection, a cancellation or a failed delivery. */
  byStaffName: string | null;
  automatic: boolean;
  requestedAt: Date;
  updatedAt: Date;
}

/**
 * The refunds made on one order, oldest first, including ones the processor refused or has not
 * confirmed yet. Staff at the order's venue. Another org's order, or one at a venue the caller
 * has no role at, is not found.
 */
export async function listOrderRefunds(ctx: Ctx, orderId: string): Promise<OrderRefundView[]> {
  const order = await loadOrder(ctx, z.string().uuid().parse(orderId));
  requireStaff(ctx, { venueId: order.venue_id, minRole: 'read_only' });
  await assertModule(ctx, order.venue_id, orderingModule);
  const rows = await ctx.db
    .selectFrom('refunds as r')
    .leftJoin('staff as s', 's.id', 'r.staff_id')
    .select(['r.id', 'r.amount_cents', 'r.status', 'r.reason', 'r.failure_reason', 'r.staff_id', 'r.created_at', 'r.updated_at', 's.first_name', 's.last_name'])
    .where('r.order_id', '=', order.id)
    .orderBy('r.created_at')
    .orderBy('r.id')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    amountCents: r.amount_cents,
    status: r.status === 'completed' || r.status === 'failed' ? r.status : 'pending',
    reason: r.reason,
    failureReason: r.failure_reason,
    byStaffName: r.staff_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || null : null,
    automatic: r.staff_id === null,
    requestedAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}
