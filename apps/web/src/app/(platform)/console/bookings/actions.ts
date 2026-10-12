'use server';

import { bookings } from '@ros/modules';
import { act, bool, int, nullableText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

const PATH = '/console/bookings';

/**
 * The book's actions, each the service function the assistant's booking tools are pinned to.
 * The service checks the role (host, front of house, manager, owner) at the booking's venue and
 * that bookings are on there; an id from another venue is not found. The venue for a new booking
 * is the console's selected one, never a form field.
 */
export async function confirmBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.confirmBooking(ctx, { bookingId: text(fd, 'bookingId') }), { success: (b) => `Booking ${b.reference} confirmed. The guest has been told.`, revalidate: PATH });
}

export async function declineBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.declineBooking(ctx, { bookingId: text(fd, 'bookingId'), reason: nullableText(fd, 'reason') }), { success: (b) => `Booking ${b.reference} declined. The guest has been told.`, revalidate: PATH });
}

export async function cancelBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.cancelBooking(ctx, { bookingId: text(fd, 'bookingId'), reason: nullableText(fd, 'reason') }), { success: (b) => `Booking ${b.reference} cancelled. The guest has been told.`, revalidate: PATH });
}

export async function seatBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.seatBooking(ctx, { bookingId: text(fd, 'bookingId') }), { success: (b) => `${b.reference} seated.`, revalidate: PATH });
}

export async function markNoShow(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.markNoShow(ctx, { bookingId: text(fd, 'bookingId') }), { success: (b) => `${b.reference} marked as a no-show.`, revalidate: PATH });
}

export async function completeBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => bookings.completeBooking(ctx, { bookingId: text(fd, 'bookingId') }), { success: (b) => `${b.reference} finished.`, revalidate: PATH });
}

/** A phone booking. Confirmed at once; the guest is told if they gave a contact and the box is ticked. */
export async function addBooking(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    (ctx, c) =>
      bookings.addBooking(ctx, {
        venueId: c.venue.id,
        date: text(fd, 'date'),
        time: text(fd, 'time'),
        partySize: int(fd, 'partySize') ?? 0,
        name: text(fd, 'name'),
        email: nullableText(fd, 'email'),
        phone: nullableText(fd, 'phone'),
        note: nullableText(fd, 'note'),
        overCapacity: bool(fd, 'overCapacity'),
        notifyGuest: bool(fd, 'notifyGuest'),
      }),
    { success: (b) => `Booked: ${b.reference}, ${b.partySize === 1 ? 'one guest' : `${b.partySize} guests`} at ${b.time} on ${b.date}.`, revalidate: PATH },
  );
}
