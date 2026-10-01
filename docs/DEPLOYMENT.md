# DEPLOYMENT — shipping one codebase to many venues without breaking service

> Written 2026-09-30. Built on two things: the boundary
> between configuration and code, and a staged rollout with a fast way back.

## 1. The boundary: venues are data, behaviour is code

- One codebase, one deployment. **No per-venue branch, build, deploy or fork, ever.**
- Everything that differs between venues is a row: brand tokens, module config, connections,
  templates, menu, hours.
- **Code never branches on which tenant it is.** `if (orgId === …)` and its cousins fail lint.
  When a venue needs something config cannot express, the answer is a new config option on the
  module (for everyone, behind a flag) or a new adapter. Never venue-specific code.
- This applies to tenant zero as much as anyone.

The test: adding a venue is filling in config and connecting accounts. Zero code.

## 2. Environments

| Environment | Database | External services | Who uses it |
|---|---|---|---|
| Local | local or a branch database, fixtures seeded | sandboxes, no real sends | development |
| Preview (per change) | branch database, fixtures seeded | sandboxes | review, the gates in §4 |
| Staging | its own project, fixtures plus a copy of tenant zero's shadow data | sandboxes; sends go to test addresses only | pre-release checks, migration rehearsal |
| Production | one project | live | venues |

Production secrets exist only in production. Nothing outside production can send a real
message, take a real payment or dispatch a real courier.

## 3. Rings

A change reaches venues in rings, behind an org-scoped flag.

| Ring | Who | Moves on when |
|---|---|---|
| 0 | fixtures and tenant zero | gates green; tenant zero's numbers still reconcile |
| 1 | a few venues who agreed to go first | a full trading week with error and health budgets held |
| 2 | everyone | — |

- Any venue can be held back on the old behaviour while its problem is looked at.
- A flag has an owner and an expiry. When a change is at ring 2 the flag and the old path are
  deleted; a flag that outlives its expiry fails CI. Flags are for rollout, not for permanent
  per-venue differences (that is config).
- Not everything needs rings: copy fixes and additive changes with no behaviour change go
  straight out. Anything touching ordering, payment, kitchen delivery of orders, comms sends,
  loyalty balances, tenant isolation or the hub's write path always goes through rings.

## 4. Gates before a change is promoted

Type check clean · build succeeds · unit tests green · **scenario suite green with
side-effects read back** (`MODULES.md` contract item 8) · the cross-tenant leak test ·
the negative tests in `THREAT_MODEL.md` §11 · Core Web Vitals within budget on the tenant
templates · migrations rehearsed on staging.

A gate that cannot pass stops the release. It is not redefined to fit what passed.

## 5. The way back

- **Code:** redeploy the previous build. This must always be safe, which is what §6 guarantees.
- **Behaviour:** turn the flag off, for one venue or all.
- **A module at one venue:** the owner or we can switch it off. The venue's site then says
  plainly what is unavailable ("online ordering is paused, call us on …") instead of failing.
  Disabling hides surfaces and never deletes data (`MODULES.md` cross-cutting rule).
- **Data:** point-in-time recovery for the whole database is the last resort because it rolls
  back every venue. Keep per-tenant logical exports so one venue can be restored alone.

## 6. Migrations

One schema for everyone, so a bad migration hits every venue at once.

- Expand, then contract: add, backfill, switch reads, drop later. Never rename in place.
- **Every migration works with the previous build as well as the new one**, so the code can be
  rolled back without touching the database.
- Destructive steps ship in a later release than the code that stopped using the column.
- Long backfills run as worker jobs in batches per tenant, not inside the migration.
- Rehearsed on staging against tenant zero's data volume first.

## 7. Things that must survive a deploy

- **Kitchen and counter screens.** They are installed web apps with a local cache. The server
  keeps serving the previous client version's API until screens have updated; a screen never
  reloads itself mid-service.
- **Webhooks.** Providers retry; ingest is idempotent; the reconciliation poll catches what a
  deploy window dropped.
- **Queued work.** Job payloads are versioned; a new worker can read the previous version's
  jobs. Workers drain before stopping.
- **Carts and checkouts in flight.** A guest mid-checkout during a deploy completes on the new
  build or gets a clear retry, never a double charge (idempotency key).

## 8. When not to deploy

Venues trade on Friday and Saturday nights. Ring-gated changes do not ship into a service
period in any ring's local time zone; the release tool knows each venue's trading hours and
says no. Urgent fixes are the exception and are logged as such.

## 9. Versioned things inside the one deployment

| Thing | Versioned how | Pinned per venue? |
|---|---|---|
| Module config schema | schema version on `venue_modules`; a migration function per step | follows the code |
| Message templates | platform default plus org override; rendered snapshot stored on send | org override is theirs |
| Hosted agent templates (`modules/hub.md` §8) | semantic version; evaluated on fixtures before promotion | **yes**, and rollback is re-pinning |
| Agent tool catalogue | additive changes only; a changed output shape is a new tool name | no |
| Adapters (POS, courier, ESP) | contract-tested against the provider's sandbox in CI | no |

## 10. Watching it

Per-tenant health as in `ARCHITECTURE.md` §7: last successful provider sync, queue depth,
order-to-kitchen latency, send failures, hub error rate. Each ring's promotion reads these.
A venue's own health page shows its connections and anything we have paused.

Alert on absence as well as on errors: a venue that normally takes forty orders on a Friday and
has taken none by eight o'clock is an incident even if nothing has thrown.

## 11. First production release checklist

Threat-model open items closed or accepted · leak test green on real data · backups restored
once for real · a rollback rehearsed · incident plan written · the data-handling agreement
signed by the first venue · `VERIFY.md` criticals answered.
