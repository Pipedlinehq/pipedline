# MODULE — `pos` (tap-touch order entry & tender)

The ambition. Sequenced last among the core modules, but specified now because the ledger,
menu, KDS and loyalty models must not need reshaping when it arrives.

## Staging — how it arrives without a big bang

| Stage | What ships | When |
|---|---|---|
| **P0** | Square stays the POS; we mirror payments into the ledger | v1 |
| **P1** | **Order-entry-only terminal** — staff take the order, it hits the KDS and the ledger; payment still tendered in Square | after KDS is proven |
| **P2** | Tender in our POS via Square Terminal / reader; Square becomes a payment rail only | at scale |
| **P3** | Full POS — cash drawer, offline-first, shift & cash-up | the ambition |

P1 is the sneaky-good stage: it delivers the itemisation, coursing and timing benefit to the
kitchen with **none of the payment, PCI, hardware or offline risk**, because the tender still
happens where it already happens. Most of the module's value lands here.

## 1. Order entry

```sql
pos_sessions(id, venue_id, staff_id, terminal_id, opened_at, closed_at,
             opening_float_cents, closing_counted_cents, variance_cents)

terminals(id, venue_id, name, device_token, kind, last_seen_at, config jsonb)
-- kind: 'counter' | 'handheld' | 'kiosk' | 'kds-companion'

pos_orders(id, org_id, venue_id, session_id, staff_id,
           order_type,          -- 'dine-in' | 'takeaway' | 'bar-tab' | 'phone'
           table_id NULL, tab_name NULL, covers NULL,
           status,              -- 'open' | 'sent' | 'partially_paid' | 'paid' | 'voided'
           opened_at, closed_at)

pos_order_items(id, pos_order_id, menu_item_id, name_snapshot, qty,
                unit_price, modifiers jsonb, note,
                seat_number NULL, course, station_id,
                status,          -- 'pending' | 'sent' | 'voided' | 'comped'
                sent_at, voided_by, void_reason)
```

Entry surface: category grid → item → **modifier prompts in sequence** (required groups block
progression), qty, seat number, course. Held in a `pending` state until **Send**, which is what
creates the KDS ticket. Nothing reaches the kitchen until send — staff must be able to correct
a mis-tap without a void.

Must handle: seat numbering (for split-by-seat later), coursing at entry, item notes, "no
onion" style modifiers, open/misc items, and **hold-and-fire per course**.

Handheld order entry at the table is the same app at a narrower breakpoint — not a separate
product.

## 2. Table & tab management

Open a table from the floor plan (**the same renderer as `bookings`** — one component, three
consumers: plan editor, host view, POS). Transfer an order between tables, merge two tables,
split one table into two orders, move an item between orders, open a bar tab by name or card
pre-auth.

The floor-plan reuse is why `bookings` and `pos` share `tables` rather than each owning their
own — a venue configures its room once.

## 3. Split bills — get this right or lose the venue

Four modes, all expected:
- **By seat** — needs seat numbers captured at entry, which is why seat numbering is in P1
- **By item** — drag items into separate cheques
- **Evenly** — N ways, with cent-rounding rules that must total exactly
- **By amount** — partial payments against a running balance

```sql
cheques(id, pos_order_id, label, subtotal, discount_total, tax_total,
        tip_total, total, status)
cheque_items(cheque_id, pos_order_item_id, qty_share, amount)
payments(id, cheque_id, tender_type, amount_cents, tip_cents,
         square_payment_id NULL, cash_received, change_given,
         status, taken_by, taken_at)
```

Rounding on even splits must reconcile to the cent — allocate the remainder deterministically
to the first cheque, never leave a floating cent.

## 4. Tender types

Card (Square Terminal/reader), cash (with change calculation and drawer open), split tender
across methods, gift card, loyalty redemption, house account / on-account for regulars, and
staff meal. Each with its own permission and its own line in the shift report.

## 5. Discounts, comps, voids — permission-gated and audited

```sql
adjustments(id, pos_order_id, pos_order_item_id NULL, kind,
            -- 'discount_percent' | 'discount_amount' | 'comp' | 'void' | 'price_override'
            value, reason_code, note, staff_id, approved_by_staff_id NULL, occurred_at)
```

Every adjustment carries a **reason code and an actor**, and above a configurable threshold
requires a manager PIN. This is theft prevention, and it is the first thing an experienced
operator asks about. All of it lands in `audit_log`.

## 6. Offline-first — the genuinely hard requirement

A POS that stops when the WAN drops is not a POS. This is the real reason P3 is last.

- **Local-first write model**: orders, items and payments (cash) write to local storage first,
  sync as events. Card payments require connectivity or the reader's own offline mode — be
  explicit with venues about that boundary rather than pretending.
- **Sync unit is the event, not the row.** Same discipline as `ticket_events` — events are
  idempotent and commutative; last-write-wins on rows will lose orders.
- **Terminal-scoped id generation** (ULID with a terminal prefix) so two offline terminals
  cannot collide.
- **Conflict policy declared per entity**, not improvised: order items append-merge; payments
  never merge; voids always win.
- Every terminal shows its own connection and pending-sync state, always visible.

This is where the multi-tenant-serverless architecture stops being a free lunch — the POS is
the one surface that must be local-first. Plan for it as a distinct client, sharing the schema
and API but not the rendering assumptions of the rest of the platform.

## 7. Shift management & cash-up

Clock in/out, opening float, drawer opens (each logged with actor and reason), X report
(mid-shift, non-resetting), Z report (end of shift, resetting), counted-vs-expected variance
by tender type, tip declaration and pooling rules.

## 8. Hardware

Tap-touch terminal (any modern tablet or all-in-one), Square reader/Terminal for cards, receipt
printer (network ESC/POS via a local print bridge), cash drawer (kick via printer), optional
customer-facing display. Everything web-based; the print bridge is the only local binary.

## 9. What P1 must get right so P2/P3 are additive

1. Seat numbers and coursing captured at entry — retrofitting these into an existing order
   model is painful and they are prerequisites for split-by-seat.
2. `pos_orders` writes into the **same `transactions` ledger** as every other source, with
   `source: 'pos'`. No parallel ledger.
3. The floor plan is shared with `bookings` from the start.
4. `ticket_events` is the KDS sync contract, and POS sends produce those events — so P2 and P3
   change where money is taken, never how the kitchen is fed.

## 10. Config surface

`order_types[]` · `require_seat_numbers` · `course_map` · `auto_send_on_item`
· `manager_pin_threshold` · `void_reason_codes[]` · `discount_reason_codes[]`
· `tender_types[]` · `tip_presets[]` · `tip_pooling_rule` · `receipt_template`
· `drawer_kick_on[]` · `offline_mode` · `shift_report_recipients[]`
