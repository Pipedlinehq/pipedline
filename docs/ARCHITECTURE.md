# ARCHITECTURE — How this scales to hundreds of venues

## 1. Tenancy model

### Two levels, always

```
org  (the brand / business entity — owns customers, loyalty, brand, billing)
 └── venue  (a physical location — owns menu, floor plan, hours, orders, Square account)
```

**Single-venue restaurants are an org with exactly one venue.** There is no "simple mode".
Building single-venue-only and retrofitting groups later means rewriting the customer table,
the loyalty ledger and every report — that retrofit is the single most expensive mistake
available here, and it costs ~nothing to avoid now.

### What scopes where

| Scoped to `org` | Scoped to `venue` |
|---|---|
| customers & identity graph | menu, sections, items, modifiers |
| loyalty program, accounts, points ledger | floor plan, tables, service periods |
| brand tokens & theme | trading hours, holidays, prep times |
| marketing consent & suppression | orders, bookings, tickets |
| billing (what *we* charge them) | Square merchant/location credentials |
| staff accounts & roles | staff↔venue assignment |

Rationale: a guest who earns points at the group's CBD venue must burn them at the Newtown
venue. Loyalty and identity are org-level or groups don't work. Menus and floor plans differ
per site, so they are venue-level. Brand is org-level **with per-venue override columns** —
groups sometimes run a sub-brand at one site.

### Isolation: RLS, not separate databases

One Supabase Postgres. `org_id` on every table (plus `venue_id` where venue-scoped). Row-level
security keyed off JWT claims.

- **Not schema-per-tenant** — hundreds of schemas makes every migration an N-way fan-out.
- **Not database-per-tenant** — cost and ops load scale linearly with customers, which is the
  opposite of what we want.

**Indexing discipline:** every index leads with the tenant column. `(org_id, created_at)`,
`(venue_id, status, scheduled_for)`. A query plan that scans across tenants is a bug, and at
300 venues it is an outage.

**Connection pooling is mandatory.** Serverless functions + Postgres = connection exhaustion.
Use the Supabase transaction pooler for request-path queries from day one, not as a fix later.

## 2. Request routing — host → tenant

One Next.js app on Vercel. Middleware resolves the incoming `Host` header to an org/venue and
puts it in request context.

```
tables.orders-for.<platform>.com   → wildcard subdomain, default at onboarding
bellastrattoria.com.au             → custom domain, added once they hand over DNS
```

- **Default:** wildcard subdomain, live the moment the org row exists. Zero DNS dependency,
  so a restaurant can be sold, onboarded and live in a day.
- **Custom:** added programmatically to the Vercel project via its Domains API when the
  restaurant is ready. Their site keeps working on the subdomain throughout; the swap is
  a config change, not a migration.

Keep a `domains` table (`host`, `org_id`, `venue_id`, `is_primary`, `verified_at`) as the
source of truth, cached in-edge. Never derive tenancy from a path prefix — it leaks into
every URL and makes the custom-domain migration a redirect nightmare.

## 3. Theming — "different-looking websites" without different codebases

Two orthogonal dimensions:

**(a) Design tokens** — captured in brand onboarding, stored per org:
typography (heading font, body font, scale ratio, weights), colour (primary, secondary, accent,
surface, surface-alt, text, text-muted, border, success/warn/error), radius scale, spacing scale,
shadow depth, image treatment (crop ratio, filter, corner style), logo (SVG + raster + mark-only),
and a tone-of-voice sample used to steer generated copy.

Emitted as CSS custom properties on the root layout. **Zero per-tenant CSS files.**

**(b) Layout skeletons** — 4–6 hand-built React layout archetypes, chosen at onboarding:
`hero-photo` · `editorial` · `menu-forward` · `minimal` · `split-panel` · `single-scroll`.
Each is a real designed page composition, not a template with slots for everything.

**Tokens × skeletons = the visual variety.** 6 skeletons × distinct brand tokens reads as
genuinely different sites, while remaining one codebase you can ship a fix to once. Content
(copy, images, menu, hours) lives in the DB and is edited by the restaurant.

**Caching:** render tenant pages statically and revalidate by tag — `cacheTag('org:<id>')`,
`cacheTag('menu:<venue_id>')`. Publishing a menu change busts exactly that tenant. Without
per-tenant cache tags you either serve stale menus or rebuild everything on every edit; at
300 venues the second option is not available to you.

## 4. Module system

```sql
modules(key, name, description, config_schema_version)        -- catalogue
venue_modules(venue_id, module_key, enabled, config jsonb, version, enabled_at)
```

- Config validated with a **Zod schema versioned alongside the module**. A module with no
  validated config schema is not shippable.
- Server-side `assertModule(venueId, 'bookings')` guards every route and server action.
  Client-side `useModule()` drives navigation and UI.
- Routes always exist in the bundle; a disabled module 404s. Do not try to conditionally
  register routes — it fights the framework and breaks static analysis.
- **No module may read another module's tables directly.** Cross-module reads go through the
  spine (customer, transaction, event) or a published function. This is what lets you rip out
  and rebuild the bookings module at venue 200 without touching loyalty.

## 5. Infrastructure split

| Layer | Runs on | Carries |
|---|---|---|
| Web + API | **Vercel** (one project, N domains) | tenant sites, admin console, ordering, booking UI, webhooks |
| Database + auth + storage | **Supabase** (one project) | the spine, RLS, guest/staff auth, brand assets |
| Workers | **Railway** | queue consumers, cron, provisioning jobs, report generation, LLM batch work |
| Email | **Resend** | transactional + marketing |
| SMS/voice | **Twilio** | transactional + marketing, later Retell for supplier/booking calls |
| Payments | **Square** | card processing, in-venue transaction source |

Vercel for anything request-shaped, Railway for anything that must run longer than a request
or retry for hours. Do not send email from a request handler — see §6.

## 6. Comms at scale (the part that bites)

You have built Resend/Twilio pipes before. At hundreds of tenants, three new problems appear:

**Deliverability is shared unless you make it not.** One restaurant blasting a stale list on a
shared sending domain drags down every other tenant's inbox placement. Split it:

- **Transactional** (order confirmation, booking reminder, receipt) → platform-owned sending
  domain. You control content and volume, reputation stays clean.
- **Marketing** (campaigns, win-back, loyalty offers) → **per-org verified sending domain**,
  set up during onboarding. Their reputation, their domain, isolated blast radius.

**SMS needs per-tenant identity and registration.** Twilio subaccounts per org give you
isolation, per-tenant billing attribution, and independent suspension. AU sender-ID / A2P
registration is a real onboarding gate with lead time — start it on day one of onboarding,
not the week before launch.

**Never send from the request path.** Outbox pattern: the request writes a `messages` row in
the same transaction as the business change; a Railway worker drains it. This gives you retries,
rate limiting, per-tenant throttles, provider failover, and an audit trail — none of which you
can bolt on afterwards.

**Consent is per-org and legally load-bearing.** Australian Spam Act 2003: record consent
source, timestamp, and IP; honour unsubscribe within 5 business days; include sender
identification. Suppression lists are per-org and must survive list re-imports.

## 7. Observability and the tenant blast radius

- Every log line, trace and error carries `org_id` + `venue_id`. Non-negotiable — otherwise
  "the site is broken" is unanswerable.
- Per-tenant health: last successful Square sync, comms queue depth, booking availability
  computation time, page cache hit rate.
- **Per-tenant rate limits and quotas** on comms sends, API calls, and webhook processing so
  one venue cannot exhaust a shared resource.
- Feature flags scoped to org so a risky module version rolls out to 5 venues before 300.

## 8. Migrations at N tenants

One schema, so migrations are single-shot — but a bad one hits every restaurant at once.
Rules: expand-then-contract only (add column → backfill → switch reads → drop later, never
rename in place); every migration reversible; run against the seeded fixture group before prod.

## 9. The POS ambition — design for it now, build it later

You want your own POS eventually. That is the right call to defer, and the wrong call to
design around later. The one thing to do now:

**Model the transaction ledger as if you own it, and treat Square as one adapter feeding it.**

```
transactions ← source: 'square' | 'online-order' | 'pos' | 'manual'
             ← external_ref (Square payment id, nullable)
             ← line items, modifiers, discounts, tender, staff, table
```

If the ledger is shaped as "a mirror of Square", replacing Square means rewriting loyalty,
reporting, and Criota attribution. If it is shaped as a real ledger with pluggable sources,
building your own POS is adding a source. Same work now, radically different work later.
