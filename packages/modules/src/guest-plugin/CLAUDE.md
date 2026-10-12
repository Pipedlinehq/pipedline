# guest-plugin — the venue inside guests' assistants (v1)

Spec: `docs/modules/guest-plugin.md` ("v1 as built" at the top). Research behind it:
`content-engine/channel/research/selling-inside-assistants.md`.

A **public** MCP endpoint a guest's assistant (ChatGPT, Claude) adds by its address: find a
Pipedline venue, read its menu and hours, book a table, start a pickup order. The guest always
pays on the venue's own order page (OpenAI's "external checkout"); no payment is taken in the
chat. Alcohol is never orderable here. No vouchers, no delivery, no guest accounts.

It is **not** the hub. The hub's server (`hub/server.ts`, `/api/mcp`) acts for a staff member
behind an access key; this one (`server.ts`, `/api/guest/mcp`) has no sign-in and acts for an
anonymous member of the public. Its tools are **not** `defineTool` tools (those are offered to
staff keys by scope); they live in `GUEST_TOOLS` and are served only here.

**Toggleable** per venue (key `guest-plugin`), `dependsOn: []`. **Owns no tables** and has no
migration: proposals and cart links are signed, not stored; limits use core `rate_limits`.
Uses: `tenancy` (`getVenue`, `getOrg`, `openWindows`, `listPublicVenues`; reads `venues`,
`orgs`, `venue_modules`, `domains`), `menu` (`getPublicMenu`), `bookings`
(`getBookingAvailability`, `requestBooking`, `whenLine`, `partyLine`), `ordering`
(`priceCart`, `getPickupSlots`), `identity` (`normaliseEmail`, `normalisePhone`), `website`
(`websiteModule` to know the venue has a site). Core: `secrets.orgKey(org, 'assistant_links')`.

## Public functions by purpose

The directory (`directory.ts`, **platform-level, `app.db`**: the only cross-organisation read,
documented there): `findListedVenues(app, query)` (every word must match name, trading name,
suburb, postcode or cuisine; wildcards escaped; 10 at most), `listedVenueOrg(app, venueId)`.
Listed = plugin on + venue `live` + organisation `live`.

Guest-facing service functions (`guest.ts`; no role check, anonymous; a paired screen is
refused; plugin off, venue not live or org not live → not found `Venue not found`):
- `guestVenue(ctx, venueId)` → `{ venue, cfg }`.
- `assistantVenueInfo(ctx, { venueId })` → address, phone, website, cuisine, price band, seven
  days of hours (venue-local `HH:MM-HH:MM`), `openNow`, bookings offered (+ instant/request,
  max party, phone rule, note), pickup offered (+ asap), the venue's `assistant_note`.
- `assistantMenu(ctx, { venueId, at? })` → `getPublicMenu(surface 'assistants')` (an item the venue
  hid from "Inside assistants" is left out; the `assistants` channel's price applies) cut to
  `visible_menus`, plus `orderable`.
- `assistantBookingTimes(ctx, { venueId, date, partySize })` → `getBookingAvailability`.
- `assistantPickupTimes(ctx, { venueId, date? })` → `getPickupSlots`.
- `assistantBooking(ctx, { venueId, date, time, partySize, name, email?, phone?, note?, proposal? })`
  → `TwoStep<AssistantBooked>`. Without `proposal`: availability and contact checked, nothing
  written, `{ step: 'ask', summary, proposal, expiresAt }`. With it: `requestBooking` with
  `channel 'assistant'` and `requestKey = gp-<sha256(proposal)[0..40]>` (a replay is the same
  booking). Daily caps: 5 per guest contact, 30 per address (`rate_limits`).
- `assistantOrder(ctx, { venueId, items[{itemId, quantity, optionIds}], pickupSlot ('asap' | slot ISO), proposal? })`
  → `TwoStep<AssistantCheckout> & { cart }`. Refuses (in words, `invalid`) items not on a
  visible menu at that time, alcohol, sold-out items and options, then `priceCart` issues
  (required choices, minimum order, a bad or full slot). The yes mints a cart link.
- `openCartLink(ctx, { venueId, token })` → `{ ok: true, cart: { lines, slotStart, slotDate, notices } } | { ok: false, message }`.
  For the venue's order page. Token must be this org's, unaltered, unexpired, for this venue,
  and the plugin still on with ordering offered. Re-checks lines (alcohol / off-menu dropped
  with a notice; sold out kept for the page to show), re-prices with `priceCart`, drops a slot
  that is gone. Rate-limited per address (60 / 10 min). Tracks `assistant_cart.opened`.
- `venueSite(ctx, venue)` → `{ base, orderPath }`: venue's own host → `/order`; an org host
  with one public venue with a website → `/order`; otherwise `/at/<slug>/order`.

The two-step (`twoStep` in `guest.ts`): the proposal (`tokens.ts`, `p1.<claims>.<sig>`) carries
kind, venue, a digest of the details and a digest of the words shown, expiry 15 minutes; signed
with the org key, never the guest's details. The second call must send the same details; if the
words rebuilt now differ (price, rule changed), the guest is asked again (`changed: true`).
Summaries contain only stable words (no "about 20 minutes").

Cart links (`tokens.ts`, `c1.<cart>.<sig>`): venue, lines (item, qty, option ids, uuids packed
to 22 chars), slot or null, expiry 30 minutes. No prices, no names, no notes.

The endpoint (`server.ts`): `handleGuestMcpRequest(app, request, { ip, limits? })`, POST only,
both protocol generations (stateless), `buildGuestServer(call)`, `GUEST_INSTRUCTIONS`.
`tools.ts`: `GUEST_TOOLS` (7), `GUEST_LIMITS` (300 requests / 120 calls per address per
minute, 300 calls per venue per minute). Every output is parsed through its zod object (the
allowlist). Errors: `AppError` message as is; zod as "Some of that was not valid. …"; anything
else logged and answered "Nothing was booked or ordered."

## Hooks

None defined or registered.

## Config surface (`guestPluginConfig`, per venue; every field described)

`visible_menus` (names, case-insensitive; empty = every online menu), `offer_bookings` (true),
`offer_ordering` (true), `assistant_note` ('' = none). On/off is the module switch itself.

## Jobs, schedules, events, templates, tools

- Jobs, schedules, templates: none (booking messages are the bookings module's).
- Events: `assistant_cart.created` (item_count, subtotal_cents, asap), `assistant_cart.opened`
  (item_count, ok). Bookings made here carry `source: 'assistant'` on `booking.requested`.
- Tools (guest endpoint only): `find_venue`, `venue_info`, `menu_read`, `booking_times`,
  `pickup_times` (read-only); `booking_request` (openWorld), `order_start` (two-step).

## Fixtures and tests

- Seeder `packages/fixtures/src/seeders/48-guest-plugin.ts`: on at the diner (note "Walk-ins
  welcome at the bar."), CBD and Newtown; Bondi off.
- Tests `packages/modules/test/guest-plugin/guest-plugin.test.ts` (real MCP client + raw
  current-protocol calls against the real handler). Browser: `tests/e2e/15-site-assistant-cart.e2e.ts`.
- Web: `apps/web/src/app/(platform)/api/guest/mcp/route.ts`; the order page reads `?cart=` in
  `apps/web/src/components/site/order-pages.tsx` and `order/order-app.tsx` (`assistantCart`).

## Simulated vs real

No ports. Nothing in it calls a provider. Unverified against a real ChatGPT or Claude account
(see the spec's "v1 as built").

## Known gaps

- Per-address limits assume the address is the guest's. Assistants call from their provider's
  servers, so many guests share one address; bookings' own per-address limit (20 / 10 min)
  then applies to all of them together. Revisit with real traffic.
- No business feed (`GET /v1/businesses`) for OpenAI's reservation spec; no MCP Apps widget.
- No catalogue resource; the instructions and tool descriptions are the whole guide.
- `visible_menus` matches menu names: renaming a menu hides it until the setting is updated.
- No console screen beyond the generated Features form.
