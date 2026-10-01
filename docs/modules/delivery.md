# MODULE — `delivery`

> Draft, 2026-09-30. Was "parked" in `MODULES.md`. Staging at the bottom matches `ROADMAP.md`.

"Delivery" is two different things. They have opposite value to the platform, so they are
specified separately.

| | A. First-party delivery | B. Marketplace orders |
|---|---|---|
| Where the guest orders | the venue's own site (ours) | Uber Eats, DoorDash |
| Who owns the guest | the venue | the marketplace |
| Who carries it | a courier service we dispatch by API | the marketplace |
| Identity for us | full, with consent | none |
| Build | an extension of `ordering` | ingest only, later |

## A. First-party delivery — build this

The guest orders on the venue's site exactly as for pickup, enters an address, and a courier is
dispatched through a courier-as-a-service API. The venue keeps the customer, the data and the
margin, and pays a per-delivery fee.

Both main providers operate in Australia and offer an API for orders placed on the merchant's own
channel (checked 2026-09-30; see Sources). Onboarding terms, coverage and alcohol handling are
still to confirm (`VERIFY.md` #15).

### Adapter contract

```ts
interface CourierAdapter {
  key: string                                   // 'uber_direct' | 'doordash_drive'
  quote(venueId, dropoff, readyAt): Promise<Quote>        // fee, ETA, expiry
  create(venueId, order, quoteId): Promise<Delivery>      // idempotent on our order id
  cancel(venueId, deliveryRef): Promise<CancelResult>     // may carry a fee
  onWebhook(payload): Promise<DeliveryEvent[]>            // signature-verified, deduped
}
```

One contract, two adapters, chosen per venue. A second adapter is also the failover when the
first has no courier available.

### Schema

```sql
deliveries(id, org_id, venue_id, order_id, provider, external_ref,
           quote_id, quote_expires_at,
           courier_fee_cents,            -- what the venue pays
           customer_fee_cents,           -- what the guest was charged
           status,                       -- 'quoted' | 'requested' | 'courier_assigned' | 'picked_up'
                                         -- | 'delivered' | 'failed' | 'returned' | 'cancelled'
           pickup_eta, dropoff_eta, tracking_url,
           dropoff_address jsonb, dropoff_lat, dropoff_lng, dropoff_notes,
           proof jsonb,                  -- photo / signature / PIN, as the provider returns it
           idempotency_key UNIQUE, created_at)

delivery_status_history(id, delivery_id, from_status, to_status, at, source, raw jsonb)

delivery_zones(id, venue_id, name, kind,       -- 'radius' | 'polygon'
               radius_m NULL, polygon jsonb NULL,
               min_order_cents, fee_rule jsonb, is_active)
-- fee_rule: pass-through, flat, subsidised to a cap, free above a spend
```

### Flow

1. Address at checkout → inside a zone? → live quote → fee shown before payment.
2. Payment confirmed → order accepted → courier requested **timed to the prep time**, not at
   order time. A courier waiting at the pass costs the venue; food waiting for a courier costs
   the guest.
3. Status webhooks → the guest gets a tracking link by SMS or email through the comms outbox.
4. Delivered → order complete → ledger transaction with `channel = 'delivery'`.

### The parts that bite

- **Quotes expire.** Re-quote if the guest lingers at checkout; never charge a stale fee.
- **No courier available.** Decide per venue: try the second provider, offer pickup, or refund.
  Never leave an accepted order with no carrier and no message.
- **Cancellation fees** after a courier is assigned. Who absorbs them is venue config.
- **Failed and returned deliveries.** A refund policy the venue sets, shown at checkout.
- **Late or missing food is the venue's problem in the guest's eyes.** A support path in the
  console with the delivery timeline and proof attached.
- **Kitchen load.** Delivery orders draw on the same pacing caps as pickup and QR. One concept,
  the same config words.
- **Alcohol** needs ID at the door and provider support for it. Off by default.
- **Packaging and food-safety time limits** are the venue's duty; surface a max delivery radius.
- **A delivery order pushed into Square may not show where a pickup order does.** A developer
  forum thread reports delivery-type orders created by API not appearing in Square's order
  screens while pickup-type ones do. Test before relying on it (`VERIFY.md` #14).

## B. Marketplace orders — ingest later, do not build around

The marketplace owns the guest; no name, contact or consent reaches the venue. Integrating here
adds nothing to the identity graph. It is still worth having, later, for two reasons:

- **A true revenue and kitchen-load picture.** Ledger rows with `source = 'aggregator'`,
  `customer_id` always NULL.
- **One menu and one 86.** Availability and price changes pushed to every channel in one write.

Do this through aggregator middleware (one integration across marketplaces), never a direct
integration per marketplace; those are partner-gated.

## What not to build

Our own drivers, dispatch, or routing. A consumer marketplace. Direct marketplace integrations.

## Config surface

`delivery_enabled` · `providers[]` (ordered; first is preferred) · `zones[]` · `fee_rule`
· `min_order_cents` · `courier_request_lead_minutes` · `no_courier_fallback`
· `cancellation_fee_policy` · `alcohol_enabled` · `max_radius_m` · `tracking_channel`

## Proposed staging

A with Stage 2, after pickup ordering has run on a real venue. B is deferred until venues ask.

Depends on: `ordering`, `ledger`, `comms`, a `connections` row per courier provider (`modules/hub.md` §4).

## Sources

- Uber Direct, Australia: https://merchants.ubereats.com/au/en/resources/articles/what-is-white-label-delivery/ · https://developer.uber.com/docs/deliveries/overview
- DoorDash Drive, regions: https://developer.doordash.com/en-US/docs/drive/overview/faqs/
- Square delivery-type orders not appearing: https://developer.squareup.com/forums/t/orders-api-delivery-fulfilments-created-successfully-but-not-appearing-in-orders-manager-or-square-kds/26705
