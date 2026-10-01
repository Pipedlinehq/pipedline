# MODULE — `kds` (Kitchen Display System)

The screen the kitchen actually runs on. **Build this before the POS**, not after: online orders
already need to reach the pass, and a KDS that consumes orders from any source is useful on day
one. When the POS arrives it becomes just another source.

## 1. Sources — one display, every channel

```
online pickup order ─┐
POS order entry ─────┼──► tickets ──► station routing ──► station screens ──► expo/pass
delivery aggregator ─┤
QR dine-in order ────┘
```

A single `tickets` stream, source-tagged. Kitchens do not care where an order came from; they
care what to cook and when. Anything that gives delivery orders a separate screen from dine-in
orders gets abandoned in week two.

## 2. Stations & routing

```sql
stations(id, venue_id, name, kind, sort_order, is_active,
         screen_layout,        -- 'grid' | 'list' | 'rail'
         max_active_tickets,   -- pacing cap for this station
         alert_sound, colour)
-- kind: 'grill' | 'saute' | 'larder' | 'fry' | 'pizza' | 'pass' | 'dessert' | 'bar' | 'prep' | 'expo'

item_station_routes(id, venue_id, menu_item_id NULL, section_id NULL, station_id, sort_order)
-- route by item, or fall back to route by section. Item-level wins.

station_screens(id, venue_id, station_id, name, device_token, last_seen_at, config jsonb)
-- a physical screen; a station may have several, a screen may show several stations
```

**Route by item with a section-level fallback.** Every restaurant has exceptions (the
"salad" section is larder, except the warm duck salad which is grill). Item-level routing with
a section default covers this without making them configure 200 items by hand at onboarding.

**One item can route to multiple stations** — a burger fires at grill (patty) and larder
(assembly). The expo view is what reconciles them.

## 3. Ticket & item model

```sql
tickets(id, org_id, venue_id, source, source_ref,
        order_id NULL, booking_id NULL,
        ticket_number,              -- venue-scoped, resets daily
        channel,                    -- 'dine-in' | 'pickup' | 'delivery' | 'qr'
        table_label NULL, guest_name NULL, covers NULL,
        status,                     -- 'new' | 'in_progress' | 'ready' | 'bumped' | 'recalled' | 'cancelled'
        priority,                   -- 0 normal, higher = jump the rail
        is_rush, is_on_hold,
        target_ready_at,            -- promised time (pickup slot, or fire time + turn)
        received_at, first_viewed_at, started_at, ready_at, bumped_at,
        prep_seconds_actual, notes)

ticket_items(id, ticket_id, station_id, menu_item_id,
             name_snapshot, qty, modifiers jsonb, item_note,
             course,                -- 1 = entree, 2 = main, 3 = dessert
             seat_number NULL,
             prep_seconds_estimate,
             fire_at,               -- computed; see §5
             status,                -- 'queued' | 'held' | 'fired' | 'cooking' | 'ready' | 'bumped' | 'voided'
             started_at, ready_at, bumped_at,
             allergen_flags[], is_priority)

ticket_events(id, ticket_id, ticket_item_id NULL, event, station_id,
              staff_id NULL, occurred_at, metadata jsonb)
-- append-only: viewed, fired, started, bumped, recalled, held, voided, transferred
```

**`name_snapshot` and `modifiers` are frozen at ticket creation.** A menu edit mid-service must
never mutate a ticket already on a screen.

**`allergen_flags[]` denormalised onto the item.** Allergen information must be visible on the
station screen without a join, without a tap, and in a colour nobody can miss. This is a safety
requirement, not a feature.

## 4. Coursing & firing

```
Course 1 (entrées) ──► fires immediately on send
Course 2 (mains)   ──► held; fires on expo's "fire mains", or auto-fires N min after
                       course 1 is bumped
Course 3 (dessert) ──► held; fires on demand only
```

Per-venue config: `auto_fire_next_course` (bool), `auto_fire_delay_minutes`, `default_course_map`
(which menu sections map to which course by default).

Manual controls the pass needs: **fire**, **hold**, **rush**, **recall**, **all-day view**.
A dine-in service that cannot hold and fire mains is not usable in a real dining room.

## 5. Timings — the part that separates a real KDS from a ticket printer

Each item carries `prep_seconds_estimate` (from `menu_items.prep_minutes`). Items on the same
course must **land together**, so they cannot all start together:

```
item.fire_at = ticket.course_target_at − item.prep_seconds_estimate
```

A 14-minute steak fires at T−14; the 3-minute salad that goes with it fires at T−3. The station
screen shows each item at its fire time, not at order time. This is the single highest-value
behaviour in the module and the reason kitchens replace paper.

**Escalation colours** on ticket age against target:

| State | Rule (configurable) |
|---|---|
| green | age < 60% of target |
| amber | 60–90% |
| red | 90–100% |
| flashing red | over target |

Configurable thresholds per station — a bar's targets are not a grill's.

## 6. Station screen behaviour

- **Grid / list / rail layouts**, chosen per station. Rail (horizontal, oldest left) suits a
  high-throughput line; grid suits a pass.
- Each station sees **only its own items**, plus ticket context (table, course, covers, rush).
- **Bump** marks an item or the station's whole slice of a ticket done. **Recall** undoes it —
  recall must always be available, because bumps are mis-tapped constantly on a busy line.
- **All-day counts**: a persistent header — "ALL DAY: 6 ribeye · 4 barra · 11 fries" — aggregated
  across every live ticket. Chefs batch by item, not by ticket.
- **Audible + visual new-ticket alert**, repeating until first view.
- Large type, high contrast, glove/wet-hand friendly hit targets, no hover-dependent UI.
- **Never require scrolling to see an overdue ticket** — overflow pages, oldest first.

## 7. Expo / pass view

Sees the whole ticket across all stations: which stations are done, which are outstanding, what
is blocking the plate-up. Bumps the **ticket** (as opposed to a station's slice), which is what
transitions it to `ready` and fires the guest-facing notification for pickup orders.

Expo also holds: fire-next-course, rush, reprint/reissue, transfer to another table, and void.

## 8. Pacing / throttling

`stations.max_active_tickets` and a venue-level cap on tickets in flight. When exceeded, new
online orders' promised times extend automatically rather than the kitchen silently drowning.
This is the same pacing principle as `max_covers_per_slot` in bookings and
`max_orders_per_slot` in ordering — **one concept, three surfaces; keep the config language
identical across them** so a manager learns it once.

## 9. Offline resilience — non-negotiable

**The kitchen cannot stop because the internet did.** Station screens run as an installable web
app with a local cache:

- Tickets already received stay on screen and remain fully interactive.
- Bumps, recalls and fires queue locally and sync on reconnect (idempotency key per event).
- A visible, unmissable connection banner — degraded state must never be silent.
- On reconnect, server state wins for ticket *content*, local events replay for ticket *status*.
- Optional venue-local relay for large sites so screens survive a WAN outage as a group.

Design `ticket_events` as the sync unit, not ticket state. Events are commutative and
idempotent; state is not.

## 10. Metrics (feeds reporting and, later, the ads/Criota loop)

Per ticket and per item: received→first-viewed, →started, →ready, →bumped. Rolled up by
station, daypart, day of week, and channel. Answers "how long is a Friday 7pm main taking",
"which station is the bottleneck", "are delivery orders slowing dine-in". Restaurants have
never had this and it demos extremely well.

## 11. Hardware

Cheap Android tablets or any browser-capable screen — the app is a web app, no native build,
no per-device provisioning beyond pairing a `device_token`. Optional physical bump bars are
just keyboard input; map keys to bump/recall/page. Kitchen-grade screens can come later; do not
gate the module on hardware partnerships.

## 12. Config surface

`stations[]` · `routing_rules` · `layout_per_station` · `escalation_thresholds`
· `auto_fire_next_course` · `auto_fire_delay` · `course_map` · `max_active_tickets`
· `alert_sound` · `alert_repeat_seconds` · `show_allday_counts` · `bump_requires_confirm`
· `offline_relay_enabled`
