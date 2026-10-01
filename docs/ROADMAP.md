# ROADMAP — Build sequence

Resequenced 2026-09-30 (decisions of that date). The goal is a hub per venue:
website, orders, delivery, QR, and the services a venue plugs in, Criota among them. Bookings,
the full kitchen display and our own POS are deferred until venues ask for them.

Each stage is independently sellable and the attribution asset accrues from day one. Built
against `fixtures/` for tests, and against **a first real venue as a read-only shadow tenant** for real data
.

## Before any code
`THREAT_MODEL.md` read and accepted · `DEPLOYMENT.md` read · `VERIFY.md` #4, #7, #11, #12
answered or explicitly designed around.

## Stage 0 — Spine
`tenancy` · `identity` (with the consent model, `SCHEMA.md` §2a) · `ledger` · `events` ·
`connections` (`modules/hub.md` §4) · `console` shell · fixtures + seeds · Square adapter, read-only

Nothing is sellable yet, but every later decision depends on this being right. **Attribution
columns exist from the first migration** — they are unbackfillable.

Done when: both fixtures seed clean; RLS proven with a cross-tenant leak test; tenant zero's
Square history ingests idempotently (run twice, same row count) with card identifiers stripped;
a transaction can be attributed to a customer.

## Stage 1 — Sellable surface
`website` (tokens + 3 skeletons) · `qr` Q1 (view-only menu) · `hub` reads (the MCP server) ·
`comms` (transactional only) · onboarding wizard v1

First revenue point. A venue gets a real site on a subdomain, a live QR menu that works on any
POS, and its own assistant able to read its numbers. `events` start collecting.

## Stage 2 — Transactions flowing
`ordering` (pickup) · `qr` Q2 (order and pay at the table) · orders pushed to the venue's POS ·
the simple kitchen order screen (`modules/ordering.md` §5) for venues without one ·
`delivery` part A (first-party, courier by API) · `hub` confirmed writes

The platform becomes operationally load-bearing. No coursing, fire timing or station routing:
Square venues see orders where they already look, and everyone else gets one loud screen.

## Stage 3 — The asset
`loyalty` · `qr` Q3 (the guest chooses to be known) · `comms` marketing (per-org domains,
consent, suppression, ESP adapter) · the Criota plug and the gateway (`modules/hub.md` §7)

This is what the whole thing was for: a known guest, a consented record, and a creator's
campaign tied to paid meals, per venue.

## Stage 4 — Depth
`campaigns` · `reviews` · reporting console · hosted agents (`modules/hub.md` §8) ·
POS adapter #2 (Lightspeed) · middleware evaluation for the long tail

## Deferred — built when venues ask, not before
| Module | Why it waits | What would bring it forward |
|---|---|---|
| `bookings` | the largest single module; incumbents are strong | several venues asking, or a booking platform exit that strands them |
| `kds` (full: stations, coursing, fire timing) | Square venues already have screens; Stage 2's order screen covers the rest | venues on a closed POS with real dine-in QR volume |
| `pos` P1–P3 | offline-first, hardware, cash-up: a company's worth of work | a base of venues on closed POS systems asking to switch |
| `delivery` part B (marketplace ingest) | adds no guest identity | venues wanting one menu and one 86 across channels |
| `inventory`, `rostering`, `ads`, `giftcards` | not needed for the goal | demand |

The specs in `modules/` for the deferred modules stay as written. The spine still carries what
they will need (the ledger's `source`, shared tables, `ticket_events` as a sync unit), so
deferring them costs nothing later.

---

## Rules that hold across every stage

**Every module is built against the group fixture, not just the single venue.** A module proven
only on one venue will break on a group, and you will discover it at a paying customer.

**Every module is also run against tenant zero's real data before it is called done.** Fixtures
are shaped by what we expected; live data is not.

**Done means the side-effect was read back** (`MODULES.md` contract item 8).

**Time-to-live per onboarding is tracked from venue #1.** It is the metric that decides whether
hundreds of restaurants is reachable. If manual-touch minutes aren't falling stage over stage,
the software quality doesn't matter.
