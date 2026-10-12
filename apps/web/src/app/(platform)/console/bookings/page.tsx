import Link from 'next/link';
import { GUEST_FACING_ROLES, addDays, localDate } from '@ros/core';
import { bookings } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { app } from '@/lib/runtime';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { BOOKING_SOURCE, BookingStatusBadge, covers } from '@/components/console/booking-bits';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, Checkbox, Dialog, EmptyState, Field, GuestText, Input, LinkButton, PageHeader, SubmitButton, Table, Td, Textarea, Th, dayLabel, timeOnly } from '@/ui';
import { addBooking, cancelBooking, completeBooking, confirmBooking, declineBooking, markNoShow, seatBooking } from './actions';

export const metadata = { title: 'Bookings · Pipedline' };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The book (docs/CONSOLE_IA.md section 1, Bookings): one venue-local day at a time, covers per
 * service against the cap, every booking in time order, and the host's actions on each. Hosts,
 * front of house, managers and owners; the service refuses kitchen and read-only roles, so the
 * screen says so too. Guest-written text (names, notes) is rendered as text.
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('bookings'))) return <ModuleOff title="Bookings" what="Table bookings" canManage={manager} />;
  if (!manager && !GUEST_FACING_ROLES.includes(c.role)) return <NotForYourRole title="Bookings">The book holds guests' names and contact details, so it is for hosts, front of house and managers.</NotForYourRole>;

  const tz = c.venue.timezone;
  const today = localDate(app().clock(), tz);
  const date = ISO.test(one(sp.date)) ? one(sp.date) : today;
  const service = one(sp.service) || undefined;
  const showAll = one(sp.show) === 'all';
  const day = await read((ctx) => bookings.listBookings(ctx, { venueId: c.venue.id, date, service, show: showAll ? 'all' : 'active' }));

  const link = (d: string, extra: Record<string, string | undefined> = {}) => {
    const q = new URLSearchParams({ date: d });
    const s = 'service' in extra ? extra.service : service;
    if (s) q.set('service', s);
    if ('show' in extra ? extra.show === 'all' : showAll) q.set('show', 'all');
    return `/console/bookings?${q.toString()}`;
  };
  const weekday = WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const dateWords = date === today ? `Today, ${weekday} ${dayLabel(date)}` : date === addDays(today, 1) ? `Tomorrow, ${weekday} ${dayLabel(date)}` : `${weekday} ${dayLabel(date)} ${date.slice(0, 4)}`;

  return (
    <>
      <PageHeader
        eyebrow="Bookings"
        title={dateWords}
        description={`The book at ${c.venue.name}. Covers are guests; each service has a cap from the booking rules.`}
        actions={
          <>
            <Dialog trigger="Add a booking" title="Take a booking by phone" triggerVariant="primary">
              <ActionForm action={addBooking} className="space-y-4" resetOnSuccess>
                <p className="text-sm text-ink-2">Confirmed straight away. Any time inside a service works, not only the times guests see; the caps still apply unless you book over them.</p>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Date">
                    <Input name="date" type="date" defaultValue={date} required />
                  </Field>
                  <Field label="Time" hint="24-hour, e.g. 19:15">
                    <Input name="time" type="time" required step={300} />
                  </Field>
                  <Field label="Guests">
                    <Input name="partySize" type="number" min={1} max={500} defaultValue={2} required />
                  </Field>
                  <Field label="Name the booking is under">
                    <Input name="name" required maxLength={100} />
                  </Field>
                  <Field label="Phone" hint="Optional">
                    <Input name="phone" type="tel" maxLength={30} />
                  </Field>
                  <Field label="Email" hint="Optional">
                    <Input name="email" type="email" maxLength={254} />
                  </Field>
                </div>
                <Field label="Note for the floor" hint="Not shown to the guest.">
                  <Textarea name="note" maxLength={500} className="min-h-16" />
                </Field>
                <Checkbox name="notifyGuest" defaultChecked label="Send the guest a confirmation" hint="Only if they gave a phone or email." />
                <Checkbox name="overCapacity" label="Book it even if it goes past a cap" hint="Recorded on the booking." />
                <SubmitButton pendingLabel="Booking…">Book it</SubmitButton>
              </ActionForm>
            </Dialog>
            {manager ? <LinkButton href="/console/bookings/settings">Booking rules</LinkButton> : null}
          </>
        }
      />

      <nav aria-label="Day" className="mb-5 flex flex-wrap items-center gap-2">
        <LinkButton href={link(addDays(date, -1))} size="sm">
          ← Day before
        </LinkButton>
        <LinkButton href={link(today)} size="sm" variant={date === today ? 'primary' : 'secondary'}>
          Today
        </LinkButton>
        <LinkButton href={link(addDays(date, 1))} size="sm">
          Day after →
        </LinkButton>
        <form method="get" role="search" aria-label="Choose a day" className="flex items-center gap-2">
          {service ? <input type="hidden" name="service" value={service} /> : null}
          {showAll ? <input type="hidden" name="show" value="all" /> : null}
          <label className="sr-only" htmlFor="booking-date">
            Date
          </label>
          <input id="booking-date" type="date" name="date" defaultValue={date} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" />
          <button type="submit" className="h-8 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink hover:bg-sunken">
            Show
          </button>
        </form>
        <span className="ml-auto text-sm">
          <Link href={link(date, { show: showAll ? undefined : 'all' })} className="text-accent">
            {showAll ? 'Hide declined, cancelled and finished' : 'Show every booking, including declined and cancelled'}
          </Link>
        </span>
      </nav>

      {!day.ok ? (
        <ReadError message={day.error} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="booking-services">
            <div className="rounded-card border border-line bg-surface p-4">
              <p className="text-sm text-ink-2">Whole day</p>
              <p className="mt-1 font-display text-[1.75rem] font-medium tabular-nums text-ink">{day.data.totals.covers}</p>
              <p className="text-xs text-ink-3">
                covers across {day.data.totals.bookings} {day.data.totals.bookings === 1 ? 'booking' : 'bookings'}
                {day.data.totals.requests ? `, ${day.data.totals.requests} waiting for a yes` : ''}
              </p>
            </div>
            {day.data.services.map((s) => {
              const on = service?.toLowerCase() === s.name.toLowerCase();
              return (
                <Link key={s.name} href={link(date, { service: on ? undefined : s.name })} aria-current={on ? 'true' : undefined} className={`rounded-card border p-4 ${on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}>
                  <p className="flex items-center justify-between text-sm text-ink-2">
                    <span>{s.name}</span>
                    {s.startsAt && s.endsAt ? (
                      <span className="text-xs text-ink-3">
                        {timeOnly(s.startsAt, tz)}–{timeOnly(s.endsAt, tz)}
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-1 font-display text-[1.75rem] font-medium tabular-nums text-ink">
                    {s.covers}
                    <span className="text-base text-ink-3"> / {s.maxCovers}</span>
                  </p>
                  <p className="text-xs text-ink-3">
                    covers booked{s.requestedCovers ? `, ${s.requestedCovers} more waiting` : ''}
                  </p>
                </Link>
              );
            })}
          </div>

          {day.data.bookings.length === 0 ? (
            <EmptyState title={showAll ? 'Nothing in the book for this day' : 'Nothing live in the book for this day'}>
              {showAll ? 'No booking was made for this day.' : 'Requests, confirmed and seated bookings appear here. Declined, cancelled and finished ones are behind the link above.'}
            </EmptyState>
          ) : (
            <Card padded={false} title={service ? `${service} bookings` : 'Bookings in time order'}>
              <Table label="Bookings">
                <thead>
                  <tr>
                    <Th>Time</Th>
                    <Th>Guests</Th>
                    <Th>Name</Th>
                    <Th>Contact</Th>
                    <Th>Notes</Th>
                    <Th>From</Th>
                    <Th>Status</Th>
                    <Th>
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {day.data.bookings.map((b) => (
                    <tr key={b.id} data-testid={`booking-${b.reference}`} data-status={b.status}>
                      <Td className="whitespace-nowrap">
                        <span className="font-medium">{b.time}</span>
                        <span className="block text-xs text-ink-3">{b.serviceName}</span>
                      </Td>
                      <Td numeric>{b.partySize}</Td>
                      <Td>
                        <GuestText>{b.guestName}</GuestText>
                        <span className="block font-mono text-xs text-ink-3">{b.reference}</span>
                      </Td>
                      <Td className="text-xs">
                        {b.guestPhone ? <span className="block">{b.guestPhone}</span> : null}
                        {b.guestEmail ? <span className="block break-all">{b.guestEmail}</span> : null}
                        {!b.guestPhone && !b.guestEmail ? <span className="text-ink-3">None given</span> : null}
                      </Td>
                      <Td className="max-w-xs text-xs">
                        {b.guestNote ? (
                          <p>
                            Guest: <GuestText>{b.guestNote}</GuestText>
                          </p>
                        ) : null}
                        {b.staffNote ? <p className="text-ink-2">Floor: {b.staffNote}</p> : null}
                        {b.overCapacity ? <Badge tone="warn">Over capacity</Badge> : null}
                        {b.statusReason ? <p className="text-ink-3">Reason: {b.statusReason}</p> : null}
                      </Td>
                      <Td className="text-xs text-ink-2">{BOOKING_SOURCE[b.source] ?? b.source}</Td>
                      <Td>
                        <BookingStatusBadge status={b.status} />
                        {b.status === 'cancelled' && b.cancelledBy ? <span className="block text-xs text-ink-3">by {b.cancelledBy}</span> : null}
                      </Td>
                      <Td align="right">
                        <div className="flex flex-wrap justify-end gap-1.5">
                          {b.status === 'requested' ? (
                            <>
                              <InlineAction action={confirmBooking} hidden={{ bookingId: b.id }} label="Confirm" variant="primary" testId={`confirm-${b.reference}`} />
                              <ConfirmAction trigger="Decline" title={`Decline ${b.reference}?`} action={declineBooking} hidden={{ bookingId: b.id }} confirmLabel="Decline" reason={{ label: 'Tell the guest why (optional)', required: false, minLength: 0 }} testId={`decline-${b.reference}`}>
                                <p>
                                  The request for {covers(b.partySize)} at {b.time} is turned down and the guest is told. The covers stay free.
                                </p>
                              </ConfirmAction>
                            </>
                          ) : null}
                          {b.status === 'confirmed' || b.status === 'no_show' ? <InlineAction action={seatBooking} hidden={{ bookingId: b.id }} label="Seat" variant="primary" testId={`seat-${b.reference}`} /> : null}
                          {b.status === 'confirmed' && b.startsAt <= app().clock() ? <InlineAction action={markNoShow} hidden={{ bookingId: b.id }} label="No-show" testId={`noshow-${b.reference}`} /> : null}
                          {b.status === 'seated' || b.status === 'confirmed' ? <InlineAction action={completeBooking} hidden={{ bookingId: b.id }} label="Finish" testId={`finish-${b.reference}`} /> : null}
                          {b.status === 'requested' || b.status === 'confirmed' ? (
                            <ConfirmAction trigger="Cancel" title={`Cancel ${b.reference}?`} action={cancelBooking} hidden={{ bookingId: b.id }} confirmLabel="Cancel the booking" reason={{ label: 'Tell the guest why (optional)', required: false, minLength: 0 }} testId={`cancel-${b.reference}`}>
                              <p>
                                {covers(b.partySize)} at {b.time} on {dayLabel(b.date)} is cancelled for the guest and they are told. The covers go back at once.
                              </p>
                            </ConfirmAction>
                          ) : null}
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          <p className="text-xs text-ink-3">
            Times are {tz}. Your assistant reads the same book with <span className="font-mono">bookings_today</span> and makes the same changes after your yes.
          </p>
        </div>
      )}
    </>
  );
}
