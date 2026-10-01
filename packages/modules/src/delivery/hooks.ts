import type { Ctx } from '@ros/core';
import { json } from '@ros/core';
import { onCustomerErase, onCustomerMerge, registerCustomerDataProvider } from '../identity/index';

/**
 * Delivery's side of the identity spine's hooks. A delivery holds where the guest was and what
 * they wrote for the courier, so it follows a merge, is in their export, and loses the address,
 * the notes and the proof photo when they are erased. The fees and the timeline stay: they are
 * the venue's costs, not the guest's data. The status history holds nothing personal by design.
 */

onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  await ctx.db.updateTable('deliveries').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
});

onCustomerErase(async (ctx, customerId) => {
  await ctx.db
    .updateTable('deliveries')
    .set({ customer_id: null, dropoff_address: json({ erased: true }), dropoff_lat: null, dropoff_lng: null, dropoff_notes: null, proof: null, courier_name: null })
    .where('customer_id', '=', customerId)
    .execute();
});

registerCustomerDataProvider('deliveries', async (ctx: Ctx, customerId: string) => {
  const rows = await ctx.db
    .selectFrom('deliveries')
    .select(['venue_id', 'status', 'dropoff_address', 'dropoff_notes', 'customer_fee_cents', 'requested_at', 'delivered_at', 'created_at'])
    .where('customer_id', '=', customerId)
    .where('order_id', 'is not', null)
    .orderBy('created_at')
    .execute();
  return rows.map((r) => ({
    venueId: r.venue_id,
    status: r.status,
    address: r.dropoff_address,
    notesForCourier: r.dropoff_notes,
    deliveryFeeCents: r.customer_fee_cents,
    requestedAt: r.requested_at,
    deliveredAt: r.delivered_at,
    createdAt: r.created_at,
  }));
});
