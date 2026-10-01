import type { Ctx } from '@ros/core';
import { onCustomerErase, onCustomerMerge, registerCustomerDataProvider } from '../identity/index';

/**
 * Ordering's side of the identity spine's hooks: orders name a customer and carry what the
 * guest typed at checkout, so they follow a merge, appear in the guest's export, and lose
 * everything personal when the guest is erased. The ledger rows are the venue's sales and stay.
 */

onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  await ctx.db.updateTable('orders').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
});

onCustomerErase(async (ctx, customerId) => {
  const orders = await ctx.db.selectFrom('orders').select('id').where('customer_id', '=', customerId).execute();
  if (!orders.length) return;
  const ids = orders.map((o) => o.id);
  // The order stays as a sale; who placed it and what they wrote does not.
  await ctx.db
    .updateTable('orders')
    .set({ customer_id: null, customer_name: null, customer_email: null, customer_phone: null, customer_note: null, session_id: null })
    .where('id', 'in', ids)
    .execute();
  await ctx.db.updateTable('order_items').set({ note: null }).where('order_id', 'in', ids).execute();
  await ctx.db.updateTable('kitchen_tickets').set({ guest_name: null, notes: null }).where('order_id', 'in', ids).execute();
});

registerCustomerDataProvider('orders', async (ctx: Ctx, customerId: string) => {
  const orders = await ctx.db
    .selectFrom('orders')
    .select(['id', 'reference', 'venue_id', 'channel', 'status', 'payment_status', 'created_at', 'promised_at', 'table_label', 'total_cents', 'currency', 'customer_name', 'customer_email', 'customer_phone', 'customer_note'])
    .where('customer_id', '=', customerId)
    .orderBy('created_at')
    .execute();
  if (!orders.length) return [];
  const items = await ctx.db.selectFrom('order_items').select(['order_id', 'name_snapshot', 'qty', 'line_total_cents', 'note']).where('order_id', 'in', orders.map((o) => o.id)).orderBy('line_no').execute();
  return orders.map((o) => ({
    reference: o.reference,
    venueId: o.venue_id,
    channel: o.channel,
    status: o.status,
    paymentStatus: o.payment_status,
    placedAt: o.created_at,
    promisedAt: o.promised_at,
    tableLabel: o.table_label,
    totalCents: o.total_cents,
    currency: o.currency,
    name: o.customer_name,
    email: o.customer_email,
    phone: o.customer_phone,
    note: o.customer_note,
    items: items.filter((i) => i.order_id === o.id).map((i) => ({ name: i.name_snapshot, qty: i.qty, totalCents: i.line_total_cents, note: i.note })),
  }));
});
