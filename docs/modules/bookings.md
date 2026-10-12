# MODULE — `bookings` (dine-in reservations)

## v1 as built (2026-10-04)

Built: **capacity-based bookings without a floor plan**. Code in
`packages/modules/src/bookings/` (its `CLAUDE.md` lists every function), migration
`db/migrations/0750_bookings.sql`, tests `packages/modules/test/bookings/bookings.test.ts`.
Everything below this section is the full design; v1 takes sections 2, 3, 5 and 6 in reduced
form and skips sections 1, 4, 7 and the deposits of 8.

**What exists**

- **Services.** Per weekday periods in the module config (`service_periods`: name, days, start,
  end, optional last booking time), or, when none are set, the venue's opening hours (one
  service per opening period). A closed day in the hour exceptions closes bookings; special
  hours narrow them. Slots every 15, 30 or 60 minutes.
- **Capacity, computed per request (§3), never stored.** Three caps: guests starting in a slot
  (kitchen pacing, the §2 `max_covers_per_slot`), guests per service, and optionally guests
  seated at once using typical sitting lengths by party size (the §2 turn times, kept in config,
  not a table). Plus: largest party online, booking window in days, cut-off before a slot. Time
  is venue-local wall-clock, correct across daylight saving.
- **Lifecycle (§5, reduced).** `bookings` + `booking_status_history`. requested → confirmed |
  declined | cancelled; confirmed → cancelled | seated | no_show | completed; seated →
  completed; no_show → seated. `auto_confirm` decides whether a booking within capacity is
  confirmed at once or waits as a request. Every change audited and emitted (`booking.*`).
- **Guest flow (§6, reduced).** `getBookingAvailability` → `requestBooking` (no account,
  idempotent request key, capacity re-checked inside a per-venue lock) → a transactional email
  or SMS (confirmed / request received) with a private link → `getBookingByToken`,
  `cancelBookingByToken`. A reminder job before the booking (on by default, hours configurable).
  Booking links the guest record (or makes one) and grants no consent.
- **Staff.** List a day with covers per service, confirm, decline, cancel, seat, no-show,
  finish, phone bookings (any time inside a service, caps overridable on purpose), totals
  (covers, cancellations, no-show rate) for read-only staff.
- **Assistant tools.** `bookings_today`, `bookings_list`, `booking_availability` (read);
  `booking_confirm`, `booking_decline`, `booking_cancel`, `booking_add` (write, asked first).

**Console depth, wave 2 (2026-10-13; `docs/CONSOLE_IA.md` section 9, pattern 7 and the "Came from"
badge of pattern 2)**

- **Came from.** `source` (web · assistant · phone · staff) is a badge on every booking row and
  the booking page, and a filter on the book.
- **No-show count per guest.** `BookingView.noShowCount`: how many of the guest's bookings across
  the organisation ended `no_show` (by `customer_id`; 0 with no record). Shown read-only on booking
  rows and the booking page. Not stored: counted when the book is read.
- **Didn't finish.** The flow records no "started" step (a request is written whole; the guest
  plugin's two-step is a signed token, never a row), so the unfinished booking is **a request the
  venue never answered inside its window**: `request_window_hours` (config, default 24), or the
  booking's own time if sooner. `bookings.detect_abandoned` is booked per request when it is made;
  if still `requested` it sets `abandoned_at` and tracks `booking.abandoned`.
  `listUnfinishedBookings`, `nudgeUnfinishedBooking` (host, front of house, managers): one
  transactional `booking.unanswered` (still waiting; how to reach the venue; the guest's own cancel
  link), `nudge_sent_at` / `nudge_message_id` / `nudge_status`; audited `bookings.nudge_sent`,
  event `booking.nudged`; a second nudge is `conflict`; no consent recorded; bounced/complained
  addresses are not written to. `applyStatus` sets `recovered_at` (event `booking.recovered`) when
  an unfinished request becomes confirmed, seated or completed. `bookings.purge_unfinished`
  (daily): three months after `abandoned_at`, never recovered → guest name, contact, notes and
  `customer_id` cleared, `purged_at` set, audited `bookings.unfinished_purged`, event
  `booking.purged`. Tool `booking_nudge`; `bookings_list` rows carry `came_from`, `no_shows_before`
  and `unfinished`. Migration `0770`; tests `packages/modules/test/orders-depth/bookings-unfinished.test.ts`.

**Not in v1 (still the design below)**

Floor plans, areas, tables and combinations (§1); table allocation and auto-suggest (§4); the
host / service view (§7); deposits, card holds and cancellation windows (§8); waitlist; guest
modify (v1: cancel and rebook); reminders at more than one offset; a buffer between sittings;
occasion / dietary / allergy fields (v1 has one free-text guest note and one staff note); the §3
cache; linking a seated booking to a transaction. (The per-customer no-show count is now shown,
counted at read time rather than stored on the guest record.)

**What the web app will need (not built here)**

- A public booking widget on the venue site: date → party size → times
  (`getBookingAvailability`) → details → `requestBooking` with a request key made once per
  attempt, showing `note`, `confirmation` and `phoneNumber` from the availability answer.
- A manage page at `/booking/<token>` (the path `manageUrl` builds on the venue's primary
  domain): `getBookingByToken`, a cancel button calling `cancelBookingByToken`.
- A console screen: the day's book (`listBookings`), confirm / decline / cancel / seat / no-show
  / finish, add a phone booking (`addBooking`), and `bookingSummary`. Settings already appear on
  the generated Features form (arrays of service periods and sitting lengths may need a
  hand-built editor).

The most complex module. Restaurants judge a booking system on whether the host can run
Friday night on it, not on whether the web form works.

## 1. Floor plan model — restaurant-tailorable

```sql
floor_plans(id, venue_id, name, is_active, canvas_width, canvas_height, background_url)
-- multiple plans per venue: "Standard", "Summer (terrace open)", "Function mode"

areas(id, venue_id, floor_plan_id, name, kind, sort_order, bookable_online, priority)
-- kind: 'dining' | 'terrace' | 'bar' | 'private' | 'counter'
-- priority: which areas the auto-allocator prefers to fill first

tables(id, venue_id, floor_plan_id, area_id,
       label,                    -- "12", "T4", "Bar 3" — the restaurant's own numbering
       seats_min, seats_max,     -- a 4-top may seat 2–4
       shape,                    -- 'round' | 'square' | 'rect' | 'booth' | 'banquette'
       x, y, width, height, rotation,   -- for the visual editor + host view
       is_bookable_online, is_accessible, sort_order, status)

table_combinations(id, venue_id, label, seats_min, seats_max)
table_combination_members(combination_id, table_id)
-- "T4+T5 = a 8-top". Modelled EXPLICITLY, not solved at runtime.
```

**Table numbering is theirs, not ours.** `label` is free text. Restaurants have "12", "T4",
"Window 2", "B1". Any system that imposes sequential integers gets rejected in the first demo.

**Why explicit combinations:** joining tables is a bin-packing problem if solved generically,
and generic solutions produce combinations the room physically cannot make (tables on opposite
walls, a booth that doesn't join). Let the restaurant declare the combinations that actually
work in their room during setup. It's 10 minutes of onboarding and it removes an entire class
of impossible-allocation bugs.

**Visual editor:** drag-drop canvas writing `x/y/width/height/rotation`. The same renderer is
reused for the host's live floor view on service — one component, two modes (edit / live). This
is the demo that sells the module, so build the editor and the live view together.

## 2. Service periods & availability rules

```sql
service_periods(id, venue_id, name, days_of_week[], starts_at, ends_at,
                last_booking_at, is_active)
-- "Lunch" Tue–Sun 12:00–15:00, last booking 14:00

turn_times(id, venue_id, service_period_id NULL, party_size_min, party_size_max, minutes)
-- 1–2 people: 75min · 3–4: 90min · 5–8: 120min · 9+: 150min

booking_rules(id, venue_id, service_period_id NULL,
              slot_interval_minutes,        -- 15 / 30
              max_party_online,             -- above this, enquiry form not instant booking
              min_notice_minutes,
              max_advance_days,
              buffer_minutes,               -- cleardown between sittings
              max_covers_per_slot,          -- kitchen pacing cap, independent of tables
              requires_deposit_above_party,
              deposit_amount, deposit_policy_text,
              cancellation_window_hours)
```

**`max_covers_per_slot` is the rule people forget.** A kitchen that can physically seat 60 at
7:00pm cannot *cook* 60 at 7:00pm. Pacing caps are how real venues protect service, and its
absence is the loudest "this was built by someone who's never worked a pass" signal.

## 3. Availability — computed, never stored

Availability is a function of (tables + combinations) × (existing bookings) × (turn time +
buffer) × (pacing cap) × (hours − exceptions). Never materialise it into a slot table; the
invalidation surface is enormous and it will drift.

Compute per request, cache with a short TTL keyed on `(venue_id, date, party_size)`, and bust
the key on any booking write for that date. This stays fast well past the volume you need.

## 4. The allocation decision — do not auto-assign at booking time

**Hold covers at booking time; assign tables at service time.**

A booking reserves *capacity* (party size against the pacing cap and the pool of tables that
could seat them). The host assigns actual tables on the day from the floor view, because that
decision depends on things no algorithm has: who's celebrating, who tips, which server is
strong, whether table 6 is under the aircon.

This is how OpenTable and SevenRooms behave, it makes availability computation dramatically
simpler, and it removes the failure mode where the system has "no availability" because it
allocated a 2-top to a couple and stranded a 4-top.

Offer an **auto-suggest** on the host view (highlight tables that fit) — never an auto-commit.

## 5. Booking lifecycle

```sql
bookings(id, org_id, venue_id, customer_id, reference,
         booked_for,                 -- timestamptz, the sitting time
         party_size, duration_minutes,
         status,                     -- see below
         source,                     -- 'web' | 'phone' | 'walk-in' | 'google' | 'staff'
         area_preference_id NULL,
         occasion,                   -- birthday, anniversary, business
         dietary_notes, allergy_notes, special_requests,
         internal_notes,             -- staff-only, never shown to guest
         deposit_payment_id NULL, deposit_amount,
         created_by_staff_id NULL, created_at)

booking_tables(booking_id, table_id, assigned_at, assigned_by)
booking_status_history(id, booking_id, from_status, to_status, at, by, reason)
```

`requested → confirmed → reminded → seated → completed`
with branches `cancelled` · `no_show` · `waitlisted` · `declined`

**Allergy notes are a safety field, not a preference.** Keep `allergy_notes` separate from
`dietary_notes`, surface it in red on the host and kitchen views, and never truncate it.

## 6. Guest-facing flow

Date → party size → available times → details → (deposit if required) → confirm.
Confirmation email + SMS immediately; reminder 24h and 3h before (configurable); one-tap
cancel/modify link that does not require an account.

**Waitlist** when a slot is full: capture the guest, notify by SMS if a cancellation opens the
slot, first-come-first-served with a 10-minute claim window.

## 7. Host / service view

The screen that runs Friday night:
- Live floor plan (same renderer as the editor) colour-coded by status
- Timeline / grid view of the service by table
- Drag a booking onto a table to assign; drag between tables to move
- Walk-in entry, waitlist, table status (seated / mains away / paid / cleared)
- Covers-vs-pacing running total
- Search a guest → visit history, spend, previous notes, allergies, loyalty tier

That last one is where bookings feeds the spine: every booking resolves to or creates a
`customer`, and every seated booking eventually links to a `transaction`. **That link is what
lets Criota attribute a creator's video to a dine-in meal** — without it, dine-in is invisible
to attribution.

## 8. No-show handling

Deposits above a configurable party size (Square payment, held or captured per policy),
cancellation window, no-show marking, and a per-customer no-show count on the guest record.
Repeat no-shows are a real cost to restaurants and a visible no-show count is a feature they
will name in the sales call.

## 9. Config surface (`venue_modules.config`)

`slot_interval` · `max_party_online` · `min_notice` · `max_advance_days` · `buffer_minutes`
· `deposit_policy` · `cancellation_window` · `confirmation_channels` · `reminder_offsets`
· `waitlist_enabled` · `allow_area_preference` · `show_availability_publicly`
