# MODULE — `qr` (QR menu, order and pay at the table)

> Draft, 2026-09-30. Staging at the bottom matches `ROADMAP.md`.

Not a separate product. The QR menu is the website's menu page opened with a table in context,
and QR ordering is `ordering` with `channel = 'dine-in-qr'`. This module owns only the codes,
the table context and the dine-in checkout differences.

## 1. Why it sits early

- **It works at every POS tier.** A venue on a closed POS gets a live menu on day one.
- **It is the dine-in identity capture that does not depend on a card identifier.** A guest who
  orders and pays at the table has given an itemised order and, if they choose, a contact and a
  consent. That closes most of the "dine-in is invisible" gap without the card route, which is
  consent-gated and weaker than first assumed.
- **Every scan is an event** with a table and a time, before anyone orders.

## 2. Codes

```sql
qr_codes(id, org_id, venue_id, code UNIQUE,     -- short slug; the QR encodes https://<host>/q/<code>
         kind,                                  -- 'menu' | 'table' | 'counter' | 'campaign'
         label,                                 -- the venue's own: "12", "T4", "Bar"
         table_id NULL, area_id NULL,
         target_path,                           -- resolved server-side at scan time
         campaign_id NULL, creator_id NULL,     -- a code on a flyer or a creator's post
         is_active, print_batch, created_at)
```

**Codes are dynamic.** The printed code points at `/q/<code>`; the destination is resolved on
our side. A venue never reprints because a menu, a domain or a table number changed.

`label` is free text so the module works with `bookings` off. When a floor plan exists,
`table_id` links to it; the module never reads the bookings tables directly.

A `campaign` code carries `creator_id` and stamps `acquisition_*` on a new customer, the same
way a landing link does.

## 3. Stages

| Stage | What the guest gets | Needs |
|---|---|---|
| **Q1 — view** | live menu: availability, dietary filters, allergens, prices | `website`, the menu model |
| **Q2 — order and pay** | order from the table, pay by card, order reaches the kitchen | `ordering`, a payment connection |
| **Q3 — known guest** | email receipt, loyalty earn, reorder, opt-ins | `identity`, `loyalty`, `comms` |

## 4. Q1 — the menu

One menu model, as `modules/ordering.md` already requires: the QR menu, the website menu and
ordering read the same rows, so an 86 in the kitchen is gone from the table's phone at once.

- Allergen and dietary display is a safety surface. Same rule as the KDS: visible without a tap.
- Cache the menu on the device after first load so weak reception in a basement still shows it.
  Ordering needs a connection and says so.
- `is_visible_in_venue` already exists on `menu_items`; QR respects it.
- Printable code sheets and table talkers generated from brand tokens, per table, in one PDF.

## 5. Q2 — order and pay

- **Pay per order in v1.** Open tabs need a card pre-authorisation and a close-out flow; leave
  them until venues ask.
- Payment through the venue's own connected account, card entered in the processor's hosted
  fields, merchant-direct. We stay out of the funds flow and out of PCI scope, as in `ordering`.
- **The order must reach the kitchen the way the kitchen already works.** For a Square venue,
  push the order to Square so it prints or shows where staff already look (`VERIFY.md` #14).
  Otherwise use the kitchen routing options in `ordering` §5.
- Table number travels on the order and on the ticket.
- Same pacing config as pickup: when the kitchen is at its cap, quoted times extend.
- Rounds: a table orders more than once. Each round is its own paid order, linked by a
  `table_session` so the venue sees the table's total.

```sql
table_sessions(id, org_id, venue_id, qr_code_id, opened_at, closed_at, covers NULL)
-- orders.table_session_id NULL links rounds; closes after a configurable idle period
```

- **Alcohol:** the venue's responsible-service duties do not move to the phone. Staff bring the
  drink and make the call. Offer a per-venue switch to exclude alcohol from QR ordering.
- **Card surcharges:** Our research records a ban on
  eftpos, Mastercard and Visa surcharges from 1 Oct 2026, with service and booking fees outside
  it. Confirm the current rule before building any fee line into checkout (`VERIFY.md` #16).

## 6. Q3 — the guest chooses to be known

At checkout, separate unticked boxes, each recorded with the wording shown (`SCHEMA.md` §2a):

- email me the receipt (transactional, no marketing consent implied)
- join the loyalty program
- send me offers by email / by SMS
- recognise this card next time

A guest who ticks nothing still ordered and paid. The order is in the ledger with no customer.

## 7. What not to build

- A consumer app or a cross-venue guest account. The guest's relationship is with the venue.
- Bill splitting across phones in v1. Each guest or the table pays for what it ordered.
- A per-order commission model by default. That is the incumbents' weak point with venues; how
  this is priced is a business decision, not a module default.

## 8. Config surface

`qr_enabled` · `stage` (view / order) · `exclude_alcohol` · `require_table` · `tipping_enabled`
· `tip_presets[]` · `session_idle_minutes` · `kitchen_routing[]` · `show_prices`
· `receipt_email_prompt` · `loyalty_prompt`

## 9. Proposed staging

Q1 with Stage 1 (it is the website's menu plus a code table). Q2 with Stage 2 (`ordering`).
Q3 with Stage 3 (`loyalty`, marketing comms).

Depends on: `website`, `ordering`, `identity`, `events`.
