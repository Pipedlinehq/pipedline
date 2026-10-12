# MODULE — `guest-plugin` (the venue inside guests' assistants)

## v1 as built (2026-10-04)

Built: the public connection, all seven tools of section 3, the checkout link of section 4 and
the venue settings of section 6. Code in `packages/modules/src/guest-plugin/` (its `CLAUDE.md`
lists every function), tests `packages/modules/test/guest-plugin/guest-plugin.test.ts`, browser
test `tests/e2e/15-site-assistant-cart.e2e.ts`. No migration: the module owns no tables.

**What exists**

- **The endpoint**: `POST https://<platform host>/api/guest/mcp`, streamable HTTP, no sign-in,
  both MCP protocol generations (the 2025 handshake and 2026-07-28), stateless, one server per
  request. Mounted at `apps/web/src/app/(platform)/api/guest/mcp/route.ts`. Separate from the
  staff connection at `/api/mcp`; its tools are not hub tools and no staff key is offered them.
  How to add it to ChatGPT and Claude: `docs/SELF_HOSTING.md` section 12.
- **Who is visible**: venues with the plugin on, venue status `live`, organisation `live`. The
  venue id a tool receives is resolved to its organisation through that public directory (the
  one cross-organisation read, `directory.ts`); everything else runs in the venue's tenant
  transaction as an anonymous visitor. Off, paused or closed answers "No venue with that id
  can be reached through this connection", from the next call on.
- **Tools** (snake_case inputs, every argument described, outputs are zod allowlists):
  `find_venue` (name, suburb, postcode or cuisine; every word must match), `venue_info`
  (address, phone, website, cuisine, price band, seven days of hours, open now, what is
  offered, the venue's note), `menu_read` (`getPublicMenu` surface `assistants` since the menu depth pass of 2026-10-13: an item hidden from "Inside assistants" is left out; before that, surface `online`; item and option
  ids, prices in cents, dietary, allergens, sold out, `alcoholic`, `orderable_here`),
  `booking_times`, `booking_request`, `pickup_times`, `order_start`.
- **Two-step confirmation for an anonymous caller**: the first call of `booking_request` or
  `order_start` changes nothing and returns `summary` (plain words for the guest) and
  `proposal`, a signed token (org key `assistant_links`) holding the venue, a digest of the
  details and a digest of the words, valid 15 minutes. The second call sends the same details
  plus the proposal. Forged, altered, expired, carried to other details or another
  organisation: nothing is done, said in words. If the words would read differently now (a
  price or a booking rule changed), the guest is asked again (`changed: true`). A booking is
  made with `channel 'assistant'` and a request key derived from the proposal, so a replayed
  yes is one booking. No consent is recorded; the bookings module queues its transactional
  confirmation.
- **Checkout link**: `order_start` refuses alcohol, sold-out items and options, items not on a
  menu the venue shows assistants at that time, and anything `priceCart` refuses (a required
  choice, the minimum order, a pickup time that is not a slot with room). Prices are the
  server's; extra fields such as a price are dropped. The yes returns
  `https://<venue host>/order?cart=<token>` (or `/at/<venue>/order` on a group's site): items,
  options and slot only, signed, 30 minutes. The order page verifies it, re-checks and re-prices
  everything, pre-fills the cart (and the pickup time when it is still free), removes `cart=`
  from the address, and the guest pays as usual. A bad or expired link shows a plain sentence
  and an empty cart. Nothing is ordered until the guest pays.
- **Limits**: per address 300 requests and 120 tool calls a minute; per venue 300 tool calls a
  minute; bookings through assistants 5 per guest contact and 30 per address a day; cart links
  opened 60 per address per 10 minutes. Bookings' own per-address and per-venue limits apply too.
- **Settings** (section 6): `visible_menus`, `offer_bookings`, `offer_ordering`,
  `assistant_note`. On/off is the module switch. Fixtures: on at the diner, CBD and Newtown.

**Not built, or not verified**

- Nothing here was tried against a real ChatGPT or Claude account. The protocol behaviour is
  tested with the MCP SDK's own client and hand-written current-protocol calls. Whether
  ChatGPT's developer mode and Claude's custom connectors accept a connection with no
  authentication, which protocol revision each speaks, and how each shows the two-step and
  the link to the guest, are unverified.
- Assistants call from their provider's servers, so per-address limits count many guests
  together. The numbers above are guesses until there is traffic.
- No business feed for OpenAI's reservation spec, no MCP Apps widget, no Google Merchant feed,
  no listing (section 7 is all a person's work). No delivery, vouchers or in-chat payment.

Drafted 2026-10-04. Depends on `bookings` v1 and the existing `menu`,
`ordering`, `tenancy` and `website` modules. Research behind every external claim:
`content-engine/channel/research/selling-inside-assistants.md` (checked 2026-10-04).

## 1. What it is

A **public** assistant connection that a guest's assistant (ChatGPT first, Claude second) uses
to find a Pipedline venue, read its menu and hours, book a table, and start a pickup order. It
is separate from the hub's MCP server, which acts for a venue's staff. Here the caller is an
anonymous member of the public, so the rules are different (section 5).

One connection serves every Pipedline venue that switches the plugin on. That matches the shape
OpenAI's restaurant-reservation spec is written for: one provider plugin plus a feed of many
businesses (research, section 2).

## 2. What is possible today, and what is not (Australia, October 2026)

| Guest wants to | Possible now? | How Pipedline does it |
|---|---|---|
| Find the venue, hours, address | Yes | Read tools |
| Read the menu, allergens, what's sold out | Yes | Read tools over `menu.getPublicMenu` |
| Book a table | Yes (no payment involved) | `bookings` guest functions; confirmation by email/text |
| Order for pickup and **pay inside the chat** | **No.** Instant Checkout is being retired, in-plugin payment is a private beta for select marketplaces, Stripe's agentic commerce excludes Australia | — |
| Order for pickup, **pay on the venue's own page** | Yes. OpenAI calls this external checkout and requires it for plugins | Build the cart in the chat, return a link to the venue's existing checkout with the cart filled in |
| Buy alcohol | No. Banned from OpenAI shopping | Alcoholic items are never offered in this plugin |
| Buy a gift voucher | Unclear; plugins may sell physical goods only and vouchers are not named | Not offered in v1 |
| Delivery | Technically, but the courier side is simulated only | Not in v1; pickup only |

The video must not promise "pay inside ChatGPT" to an Australian venue.

## 3. Tools (v1)

All read tools are open; the two that create something return a confirmation step to the guest
in plain words before acting, following the hub's propose/commit pattern adapted for anonymous
callers (a short-lived signed proposal, no staff role).

| Tool | Does | Built on |
|---|---|---|
| `find_venue` | Venues on Pipedline matching a name, suburb or cuisine | `tenancy` venues with the plugin on and status live |
| `venue_info` | Address, phone, today's hours, cuisine, price band, booking and ordering availability | `tenancy`, trading hours, hour exceptions |
| `menu_read` | The menu being served at a time, with prices, dietary tags, allergens, sold-out flags; alcoholic items marked and never orderable here | `menu.getPublicMenu` (surface `assistants`: what the venue shows "Inside assistants", at that channel's price) |
| `booking_times` | Bookable times for a date and party size | `bookings.getBookingAvailability` |
| `booking_request` | Request a table; returns the reference and what happens next | `bookings.requestBooking` |
| `pickup_times` | Pickup slots for a date | `ordering.getPickupSlots` |
| `order_start` | Builds a cart from menu items and options, prices it on the server, and returns a checkout link to the venue's own order page with the cart filled in | `ordering` cart pricing; a signed cart token the order page reads |

Not in v1: payment in the chat, delivery, vouchers, loyalty, guest accounts.

## 4. The checkout link

The venue's site already has a checkout (`ordering.createOrder` with card payment). `order_start`
creates a short-lived signed cart token (items, options, pickup slot; no personal details) and
returns `https://<venue host>/order?cart=<token>`. The page re-prices everything on the server
and the guest pays there. The assistant never sees a card, and client-supplied prices are ignored
as they are today.

## 5. Rules for a public connection

- No sign-in. Every call is anonymous; rate-limited per IP and per venue.
- Only venues that switched the plugin on and are live are visible.
- Nothing guest-level is returned: no other guests' bookings, no customer data, no staff data.
- A booking needs a name and an email or phone, given by the guest in the chat. It is used for
  the booking only. No marketing consent is implied or recorded.
- Guest-written text (names, notes) is stored as untrusted and never shown to another guest.
- Text returned to the assistant is factual and short; menu descriptions are the venue's own.
- Abuse: a cap on unconfirmed bookings per contact and per IP per day; the venue can turn the
  plugin off at any time.

## 6. Venue settings (plugin config)

On/off; which menus are visible to assistants; whether bookings and ordering are offered through
assistants (each separately); a line shown to the guest's assistant ("Groups over 8, please call").

## 7. Listing it

Building it is not the same as being listed. Steps a person must do: OpenAI developer
verification and plugin review; applying for OpenAI's restaurant-reservation conversion spec
(beta, by application); Anthropic directory review. Until listed, a guest (or the venue, for a
demo) can add it to ChatGPT by its address in developer mode, or to Claude as a custom connection.

## 8. Later

ACP or Google UCP checkout endpoints (both define pickup) when they open to Australian merchants;
a Google Merchant Center feed; delivery once couriers are live.
