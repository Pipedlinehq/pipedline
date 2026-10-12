import { z } from 'zod';
import { type Ctx, GUEST_FACING_ROLES, addMinutes, assertModule, audit, conflict, defineJob, defineSchedule, invalid, notFound, requireStaff, track } from '@ros/core';
import { type BookingView, getBooking } from './bookings';
import { notifyGuest } from './messages';
import { bookingNudged, bookingPurged, bookingsModule } from './module';

/**
 * "Didn't finish" for bookings (docs/COMMERCE_ADMIN_PATTERNS.md section 2.2, pattern 7). The
 * bookings flow records no "started" step, so the unfinished booking is the request the venue
 * never answered inside its window (`request_window_hours`, or the booking's own time if sooner).
 * Detection is `detectAbandonedBookingJob` in bookings.ts. Here: the list, the one nudge, and
 * the three-month purge.
 *
 * The nudge is transactional: one message about the guest's own request, no offer, no consent
 * implied or recorded. The outbox still refuses an address that bounced or complained. A second
 * nudge is refused outright.
 */

const WORKER = { kind: 'worker' as const, job: 'bookings.unfinished' };
const PURGE_AFTER_DAYS = 92;

const requireFrontOfHouse = (ctx: Ctx, venueId: string) => requireStaff(ctx, { venueId, minRole: 'host', anyOf: GUEST_FACING_ROLES });

export const listUnfinishedBookingsInput = z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(100) }).strict();

/** Requests the venue never answered in time, newest first, recovered ones included (they carry the badge). Host, front of house, managers. */
export async function listUnfinishedBookings(ctx: Ctx, raw: z.input<typeof listUnfinishedBookingsInput>): Promise<BookingView[]> {
  const input = listUnfinishedBookingsInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  await assertModule(ctx, input.venueId, bookingsModule);
  const rows = await ctx.db
    .selectFrom('bookings')
    .select('id')
    .where('venue_id', '=', input.venueId)
    .where('abandoned_at', 'is not', null)
    .where('purged_at', 'is', null)
    .orderBy('abandoned_at', 'desc')
    .limit(input.limit)
    .execute();
  const out: BookingView[] = [];
  for (const r of rows) out.push(await getBooking(ctx, { bookingId: r.id }));
  return out;
}

export const bookingNudgeInput = z.object({ bookingId: z.string().uuid() }).strict();

export interface BookingNudgeResult {
  booking: BookingView;
  via: 'email' | 'sms';
  status: 'queued' | 'suppressed';
  reason?: string;
}

/** Everything `nudgeUnfinishedBooking` checks, without sending: the tools ask with it. */
export async function checkBookingNudge(ctx: Ctx, bookingId: string): Promise<BookingView> {
  const b = await getBooking(ctx, { bookingId: z.string().uuid().parse(bookingId) });
  if (!b.abandonedAt || b.purgedAt) throw invalid(`Booking ${b.reference} is not on the "didn't finish" list.`);
  if (b.nudgeSentAt) throw conflict(`The guest has already been sent the one nudge about booking ${b.reference}.`);
  if (b.status !== 'requested') throw conflict(`Booking ${b.reference} is no longer waiting for a yes. There is nothing to nudge about.`);
  if (!b.guestEmail && !b.guestPhone) throw invalid(`Booking ${b.reference} has no email or phone to write to.`);
  return b;
}

/**
 * Send the one nudge about an unanswered booking request. Host, front of house, managers. It
 * tells the guest the request is still waiting, how to reach the venue, and gives their own link
 * to cancel. Audited and tracked; the booking remembers it was sent, so it is never sent twice.
 */
export async function nudgeUnfinishedBooking(ctx: Ctx, raw: z.input<typeof bookingNudgeInput>): Promise<BookingNudgeResult> {
  const input = bookingNudgeInput.parse(raw);
  const b = await checkBookingNudge(ctx, input.bookingId);
  const row = await ctx.db
    .selectFrom('bookings')
    .select(['id', 'venue_id', 'customer_id', 'reference', 'booked_for', 'party_size', 'guest_name', 'guest_email', 'guest_phone'])
    .where('id', '=', b.id)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound('Booking not found');
  const sent = await notifyGuest(ctx, { ...row, status_reason: null }, 'unanswered');
  if (!sent) throw invalid(`Booking ${b.reference} has no email or phone to write to.`);
  const status = sent.status === 'queued' ? 'queued' : `suppressed:${sent.reason ?? 'suppressed'}`.slice(0, 60);
  await ctx.db.updateTable('bookings').set({ nudge_sent_at: ctx.now(), nudge_message_id: sent.messageId, nudge_status: status, updated_at: ctx.now() }).where('id', '=', b.id).execute();
  await audit(ctx, { action: 'bookings.nudge_sent', entityType: 'booking', entityId: b.id, venueId: b.venueId, after: { reference: b.reference, via: sent.via, status } });
  await track(ctx, bookingNudged, { booking_id: b.id, via: sent.via, status: sent.status }, { venueId: b.venueId, customerId: row.customer_id });
  return { booking: await getBooking(ctx, { bookingId: b.id }), via: sent.via, status: sent.status, reason: sent.reason };
}

/**
 * Three months after a request was marked unanswered, if it was never confirmed, the guest's
 * details are removed and it leaves the list. The row stays (its history is append-only), with
 * nothing personal on it, the way an erased guest's booking does. Daily, per org.
 */
export const purgeUnfinishedBookingsJob = defineJob({
  kind: 'bookings.purge_unfinished',
  schema: z.object({ bucket: z.string().optional() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (!job.orgId) throw new Error('bookings.purge_unfinished needs an org');
    await app.tenant(job.orgId, WORKER, async (ctx) => {
      const cutoff = addMinutes(ctx.now(), -PURGE_AFTER_DAYS * 24 * 60);
      const stale = await ctx.db
        .selectFrom('bookings')
        .select(['id', 'venue_id', 'reference'])
        .where('abandoned_at', '<', cutoff)
        .where('purged_at', 'is', null)
        .where('recovered_at', 'is', null)
        .where('status', 'in', ['requested', 'declined', 'cancelled'])
        .limit(500)
        .execute();
      for (const b of stale) {
        await ctx.db
          .updateTable('bookings')
          .set({ customer_id: null, guest_name: null, guest_email: null, guest_phone: null, guest_note: null, staff_note: null, purged_at: ctx.now(), updated_at: ctx.now() })
          .where('id', '=', b.id)
          .execute();
        await audit(ctx, { action: 'bookings.unfinished_purged', entityType: 'booking', entityId: b.id, venueId: b.venue_id, after: { reference: b.reference } });
        await track(ctx, bookingPurged, { booking_id: b.id }, { venueId: b.venue_id });
      }
    });
  },
});

export const purgeUnfinishedBookingsSchedule = defineSchedule({
  key: 'bookings.purge_unfinished',
  everyMinutes: 24 * 60,
  scope: 'org',
  job: purgeUnfinishedBookingsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  // Platform scheduler: asked outside any tenant, only "does this org have anything to purge".
  async appliesTo(app, orgId) {
    const row = await app.db.selectFrom('bookings').select('id').where('org_id', '=', orgId).where('abandoned_at', 'is not', null).where('purged_at', 'is', null).limit(1).executeTakeFirst();
    return !!row;
  },
});
