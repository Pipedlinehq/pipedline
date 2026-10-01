# delivery — first-party delivery: zones, courier quotes, timed dispatch, tracking

Written from the in-progress state of 2026-10-01; check index.ts for anything newer.

Delivery for orders placed on the venue's own site (docs/modules/delivery.md part A): an address is
checked against the venue's zones and priced by a courier at checkout, a courier is booked when the
food is nearly ready, and the courier's status drives the guest's messages, refunds and order completion.

**Toggleable** per venue (`assertModule`, plus the venue's own `delivery_enabled` pause via `assertDelivery`).
`dependsOn: ['ordering']`. Owns `delivery_zones`, `deliveries`, `delivery_status_history` (tables from
migration 0004, columns added in 0110). History rows hold nothing personal by design.

## Public functions by purpose
Checkout (public, no role; org from the host):
- `quoteDelivery(app, actor, quoteInput)` checks zone, `max_radius_m`, alcohol, asks the preferred courier then the next; saves a `quoted` delivery. Rate-limited per IP (30/10 min) and per venue. Returns `deliveryId` to pass to ordering.
- `assertDelivery(ctx, venueId)` module on and `delivery_enabled`. `addressInput`, `quoteInput`.
- `getDeliveryTracking(ctx, trackingToken)` guest tracking page by the order's token; no address or contact details. Rate-limited per IP.
Console:
- Zones: `saveZone(ctx, zoneInput)`, `deactivateZone(ctx, zoneId)` (manager, audited); `listZones(ctx, venueId, {includeInactive?})` (read_only).
- Settings: `getDeliverySettings(ctx, venueId)` (read_only), `updateDeliverySettings(ctx, deliverySettingsInput)` (manager; partial config merged, validated whole by core `setModule`).
- `getDelivery(ctx, deliveryId)` full view with timeline and proof (kitchen / front_of_house / host, or manager+); `getDeliveryForOrder(ctx, orderId)`; `listDeliveries(ctx, listDeliveriesInput)` (read_only; suburb and postcode only; unordered quotes hidden unless asked by status).
Webhooks and worker:
- `handleCourierWebhook(app, {plugKey, rawBody, headers, url})` signature checked with the delivery's connection `webhookSecret`, claimed, then the delivery is re-fetched from the provider. Unknown delivery and bad signature get the same answer.
- `applyProviderState(ctx, deliveryId, state, source, hint)` records a provider state; never moves backwards (`RANK`).
- Helpers: `guestFee(rule, courierFeeCents, subtotalCents)`, `distanceM`, `insidePolygon`.

## Hooks
- Registers `ordering.registerDeliveryPricing` (`getQuote` re-prices from the server's cart; `attachToOrder` ties one quote to one order).
- Registers `ordering.onOrderStatusChanged`: `accepted` schedules `requestCourierJob` at `promisedAt - courier_request_lead_minutes`; `rejected`/`cancelled`/`refunded` cancels (enqueues `cancelCourierJob` once a courier is booked); `placed` copies the order's customer onto the delivery.
- Registers `identity.onCustomerMerge`, `identity.onCustomerErase` (address, notes, proof, courier name cleared; fees and timeline kept), `identity.registerCustomerDataProvider('deliveries', …)`.
- Calls ordering's fulfilment functions (`completeOrderByCourier`, `cancelUndeliverableOrder`, `switchOrderToPickup`, `refundForDelivery`, `flagOrderForStaff`) instead of writing order tables.

## Config surface (`deliveryConfig`, venue)
`delivery_enabled` pause switch · `providers[]` courier plug keys, preferred first (max 5) · `fee_rule`
(`pass_through` | `flat` | `subsidised` | `free_above` with `otherwise`), a zone's own rule wins ·
`min_order_cents` where a zone sets none · `courier_request_lead_minutes` (default 10) ·
`failover_to_next_provider` · `no_courier_fallback` `refund` | `offer_pickup` · `failed_delivery_refund`
`full` | `delivery_fee` | `none` · `cancellation_fee_policy` `venue_absorbs` | `deduct_from_refund` ·
`alcohol_enabled` (off) · `max_radius_m` (default 8000) · `tracking_channel` `auto` | `email` | `sms` | `none`.
No org settings namespace.

## Jobs, schedules, events, templates, tools
- Jobs: `delivery.request_courier` (5 attempts; booking via `once` keyed `courier:<id>:<provider>`; no courier anywhere → fallback), `delivery.cancel_courier`, `delivery.refresh`, `delivery.reconcile`.
- Schedule: `delivery.reconcile` every 5 min per org, only while a delivery is in flight or scheduled; re-fetches deliveries not checked for 10 min and re-queues lost courier requests.
- Events: `delivery.quoted`, `delivery.requested`, `delivery.status_changed`, `delivery.delivered`, `delivery.failed`, `delivery.cancelled`.
- Templates (transactional, email + sms each): `delivery.dispatched`, `delivery.picked_up`, `delivery.delivered`, `delivery.failed`, `delivery.no_courier_pickup`.
- Tool: `deliveries_summary` (read, `orders:read`, venue-scoped): on the road now, period totals, fees; no addresses or names.

## Simulated vs real
Courier port (`packages/core/src/ports/courier.ts`). Plugs declared here: `uber-direct`, `doordash-drive`
(org-level connections, real adapters in `packages/adapters/src/uber-direct` and `doordash-drive`, both
`supportsAlcohol: true`). Simulators `sim-courier-a` / `sim-courier-b` in `packages/adapters/src/sim/courier.ts`
(`supportsAlcohol: false`); the fixture seeder `25-delivery.ts` uses both. Tests: `packages/modules/test/commerce-2/delivery.test.ts`.

## Known gaps
- No route in `apps/web` calls `handleCourierWebhook` or `quoteDelivery` yet; only the seeder and tests do.
- Part B of the spec (marketplace orders) has no code.
