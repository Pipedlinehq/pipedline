# 00 — Index (READ THIS FIRST)

**Working name:** `restaurant-os` — rename freely; nothing depends on it yet.

## What this is

A **multi-tenant vertical SaaS platform** for restaurants. One codebase, one deployment, N venues.
We own the guest identity graph and the transaction ledger; the website, ordering, bookings, loyalty
and comms are the machinery that earns us access to them. Criota consumes the resulting attribution.

**Goal as restated 2026-09-30:** a hub per venue. It hosts the venue's website, orders, delivery
and QR menus, and the venue plugs the services it uses into it (`modules/hub.md`), Criota being
one. Bookings, the full kitchen display and our own POS are deferred (`ROADMAP.md`).

This is one product for many venues: not bespoke per-client builds, and not orchestration around
incumbent tools.

## Read-when map

| When you are… | Read |
|---|---|
| Orienting to the whole thing | this file, then `ARCHITECTURE.md` |
| Understanding where this is going | `PIPEDLINE.md` — the direction of record |
| Running it yourself | `SELF_HOSTING.md` |
| Writing a plugin | `PLUGINS.md` |
| Making any schema decision | `SCHEMA.md` — the org/venue/customer/transaction spine |
| Deciding how tenants get isolated, themed, routed, cached | `ARCHITECTURE.md` |
| Adding or scoping a module | `MODULES.md` → then `modules/<name>.md` |
| Building a specific module | `modules/<name>.md` |
| Deciding which POS systems to support | `modules/pos-adapters.md` |
| Designing assistant access, connected services, or the Criota link | `modules/hub.md` |
| Touching card identifiers, consent, or anything guest-level leaving a venue | `SCHEMA.md` §2a |
| Writing or reviewing any code | `THREAT_MODEL.md` — tenant isolation, public surfaces, assistants, secrets |
| Shipping, migrating, flagging or rolling back | `DEPLOYMENT.md` |
| Designing the intake / provisioning flow | `ONBOARDING.md` |
| Needing test data or a worked example | `fixtures/README.md` |
| Deciding what to build next | `ROADMAP.md` |
| Checking a third-party capability claim | `VERIFY.md` — assumptions not yet confirmed against live docs |

## The one-line thesis

> Own the layer above the POS — identity, transactions, demand — for hundreds of venues on one
> codebase, so Criota can close the loop from creator content to a paid meal.

## Non-negotiables (decided; changing these is a rewrite)

1. **Single codebase, single database, `org_id`/`venue_id` + RLS.** Never a fork per restaurant.
2. **Two-level tenancy — `org` → `venue` — from day one.** Single-venue is an org with one venue.
3. **Acquisition attribution stamped at customer creation, from venue #1.** Unbackfillable.
4. **Transactions are an append-only ledger we own**, sourced from Square today, from our own POS later.
5. **Every module is config-driven and toggleable.** No module may assume it is installed.
6. **POS support is tiered, not universal.** Deep (Square, Lightspeed) / read-only / none — declared to the venue up front. See `modules/pos-adapters.md`.
7. **Nothing guest-level leaves an org, and card identifiers are consent-gated and hashed per org.** See `SCHEMA.md` §2a. Criota and every other plug receive per-venue totals.
8. **Venues are data, behaviour is code.** No per-venue branch or code path. See `DEPLOYMENT.md` §1.
