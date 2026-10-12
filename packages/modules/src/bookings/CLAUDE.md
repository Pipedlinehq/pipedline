# bookings — table bookings (v1: capacity, no floor plan)

Spec: `docs/modules/bookings.md` ("v1 as built" at the top; the rest is the full design).

A guest books a table for a date, time and party size on the venue's site or through an
assistant, with no account. A booking holds **covers** (guests) against the venue's pacing caps;
no table is assigned. Staff confirm, decline, cancel, seat, finish and mark no-shows, and take
phone bookings. The venue's own assistant reads the book and makes changes after a yes.

**Toggleable** per venue (key `bookings`). `dependsOn: []`. Owns `bookings` and
`booking_status_history` (`@append_only`), migration `0750_bookings.sql`. Enums
`booking_status` (requested, confirmed, declined, cancelled, seated, no_show, completed) and
`booking_source` (web, assistant, phone, staff).
Uses: `tenancy` (`getVenue`, `openWindows`, `listHourExceptions`; reads `domains` for the
manage link), `identity` (`resolveCustomer`, `normaliseEmail`, `normalisePhone`, hooks),
`comms` (`queueMessage`, `defineTemplate`). Core: `secrets.orgKey(org, 'booking_links')`.

## Public functions by purpose

Guest-facing (no role check; anonymous, a signed-in guest, or an assistant acting for a guest;
a paired screen is refused; another org's venue or the module off is not found):
- `getBookingAvailability(ctx, { venueId, date, partySize })` → `BookingAvailability`:
  `times: [{ time 'HH:MM', startsAt, service }]` (only bookable ones), `reason` (words when
  none), `services`, `maxPartySize`, `firstDate`/`lastDate`, `confirmation: instant|request`,
  `phoneNumber: required|optional|not_asked`, `note` (the venue's note), `venuePhone`, `timezone`.
- `requestBooking(ctx, { venueId, date, time, partySize, name, email?, phone?, note?, requestKey, channel? })`
  → `RequestedBooking` = `GuestBookingView` + `manageToken` + `manageUrl`. `time` must be one of
  the times availability lists. `channel`: `web` (default) or `assistant` (stored as `source`).
  Idempotent on `requestKey` (16-100 chars, unique per org; same key at another venue →
  conflict). Takes a per-venue advisory lock, then re-checks capacity: the loser of a race for
  the last place gets `conflict` "That time has just been booked up. Choose another time."
  Refusals are `invalid` with a sentence a guest can read. Resolves (or creates) the customer
  from email/phone; records **no consent**. Status `confirmed` (auto_confirm) or `requested`.
  Rate-limited per IP (20/10 min) and per venue.
- `getBookingByToken(ctx, token)` → `GuestBookingView` (reference, venue name/phone, status,
  date, time, startsAt, timezone, service, party size, duration, first name, own note,
  `venueMessage` when staff declined/cancelled, `canCancel`). No contact details.
- `cancelBookingByToken(ctx, token)` → `GuestBookingView`. Requested or confirmed, before its
  start. Cancelling twice is one cancel. Tells the guest.

The token is not stored: `base64url(booking id ‖ HMAC(org key 'booking_links', id)[0..16])`,
43 chars. Wrong, cut, forged, or another org's token → not found. Rate-limited per IP.

Staff (host / front of house and above, via `requireStaff({ minRole: 'host', anyOf: GUEST_FACING_ROLES })`;
kitchen and read-only are forbidden; a venue with no role, or another org's id, is not found):
- `listBookings(ctx, { venueId, date?, to?, service?, show?: 'active'|'all', status?: BookingStatus[] })` → `BookingDay` with
  covers per service (`covers` = confirmed+seated+completed, `requestedCovers`, `maxCovers`) and totals.
  `to` (at most 62 days after `date`) lists a run of days: `services` is then empty and `to` is echoed;
  `status` keeps only those statuses whatever `show` says (the console's "Needs confirming" view).
- `getBooking(ctx, { bookingId })`, `findBookingByReference(ctx, { venueId, reference })`,
  `searchBookings(ctx, { venueId, q, limit? })` (guest name or reference contains `q`; soonest ahead first; the console's search).
- `confirmBooking`, `declineBooking({ bookingId, reason? })`, `cancelBooking({ bookingId, reason? })`,
  `seatBooking`, `markNoShow` (only once `booked_for` has passed), `completeBooking`. The same
  change twice is one change; an illegal move is `invalid`. Moves: requested → confirmed |
  declined | cancelled; confirmed → cancelled | seated | no_show | completed; seated → completed;
  no_show → seated.
- `checkStatusChange(ctx, bookingId, to)` — the checks without the change (tools ask with it).
- `addBooking(ctx, { venueId, date, time, partySize, name, email?, phone?, note?, overCapacity?, notifyGuest? })`
  → confirmed, source `phone`. Any time inside a service (not only on the grid), any party size,
  no cut-off or window; the caps apply unless `overCapacity` (stored, audited). `note` is a staff
  note. `checkStaffBooking` = its checks without the write.
- `bookingSummary(ctx, { venueId, from, to })` — read-only and above (numbers only): bookings,
  covers, cancelled (+ by guest), declined, no-shows, no-show rate, by source.
- Config is changed through `tenancy.configurePlugin` / `plugin_configure` (manager).

## Hooks

Registers (`hooks.ts`): `identity.onCustomerMerge` (moves `customer_id`), `identity.onCustomerErase`
(clears customer, name, email, phone, guest note, staff note; the booking and its covers stay),
`identity.registerCustomerDataProvider('bookings', …)`.

## Config surface (`bookingsConfig`, per venue; every field described)

`service_periods[]` (`name`, `days` sun..sat, `starts_at`, `ends_at` (earlier = past midnight),
`last_booking_at|null`); empty = follow the opening hours (one service per period, named after
its service type). `last_booking_before_close_minutes` (60), `slot_minutes` 15|30|60 (30),
`max_covers_per_slot` (20), `max_covers_per_service` (80), `max_covers_seated|null`,
`max_party_size_online` (8), `sitting_minutes[]` ({up_to_party_size, minutes}),
`booking_window_days` (60), `cutoff_minutes` (60), `auto_confirm` (true),
`phone_number` required|optional|not_asked, `booking_note`, `send_reminders` (true),
`reminder_hours_before` (24). A closed hour exception closes bookings; special hours clip them.

## Availability (`availability.ts`)

Computed per call, never stored. Slots are venue-local wall-clock times turned into instants
(`zonedTimeToUtc`), so DST days keep 19:00 at 19:00. Holding statuses: requested, confirmed,
seated, completed, no_show. Caps: covers starting in the slot `[slot, slot+slot_minutes)`,
covers in the service (`service_date` + `service_name`), and, when set, guests seated at once
using each booking's `duration_minutes`.

## Jobs, schedules, events, templates, tools

- Job `bookings.reminder` (key `remind:<id>`, run at `booked_for − reminder_hours_before`),
  enqueued when a booking becomes confirmed with a contact. Sends only if still confirmed, ahead,
  not yet reminded, module on and reminders on; sets `reminded_at`. No schedule.
- Events (ids and numbers only): `booking.requested` (status, source, service, lead_minutes,
  over_capacity), `booking.confirmed` (auto), `booking.declined`, `booking.cancelled` (by, was,
  minutes_before), `booking.seated` (minutes_late), `booking.no_show`, `booking.completed`; all
  carry `booking_id`, `party_size`.
- Templates (email + sms, all transactional): `booking.confirmed`, `booking.requested`,
  `booking.declined`, `booking.cancelled`, `booking.reminder`. Email if given, else SMS, else none.
  Idempotency key `booking:<id>:<what>`.
- Tools (`bookings:read`): `bookings_today`, `bookings_list`, `booking_availability`.
  (`bookings:write`, `minRole: 'host'`, `sensitive`): `booking_confirm`, `booking_decline`,
  `booking_cancel`, `booking_add`. Questions name the booking by reference, size and time, never
  by guest words; write outputs carry no guest text; list outputs give first name and the note
  labelled as quoted guest content, no contact details.

## Fixtures and tests

- Seeder `packages/fixtures/src/seeders/47-bookings.ts`: on at the diner (explicit Lunch/Dinner
  periods, 12 a slot, 50 a service) and at CBD and Newtown (opening hours); Bondi off. Phone
  bookings for tomorrow without contact details (nothing is sent).
- Tests `packages/modules/test/bookings/bookings.test.ts`.

## Known gaps (v1)

No floor plan, tables, combinations or allocation; no host view; no deposits or card holds;
no waitlist; no guest modify (cancel and rebook); no per-customer no-show count; no buffer
between sittings; no web pages (booking widget, manage page at `/booking/<token>`, console
screen) — see the spec.
