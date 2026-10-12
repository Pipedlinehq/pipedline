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
  channel's price; `priceFor(ctx, itemId, channel)` answers one line. **Ordering must pass the
  order's channel as the surface** (`pickup`, `delivery`, `qr`) for a channel price or a
  per-channel hiding to reach the order; `pricing.ts` still passes `online`.
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
