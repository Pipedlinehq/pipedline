# MODULE — `ordering` (online, pickup-first)

Pickup only at v1. Delivery is a parked module; the schema below does not preclude it.

## As built: console depth, wave 2 (2026-10-13)

Patterns 2, 7 and 10 of `docs/COMMERCE_ADMIN_PATTERNS.md` section 3 (`docs/CONSOLE_IA.md` section 9).
Code: `packages/modules/src/ordering/{axes,unfinished,drafts}.ts` and the additions in `orders.ts`,
`payment.ts`, `templates.ts`, `tools.ts`; migration `db/migrations/0770_orders_bookings_depth.sql`;
tests `packages/modules/test/orders-depth/`; browser `tests/e2e/63-console-orders-depth.e2e.ts`.

- **Three status axes + "Came from"** (`axes.ts`). Derived, never stored: kitchen from `status` and
  `channel` (none · new · accepted · cooking · ready · collected | delivered | served · stopped), money
  from `payment_status`, `status` and `source` (unpaid · due · paid · partly_refunded · refunded ·
  voided; `due` is an unpaid phone or function order, `voided` one that will never be paid), how it
  leaves from `channel` (pickup · table · delivery). Stored: `orders.source` (`order_source` enum:
  website · qr · phone · assistant · square). `createOrder` sets qr for a table order and takes
  `website | assistant` from the page (the venue site passes `assistant` when a guest's assistant
  handed it a cart); drafts are `phone`; `square` is reserved for the till. `listOrders` filters
  `kitchen[]`, `money[]`, `leaves[]`, `source[]`, `unfinished`, `drafts`. `OrderView.axes`.
- **Didn't finish** (`unfinished.ts`, job in `orders.ts`). `createOrder` books
  `ordering.detect_abandoned` at `abandoned_after_minutes` (config, default 10) for a pickup or
  delivery with an email or phone. The job marks `abandoned_at` when the order is still
  `pending_payment` or has lapsed (`lapsed_at`, set by the expiry job), tracks `order.abandoned`,
  and marks it recovered at once if the guest has already paid a later order. `listUnfinishedOrders`
  (host, front of house, managers). `nudgeUnfinishedOrder`: one transactional `order.nudge`
  (email, else SMS) keyed `order:<id>:nudge`, pointing at the order's own pay page while it can be
  paid, else the venue's order page; records `nudge_sent_at`, `nudge_message_id`, `nudge_status`
  (`queued` | `suppressed:<reason>`); audited `order.nudge_sent`, event `order.nudged`; a second
  nudge is `conflict`. No consent is recorded; the outbox's bounced/complained suppressions stand.
  `markRecoveredOrders` (called by `settlePayment`): the paid order itself if unfinished, and any
  earlier unfinished order at the venue by the same customer, email or phone → `recovered_at`,
  `recovered_order_id`, event `order.recovered`. `ordering.purge_unfinished` (daily, per org):
  three months after `abandoned_at`, never paid → name, contact, note, item notes and `customer_id`
  cleared, `purged_at` set, audited `order.unfinished_purged`, event `order.purged`. The row stays
  (status history is append-only; offers and the ledger may point at it).
- **Phone and function orders** (`drafts.ts`). `planDraftOrder` / `createDraftOrder` (host, front of
  house, managers; a custom item needs a manager): menu lines priced from `getOrderableItems` at the
  wanted time (86'd items refused; `exclude_alcohol` kept for pickup; required choices enforced; no
  slot, minimum or window), custom items (`name`, `priceCents`, `qty`, category "Custom",
  `menu_item_id` null), tax from the org; status `draft`, `source` phone, `promised_at` = wanted
  time, `hold_until`, a tracking token; audited `order.draft_created`, event `order.drafted`.
  `sendPayLink`: moves a draft to `pending_payment`, books `ordering.expire_unpaid` for
  `hold_until` (else the wanted time, else 30 days), sends `order.pay_link` with the tracking URL
  (`/order/t/<token>`), whose pay panel is `payOrder` by tracking token: the same checkout as every
  online order, for the full amount. `markDraftPaid` (manager): a `payments` row with provider
  `manual`, then `settlePayment` as for a card (ledger tender = cash | bank | other from
  `orders.paid_by`, ticket, confirmation, placed/accepted); audited `order.marked_paid` with the
  reason; `refundOrder` refuses a manual payment. `cancelDraftOrder`. `ordering.expire_drafts`
  (daily): drafts with `updated_at` over a year old are cancelled ("Not used for a year.").
- **Not built: deposits.** The payment path charges an order's whole total once and settles the
  order as paid in the same step. A deposit needs a partial payment state, a second charge for the
  balance, a ledger row that is not yet a sale and a kitchen docket that waits: none of that exists
  cleanly, so the pay link is for the full amount and the module's `CLAUDE.md` records the gap.
- Tools: `orders_list` (`show`: waiting · live · recent · unfinished · drafts; `came_from`), `order_nudge`,
  `order_draft_create`, `order_pay_link_send`, `order_mark_paid`. Templates: `order.nudge`,
  `order.pay_link`. Events: `order.abandoned`, `order.nudged`, `order.recovered`, `order.purged`,
  `order.drafted`, `order.pay_link_sent`, `order.marked_paid`, `order.draft_expired`.
- Fix on the way: `trackingUrl` now builds `/order/t/<token>`, the path the site serves; it built
  `/order/<token>`, which had no page.

## As built: the bill — channel prices, offers and surcharges on totals (2026-10-13)

Closes the two gaps wave 2 left for ordering (`CONSOLE_IA.md` section 9: the Menu row's "passing
the order's channel as the surface" and the Offers row's "has yet to call `automaticAdjustments`,
`codeCombinesWith` and `applicableSurcharges`"). Code: `packages/modules/src/ordering/bill.ts`
(new), `pricing.ts`, `drafts.ts`, `orders.ts`, `payment.ts`, `tickets.ts`, `templates.ts`;
migration `db/migrations/0810_order_surcharges.sql` (`orders.surcharge_cents`, `orders.surcharges`
jsonb); tests `packages/modules/test/orders-depth/bill.test.ts`; browser
`tests/e2e/67-site-order-offers.e2e.ts`.

- **Channel-aware pricing.** `buildCart` and `planDraftOrder` pass the order's own channel as the
  menu surface (`pickup`, `delivery`, or `qr` for a table order), so `getOrderableItems` answers
  with that channel's price list and its "where it shows": a delivery order is priced from the
  delivery price, a pickup from the pickup price, and an item hidden from Pickup is not found for a
  pickup (cart page, checkout and phone order alike) while a delivery still has it. The site's
  order page, the guest plugin's `order_start` (channel `pickup`) and drafts all go through these
  two functions, so nothing else had to change. Client-supplied prices are still dropped by the schema.
- **The order of the bill** (`bill.ts`): subtotal − typed codes − automatic offers → + surcharges →
  + delivery → tax → + tip = total. `bill.ts` is the one file in ordering that calls the offers
  module directly (`automaticAdjustments`, `codeCombinesWith`, `applicableSurcharges`,
  `surchargeNotice`), noted as the exception in `contract.ts`; everything in it applies only where
  the offers plugin is switched on for the venue.
- **Automatic offers.** After the code adjusters, `automaticOffers` asks offers for the offers that
  apply to this guest, venue and moment, capped like a code's discount (whole cents, never more than
  is left to come off, the delivery fee included for a delivery order). Worked out afresh at every
  quote (`priceCart`) and again at `createOrder`, which never trusts the quote; the order freezes
  the result in `adjustments` (`code` `auto:<offerId>`, `ref.auto = '1'`). At payment
  `commitAdjustments` hands each to `offersAdjuster.commit`, which writes one `offer_uses` row with
  `order_id` and the sale's `transaction_id`; a replayed payment is one use (the `once()` key and
  the row's uniqueness). Each committed adjustment is audited `order.offer_applied` (`code`,
  `label`, `amountCents`, `automatic`, `offerId`, `transactionId`); the offers module tracks
  `offer.applied` / `offer.redeemed`. An offer with a per-guest limit is counted per `customer_id`,
  which `createOrder` resolves from the signed-in guest or the email or phone given, before pricing.
  `orders.promo_code` keeps the first typed code only.
- **Codes together.** For each typed code, after its adjuster has priced it, `codeClash` asks
  `codeCombinesWith` whether it may sit with the adjustments already accepted; a refusal is a
  `rejectedCodes` entry with the offers module's words ("That offer cannot be used together with
  Bill five.") and `createOrder` refuses the order with the same message. A loyalty reward counts as
  a whole-bill offer that combines with nothing (offers' rule).
- **Surcharges.** `surchargesFor(ctx, venueId, at, base)` with `at` the day the order is for (the
  pickup slot, the wanted time of a phone order, else now) and `base` the subtotal after every
  discount; each surcharge is `{ id, name, percentBp, reason, notice, amountCents }`, frozen onto
  the order (`surcharges`, `surcharge_cents`) so a later change to the rate does not change what
  was charged. Tax is worked out on subtotal − discounts + surcharges + delivery. Never a card
  surcharge: the offers module refuses to create one. The till push lists each surcharge as a
  service charge beside the delivery fee.
- **Where each line appears.** `PricedCart`, `OrderView` and `TrackedOrder` gain `surcharges[]`,
  `surchargeCents`, `surchargeNotices[]` and `breakdown: TotalsLine[]` (subtotal, each offer as its
  own line with its plain-words summary, each surcharge as its own line with its notice, delivery,
  tip, tax, total, refunded; `totalsBreakdown` is the one function every surface prints from);
  `OrderView.adjustments[].automatic` says an offer applied by itself. The site's order page shows
  the surcharge notice before anything is chosen (`CheckoutOptions.surchargeNotice`) and each line
  as the cart is priced; the menu page prints the notice under the menu (`ordering.surchargeNotice`);
  the receipt (`/order/t/<token>`), the console order page and the kitchen screen's ticket
  (`TicketView.bill`) print the same lines, and the kitchen email docket gains `charges_line`.
- **Left out.** A staff-built phone or function order carries the surcharge for its day but no
  automatic offer (staff have no way to see or decline one; add it as a custom item). The ledger's
  `CanonicalTransaction` has no surcharge field: the sale's `total_cents` includes the surcharge and
  `subtotal_cents` is the food, as with the delivery fee. A "free delivery" automatic offer is
  counted among the discounts the surcharge comes after (the surcharge base is the subtotal after
  every adjustment). An automatic offer priced onto an order that ends before the order is paid is
  honoured at the price the guest was shown, as a code is.

## 1. Menu model — shared with website, and later the POS

```sql
menus(id, venue_id, name, is_active, available_days[], available_from, available_to)
-- separate breakfast / lunch / dinner / weekend menus with availability windows

menu_sections(id, venue_id, menu_id, name, description, sort_order, is_visible)

menu_items(id, venue_id, section_id, name, description, price_cents,
           image_url, sort_order,
           is_available, unavailable_until,     -- "86'd" until end of service
           dietary_tags[],                       -- gf, df, v, vg, nuts...
           allergens[], spice_level, calories,
           prep_minutes, max_per_order,
           is_visible_online, is_visible_in_venue,
           square_catalog_id NULL)

modifier_groups(id, venue_id, name, selection_type,   -- 'single' | 'multi'
                min_selections, max_selections, is_required, sort_order)
modifiers(id, venue_id, group_id, name, price_delta_cents, is_default,
          is_available, sort_order)
item_modifier_groups(item_id, group_id, sort_order)
```

**One menu model serves the website, ordering, and eventually the POS.** Do not let the
website hold "display menu" content separately from the ordering menu — restaurants change
prices and 86 items constantly, and two sources of truth means the website advertises a dish
the kitchen ran out of at 6pm.

**`is_available` + `unavailable_until`** is the 86 button. It must be one tap from the
kitchen's phone. This is a small feature that gets mentioned in every restaurant demo.

### 1a. Menu as built (2026-10-13, console depth pass; `docs/CONSOLE_IA.md` section 9, patterns 11 and 12)

The model above is live with these additions (migration `0790_menu_depth.sql`; module guide
`packages/modules/src/menu/CLAUDE.md`):

- **Scheduled menus and sections.** `menus.live_from` / `live_until` and
  `menu_sections.live_from` / `live_until` (instants). A manager sets them as a venue-local date
  and time ("Brunch goes live Saturday 8:00", "Winter menu from 1 June"); the module turns them
  into instants when saved, so daylight saving cannot move them. `getPublicMenu`,
  `getOrderableItems`, the QR menu, ordering and the guest plugin's `menu_read` all honour them.
  States: not active · scheduled · live · retired (`scheduleStateAt`). The console shows them and
  previews them as of any date and time.
- **Sold out until.** The 86 button's `until` is end of service · tomorrow (the venue's next
  opening) · a time · until someone puts it back. The return is worked out at read time from
  `unavailable_until`, never by a job, so every surface flips at the same instant and nothing can
  run late or twice. Shown on the kitchen screen ("back 9:30 pm") and the console.
- **Where it shows.** `menu_items.shown_on text[]` over five channels: `website`, `qr`,
  `pickup`, `delivery`, `assistants`. `is_visible_online` (= website) and `is_visible_in_venue`
  (= qr) stay and a trigger keeps the three in step. Sections carry a default for new items;
  `menu_settings.new_items_shown_on` is the venue's default ("new items go everywhere"). The
  public menu's `surface` is one of the five, or the older `online` (website) / `in_venue` (qr).
- **Price lists per channel.** `menu_item_prices(item_id, channel, price_cents)`, one row per
  item and channel, over the item's own price. `getPublicMenu` and `getOrderableItems` return the
  channel's price; `priceFor(ctx, itemId, channel)` answers one line. Ordering passes the order's
  channel as the surface (`pickup`, `delivery`, `qr`) in `pricing.ts` and `drafts.ts` (2026-10-13,
  "The bill" above), so a channel price and a per-channel hiding reach every order.
- Assistant tools: `menu_list` (adds schedule, sold-out-until, channels, channel prices),
  `menu_set_availability` (the four `until` choices), `menu_schedule`, `menu_show_on`,
  `menu_set_channel_price`.

## 2. Ordering flow

```sql
orders(id, org_id, venue_id, customer_id, reference,
       channel,              -- 'pickup' | 'delivery' | 'dine-in-qr'
       status,
       pickup_slot_start, pickup_slot_end, requested_asap,
       subtotal, discount_total, tax_total, tip_total, total,
       promo_code, loyalty_redemption_id NULL,
       payment_status, square_payment_id, square_order_id,
       customer_note, created_at)

order_items(id, order_id, menu_item_id, name_snapshot, qty,
            unit_price, modifiers jsonb, note, line_total)

order_status_history(id, order_id, from_status, to_status, at, by)
```

`draft → placed → accepted → preparing → ready → collected`
branches: `rejected` · `cancelled` · `refunded`

## 3. Pickup capacity — slot pacing

Same lesson as bookings: a kitchen has a throughput ceiling.

```sql
pickup_slots config: slot_minutes, max_orders_per_slot, max_items_per_slot,
                     lead_time_minutes, cutoff_before_close_minutes
```

Compute available slots from prep times + current load. Offer "ASAP (approx 25 min)" plus
scheduled slots. Auto-throttle: when a slot fills, it disappears from the picker.

## 4. Payments — Square, kept out of PCI scope

Card entry via Square's client-side Web Payments SDK; the card never touches your servers,
which keeps you at the lightest PCI compliance tier. Your backend creates and confirms the
payment against the venue's connected Square account.

Each venue connects their own Square account by OAuth during onboarding; store the merchant
and location ids per venue. Money moves merchant-direct — you are not in the funds flow, which
avoids becoming a payment facilitator and everything that entails.

## 5. Order routing to the kitchen

Configurable per venue, because kitchens differ:
- Kitchen display view (tablet, auto-refreshing, audible alert on new order)
- Email to a kitchen address
- SMS to the manager
- Printed docket (later — needs a print bridge)

New-order alerting must be loud and repeat until acknowledged. A missed online order is the
fastest way to lose a venue.

## 6. Config surface

`pickup_enabled` · `slot_minutes` · `max_orders_per_slot` · `lead_time_minutes`
· `cutoff_before_close` · `asap_enabled` · `tipping_enabled` · `tip_presets[]`
· `min_order_cents` · `promo_codes_enabled` · `kitchen_routing[]` · `auto_accept`
