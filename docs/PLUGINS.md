# PLUGINS — how to write a plugin

For a developer who has never seen this repository. Everything here describes the code as it
stands on 2026-10-02. Section 7 lists what does not exist yet. Read it before you plan anything.

The worked example is a real module in this repository: `specials`, a venue's specials board.
The code excerpts below are from its files (shortened where the text says so), and every
command output shown was produced by running the command.

A note on names. The public name is Pipedline. Some names in the code still say `ros`: the
packages are `@ros/core`, `@ros/modules` and so on. It is the same thing.

## Before you start

You need Node 22 or newer and pnpm. You do not need Docker or a Postgres install: tests boot an
embedded Postgres.

```bash
pnpm install
npx vitest run specials        # runs the worked example's tests
```

You should see `Tests  11 passed (11)`. The first run takes about 45 seconds: it starts
Postgres, applies every migration and seeds two fixture organisations.

Read these first. They are short, and this guide does not repeat them in full:

- `CLAUDE.md` (the rules, the commands, how tests are written)
- `docs/THREAT_MODEL.md` (what must never go wrong; section 11 is the list of negative tests)
- `docs/MODULES.md` (the module contract)

---

## 1. What a plugin is

A plugin is a capability a venue switches on. There are two kinds, and they are very different.

| | A. Module | B. Plug |
|---|---|---|
| What it is | Code inside the engine | A service somebody else runs, with its own MCP server |
| Where it lives | `packages/modules/src/<name>/` | On your servers |
| Data | Its own tables in the venue's database | Stays with you; the engine stores a connection and an access key |
| Runs inside the engine | Yes | No. The engine only calls your server |
| Switched on by | A venue manager, per venue (`venue_modules`) | An owner or manager connects it; each venue then offers it to assistants |
| Reviewed how | Code review, the gates, the tests | A person reads your tool list and pins it |
| Examples | `qr`, `reviews`, `loyalty`, `specials` | Criota (`packages/modules/src/hub/plugs.ts`) |

**Choose a module** when the feature needs the venue's own data (menu, orders, guests, sales),
has to work for guests on the venue's site, or must be switched on per venue with settings.
A module is merged into the engine, so it is held to every rule in section 2.

**Choose a plug** when you already run a service and want a venue's assistant to use it next to
the venue's own tools. You write no code in this repository beyond a catalogue entry. In return
you get nothing from the venue's database: your tools see only the arguments an assistant sends.

There is a third thing in the code that is also called a plug: an `adapter` plug, such as a
till or a courier, which the engine calls through a typed port (`packages/core/src/ports/`).
Writing one means writing an adapter in `packages/adapters/`. This guide does not cover it.

---

## 2. The rules a module must follow

These are the rules in `CLAUDE.md`, with the reason and what catches a breach. "Your tests"
means nothing automatic catches it: a reviewer looks for the test.

| # | Rule | Why | What enforces it |
|---|---|---|---|
| 1 | Every read and write of tenant data happens inside `app.tenant(orgId, principal, fn)`. The org comes from the host, the session or the key, never from an argument. | One database holds many businesses. A missed check exposes all of them. | The database. `app.tenant` runs as role `app_tenant` with row-level security on. `packages/modules/test/spine/isolation.test.ts` checks every table, including yours. |
| 2 | A service function is `fn(ctx, input)`: validate `input` with zod, then the role check, then `assertModule`. Another org's id, or a venue the caller has no role at, is **not found**, not forbidden. Throw `AppError`. | The same function serves the console, the site and the assistant. Not-found means ids cannot be probed. | `requireStaff` and `assertModule` in `@ros/core` do the answering. That you called them: your tests. |
| 3 | No provider call inside a tenant transaction. Outward actions go through `once(...)`, normally from a job. Job handlers are safe to run twice. | A slow provider would hold a database transaction open. A retry must not send twice. | Your tests. |
| 4 | Webhooks: verify the signature on the raw body, de-duplicate, re-fetch before acting. | A webhook is input from a stranger until proven otherwise. | Your tests. |
| 5 | Time is `ctx.now()` or `app.clock()`, never `new Date()` or `Date.now()`. Business dates use the venue's zone. Money is integer cents. | Tests and fixtures move the clock. Floats lose cents. | Your tests (a test that moves the clock fails if you used the real one). |
| 6 | Write jsonb columns with `json(value)`. | A bare array becomes a Postgres array and the insert fails. | The insert fails in your tests. |
| 7 | A module owns the tables in its `module.ts`. It may read spine tables. It never touches another module's tables, and writes to spine tables go through the spine's functions. | A venue can switch any module off. Nothing else may depend on its tables. | `pnpm check:modules` (below). |
| 8 | Venues are data. No `if (orgId === …)`. If config cannot express it, add a config option. | One codebase serves every venue. | `pnpm check:tenant-branching` (below). |
| 9 | Card identifiers are never stored raw, logged or returned. | Card-scheme rules. | `isolation.test.ts` ("no raw card identifier is stored anywhere"). Most modules never touch them. |
| 10 | Consent comes from the guest. Marketing goes through `comms.queueMessage`. | Privacy law, and one venue must not burn the others' deliverability. | `identity.grantConsent` refuses staff; `queueMessage` checks consent and suppression. |
| 11 | Everything measurable is declared: events with `defineEvent`, templates with `comms.defineTemplate`, tools with `defineTool`. | The declarations are the data dictionary and the tool catalogue. | `defineEvent` throws unless the name looks like `noun.verb`. `defineTool` throws unless the name is snake_case. `track` throws on an undeclared event or properties that do not match. A duplicate name throws under the test runner. |
| 12 | Audit every change a venue could dispute. | The audit log is the venue's record of who did what. | Your tests. |
| 13 | Guest-written text is untrusted. Render it as text. Label it when returning it to an assistant. | It can carry instructions aimed at the assistant. | Your tests. |

### What the two gates check, exactly

**`pnpm check:modules`** (`scripts/check-module-boundaries.ts`)

- Every table in the schema is owned by exactly one module's `tables` list, or is one of core's
  six (`jobs`, `side_effects`, `audit_log`, `rate_limits`, `webhook_events`, `secrets`).
- In every `.ts` file under `packages/modules/src/<dir>/` it finds Kysely calls
  (`selectFrom`, `insertInto`, `updateTable`, `deleteFrom`, the joins) and
  `from` / `join` / `into` / `update` inside `` sql`…` `` templates, and looks at the table named.
- Your own table: fine. A spine table: reads are fine, writes fail. Another toggleable
  module's table: any use fails. A core table: any use fails.

Its limits: it sees table names written as string literals, in `packages/modules/src` only. A
table name held in a variable is not seen. A reviewer checks for that.

**`pnpm check:tenant-branching`** (`scripts/check-tenant-branching.ts`)

- Scans `packages/core/src`, `packages/modules/src`, `packages/adapters/src` and `apps`.
- Fails on a line that compares `orgId`, `org_id`, `orgSlug`, `org.slug`, `org.id`, `venueId`,
  `venue_id`, `venue.slug`, `venue.id`, `tenantId` or `tenant.slug` with a string literal, and
  on `case 'oak-…'`.
- Files named `*.test.ts` are exempt. A line carrying the comment `tenant-branching-ok:` (or the
  line after one) is exempt; a reviewer will ask why.

**`pnpm gates`** runs typecheck, both gates and every test with strict seeders. It must pass.

### Migration rules

From `CLAUDE.md`. `isolation.test.ts` checks that row-level security is on for every table,
that every table is classified, and that one organisation can read or write no row of another.
The rest is checked in review.

- Additive only. Never edit a migration that has been applied. New file.
- Every tenant table has `org_id uuid not null references orgs(id)` and indexes that lead with it.
- Status-like columns are Postgres enums.
- End the file with `select app.apply_tenant_rls();`. That call switches row-level security on
  for your table and grants the tenant role access to its own org's rows only.
- Special tables carry a tag in a table comment: `@append_only`, `@shared_read`, `@reference`,
  `@platform` (explained at the top of `db/migrations/0001_foundation.sql`).

---

## 3. Writing a module, step by step

The example: a specials board. A manager posts a special with a name, a description, a price in
cents and the days it runs. Guests see the ones running today. An assistant can list them, post
one and take one down.

Files you will create:

```
db/migrations/0700_specials.sql
packages/modules/src/specials/module.ts      the definition, the config, the events
packages/modules/src/specials/specials.ts    the service functions
packages/modules/src/specials/tools.ts       the assistant tools
packages/modules/src/specials/index.ts       what other code may import
packages/modules/src/specials/CLAUDE.md      the guide for the next person
packages/fixtures/src/seeders/45-specials.ts fixture data
packages/modules/test/specials/specials.test.ts
docs/modules/specials.md                     the spec
```

And one line added to `packages/modules/src/index.ts`.

### Step 1. The migration

Migrations are applied in file-name order. Pick a number that is not in use and is above the
ones already there. The existing files are grouped loosely by area (`0100` commerce, `0300`
loyalty, `0450` hub, `0600` analytics); there is no written table of ranges, so look at
`db/migrations/` and take a free block. `specials` took `0700`.

`db/migrations/0700_specials.sql`:

```sql
create table specials (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  venue_id uuid not null references venues(id),
  name text not null check (char_length(name) between 1 and 80),
  description text,
  price_cents integer not null check (price_cents >= 0),
  -- Venue-local calendar days, both inclusive.
  starts_on date not null,
  ends_on date not null,
  -- Set when a manager takes it down before (or after) its last day. Rows are never deleted.
  ended_at timestamptz,
  ...
);
create index specials_venue_days on specials (org_id, venue_id, starts_on, ends_on);
create unique index specials_one_per_name_and_day on specials (org_id, venue_id, lower(name), starts_on) where ended_at is null;

select app.apply_tenant_rls();
```

Things to notice: `org_id` is there and the index leads with it; money is `integer` cents; a
row is ended, not deleted, because a module can be switched off and on again and must find its
data intact; the last line applies row-level security.

Run this straight away:

```bash
pnpm db:types
```

It boots a throwaway Postgres, applies every migration and rewrites
`packages/core/src/db.gen.ts`. You should see:

```
✓ Introspected 106 tables and generated ./packages/core/src/db.gen.ts in 37ms.
wrote packages/core/src/db.gen.ts
```

`git diff --stat` should show only your table added to `db.gen.ts`. If the command fails, fix
the migration before doing anything else: a broken migration breaks every test in the repository.

Now run the boundary gate. It fails, and that is correct:

```bash
pnpm check:modules
```

```
Module boundary violations (1):
  - table specials has no owning module (add it to a module's "tables")
```

### Step 2. The module definition and its config

`packages/modules/src/specials/module.ts`:

```ts
export const specialsConfig = z.object({
  heading: z.string().trim().min(1).max(40).default('Specials').describe('The heading guests see above the specials, e.g. "Today\'s specials".'),
  show_prices: z.boolean().default(true).describe('Whether guests see the price of each special. Staff always see it.'),
  max_running: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('The most specials that may be running or scheduled at once. Posting one more is refused until one ends.'),
  max_days: z.number().int().min(1).max(366).default(31).describe('The longest a single special may run, in days.'),
});

export const specialsModule = defineModule({
  key: 'specials',
  name: 'Specials board',
  description: 'Daily or weekly specials a manager posts with a name, a price and the days they run. Guests see the ones running today.',
  dependsOn: [],
  needs: ['Nothing to connect. A page that shows the specials to guests needs the Website or the QR menu switched on.'],
  tables: ['specials'],
  configSchema: specialsConfig,
  configVersion: 1,
  defaultConfig: specialsConfig.parse({}),
});
```

The fields of `defineModule` (`packages/core/src/modules.ts`):

- `key` is what `venue_modules.module_key` stores. Do not change it later.
- `name` and `description` are shown to owners and to assistants. Write them for a venue owner.
- `dependsOn` lists module keys that must be on first. `setModule` refuses to switch yours on
  without them and `assertModule` checks them on every call. Keep it empty if you can.
- `needs` is plain words for what a venue must have before the module is useful.
- `tables` is every table you own. This is what the boundary gate reads.
- `configSchema` validates `venue_modules.config`. **Every field needs a default**, so that
  `configSchema.parse({})` is a working config: a module that was never configured reads as its
  defaults.
- `configVersion` and `migrateConfig`: when you change the shape of the config, raise the
  version and supply a function that upgrades a stored config. A stored config that no longer
  parses falls back to the defaults rather than failing.
- Do not set `spine: true`. Spine modules are always on. An outside plugin is toggleable.

Everything a venue might want to be different goes in the config (rule 8). The code reads the
config that `assertModule` returns; it never asks which venue it is.

Register the module by adding one line to `packages/modules/src/index.ts`:

```ts
export * as specials from './specials/index';
```

That file is the only loading mechanism. Importing `@ros/modules` runs every module's
`defineModule`, `defineEvent`, `defineTool` and so on as a side effect, which fills the
process-wide registries (`packages/core/src/registry.ts`).

Check:

```bash
pnpm check:modules
```

```
module boundaries ok: 20 modules, 106 tables, 20 source directories
```

### Step 3. Events

Also in `module.ts`. An event is declared once, with a zod shape and a description a person can
read. The name must look like `noun.verb`.

```ts
export const specialPosted = defineEvent({
  name: 'special.posted',
  module: 'specials',
  description: 'A manager (or their assistant, after a yes) posted a special. Carries its price and how many days it runs.',
  properties: z.object({ special_id: z.string(), price_cents: z.number().int(), days: z.number().int() }),
});
```

Keep personal data out of event properties: ids and numbers, not names or free text.

### Step 4. Service functions

`packages/modules/src/specials/specials.ts`. Every function has the same opening, in this order
(rule 2): parse the input, check the role, check the module.

```ts
export async function checkSpecial(ctx: Ctx, raw: z.input<typeof specialInput>): Promise<SpecialPlan> {
  const input = specialInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const config = await assertModule(ctx, input.venueId, specialsModule);
  const venue = await getVenue(ctx, input.venueId);
  const today = localDate(ctx.now(), venue.timezone);
```

What each line gives you:

- `specialInput` is a `z.object({...}).strict()`. `priceCents` is `z.number().int().min(0)`. An
  argument the function does not have is refused, not ignored.
- `requireStaff` throws **not found** when the caller has no role at that venue (which covers
  every venue of another organisation), and **forbidden** when their role is too low. Use
  `requireOwner`, `requireGuest` or `requireDevice` for other callers.
- `assertModule` throws `module_disabled` (HTTP 404) when the module is off at the venue, and
  returns the venue's validated config.
- `ctx.now()` and `localDate(…, venue.timezone)`: "today" is the venue's day, and tests can move it.
- `getVenue` is a function the `tenancy` spine module publishes. Calling another module's
  function is how you reach its data.

The write, the audit entry and the event happen in the same transaction:

```ts
  await audit(ctx, {
    action: 'specials.posted',
    entityType: 'special',
    entityId: row.id,
    venueId: row.venue_id,
    after: { name: row.name, priceCents: row.price_cents, startsOn: row.starts_on, endsOn: row.ends_on },
  });
  await track(ctx, specialPosted, { special_id: row.id, price_cents: row.price_cents, days: plan.days }, { venueId: row.venue_id });
```

When a function takes an id rather than a venue, load the row first, then check the role at the
row's venue. Row-level security means another organisation's row is simply not there:

```ts
  const before = await ctx.db.selectFrom('specials').select(COLS).where('id', '=', input.specialId).executeTakeFirst();
  if (!before) throw notFound('Special not found');
  requireStaff(ctx, { venueId: before.venue_id, minRole: 'manager' });
  await assertModule(ctx, before.venue_id, specialsModule);
```

A guest-facing function has no role check, because an anonymous visitor calls it. It still
checks the module, and it takes as little as possible. `getCurrentSpecials(ctx, venueId)` takes
a venue id and nothing else, so there is no way for a guest to send a price.

Three more things the example does not need but you might:

- **An update function.** Build its schema from the create schema made partial, and parse it
  with `parsePatch` from `@ros/core`, not `schema.parse`. A partial schema with defaults fills
  in fields the caller left out and would overwrite stored values. See `updateQrCode` in
  `packages/modules/src/qr/codes.ts`.
- **A job or a schedule.** `defineJob`, `enqueue(ctx, job, payload, { key })` and
  `defineSchedule` in `packages/core/src/jobs.ts` and `schedules.ts`. See
  `packages/modules/src/qr/sessions.ts`.
- **A message to a guest or to staff.** `comms.defineTemplate` and `comms.queueMessage`. Never
  call an email or SMS provider yourself.

Export what others may call from `index.ts`. Throw `AppError` (or the helpers `notFound`,
`forbidden`, `invalid`, `conflict`): its message is shown to people, so write it for a person.

### Step 5. Assistant tools

`packages/modules/src/specials/tools.ts`. A tool is a thin wrapper around a service function.
It must not reimplement the checks.

A read:

```ts
export const specialsListTool = defineTool({
  name: 'specials_list',
  module: 'specials',
  title: 'The specials board',
  description:
    'The venue\'s specials: each one\'s name, description, price, the days it runs and whether it is running today, still to come, over, or was taken down. Use it to answer "what are today\'s specials?" or to find a special before ending it.',
  effect: 'read',
  scope: 'specials:read',
  venueScoped: true,
  input: z.object({ include_past: z.boolean().optional().describe('True to also list specials that are over or were taken down') }),
  output: z.object({ specials: z.array(specialShape), running_today: z.number().int() }),
  async run({ ctx, venueId }, input) {
    const rows = await listSpecials(ctx, { venueId: venueId!, show: input.include_past ? 'all' : 'open' });
    return { specials: rows.map(shown), running_today: rows.filter((r) => r.status === 'running').length };
  },
});
```

- `name` is snake_case and unique across the engine.
- `module` is your module key. The tool is offered only at venues where that module is on.
- `scope` is a name you choose, `<area>:read` or `<area>:write`. There is no central list. A
  key must hold the scope, and the venue's `allowed_scopes` must allow it. A scope that starts
  with `guests:` is treated as guest-level and is off until the venue switches guest-level
  reads on.
- `venueScoped: true` means the hub works out which venue and passes `venueId`. Never take a
  venue id as a tool argument.
- `input` and `output` must be `z.object(...)`. A tool whose input or output is not an object is
  not offered. **`output` is an allowlist**: the hub parses what you return through it, and a
  field you did not name does not leave.
- Describe every argument with `.describe()`. The description is what the assistant reads.

A write is `propose` and `commit`:

```ts
  async propose({ ctx, venueId }, input) {
    // The same checks the change itself makes: a refusal comes now, before anyone is asked.
    const plan = await checkSpecial(ctx, {
      venueId: venueId!,
      name: input.name,
      description: input.description,
      priceCents: input.price_cents,
      startsOn: input.starts_on,
      endsOn: input.ends_on,
    });
    const when = plan.days === 1 ? `on ${plan.startsOn}` : `from ${plan.startsOn} to ${plan.endsOn} (${plan.days} days)`;
    return {
      question: `Post "${plan.name}" at ${formatMoney(plan.priceCents)} on the specials board at ${plan.venue.name}, ${when}? Guests see it on ${plan.days === 1 ? 'that day' : 'those days'}.`,
      commit: async () =>
        shown(
          await postSpecial(ctx, {
            venueId: plan.venue.id,
            name: plan.name,
            description: plan.description,
            priceCents: plan.priceCents,
            // The days the person was shown, not "today" worked out a second time.
            startsOn: plan.startsOn,
            endsOn: plan.endsOn,
          }),
        ),
    };
  },
```

How the hub uses it (`packages/modules/src/hub/calls.ts`):

1. The assistant calls the tool. The hub runs `propose` in a transaction that is rolled back,
   and answers with `question`. Nothing has changed.
2. The assistant shows the question to its person and sends their answer back with the same
   arguments and a signed, single-use note.
3. The hub runs `propose` again. Only if the answer is yes, the note is unspent and unexpired,
   the arguments are the same, **and the question reads exactly as it did** does it run `commit`.

So: `propose` must change nothing; the question must say exactly what will change, in plain
words, with the money and the venue named; and `commit` must do what the question said. In the
example the dates are worked out once in `propose` and passed to `commit`, so "today" cannot
move between the question and the change.

Set `minRole` on a write, and `sensitive: true` on a tool that moves money or sends to guests
(a hosted agent never runs a sensitive tool on its own).

### Step 6. The fixture seeder

Contract item 5 in `docs/MODULES.md`: a module ships fixture data, so it can be developed and
tested without a real venue. One file, `packages/fixtures/src/seeders/NN-<module>.ts`,
default-exporting a `ModuleSeeder`. Files run in name order after the spine is seeded.

`packages/fixtures/src/seeders/45-specials.ts`:

```ts
const seeder: ModuleSeeder = {
  module: 'specials',
  async seed(app, fixture) {
    // Every fixture venue is in Sydney; "today" is the venue's own calendar day.
    const today = localDate(app.clock(), 'Australia/Sydney');
    for (const org of [fixture.diner, fixture.group]) {
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venue of Object.values(org.venues)) {
          await setModule(ctx, specials.specialsModule, { venueId: venue.id, enabled: true });
          await specials.postSpecial(ctx, {
            venueId: venue.id,
            name: 'Slow-roasted lamb shoulder',
            description: 'For two, with roast potatoes and mint sauce.',
            priceCents: 6400,
            startsOn: today,
            endsOn: addDays(today, 2),
          });
```

(The file goes on to post a second special and close the loops.)

Seed through your own service functions, not with raw inserts, so the audit entries and events
exist as they would for a real venue. Seed both fixture organisations: the isolation test needs
data on both sides to prove one cannot read the other.

A broken seeder is only reported, not fatal, in a normal test run. The gates run with
`ROS_STRICT_SEEDERS=1`, where it fails the run.

### Step 7. Tests

`packages/modules/test/specials/specials.test.ts`. Each test file gets its own copy of the
seeded database.

```ts
const t = useTestEnv();
// t.app, t.db (unscoped, for reading back), t.sim (simulated providers), t.clock, t.fixture
const manager = await t.fixture.diner.as('manager');
const made = await t.app.tenant(diner.orgId, manager, (ctx) => specials.postSpecial(ctx, { ... }));
const row = await t.db.selectFrom('specials').selectAll().where('id', '=', made.id).executeTakeFirstOrThrow();
```

**Done means the side effect was read back.** A function that returns without an error proves
nothing. After every write, query `t.db` and assert the row, the audit entry and the event.

The negative cases from `docs/THREAT_MODEL.md` section 11 that apply to this module, and where
the example tests each one:

| Case | Expected | Test in `specials.test.ts` |
|---|---|---|
| Staff role below what the action needs | forbidden, nothing written | "wrong role: staff below manager are forbidden…" |
| No sign-in (guest or anonymous) on a staff function | unauthenticated, nothing written | same test |
| Id belonging to another org | not found | "another organisation's ids are not found…" |
| Venue in the same org where the caller has no role | not found | "the fixture board…" (the Bondi case) |
| Module disabled | functions answer not found; tools are not offered; data is kept | "module off: every function answers not-found…" |
| Tool call with a key lacking the scope | tool not offered | "through an assistant…" (the read-only key) |
| Write tool with no confirmation, a reused one, different arguments | nothing changes | "through an assistant…" and "taking a special down…" |
| Same action twice | one effect | the replayed yes; `endSpecial` called a second time |
| Client-supplied price | the price is the one a manager typed; no guest-facing call takes one | "the price is integer cents from a manager…" |

Cases from that list that do not apply here: webhooks (the module has none), scripts in page
blocks (it renders nothing), card identifiers (it never sees one). Say so in your pull request
rather than leaving the reviewer to guess.

To test tools the way an assistant meets them, use the helpers in
`packages/modules/test/hub/helpers.ts`: `issueKey` makes an access key, `connectModern` is a
real MCP client talking to the hub's request handler, and `rawToolCall` sends one call by hand
so you can replay a confirmation:

```ts
const first = await rawToolCall(t.app, writer.key, 'special_post', args);
expect(first.asking!.question).toBe('Post "Beef cheek" at $32.50 on the specials board at Oak Diner, from 2026-09-30 to 2026-10-01 (2 days)? Guests see it on those days.');
expect(await named('Beef cheek')).toEqual([]);                      // nothing changed yet
const yes = await rawToolCall(t.app, writer.key, 'special_post', args, { inputResponses: YES, requestState: first.asking!.requestState });
const again = await rawToolCall(t.app, writer.key, 'special_post', args, { inputResponses: YES, requestState: first.asking!.requestState });
expect(again.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has already been used; ask again to do it again.' });
expect(await named('Beef cheek')).toHaveLength(1);                  // one effect
```

Also test against the **group** fixture (three venues in one organisation) when behaviour can
differ per venue. Move time with `t.clock.set(iso)` or `t.clock.advanceMinutes(n)`.

Run:

```bash
npx vitest run specials
```

```
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

### Step 8. The documents

- `packages/modules/src/<name>/CLAUDE.md`: what the module owns, every public function with the
  role it needs, hooks, the config surface, jobs, events, templates, tools, known gaps. Written
  so the next person can use the module without reading the implementation. Copy the headings
  from `packages/modules/src/specials/CLAUDE.md`.
- `docs/modules/<name>.md`: the spec. What it is for, the data, who may do what, the rules, the
  config, the tools, what is not built.
- A row in the table in `docs/MODULES.md`.

### Step 9. The page (not done in the example)

The example stops at the service function. `getCurrentSpecials` returns what the public menu
page needs, but no page calls it yet. Wiring it in means a change in `apps/web`: the public
menu is rendered from `apps/web/src/components/site/page-view.tsx`, which calls
`menu.getPublicMenu` in the same way. A console screen for posting a special is likewise not
built. Both are the next step for this module, and both are changes to the web app, not to the
module.

What you get without touching the web app: the module's switch and its settings appear on the
console's Features page, whose form is generated from your config schema
(`apps/web/src/lib/console-schema-form.ts`), and the tools appear to assistants.

### Step 10. Before you open a pull request

```bash
pnpm typecheck
pnpm check:modules
pnpm check:tenant-branching
ROS_STRICT_SEEDERS=1 npx vitest run
```

Or `pnpm gates`, which runs all four. Every one must pass.

---

## 4. How a module shows up for a venue's assistant

A venue's assistant connects to the hub's MCP server. Three tools, declared in
`packages/modules/src/tenancy/setup-tools.ts`, let it manage plugins. They need the scopes
`plugins:read` and `plugins:write` and a manager's role.

**`plugins_list`** returns every module and every plug as they stand at one venue. For
`specials` an assistant receives:

| Field | Value for `specials` | Comes from |
|---|---|---|
| `plugin` | `specials` | `key` |
| `name` | `Specials board` | `name` |
| `purpose` | `Daily or weekly specials a manager posts…` | `description` |
| `kind` | `plugin` | not a spine module, not a plug |
| `on` | true or false | `venue_modules` |
| `needs` | the `needs` list, with "<module> switched on first" for each entry in `dependsOn` | `needs`, `dependsOn` |
| `settings` | `{ heading: "Specials", show_prices: true, max_running: 10, max_days: 31 }` | the stored config, or the defaults |
| `settings_schema` | JSON Schema of the config | generated from `configSchema` |
| `you_may_change_it` | true | false only when `assistantConfigurable: false` |

You write nothing extra for this. The entry is generated from the module definition
(`listPlugins` in `packages/modules/src/tenancy/plugins.ts`), so it cannot drift from the code.

**`plugin_enable`** takes the plugin key and optional settings. **`plugin_configure`** changes
settings of a plugin that is on. **`plugin_disable`** switches it off and keeps its data. All
three are writes: the person is asked first. All three end in core `setModule`, which validates
the whole config against your schema and writes the audit entry.

A setting your schema does not have, or a value it refuses, is answered in words before anyone
is asked. These are real answers from the example's tests:

```
Specials board has no setting called "colour". Its settings are: heading, show_prices, max_running, max_days.
Those settings for Specials board are not valid. max_running: Too small: expected number to be >=1.
```

### What makes a config understandable to an assistant

The assistant sees `settings_schema` and nothing else about your settings. So:

- **Put a `.describe()` on every setting.** Code comments do not reach the schema. Several
  existing modules document their settings in comments only (`qr`, `reviews` and `hub` have no
  described setting at all); an assistant sees those settings as bare names, types and bounds.
  For `max_running` the assistant receives:
  `{"default":10,"description":"The most specials that may be running or scheduled at once. Posting one more is refused until one ends.","type":"integer","minimum":1,"maximum":50}`
- **Give every setting a default**, and bounds (`min`, `max`, `enum`). They appear in the schema
  and tell the assistant what it may send.
- **Keep the config flat.** `plugin_configure` merges the top-level keys you send over what is
  stored. A nested object is replaced whole.
- **Name settings in plain words** (`show_prices`, not `sp_vis`). The key itself is shown to the
  owner in the confirmation question: `Settings: max_running: 10 to 3.`
- Write `name`, `description` and `needs` for a venue owner. The question the owner is asked
  reads: `Switch on Specials board at Oak Diner? <description> It needs: <needs>.`

If your module must set something up when it is switched on, register
`tenancy.onPluginEnabled(fn)`. It runs in the transaction that switched the module on.

If your module governs what assistants themselves may do, set `assistantConfigurable: false`.
An assistant is then refused when it tries to enable or configure it. Only `hub` does this today.

---

## 5. Writing a plug

A plug is your service's own MCP server, offered to a venue's assistant **through** the hub.
The assistant never talks to you directly. The hub's gateway
(`packages/modules/src/hub/gateway.ts`) lists your tools under its own names, applies the
venue's scopes and roles, asks the person before any change, records every call, and labels
your results as yours.

The only plug of this kind today is Criota. Its catalogue entry is in
`packages/modules/src/hub/plugs.ts`, a simulator of its server is in
`packages/adapters/src/sim/criota-mcp.ts`, and the behaviour described below is tested in
`packages/modules/test/hub/gateway.test.ts`. Quoted test names are from that file.

### 5.1 What your MCP server must look like

The gateway talks to you with the adapter in `packages/adapters/src/mcp/http.ts`.

- **Transport: Streamable HTTP**, at one fixed https address. Answer `POST`.
- **Authentication: a bearer token.** The venue creates an access key in your product and pastes
  it into the console. The hub seals it and sends it as `Authorization: Bearer <key>` on every
  request. The key decides which account the call acts on. Answer **401** to a key you no
  longer accept. OAuth sign-in to a plug is not supported.
- **Stateless.** The gateway opens a fresh client for every call and keeps nothing between calls.
- **Tools**: each with a `name`, a `title`, a `description`, an `inputSchema`, and preferably an
  `outputSchema`.
- **Mark reads.** A tool is treated as a read only when its annotations say
  `readOnlyHint: true`. Everything else is treated as a change.
- **Declare an output schema.** With one, your structured result is validated against the
  reviewed schema and passed on as `data`; a result that does not fit is dropped and the
  assistant is told so. Without one, only your text is passed on, cut at 20,000 characters.
- **Fail in words.** Return `isError: true` with a short text. The gateway relays it as
  "<your name> could not do that: <your text>", cut at 400 characters.

**Changes and confirmation.** The hub always asks the venue's person before a change is sent to
you. How it builds the question depends on a flag the platform operator sets for your adapter,
`asksBeforeWriting`:

- **Your server asks before every change** (Criota's does; this is the better design). On the
  first call, do nothing and ask a question by MCP elicitation: a message in plain words and a
  form with **exactly one boolean field**. The gateway declines that first question on purpose,
  to read your words. It shows the person `<Your name> asks: <your question>`. On their yes it
  calls you again and accepts your question **only if it reads the same as the one they were
  shown**. So your question must be built from current state and must be stable for the same
  arguments. A form that asks for anything more than one boolean is always declined.
- **Your server does not ask.** The gateway builds the question itself from your tool's title
  and the arguments, and sends the call on a yes.

If your adapter is flagged as asking and a tool acts without asking, the gateway cannot take it
back. It reports exactly that to the person and records the call as `unconfirmed` (test: "a
service that acts without asking first is reported as exactly that").

Criota's server offers its change tools only to a client that says it can ask a person (the
MCP elicitation capability). The gateway declares that capability, so a server built the same
way works.

### 5.2 What the hub puts on top

Verified by "lists the plug's tools through our server: namespaced, under our scopes, changes
only where they can be confirmed":

- **Names.** Your tool `list_campaigns` is published as `<namespace>__list_campaigns`, where the
  namespace is your plug key in lower case with other characters turned into `_`. Its title is
  prefixed with your name, and its description with "From <name>, a service this venue connected."
- **Scopes.** Two per plug: `plug:<key>:read` and `plug:<key>:write`. An assistant's key must
  hold the scope. A key without it is offered none of your tools.
- **The connection's own grant.** The connection is made with `read`, `write` or both. A tool is
  offered only if the connection allows its effect.
- **Role.** Only a person who is a **manager or owner** at a venue that switched your plug on
  is offered your tools.
- **Per venue.** Connecting is not offering. Each venue lists your plug key in the hub setting
  `enabled_plugs`, which is empty by default. Until then nothing is offered and your server is
  not even contacted (test: "connecting a plug seals its access key, and offers nothing…").
- **Changes.** Offered only to a key its owner allowed to make changes, used by an assistant
  that can ask its person. Otherwise the assistant sees your reads only.
- **Confirmation.** The hub's own signed, single-use note, bound to the key, the tool and the
  arguments. A yes carried to other arguments, to another key, or used twice changes nothing
  (test: "a plug write goes through OUR confirmation…").
- **Records.** One `agent_calls` row per call naming your plug, the tool and the outcome, and an
  audit entry for every change attempted. Neither holds the arguments or your result.
- **Labels.** Your result is wrapped as `{ source: { plug, service }, note, data | text }`. The
  note says the content is yours and is information, never instructions.
- **Lost answers.** If a change was sent and your answer did not arrive, the person is told it
  "could not be confirmed", never that it was done and never that nothing changed (test: "an
  outcome that cannot be confirmed says so, and never says done"). Make your changes safe to
  check afterwards.
- **Hosted agents** (agents the platform runs for a venue) may use your read tools. Your write
  tools are never offered to them.

### 5.3 Review and pin

Your tool descriptions are text an assistant obeys. So a person reads them before any venue's
assistant sees them, and the hub holds you to what was read.

1. An owner or manager connects your plug with the access key (`hub.connectMcpPlug`). Your
   tools are not offered yet.
2. A **platform admin** (the operator of the deployment, not the venue) opens the platform
   console's plugs page and approves. That calls `hub.reviewPlug`, which reads your live tool
   list through the connection and stores it in `plug_reviews` with a digest per tool.
3. The digest covers each tool's `name`, `title`, `description`, `inputSchema`, `outputSchema`
   and `annotations` (`toolDigest` in `plugs.ts`).
4. From then on, each time an assistant lists or calls your tools, the gateway reads your live
   list and compares. What the assistant is shown is the **reviewed** text, not the live text.

The review is one per plug for the whole deployment, not per venue. It needs one live
connection to read the list through, so the first venue connects before the first review.

**What happens when your tool list changes** (test: "pinning: a changed description withdraws
every tool of the plug until it is reviewed again"):

| You do this | Result |
|---|---|
| Change one tool's description, title, schema or annotations | **Every** tool of your plug is withdrawn, at every venue, until a platform admin reviews again |
| Add a tool | The same: all withdrawn until reviewed |
| Remove a tool, or offer fewer tools to a narrower key | Still pinned. Nothing unreviewed is on offer |
| Put the list back exactly as reviewed | Offered again with no new review |

While withdrawn, the assistant's catalogue says "its tools are withdrawn for now, because its
tool list changed since it was reviewed", and calling a withdrawn tool by name reaches nothing.

So: version your tool list, change it rarely, and tell the operator before you deploy a change.
Nobody is notified today when a pinned list changes: the 15-minute health check
(`hub.check_plugs`) logs a warning, and the platform console's plugs page shows the plug as
changed when someone opens it.

**If you refuse the saved key** (401): the connection is marked unhealthy, your tools are
withdrawn, the person who connected it is emailed once a day at most, and you are not asked
again on every request. If you are merely unreachable, your tools are withdrawn for that
request and the connection keeps its standing (test: "when the service refuses the saved key…").

### 5.4 What data may and may not leave an organisation

**What you receive through tool calls: the arguments, and nothing else.** The gateway passes
the assistant's arguments and the venue's access key for your service. It adds no venue data,
no guest data and no identity of the staff member.

Be clear about the limit of that. The arguments are written by the venue's assistant, which can
also read the venue's own tools if its key allows. The engine does not inspect what an
assistant chooses to put in an argument. What it does control is what the assistant can read
in the first place: guest-level reads are off by default at every venue, have their own scopes,
and there is no bulk export tool (`docs/THREAT_MODEL.md` section 7).

**What the engine itself releases to a connected service: campaign outcomes, to Criota only.**
This is the one path where the engine hands a service data from the venue's database. Its rules
are the consent rules for anything that follows it (`docs/modules/hub.md` section 7; test: "the
Criota boundary: nothing is shared until the venue switches it on AND Criota is connected, per
venue, above a minimum cohort"):

- **Off by default**, for every venue, including one that came in through the service.
- **The venue switches it on** (`criota_share_enabled`), and the service must be connected.
- **An owner issues the key.** A service key holds the scope `outcomes:read` and nothing else,
  can never make changes, and ends when the connection is revoked.
- **Totals only.** Per-campaign outcomes: new customers, spend as a band, repeat rate.
- **A minimum cohort.** No figure is released for fewer guests than the venue's setting, which
  cannot be set below 5 and defaults to 10.
- **Per venue.** Never joined across venues. A guest at two venues is two unrelated counts.
- **Never**: guest rows, names, contact details, card identifiers, or any per-guest record.

The path is closed to other plugs in code: `campaignOutcomes` in
`packages/modules/src/analytics/outcomes.ts` answers "There are no outcomes for this service"
to a service key of any plug that is not Criota. A new plug gets no data from the engine.

---

## 6. Getting a plugin accepted

What a reviewer checks. Run through it yourself first.

**For a module**

Gates and tests
- [ ] `pnpm typecheck`, `pnpm check:modules`, `pnpm check:tenant-branching` pass.
- [ ] `ROS_STRICT_SEEDERS=1 npx vitest run` passes, the whole suite, not only your file.
- [ ] `db.gen.ts` was regenerated and its diff contains only your tables.

Tenancy and access
- [ ] Every table has `org_id`, indexes that lead with it, and the migration ends with
      `select app.apply_tenant_rls();`.
- [ ] Every exported function starts: zod parse, role check, `assertModule`. Guest-facing
      functions have no role check but do call `assertModule`.
- [ ] No use of `app.db` or `app.platform()` without a comment saying why.
- [ ] No table name held in a variable, and no query on a table you do not own (the gate cannot
      see the first).
- [ ] No tenant-specific branching, and no `tenant-branching-ok:` comment without a reason.

Threat-model cases (`docs/THREAT_MODEL.md` section 11), each with a test that reads the database back
- [ ] Wrong role: forbidden, nothing written.
- [ ] Another org's id: not found. A venue the caller has no role at: not found.
- [ ] Module off: not found; tools not offered; data kept and back when switched on.
- [ ] Replay: one effect.
- [ ] Prices, totals and discounts come from the server or from staff, never from a guest.
- [ ] For each case that does not apply, the pull request says why.

Behaviour
- [ ] Time from `ctx.now()`; dates in the venue's zone; money in integer cents.
- [ ] No provider call inside a tenant transaction; outward actions through `once` and a job.
- [ ] Every change a venue could dispute is audited. Every measurable thing is a declared event.
- [ ] Guest-written text is returned to assistants as labelled, length-capped quoted content
      (see `packages/modules/src/reviews/guest-content.ts`).
- [ ] Disabling the module deletes nothing.

Tools
- [ ] Each tool calls the same service function the console would. No second implementation.
- [ ] `output` names only what should leave. No personal data that the task does not need.
- [ ] Every write is `propose` + `commit`; `propose` changes nothing; the question is specific
      and names the venue and any money; `commit` does what the question said.
- [ ] No tool both reads guest-written text and changes state in one call.
- [ ] No export or bulk-read tool.

Config and documents
- [ ] Every setting has a default, bounds and a `.describe()`.
- [ ] A fixture seeder that seeds both fixture organisations through the module's own functions.
- [ ] `CLAUDE.md` in the module directory, a spec in `docs/modules/`, a row in `docs/MODULES.md`.

**For a plug**

- [ ] Streamable HTTP at a fixed https address; bearer access key; 401 on a refused key.
- [ ] Every read tool carries `readOnlyHint: true`. Every tool has an output schema.
- [ ] Every change asks first, with a single-boolean form and a question that is specific and
      stable for the same arguments.
- [ ] Descriptions say what the tool does and contain no instructions to the assistant beyond
      how to use the tool.
- [ ] Results carry no more personal data than the task needs.
- [ ] The tool list is versioned, and the operator is told before it changes.

---

## 7. Not there yet

Exact about today. Each item names the file that shows it.

**Modules**

1. **A module cannot be loaded from outside the repository.** It must be merged in (or you run
   your own fork, which the licence allows; AGPL-3.0 then requires you to publish your changes
   if you offer it as a hosted service). The only loading mechanism is the static list of
   imports in `packages/modules/src/index.ts`. There is no plugin directory, no dynamic import
   and no configuration that names extra modules.
2. **There is no published SDK.** `@ros/core`, `@ros/modules`, `@ros/testkit` and the rest are
   workspace packages marked `"private": true` (`packages/*/package.json`). You cannot depend on
   them from another repository.
3. **Module code is not sandboxed.** It runs in the engine's process with the engine's database
   connection. Row-level security, the gates and review are the protection. That is why a
   module is merged, not installed.
4. **There is no public catalogue or registry.** `docs/PIPEDLINE.md` section 3 describes one
   (`/plugins.json`, `/llms.txt`, a public plugins page). None of it exists. The only catalogue
   is `plugins_list`, which an assistant with a venue's key can read.
5. **There is no scaffold command.** You copy an existing module.
6. **Migration number ranges are not written down.** They are a habit visible in
   `db/migrations/`. Two people can pick the same number.
7. **A module's tables cannot be removed.** Migrations are additive only and there is no
   uninstall. Switching a module off hides it and keeps its data.
8. **A new module gets no pages.** The console's Features page (switch and settings form) is
   generated. Any other screen, and anything on the public site, is a change to `apps/web`.
   For `specials`, neither the public menu page nor a console screen exists.
9. **The boundary gate reads string literals only**, in `packages/modules/src` only
   (`scripts/check-module-boundaries.ts`). Rules 3, 4, 5, 6, 12 and 13 in section 2 have no
   automated gate at all; they rest on tests and review.

**Plugs**

10. **A self-hosted operator cannot add a plug without code changes.** Three things are in code:
    the catalogue entry (`definePlug` in `packages/modules/src/hub/plugs.ts`), the adapter
    registration with the server's address (`packages/runtime/src/live.ts`, which registers
    only Criota), and the environment variable for that address
    (`packages/runtime/src/env.ts`, which knows only `CRIOTA_MCP_URL`). The address is fixed in
    code on purpose: a venue must not be able to point the engine at an address of its choosing.
11. **There is no manifest format for a plug.** `docs/modules/hub.md` section 6 says "a community
    plug is a manifest, not code we run". No manifest exists; a plug is a `definePlug` call.
12. **The `community` tier is a word in a type** (`PlugDef.tier` in
    `packages/core/src/connections.ts`). Nothing reads the tier, and nothing makes a community
    plug read-only until reviewed, as that document says it should be. Every plug is held to the
    same pin-and-review step.
13. **A plug authenticates by access key only.** `connectMcpPlug`
    (`packages/modules/src/hub/health.ts`) stores a pasted key; the HTTP adapter sends it as a
    bearer token. A plug whose server requires OAuth sign-in cannot be connected.
14. **A plug receives no data from the engine.** The outcomes path is closed to every plug but
    Criota (`packages/modules/src/analytics/outcomes.ts`). There is no general, consented way
    for a venue to share totals with another service.
15. **A plug cannot be switched on by an assistant.** `plugins_list` shows plugs as kind
    `connection`. Connecting one, and listing it in `enabled_plugs`, are done by a person in the
    console: the access key is never handled by an assistant, and `hub` settings are not
    assistant-configurable.
16. **There is no self-service review.** Review is a platform admin pressing a button after
    reading the list. There is no submission flow, no notification when a pinned list changes,
    and no way for a plug author to request a re-review.
17. **A plug's confirmation form may ask for one boolean and nothing else**
    (`soleBoolean` in `packages/adapters/src/mcp/http.ts`). A tool that needs the person to
    choose or type something during confirmation is always declined.
