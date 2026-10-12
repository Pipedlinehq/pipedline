# Console information architecture (decided 2026-10-12)

The venue console (app.pipedline.com) and the product site (pipedline.com) borrow the **structure
and vocabulary** of a mature commerce admin, so a venue owner who has used one feels at home, and
are catered to hospitality throughout. They borrow nothing else: **our own look, our own code.**
Shopify's design system (Polaris) is licensed only for apps that integrate with Shopify and
requires standalone products to be visually distinct from it, so it is not used, and no Shopify
screen is copied. The contract (`PIPEDLINE.md`) still holds: the owner's assistant is where work
is done; the console is where the owner sees, sets up and says yes.

## 1. Navigation (sidebar, in this order)

| Section | Hospo wording on the item | What it holds | Today's routes |
|---|---|---|---|
| Home | Home | Today's service at a glance, this week against last, things waiting for your yes, setup progress until live | `/console` |
| Orders | Orders | Online orders, pickup and table orders, delivery, kitchen screens | `/console/orders`, `/console/delivery`, `/console/settings/screens` |
| Bookings | Bookings | Today's bookings by service, covers, confirm/decline/seat, booking rules | new: `/console/bookings` (bookings module) |
| Menu | Menu | Menus, sections, items, modifiers, specials, sold out (86'd), menu import | `/console/menu`, specials |
| Customers | Customers | Guests, consent, loyalty members, reviews | `/console/customers`, `/console/loyalty`, `/console/reviews` |
| Marketing | Marketing | Campaigns, lifecycle flows, approvals of batches | `/console/campaigns`, `/console/approvals` |
| Offers | Offers | Offers, vouchers, loyalty rules | `/console/offers`, loyalty settings |
| Website | Website | Pages, brand kit, hours, QR codes, domain | `/console/website`, `/console/hours`, `/console/qr` |
| Analytics | Analytics | Metrics, saved views, digests | `/console/analytics` |
| Channels | Channels | Every place guests find and buy from the venue, each with on/off, status and a configure link: Website, QR menu, Online ordering, Delivery, Bookings, **Inside assistants** (the guest plugin: ChatGPT, Claude) | new: `/console/channels` |
| Plugins | Plugins | The catalogue: every module and third-party plug, on/off, configure, connect (Square, Klaviyo, Criota…) | new: `/console/plugins` (replaces settings/features + settings/connections as the main entry; those stay reachable) |
| Assistant | Assistant | The venue's assistant connection(s), what the assistant did (calls, changes), what is waiting for approval, hosted agents and their modes | promote `/console/settings/assistants` to `/console/assistant` (keep the old path redirecting) |
| Settings | Settings | Venue details, team, privacy, notifications, billing (later), platform admin link if admin | `/console/settings/*` |

Rules:
- Every existing route keeps working (tests and docs link to them). New section pages are added;
  moved pages redirect.
- The venue switcher sits at the top of the sidebar (like a store switcher), with the org name.
- A global search box at the top ("Search orders, guests, menu items…") is nice to have, not required.
- Phone layout: the sidebar collapses to a bottom bar with Home, Orders, Bookings, Menu, More.
- Vocabulary: covers, service, docket, 86'd, pass, front of house. Never "SKU", "fulfilment",
  "inventory", "merchant".

## 2. Home

Top: today's service (covers booked today, orders in progress, anything needing attention).
Then "waiting for your yes" (approvals), then the week's numbers against last week (from the
Monday digest), then setup progress with the next step while the venue is not live, then
"what your assistant did this week" (count of calls and changes, link to Assistant).

## 3. Channels

One card per channel. A channel is a module whose manifest says `kind: "channel"`. Card shows:
name, one line of what it gives the venue, on/off, status (live, needs setup, off), the public
address if any (site host, QR code, the guest assistant endpoint), and Configure. "Inside
assistants" explains in plain words that guests' assistants can find the venue, read the menu,
book and start a pickup order paid on the venue's own page, and that in Australia no payment is
taken inside the chat.

## 4. Plugins (the catalogue)

Generated from the module manifests (section 6), never hand-written. Cards grouped by category.
Each: name, purpose, what it needs, what it reads and writes (in plain words), consent
implications if any, on/off per venue, Configure (form generated from the config schema's
descriptions). Third-party plugs (Criota, Klaviyo, Square…) appear here with Connect.

## 5. Assistant

The connection(s) and how to add one (the two paths already documented), per-tool approval
reminder, the log of what the assistant did (agent_calls, with before/after for changes),
approvals waiting, hosted agents with their modes (off/shadow/supervised/autonomous).

## 6. Plugin manifests and the public catalogue

Every module declares a manifest with `defineModule`:

```ts
manifest: {
  name: 'Bookings',                 // shown to people
  purpose: 'Table bookings guests make themselves, confirmed by staff or automatically.',
  category: 'channels' | 'selling' | 'guests' | 'marketing' | 'insight' | 'setup' | 'integration',
  kind: 'channel' | 'module' | 'plug',
  needs: ['Opening hours set'],      // plain words
  reads: ['bookings', 'customers'],  // plain words, what data it touches
  writes: ['bookings', 'messages'],
  consent: 'A booking never adds a guest to a marketing list.',  // optional
  publicAddress?: (venue) => string,   // for channels: the host, QR address, endpoint
}
```

The platform host serves `GET /plugins.json` (every manifest plus the tools each module adds, the
config schema as JSON Schema with descriptions, and `on` per venue only when authenticated) and
`GET /llms.txt` (the same in plain text for assistants). Shape of `/plugins.json`:

```json
{ "generated_at": "...", "plugins": [ { "key": "bookings", "name": "...", "kind": "channel", "category": "channels",
  "purpose": "...", "needs": [], "reads": [], "writes": [], "consent": "...", "tools": [{"name":"booking_times","effect":"read","description":"..."}],
  "config_schema": { ...JSON Schema... }, "docs": "https://github.com/Pipedlinehq/pipedline/blob/main/docs/modules/bookings.md" } ] }
```

## 7. The product site (pipedline.com)

Pages: Home (what it is, in the owner's words; channels; plugins; the assistant; free), Channels,
Plugins (rendered from `/plugins.json`, with a checked-in snapshot as fallback), Pricing (run it
yourself: free; hosted with your own assistant: free, costs passed through at cost plus a stated
percentage; hosted with our agent: usage at cost plus a percentage), Open source (the repository,
the licence, the guides), Learn (the existing guide, tutorial and kit, behind its sign-up, moved
under `/guide`), Start (sends to `app.pipedline.com/start`). No person is named anywhere.
Positioning words: "connect an AI assistant to your venue's tools"; never "operating system".

## 8. Visual identity (both surfaces)

Our own: warm neutral ground, near-black ink, one accent (deep green, `#0f5c4d` light /
`#6fd0b8` dark), display face Fraunces, body IBM Plex Sans, mono IBM Plex Mono. Light and dark.
No purple, no gradient heroes, no Shopify green or Shopify's layout proportions.

## 9. Depth pass (decided 2026-10-12, from `COMMERCE_ADMIN_PATTERNS.md` section 3)

After the re-navigation lands, the console gains the conventions a mature admin has, in this
order and ownership. Each builder owns its module's engine code and that section's console pages;
nobody else edits those. Shared components come first because the others use them.

| Wave | Owner | Patterns (ranked list numbers) | What a venue gets |
|---|---|---|---|
| 1 | Shared console | 1, 3, 4, 15 | **Built (2026-10-13).** Saved views with filter tokens and undeletable defaults on Orders, Bookings, Customers, Menu, Offers and Activity (`IndexViews`, `console_views` per venue); bulk-action bar with confirms that repeat the verb (`BulkSelection`); the save bar (`GuardedForm`) on booking rules, plugin settings and hours; a Timeline component (audit + events + staff notes with @mentions, assistant and hosted-agent entries badged) on dockets, bookings and guests; the venue Activity log at `/console/activity`; search from anywhere (Ctrl/Cmd+K). Offers' "Scheduled" and "Expired" views wait for the offer dates in wave 2. Components and props: `docs/CONSOLE.md` "For builders". |
| 2 | Orders + Bookings | 2, 7, 10 | **Built (2026-10-13).** Kitchen × Money × How-it-leaves axes derived from the order's own columns (`ordering/axes.ts`), each a badge and a filter token, plus a stored "Came from" (`orders.source`: website · qr · phone · assistant · square; the venue site passes `assistant` for a cart a guest's assistant handed it); default views gain Unpaid (a grouping), Didn't finish and Phone and function orders. "Didn't finish": unpaid checkouts with a contact are marked at the venue's `abandoned_after_minutes` (one job per order), listed with Email status and Recovery status, one transactional nudge (`order.nudge`), Recovered when that order or a new one by the same guest is paid, details removed after three months; bookings the same for a request unanswered inside `request_window_hours` (the flow records no "started" step). Phone and function orders: drafts built by hand (custom item needs a manager), priced by the server, "Send a pay link" reuses the order's own tracking page and `payOrder`, "Mark as paid by cash or bank" settles it as a sale with that tender, untouched drafts cleared after a year. **Deposits not built**: the payment path charges a whole total once (see `ordering/CLAUDE.md`). Tools: `order_nudge`, `order_draft_create`, `order_pay_link_send`, `order_mark_paid`, `booking_nudge`; `orders_list` filters by source and lists unfinished and drafts. Migration `0770`. |
| 2 | Guests + Offers | 5, 6 | **Built (2026-10-13).** Guest lists in a plain query language ("last visit more than 60 days ago and said yes to email"; 11 fields, 6 operators, and/or and brackets, 10 conditions), parsed by the identity spine into parameterised SQL, built in the console with a condition picker and a text box that round-trip, five undeletable defaults per org, counts and a preview and where each is used; campaigns target a list, offers can be for one, consent is still checked at send. The offer model: code or automatic × dish / category / bill / delivery × everyone / list / new guests / loyalty members × dates, days, services, a daily window × combinability × limits, with a server-written summary, Active · Scheduled · Expired · Switched off · All views, uses and sales attributed. Surcharges as their own object (public holiday, Sunday, named days) with the legal line, and a refusal of card surcharges (banned 1 Oct 2026). Tools: `guest_list_set`, `guest_list_preview`, `offer_set`, `offer_switch`, `surcharge_set`, `surcharges_list`; `offers_summary` extended. Ordering has yet to call `automaticAdjustments`, `codeCombinesWith` and `applicableSurcharges` (`packages/modules/src/offers/CLAUDE.md`). Spec as built: `docs/modules/offers.md`. |
| 2 | Menu | 11, 12 | **Built (2026-10-13).** Scheduled menus and sections (`live_from` / `live_until`, set in the venue's own time; Scheduled and Retired views and badges; preview as of a date and time); 86'd until end of service · tomorrow · a time · until put back, the return worked out at read time so every surface flips at once (kitchen screen says when it is back); "Where it shows" per item over Website · QR · Pickup · Delivery · Inside assistants, a default per section and per venue, bulk Show on… / Hide from…, the guest plugin reads the `assistants` channel; a price per channel (`menu_item_prices`) shown on that channel's menu and given to ordering by `getOrderableItems` / `priceFor`. Tools `menu_schedule`, `menu_show_on`, `menu_set_channel_price`; `menu_list` and `menu_set_availability` extended. Spec: `docs/modules/ordering.md` section 1a; guide `packages/modules/src/menu/CLAUDE.md`. Left for ordering: passing the order's channel as the menu surface. |
| 2 | Home, Reports, Alerts, Plugs | 8, 9, 13, 14 | **Built (2026-10-13).** Home: needs-attention counts read through the owning modules' own list functions and deep-linking to the matching view (`hub.needsAttention`); guidance cards put away per staff member; up to five suggestions from the operations status and the weekly digest, approved by running the tool's own propose/commit once or dismissed with a reason (`hub.suggestions`). Reports (`/console/analytics/reports`): 24 default reports by category plus the venue's own, a report page with date range · compare to · chart · table · CSV export · Save as, repeat-visit cohorts, monthly targets with a pace meter, marked dates on charts (`analytics.reports`). Alerts (`/console/settings/notifications`): per event, recipients by name or role, email or text, per-rule on/off, Send a test, quiet hours; raised from the activity stream and sent as transactional messages to staff only (`comms.alerts`); the weekly digest is one of them. Plug pages (`/console/plugins/[key]`): manifest reads/writes, tools with last-used from `agent_calls`, connection health, Configure, Disconnect, what leaves the venue, the 30-day idle note (`hub.plugDetail`). Tools: `needs_attention`, `reports_list`, `report_run`, `alerts_summary`, `alert_set`, `suggestion_dismiss`. Left out: a kitchen-screen alert channel (the screen already shows every order as a ticket) and bookings reports (no booking measures in the catalogue yet). |

Rules carried over: hospo wording throughout; every write exists as an assistant tool with
propose/commit; every new list is a saved view; no builder runs the whole browser suite (the
integrating session does); the look stays ours.
