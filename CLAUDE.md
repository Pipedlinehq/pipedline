# Restaurant OS — session guide

A multi-tenant hub for hospitality venues: website, QR menu, ordering, delivery, loyalty, comms,
analytics, and an MCP server so a venue's own assistant can read and act. One codebase, one
database, many venues. Design docs are in `docs/`; start at `docs/00_INDEX.md`.

**Read before writing code:** `docs/THREAT_MODEL.md` (what must never go wrong),
`docs/DEPLOYMENT.md` §1 (venues are data), `docs/MODULES.md` (the module contract), and the
spec for the module you are touching in `docs/modules/`.

## Layout

```
db/migrations/        SQL, applied in name order. The schema is the contract.
packages/core/        tenant context, authz, jobs, events, tools, ports, secrets, connections
packages/modules/     one directory per module: services, jobs, templates, tools
packages/adapters/    providers behind the ports: simulators (sim/) and real ones
packages/fixtures/    the two seeded fixture orgs (oak-diner, oak-group) + per-module seeders
packages/testkit/     embedded Postgres, test app, useTestEnv()
apps/                 web (Next.js), worker
scripts/              db types, gates
```

## Commands

```bash
pnpm test                         # everything (boots Postgres, migrates, seeds once, ~16s setup)
npx vitest run <name-fragment>    # one file or folder, e.g. `npx vitest run spine/ledger`
pnpm db:types                     # after ANY migration change: applies all migrations, regenerates packages/core/src/db.gen.ts
pnpm typecheck                    # tsc across the workspace
pnpm check:modules                # module boundary gate
pnpm check:tenant-branching       # no code may branch on a specific tenant
pnpm gates                        # all of the above, strict
```

No Docker and no system Postgres: tests and dev use an embedded Postgres 18.

## The rules (most have a gate or a test behind them; 3, 4, 5, 12 and 13 rely on review)

1. **Every read and write of tenant data happens inside `app.tenant(orgId, principal, fn)`.**
   That transaction runs as role `app_tenant` with row-level security on. The org comes from
   the host, the session or the key; never from a request argument. `app.db` and
   `app.platform()` bypass row-level security: use them only for host resolution, sign-in,
   provisioning, schedulers and webhook lookup, and say why in a comment.
2. **A service function is `fn(ctx, input)`.** First validate `input` with zod. Then the role
   check (`requireStaff(ctx, { venueId, minRole })`, `requireOwner`, `requireGuest`,
   `requireDevice`). Then `assertModule(ctx, venueId, <module>)` if the module is toggleable.
   An id belonging to another org or a venue the caller has no role at is **not found**, not
   forbidden. Throw `AppError` (`packages/core/src/errors.ts`); its message is shown to people.
3. **No provider call inside a tenant transaction.** Read and mark in one transaction, call the
   provider, record the result in a second. Outward actions (send, charge, dispatch) go through
   `once(app, { orgId, key, kind }, fn)` with the same key given to the provider, and are
   normally triggered by a job enqueued in the transaction that caused them (`enqueue(ctx, job, payload, { key })`).
   Job handlers must be safe to run twice.
4. **Webhooks**: verify the signature on the raw body, `claimWebhookEvent` to de-duplicate,
   treat the payload as a hint and re-fetch before acting, `releaseWebhookEvent` on failure.
5. **Time is `ctx.now()` / `app.clock()`.** Never `new Date()` or `Date.now()` in module code:
   tests and fixtures move the clock. Business dates are the venue's own zone
   (`localParts`, `localDate`, `zonedTimeToUtc` in core). Money is integer cents.
6. **jsonb columns: write with `json(value)`.** A bare JS array becomes a Postgres array and fails.
7. **Module boundaries.** A module owns the tables listed in its `module.ts`. It may read spine
   tables (orgs, venues, customers, transactions, events …) but writes to them go through the
   spine's functions. It never touches another module's tables: call a function that module
   exports, or use a hook (`ledger.onTransactionRecorded`, `identity.onCustomerMerge`,
   `identity.onCustomerErase`, `identity.registerCustomerDataProvider`,
   `identity.onConsentChanged`, `ordering` contract in `ordering/contract.ts`,
   `approvals.onApprovalDecided`, `auth.onStaffDisabled`).
8. **Venues are data.** No `if (orgId === …)`, no per-venue code path. If config cannot express
   it, add a config option to the module's schema. `venue_modules.config` is validated by the
   module's zod schema; org-level settings use `tenancy.getOrgSettings(ctx, namespace, schema, fallback)`.
9. **Card identifiers** (fingerprint, account reference) are never stored raw, never logged,
   never returned. Only `identity.linkCard` / `resolveCustomer` handle them, hashed per org and
   only for a guest holding the `card_recognition` consent. Nothing may depend on card
   recognition working (docs/SCHEMA.md §2a).
10. **Consent comes from the guest.** `identity.grantConsent` refuses staff. Marketing messages
    go through `comms.queueMessage`, which checks consent and suppression at queue time and again at send time.
11. **Everything measurable is declared.** Events with `defineEvent` (name `noun.verb`, a zod
    property shape, a plain description) and recorded with `track` / `events.trackInSession`.
    Message templates with `comms.defineTemplate`. Assistant tools with `defineTool`: pinned to
    the same service function the console uses, output declared as a zod object (it is an
    allowlist: unnamed fields do not leave), writes implemented as `propose` returning the
    plain-words question plus `commit`.
12. **Audit every change** a venue could dispute: `audit(ctx, { action, entityType, entityId, before, after })`.
13. **Guest-written text is untrusted** (notes, reviews, names). Render as text, never markup.
    When returned to an assistant, label it as quoted guest content.

## Migrations

- Additive only; never edit an applied file. New file, next number in your module's range.
- Every tenant table has `org_id uuid not null references orgs(id)` and indexes that lead with it.
- Status-like columns are Postgres enums (they become TypeScript unions in `db.gen.ts`). Adding
  a value: `alter type … add value`, in a file that does not also use the new value.
- Tag special tables in a comment: `@append_only`, `@shared_read`, `@reference`, `@platform`
  (see `db/migrations/0001_foundation.sql`). End the file with `select app.apply_tenant_rls();`.
- Run `pnpm db:types` straight away. If it fails, fix it before doing anything else: a broken
  migration breaks every test in the repo.

## Tests

```ts
import { useTestEnv } from '@ros/testkit';
const t = useTestEnv();   // a private clone of the seeded fixture DB per test file
// t.app, t.db (unscoped, for read-back), t.sim (simulated providers), t.clock, t.fixture
const manager = await t.fixture.diner.as('manager');
await t.app.tenant(t.fixture.diner.orgId, manager, (ctx) => someService(ctx, input));
```

- **Done means the side-effect was read back.** After a write, query `t.db` and assert the row,
  the message in `t.sim.email.sent`, the job, the event. A function that returns without error
  proves nothing (framework LEARNINGS L1, L10, L15).
- Every module's tests include the negative cases in `docs/THREAT_MODEL.md` §11 that apply:
  wrong role → forbidden, other org's id → not found, module off → not found, replay → one effect,
  client-supplied price ignored.
- Test against the **group** fixture as well as the single venue when behaviour is org-wide
  (loyalty, identity) or differs per venue.
- `drainJobs(t.app)` runs due jobs; move time with `t.clock.advanceMinutes(n)` / `t.clock.set(iso)`.
- Fixture seeds for your module: `packages/fixtures/src/seeders/NN-<module>.ts` default-exporting
  a `ModuleSeeder`. Switch the module on for the fixture venues there with `setModule`.

## Working in parallel

Several sessions may be building different modules at once. Stay inside your module's
directory, your migration number range, your seeder file and your simulator file. Shared files
(`packages/modules/src/index.ts`, `packages/adapters/src/sim/index.ts`, `packages/core/src/ports/*`)
get small additive edits only; re-read before editing. If another module's in-progress work
breaks typecheck or a seeder, leave it and report it; do not fix or revert someone else's files.
Do not commit; the integrating session commits.
