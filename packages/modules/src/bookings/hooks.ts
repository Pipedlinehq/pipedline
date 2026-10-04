import type { Ctx } from '@ros/core';
import { onCustomerErase, onCustomerMerge, registerCustomerDataProvider } from '../identity/index';

/**
 * Bookings' side of the identity spine's hooks: a booking names the guest and carries what they
 * (or staff, for them) wrote, so it follows a merge, appears in the guest's export, and loses
 * everything personal when the guest is erased. The booking itself stays: its covers are the
 * venue's history.
 */

onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  await ctx.db.updateTable('bookings').set({ customer_id: winnerId }).where('customer_id', '=', loserId).execute();
});

onCustomerErase(async (ctx, customerId) => {
  await ctx.db
    .updateTable('bookings')
    .set({ customer_id: null, guest_name: null, guest_email: null, guest_phone: null, guest_note: null, staff_note: null })
    .where('customer_id', '=', customerId)
    .execute();
});

registerCustomerDataProvider('bookings', async (ctx: Ctx, customerId: string) => {
  const rows = await ctx.db
    .selectFrom('bookings')
    .select(['reference', 'venue_id', 'booked_for', 'party_size', 'status', 'source', 'guest_name', 'guest_email', 'guest_phone', 'guest_note', 'created_at'])
    .where('customer_id', '=', customerId)
    .orderBy('booked_for')
    .execute();
  return rows.map((b) => ({
    reference: b.reference,
    venueId: b.venue_id,
    bookedFor: b.booked_for,
    partySize: b.party_size,
    status: b.status,
    source: b.source,
    name: b.guest_name,
    email: b.guest_email,
    phone: b.guest_phone,
    note: b.guest_note,
    madeAt: b.created_at,
  }));
});
