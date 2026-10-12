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
| 1 | Shared console | 1, 3, 4, 15 | Saved views with filter tokens and undeletable defaults on every index page; bulk-action bar with destructive confirms that repeat the verb; the save bar; a Timeline component (system events + staff notes, assistant entries badged) on dockets, bookings and guests; the venue Activity log; global search |
| 2 | Orders + Bookings | 2, 7, 10 | Kitchen × Money × How-it-leaves status axes with a "Came from" badge; "Didn't finish" (abandoned pickup orders and bookings) with a nudge; phone and function orders with deposits, holds and pay links |
| 2 | Guests + Offers | 5, 6 | Guest lists with a plain query language ("last visit more than 60 days ago and said yes to email") used by campaigns and offers; the offer model (code or automatic × dish/bill/delivery × who), combinability, Active/Scheduled/Expired, usage counts; surcharges as their own object |
| 2 | Menu | 11, 12 | Scheduled menus; 86'd-until with auto-return; "Where it shows" per item and channel; price lists per context |
| 2 | Home, Reports, Alerts, Plugs | 8, 9, 13, 14 | Needs-attention counts that deep-link to filtered views; the reports catalogue with compare-to and export; alerts to the team per event; plug detail pages with what each reads and writes and when it last did |

Rules carried over: hospo wording throughout; every write exists as an assistant tool with
propose/commit; every new list is a saved view; no builder runs the whole browser suite (the
integrating session does); the look stays ours.
