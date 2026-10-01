# MODULES — Registry

## Spine (always on, not toggleable)

| Module | Owns |
|---|---|
| `tenancy` | orgs, venues, domains, trading hours, module config, connections |
| `identity` | customers, identities, merges, attribution stamping, consents (`SCHEMA.md` §2a) |
| `ledger` | transactions, lines, attribution; Square ingest adapter |
| `events` | first-party analytics stream |
| `comms` | outbox, email and SMS adapters, suppression, templates |
| `console` | restaurant-facing admin; staff, roles, settings |
| `platform` | our side: onboarding, provisioning, tenant health, billing |

## Toggleable modules

| Module | Key | Stage | Status | Depends on | Spec |
|---|---|---|---|---|---|
| Website & theming | `website` | 1 | ⬜ | tenancy, events | `modules/website.md` |
| QR menu, order & pay | `qr` | 1–3 | ⬜ | website, ordering, identity | `modules/qr.md` (draft) |
| **Agent access & plugs** | `hub` | 0–4 | ⬜ | tenancy, console | `modules/hub.md` (draft) |
| Online ordering (pickup) | `ordering` | 2 | ⬜ | ledger, identity, comms | `modules/ordering.md` |
| Delivery (first-party) | `delivery` | 2 | ⬜ | ordering, ledger, comms | `modules/delivery.md` (draft) |
| Loyalty | `loyalty` | 3 | ⬜ | identity, ledger, comms | `modules/loyalty.md` |
| Lifecycle campaigns | `campaigns` | 4 | ⬜ | identity, comms, events | later |
| Reviews & reputation | `reviews` | 4 | ⬜ | identity | later |
| Specials board (the worked example in `PLUGINS.md`) | `specials` | — | built | — | `modules/specials.md` |
| Kitchen display (full KDS) | `kds` | deferred | ⬜ | ordering | `modules/kds.md` |
| Dine-in bookings | `bookings` | deferred | ⬜ | identity, comms | `modules/bookings.md` |
| POS / order entry | `pos` | deferred | ⬜ | kds, ledger, bookings | `modules/pos.md` |
| Gift cards | `giftcards` | deferred | ⬜ | ledger | later |
| Ingredients & COGS | `inventory` | deferred | ⬜ | ledger, ordering | later |
| Rostering | `rostering` | deferred | ⬜ | ledger | later |
| Meta ads (Criota UGC) | `ads` | deferred | ⬜ | events, ledger, Criota | parked |

Stages and the reasons for each deferral are in `ROADMAP.md`.

## Module contract

Every module ships, or it is not shippable:

1. **Zod config schema**, versioned. Drives both validation and the settings UI.
2. **Migrations** owned by the module, expand-then-contract only.
3. **`assertModule()` guard** on every route and server action.
4. **No direct cross-module table reads.** Go through the spine or a published function.
5. **Seeds for the fixture org** (`fixtures/`) so the module is developable without a real venue.
6. **Its own tests**, run against the fixture group (multi-venue), not just a single venue.
7. **A CLAUDE.md** so the next session can wire it in without reading the implementation.
8. **A scenario per user goal, with the side-effect read back** (added 2026-09-30). A route that
   returns 2xx is not done; the row, message or ticket it was meant to produce must be read
   back from the database. This is the lesson an earlier build paid for.
9. **Its agent tools, if any, declared with the module** (`modules/hub.md` §2): pinned to the
   module's own server actions, with an output allowlist.

## Cross-cutting rule

A module may be disabled at any time on a live venue. Disabling must never orphan data or
break the ledger — it hides surfaces, it does not delete. A venue that turns bookings off for
winter and back on in spring must find its floor plan intact.
