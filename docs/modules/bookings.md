# MODULE — `bookings` (dine-in reservations)

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
