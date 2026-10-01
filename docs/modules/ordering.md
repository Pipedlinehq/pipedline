# MODULE — `ordering` (online, pickup-first)

Pickup only at v1. Delivery is a parked module; the schema below does not preclude it.

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
