import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { bookings } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { app } from '@/lib/runtime';
import { BOOKING_SOURCE, BookingSourceBadge, BookingStatusBadge, NoShowCount, bookingNudgeWords, covers } from '@/components/console/booking-bits';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { NotHere } from '@/components/console/not-here';
import { Facts, ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { Timeline, type TimelineStep } from '@/components/console/timeline';
import { Badge, Card, GuestText, LinkButton, PageHeader, dateTime, dayLabel } from '@/ui';
import { cancelBooking, completeBooking, confirmBooking, declineBooking, markNoShow, nudgeBooking, seatBooking } from '../actions';

export const metadata = { title: 'Booking · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One booking (docs/CONSOLE_IA.md section 9, wave 1): what was booked, who by, the host's actions,
 * and the timeline with the team's notes. Hosts, front of house and managers; the service answers
 * another venue's or org's id as not found.
 */
export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return <NotHere back="/console/bookings" label="Back to the book" />;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('bookings'))) return <ModuleOff title="Booking" what="Table bookings" canManage={manager} />;
  if (!manager && !GUEST_FACING_ROLES.includes(c.role)) return <NotForYourRole title="Booking">The book holds guests' names and contact details, so it is for hosts, front of house and managers.</NotForYourRole>;
  const r = await read((ctx) => bookings.getBooking(ctx, { bookingId: id }));
  if (!r.ok) {
    if (r.code === 'not_found' || r.code === 'module_disabled') return <NotHere back="/console/bookings" label="Back to the book" />;
    return (
      <>
        <PageHeader title="Booking" />
        <ReadError message={r.error} />
      </>
    );
  }
  const b = r.data;
  const venue = c.venues.find((v) => v.id === b.venueId) ?? c.venue;
  const tz = venue.timezone;
  const now = app().clock();
  const unfinished = !!b.abandonedAt && !b.purgedAt;
  const canNudge = unfinished && b.status === 'requested' && !b.nudgeSentAt && !b.recoveredAt && (b.guestEmail || b.guestPhone);
  const steps: TimelineStep[] = [
    { kind: 'step', label: `${b.source === 'phone' || b.source === 'staff' ? 'Booked by staff' : b.status === 'requested' || b.abandonedAt ? 'Requested by the guest' : 'Booked by the guest'} (${BOOKING_SOURCE[b.source] ?? b.source})`, at: b.createdAt },
    ...(b.remindedAt ? [{ kind: 'step', label: 'Reminder sent', at: b.remindedAt }] : []),
    ...(b.abandonedAt ? [{ kind: 'unfinished', label: "Counted as didn't finish: no answer inside the window", at: b.abandonedAt }] : []),
    ...(b.nudgeSentAt ? [{ kind: 'nudge', label: b.nudgeStatus?.startsWith('suppressed') ? 'Nudge not sent (address blocked)' : 'Nudge sent to the guest', at: b.nudgeSentAt }] : []),
    ...(b.recoveredAt ? [{ kind: 'recovered', label: 'Recovered: confirmed after all', at: b.recoveredAt }] : []),
    ...(b.purgedAt ? [{ kind: 'purged', label: "Guest's details removed (three months unanswered)", at: b.purgedAt }] : []),
  ];

  return (
    <>
      <PageHeader
        eyebrow="Bookings"
        title={`Booking ${b.reference}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2" data-testid="booking-badges">
            <BookingStatusBadge status={b.status} />
            <BookingSourceBadge source={b.source} />
            {b.overCapacity ? <Badge tone="warn">Over capacity</Badge> : null}
            {b.recoveredAt ? <Badge tone="good">Recovered</Badge> : unfinished ? <Badge tone="warn">Didn&apos;t finish</Badge> : null}
            {b.noShowCount > 0 ? <NoShowCount count={b.noShowCount} /> : null}
            <span>
              {covers(b.partySize)} at {b.time}, {dayLabel(b.date)} {b.date.slice(0, 4)} · {b.serviceName} at {venue.name}
            </span>
          </span>
        }
        actions={<LinkButton href={`/console/bookings?f=1&date=${b.date}`}>That day in the book</LinkButton>}
      />

      <div className="mb-6 flex flex-wrap items-start gap-2" aria-label="Booking actions">
        {b.status === 'requested' ? (
          <>
            <InlineAction action={confirmBooking} hidden={{ bookingId: b.id }} label="Confirm" variant="primary" testId="confirm" />
            <ConfirmAction trigger="Decline" title={`Decline ${b.reference}?`} action={declineBooking} hidden={{ bookingId: b.id }} confirmLabel="Decline" reason={{ label: 'Tell the guest why (optional)', required: false, minLength: 0 }} testId="decline">
              <p>
                The request for {covers(b.partySize)} at {b.time} is turned down and the guest is told. The covers stay free.
              </p>
            </ConfirmAction>
          </>
        ) : null}
        {b.status === 'confirmed' || b.status === 'no_show' ? <InlineAction action={seatBooking} hidden={{ bookingId: b.id }} label="Seat" variant="primary" testId="seat" /> : null}
        {b.status === 'confirmed' && b.startsAt <= now ? <InlineAction action={markNoShow} hidden={{ bookingId: b.id }} label="No-show" testId="noshow" /> : null}
        {b.status === 'seated' || b.status === 'confirmed' ? <InlineAction action={completeBooking} hidden={{ bookingId: b.id }} label="Finish" testId="finish" /> : null}
        {b.status === 'requested' || b.status === 'confirmed' ? (
          <ConfirmAction trigger="Cancel" title={`Cancel ${b.reference}?`} action={cancelBooking} hidden={{ bookingId: b.id }} confirmLabel="Cancel the booking" reason={{ label: 'Tell the guest why (optional)', required: false, minLength: 0 }} testId="cancel">
            <p>
              {covers(b.partySize)} at {b.time} on {dayLabel(b.date)} is cancelled for the guest and they are told. The covers go back at once.
            </p>
          </ConfirmAction>
        ) : null}
        {canNudge ? (
          <ConfirmAction trigger="Send a nudge" title={`Nudge the guest about ${b.reference}?`} action={nudgeBooking} hidden={{ bookingId: b.id }} confirmLabel="Send the nudge" variant="primary" testId="nudge">
            <p>
              One message goes to the guest by {b.guestEmail ? 'email' : 'text message'}: their request for {covers(b.partySize)} at {b.time} on {dayLabel(b.date)} is still waiting, how to reach the venue, and their own link to cancel. It is the only nudge they will get.
            </p>
          </ConfirmAction>
        ) : null}
      </div>
      {unfinished ? (
        <Card title="Didn't finish" description="The venue did not answer this request inside its window.">
          <Facts
            items={[
              ['Counted as unfinished', dateTime(b.abandonedAt!, tz)],
              ['Email status', bookingNudgeWords(b)],
              ['Recovery status', b.recoveredAt ? `Recovered ${dateTime(b.recoveredAt, tz)}` : 'Not recovered'],
            ]}
          />
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Guest">
            <Facts
              items={[
                ['Name', <GuestText key="n">{b.guestName}</GuestText>],
                ['Phone', b.guestPhone ?? '–'],
                ['Email', b.guestEmail ?? '–'],
                ['Came from', BOOKING_SOURCE[b.source] ?? b.source],
              ]}
            />
            {b.guestNote ? (
              <p className="mt-4 text-sm">
                From the guest: <GuestText>{b.guestNote}</GuestText>
              </p>
            ) : null}
            {b.staffNote ? <p className="mt-2 text-sm text-ink-2">For the floor: {b.staffNote}</p> : null}
            {b.statusReason ? <p className="mt-2 text-sm text-ink-3">Reason given: {b.statusReason}</p> : null}
            {b.customerId ? (
              <p className="mt-3 text-sm">
                <Link href={`/console/customers/${b.customerId}`} className="text-accent underline-offset-2 hover:underline">
                  Open guest record
                </Link>
              </p>
            ) : null}
          </Card>
          <Timeline entityType="booking" entityId={b.id} venueId={b.venueId} steps={steps} testId="booking-timeline" description="What happened to this booking and the team's notes, newest first." />
        </div>
        <div className="space-y-6">
          <Card title="Sitting">
            <Facts
              items={[
                ['Arrives', dateTime(b.startsAt, tz)],
                ['Table back by', dateTime(b.endsAt, tz, { date: false })],
                ['Service', b.serviceName],
                ['Guests', String(b.partySize)],
                ['Sitting', `${b.durationMinutes} minutes`],
                ['Made', dateTime(b.createdAt, tz)],
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
