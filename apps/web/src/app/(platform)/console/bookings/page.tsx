import Link from 'next/link';
import { GUEST_FACING_ROLES, addDays, localDate } from '@ros/core';
import { bookings, events } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { app } from '@/lib/runtime';
import { BulkSelection, RowBox, SelectAllBox, type BulkActionDef } from '@/components/console/bulk';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { BookingSourceBadge, BookingStatusBadge, NoShowCount, bookingNudgeWords, covers } from '@/components/console/booking-bits';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { ActionForm, Badge, Card, Checkbox, Dialog, EmptyState, Field, GuestText, Input, LinkButton, PageHeader, SubmitButton, Table, Td, Textarea, Th, dateTime, dayLabel, timeOnly } from '@/ui';
import { addBooking, bulkBookings, cancelBooking, completeBooking, confirmBooking, declineBooking, markNoShow, nudgeBooking, seatBooking } from './actions';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Bookings · Pipedline' };

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SPEC: ViewSpec = {
  page: 'bookings',
  path: '/console/bookings',
  landing: 'today',
  defaults: [
    { key: 'today', label: 'Today', filters: { when: 'today' } },
    { key: 'tomorrow', label: 'Tomorrow', filters: { when: 'tomorrow' } },
    { key: 'confirming', label: 'Needs confirming', filters: { when: 'next60', status: 'requested' } },
    { key: 'week', label: 'This week', filters: { when: 'week' } },
    { key: 'unfinished', label: "Didn't finish", filters: { unfinished: 'yes' } },
  ],
  fields: [
    {
      key: 'when',
      label: 'When',
      kind: 'select',
      options: [
        { value: 'today', label: 'Today' },
        { value: 'tomorrow', label: 'Tomorrow' },
        { value: 'week', label: 'Next 7 days' },
        { value: 'next60', label: 'Next 60 days' },
        { value: 'past7', label: 'Last 7 days' },
      ],
    },
    { key: 'date', label: 'Or one day', kind: 'date' },
    { key: 'service', label: 'Service', kind: 'text', placeholder: 'Dinner' },
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'requested', label: 'Waiting for a yes' },
        { value: 'confirmed', label: 'Confirmed' },
        { value: 'seated', label: 'Seated' },
        { value: 'completed', label: 'Finished' },
        { value: 'no_show', label: 'No-show' },
        { value: 'cancelled', label: 'Cancelled' },
        { value: 'declined', label: 'Declined' },
      ],
    },
    { key: 'show', label: 'Include', kind: 'select', options: [{ value: 'all', label: 'Declined, cancelled and finished too' }] },
    {
      key: 'source',
      label: 'Came from',
      kind: 'select',
      options: [
        { value: 'web', label: 'Website' },
        { value: 'assistant', label: 'Inside assistants' },
        { value: 'phone', label: 'Phone' },
        { value: 'staff', label: 'Staff' },
      ],
    },
    { key: 'unfinished', label: "Didn't finish", kind: 'select', options: [{ value: 'yes', label: 'Requests the venue never answered' }] },
  ],
};

/**
 * The book (docs/CONSOLE_IA.md section 1, Bookings; section 9, wave 1): one venue-local day at a
 * time with covers per service against the cap, or a run of days, with saved views ("Today",
 * "Tomorrow", "Needs confirming", "This week") and the host's actions on each booking, singly or
 * in bulk. Hosts, front of house, managers and owners; the service refuses kitchen and read-only
 * roles, so the screen says so too. Guest-written text (names, notes) is rendered as text.
 */
export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('bookings'))) return <ModuleOff title="Bookings" what="Table bookings" canManage={manager} />;
  if (!manager && !GUEST_FACING_ROLES.includes(c.role)) return <NotForYourRole title="Bookings">The book holds guests' names and contact details, so it is for hosts, front of house and managers.</NotForYourRole>;

  // A plain ?date= link (the day arrows, older links) is a filter in its own right.
  const sp = raw.date && raw.f !== '1' ? { ...raw, f: '1' } : raw;
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'bookings' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const tz = c.venue.timezone;
  const today = localDate(app().clock(), tz);
  const range = dayRange(f, today);
  const status = f.status ? [f.status as bookings.BookingStatus] : undefined;
  const isUnfinished = f.unfinished === 'yes';
  const day = await read((ctx) => bookings.listBookings(ctx, { venueId: c.venue.id, date: range.date, ...(range.to ? { to: range.to } : {}), service: f.service || undefined, show: f.show === 'all' ? 'all' : 'active', ...(status ? { status } : {}) }));
  if (day.ok && f.source) day.data.bookings = day.data.bookings.filter((b) => b.source === f.source);

  const oneDay = !range.to;
  const dayLink = (d: string) => `/console/bookings?view=${encodeURIComponent(resolved.current.key)}&f=1&date=${d}${f.service ? `&service=${encodeURIComponent(f.service)}` : ''}${f.show ? `&show=${f.show}` : ''}${f.status ? `&status=${f.status}` : ''}`;
  const weekday = (d: string) => WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()];
  const dateWords = oneDay
    ? range.date === today
      ? `Today, ${weekday(range.date)} ${dayLabel(range.date)}`
      : range.date === addDays(today, 1)
        ? `Tomorrow, ${weekday(range.date)} ${dayLabel(range.date)}`
        : `${weekday(range.date)} ${dayLabel(range.date)} ${range.date.slice(0, 4)}`
    : `${dayLabel(range.date)} to ${dayLabel(range.to!)}`;

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
                    <Input name="date" type="date" defaultValue={range.date} required />
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

      <IndexViews
        page="bookings"
        path="/console/bookings"
        resolved={resolved}
        fields={SPEC.fields}
        canSave
        saveAction={saveView}
        renameAction={renameView}
        deleteAction={deleteView}
        aside={
          oneDay && !isUnfinished ? (
            <nav aria-label="Day" className="flex flex-wrap items-center gap-2">
              <LinkButton href={dayLink(addDays(range.date, -1))} size="sm">
                ← Day before
              </LinkButton>
              <LinkButton href={dayLink(addDays(range.date, 1))} size="sm">
                Day after →
              </LinkButton>
            </nav>
          ) : null
        }
      />

      {isUnfinished ? (
        <UnfinishedBookings venueId={c.venue.id} tz={tz} filters={f} />
      ) : !day.ok ? (
        <ReadError message={day.error} />
      ) : (
        <div className="space-y-6">
          {oneDay ? (
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
                const on = f.service?.toLowerCase() === s.name.toLowerCase();
                const href = `/console/bookings?view=${encodeURIComponent(resolved.current.key)}&f=1&date=${range.date}${on ? '' : `&service=${encodeURIComponent(s.name)}`}${f.show ? `&show=${f.show}` : ''}`;
                return (
                  <Link key={s.name} href={href} aria-current={on ? 'true' : undefined} className={`rounded-card border p-4 ${on ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-sunken'}`}>
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
          ) : (
            <p className="text-sm text-ink-2" data-testid="booking-run">
              {day.data.totals.covers} covers across {day.data.totals.bookings} {day.data.totals.bookings === 1 ? 'booking' : 'bookings'} in these days
              {day.data.totals.requests ? `, ${day.data.totals.requests} waiting for a yes` : ''}.
            </p>
          )}

          {day.data.bookings.length === 0 ? (
            <EmptyState title="Nothing in the book for this view">
              {f.status || f.show === 'all' ? 'No booking matches these filters.' : 'Requests, confirmed and seated bookings appear here. Declined, cancelled and finished ones show with “Include: declined, cancelled and finished too”.'}
            </EmptyState>
          ) : (
            <BulkSelection noun={{ one: 'booking', many: 'bookings' }} actions={BULK} action={bulkBookings} testId="bulk-bookings">
              <Card padded={false} title={f.service ? `${f.service} bookings` : 'Bookings in time order'}>
                <Table label="Bookings">
                  <thead>
                    <tr>
                      <Th className="w-8">
                        <SelectAllBox label="Select every booking on this page" />
                      </Th>
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
                        <Td>
                          <RowBox id={b.id} label={`Select booking ${b.reference}`} name={b.reference} />
                        </Td>
                        <Td className="whitespace-nowrap">
                          {!oneDay ? <span className="block text-xs text-ink-3">{dayLabel(b.date)}</span> : null}
                          <span className="font-medium">{b.time}</span>
                          <span className="block text-xs text-ink-3">{b.serviceName}</span>
                        </Td>
                        <Td numeric>{b.partySize}</Td>
                        <Td>
                          <GuestText>{b.guestName}</GuestText>
                          <Link href={`/console/bookings/${b.id}`} className="block font-mono text-xs text-accent">
                            {b.reference}
                          </Link>
                          {b.noShowCount > 0 ? (
                            <span className="mt-1 block" data-testid={`noshows-${b.reference}`}>
                              <NoShowCount count={b.noShowCount} />
                            </span>
                          ) : null}
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
                        <Td>
                          <BookingSourceBadge source={b.source} />
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            <BookingStatusBadge status={b.status} />
                            {b.recoveredAt ? <Badge tone="good">Recovered</Badge> : b.abandonedAt && !b.purgedAt ? <Badge tone="warn">Didn&apos;t finish</Badge> : null}
                          </div>
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
            </BulkSelection>
          )}
          <p className="text-xs text-ink-3">
            Times are {tz}. Your assistant reads the same book with <span className="font-mono">bookings_today</span> and makes the same changes after your yes.
          </p>
        </div>
      )}
    </>
  );
}

/**
 * "Didn't finish" for bookings (pattern 7). The bookings flow records no "started" step, so the
 * unfinished booking is the request the venue never answered inside its window: it is still the
 * guest's own request, so the one nudge tells them it is waiting and how to cancel. Confirming
 * or declining is the better answer; the nudge is for when neither can happen yet.
 */
async function UnfinishedBookings({ venueId, tz, filters }: { venueId: string; tz: string; filters: Record<string, string> }) {
  const r = await read((ctx) => bookings.listUnfinishedBookings(ctx, { venueId, limit: 200 }));
  if (!r.ok) return <ReadError message={r.error} />;
  const rows = r.data.filter((b) => !filters.source || b.source === filters.source);
  return (
    <Card
      title="Booking requests the venue did not answer in time"
      description="A request still waiting for a yes when the venue's window ran out (set under Booking rules). Confirm or decline it if you can; one nudge may be sent to say it is still waiting. Details are removed after three months."
      padded={false}
    >
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Every request was answered in time">A request appears here when it has waited longer than the booking rules allow, or its time arrived, without a yes or a no.</EmptyState>
        </div>
      ) : (
        <Table label="Unanswered booking requests">
          <thead>
            <tr>
              <Th>Booking</Th>
              <Th>Guest</Th>
              <Th>For</Th>
              <Th>Waiting since</Th>
              <Th>Email status</Th>
              <Th>Recovery status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const canNudge = b.status === 'requested' && !b.nudgeSentAt && !b.recoveredAt && (b.guestEmail || b.guestPhone);
              return (
                <tr key={b.id} data-testid={`unfinished-booking-${b.reference}`} data-recovered={b.recoveredAt ? 'true' : 'false'}>
                  <Td>
                    <Link href={`/console/bookings/${b.id}`} className="font-mono text-xs text-accent">
                      {b.reference}
                    </Link>
                    <span className="block text-xs text-ink-3">
                      <BookingStatusBadge status={b.status} />
                    </span>
                  </Td>
                  <Td className="text-xs">
                    <GuestText>{b.guestName}</GuestText>
                    {b.guestEmail ? <span className="block break-all text-ink-2">{b.guestEmail}</span> : null}
                    {b.guestPhone ? <span className="block text-ink-2">{b.guestPhone}</span> : null}
                    {b.noShowCount > 0 ? (
                      <span className="mt-1 block">
                        <NoShowCount count={b.noShowCount} />
                      </span>
                    ) : null}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {covers(b.partySize)} at {b.time}, {dayLabel(b.date)}
                    <span className="block text-xs text-ink-3">
                      <BookingSourceBadge source={b.source} />
                    </span>
                  </Td>
                  <Td className="whitespace-nowrap">{dateTime(b.createdAt, tz)}</Td>
                  <Td>
                    <span className="block" data-testid={`email-status-${b.reference}`}>
                      {bookingNudgeWords(b)}
                      {b.nudgeSentAt ? <span className="block text-xs text-ink-3">{dateTime(b.nudgeSentAt, tz)}</span> : null}
                    </span>
                  </Td>
                  <Td>
                    <span className="block" data-testid={`recovery-status-${b.reference}`}>
                      {b.recoveredAt ? (
                        <>
                          <Badge tone="good">Recovered</Badge>
                          <span className="block text-xs text-ink-3">{dateTime(b.recoveredAt, tz)}</span>
                        </>
                      ) : (
                        'Not recovered'
                      )}
                    </span>
                  </Td>
                  <Td align="right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {b.status === 'requested' ? <InlineAction action={confirmBooking} hidden={{ bookingId: b.id }} label="Confirm" variant="primary" testId={`confirm-${b.reference}`} /> : null}
                      {b.status === 'requested' ? (
                        <ConfirmAction trigger="Decline" title={`Decline ${b.reference}?`} action={declineBooking} hidden={{ bookingId: b.id }} confirmLabel="Decline" reason={{ label: 'Tell the guest why (optional)', required: false, minLength: 0 }} testId={`decline-${b.reference}`}>
                          <p>The request is turned down and the guest is told.</p>
                        </ConfirmAction>
                      ) : null}
                      {canNudge ? (
                        <ConfirmAction trigger="Send a nudge" title={`Nudge the guest about ${b.reference}?`} action={nudgeBooking} hidden={{ bookingId: b.id }} confirmLabel="Send the nudge" variant="primary" testId={`nudge-${b.reference}`}>
                          <p>
                            One message goes to the guest by {b.guestEmail ? 'email' : 'text message'}: their request for {covers(b.partySize)} at {b.time} on {dayLabel(b.date)} is still waiting, how to reach the venue, and their own link to cancel. It is the only nudge they will get.
                          </p>
                        </ConfirmAction>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

const BULK: BulkActionDef[] = [
  { key: 'confirm', verb: 'Confirm', body: 'The {nouns} {is} confirmed and each guest is told. Only requests waiting for a yes can be confirmed; any other is left as it is and named.' },
  { key: 'seat', verb: 'Seat', body: 'The {nouns} {is} marked as seated.' },
  { key: 'complete', verb: 'Finish', body: 'The {nouns} {is} marked as finished.' },
  { key: 'decline', verb: 'Decline', destructive: true, reason: { label: 'Tell the guests why (optional)', required: false }, body: 'The {nouns} {is} turned down and each guest is told. The covers stay free. Only requests waiting for a yes can be declined.' },
  { key: 'cancel', verb: 'Cancel', destructive: true, reason: { label: 'Tell the guests why (optional)', required: false }, body: 'The {nouns} {is} cancelled for the guests and they are told. The covers go back at once.' },
];

/** The first (and maybe last) venue-local day the filters ask for. */
function dayRange(f: Record<string, string>, today: string): { date: string; to?: string } {
  if (f.date) return { date: f.date };
  switch (f.when) {
    case 'tomorrow':
      return { date: addDays(today, 1) };
    case 'week':
      return { date: today, to: addDays(today, 6) };
    case 'next60':
      return { date: today, to: addDays(today, 59) };
    case 'past7':
      return { date: addDays(today, -7), to: addDays(today, -1) };
    default:
      return { date: today };
  }
}
