# Running Pipedline yourself

This guide takes a clean checkout to a running deployment on your own Postgres, with your own
keys, on your own host. It is written for a developer who has not seen the repository before.

Every command in the numbered steps was run on 2 October 2026 against a new, empty Postgres 18.4
(not the seeded test database), as a database user that is not a superuser. The output shown is
what was printed. What was not run is listed at the end under
[Not covered, not verified](#11-not-covered-not-verified). Read that section before you rely on
this for real venues.

Some names in the code still say `ros` (the packages are `@ros/*`, variables start with `ROS_`): it is the same thing.

## 1. What runs

| Piece | What it is | Command |
|---|---|---|
| Web app | One Next.js server. It serves the console, the platform console, the assistant endpoint (`/api/mcp`), provider webhooks, and every venue's site. | `pnpm start:web` |
| Worker | One Node process. It runs queued jobs (sending messages, provisioning, imports) and the schedules. | `pnpm start:worker` |
| Database | One Postgres database. All venues share it. Row-level security keeps each organisation to its own rows. | yours |

Both processes read their configuration from the environment and nothing else. They read no
`.env` file by themselves (section 4 shows how to load one).

## 2. What you need

| | Required | Notes |
|---|---|---|
| Node.js | 22 or later | `package.json` `engines`. Run here on 22.23.2. |
| pnpm | 10.28.2 | Pinned in `package.json` `packageManager`. Run here with exactly that version. |
| Postgres | Run on 18.4 only | Older versions have not been tried. |
| Postgres extensions | `pgcrypto`, `citext` | The first migration creates both. They ship with Postgres (the "contrib" package on some systems). |
| A database user | Owns the database and has `CREATEROLE` | Section 3. A superuser is not needed. |
| Memory | About 4 GB free to build | The build used about 16 seconds of wall time here. The running web server used about 300 MB and the worker about 160 MB when idle. |
| Two host names | One for the console, one wildcard for venue sites | Section 8. |

Docker is not needed and is not covered: there are no container files in the repository yet.

## 3. Create the database

As a Postgres administrator, create one user and one database. Choose your own password.

```sql
create role pipedline login createrole password 'CHOOSE-A-PASSWORD';
create database pipedline owner pipedline;
```

Why these rights:

- **Owner of the database.** The migrations create two extensions and every table. The app must
  connect as the user that owns the tables: platform code (sign-in, provisioning, webhooks)
  reads across organisations as the owner, and any other user sees no rows.
- **`CREATEROLE`.** The first migration creates a role named `app_tenant`, with no login. Every
  request for a venue runs as that role, with row-level security on.

Use the same user to migrate and to run the app. `pnpm check:config` tells you if you have not.

## 4. Configuration

Copy `.env.example` to `.env` in the repository root and fill it in. It lists every variable with
a placeholder. Never commit `.env`.

The start commands do not read `.env`. Load it into the shell that starts them:

```bash
set -a; . ./.env; set +a
```

(`pnpm check:config` and `pnpm smoke:live` also read `.env` in the repository root by themselves.
Variables already in the environment win.)

Generate the two keys once and keep them safe (section 10):

```bash
openssl rand -base64 32    # ROS_MASTER_KEY
openssl rand -base64 32    # ROS_SIGNING_KEY
```

### The two decisions

Set both on every process. `pnpm check:config` refuses a configuration that leaves either out.

| Variable | Values | Meaning |
|---|---|---|
| `ROS_ENV` | `production`, `development` | `production` refuses simulated providers, refuses missing keys and hosts, closes the development tools, and writes `https` links. If you leave it unset, the web app decides `production` (Next sets `NODE_ENV`) and the worker decides `development`. Any other word, such as `staging` or `prod`, is treated as "not production". |
| `ROS_ADAPTERS` | `live`, `mixed`, `sim` | `live`: real providers only. `mixed`: real where configured, simulated otherwise. `sim`: everything simulated. `ROS_ENV=production` accepts `live` only. |

So there are two ways to run it:

- **Production**: `ROS_ENV=production`, `ROS_ADAPTERS=live`. Needs an email provider (Resend).
- **Trial**: `ROS_ENV=development`, `ROS_ADAPTERS=sim` (or `mixed`). Needs no provider. No email
  leaves the machine; "sent" messages are shown at `/dev/inbox`. **The pages under `/dev` and
  `/api/dev` are open to anyone who can reach the server in this mode, and they show every
  sign-in code.** Use it on your own machine or a private network only.

### Variables

Taken from `packages/runtime/src/env.ts`, `packages/runtime/src/index.ts` and `apps/web/src`.

| Variable | Required when | What it does |
|---|---|---|
| `ROS_ENV` | always | See above. |
| `ROS_ADAPTERS` | always | See above. |
| `DATABASE_URL` | always | `postgres://USER:PASSWORD@HOST:5432/DATABASE` |
| `ROS_MASTER_KEY` | production | 32 random bytes, base64. Seals stored provider credentials. Outside production a fixed key from the source code is used if it is unset. If you change it, credentials already stored cannot be opened. |
| `ROS_SIGNING_KEY` | production | 32 random bytes, base64. Signs short-lived tokens: an assistant's confirmation of a change, the state of a provider sign-in. Same fallback outside production. |
| `ROS_PLATFORM_HOST` | production | The host of the console, the assistant endpoint and the webhooks, for example `console.example.com`. Include the port if it is not 80 or 443. Default `localhost:3000`. |
| `ROS_TENANT_ROOT_DOMAIN` | production | Venue sites live at `<slug>.<this domain>`, for example `tables.example.net`. No port. Default `tables.localhost`. |
| `ROS_SCHEME` | no | `http` or `https`. Default `https` in production, `http` otherwise. Used in every link the app writes and in webhook addresses. With `http`, session cookies lose the `Secure` flag. |
| `ROS_DB_POOL` | no | Database connections per process. Default 10. |
| `PORT` | no | The port `pnpm start:web` listens on. Default 3000. |
| `ROS_SELF_SERVE` | no | `1` opens `/start` on the platform host: anyone with an email address can sign in and start a venue of their own (rate-limited). Off by default; `/start` is then a 404 and venues are onboarded from the platform console. |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | `live` | Email through Resend. The key starts `re_`, the webhook secret `whsec_`. |
| `ROS_PLATFORM_SENDING_DOMAIN` | `live` | Sign-in codes are sent from `signin@<this domain>`. It must be a verified domain at Resend. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | no | SMS through Twilio. Set both or neither. |
| `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WEBHOOK_URL` | no | Optional Twilio settings. |
| `ROS_PLATFORM_SMS_SENDER` | no | Sender shown on texts when no Messaging Service is set. Default `ROS`. |
| `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET` | no | Square point of sale, payments and sign-in. Set both or neither. |
| `SQUARE_ENVIRONMENT` | no | `sandbox` or `production`. Default `production`. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY`, `SQUARE_WEBHOOK_URL` | no | Without the signature key, Square webhooks are refused and sales arrive by polling only. |
| `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | no | Attaches a venue's own domain to a Vercel project. Only useful if the web app is hosted there. |
| `ANTHROPIC_API_KEY` | no | The model, for menu import and other model features. |
| `ROS_LLM_MODEL_FAST`, `ROS_LLM_MODEL_QUALITY`, `ROS_LLM_FALLBACKS` | no | Model ids per tier; `ROS_LLM_FALLBACKS=off` switches the provider's fallback off. |
| `UBER_DIRECT_ENABLED`, `DOORDASH_DRIVE_ENABLED`, `KLAVIYO_ENABLED`, `META_CAPI_ENABLED` | no | `1` offers the provider to venues. Each venue enters its own credentials. |
| `CRIOTA_MCP_URL` | no | The `https` address of the Criota remote MCP server, an optional plug. Access keys are per venue. |
| `ROS_EMAIL_ADAPTER`, `ROS_SMS_ADAPTER` | no | Override which adapter sends. Rarely needed. |
| `ROS_SITE_TAGS` | no | `1` allows Google Analytics and Meta pixel tags on venue sites, after the visitor agrees. Off by default. |
| `ROS_SITE_CACHE_SECONDS` | no | How long a published page stays cached in a web process. Default 300. |
| `ROS_SITE_CACHE_EPOCH` | no | Cache namespace. By default each process start has its own. |
| `ROS_INLINE_WORKER` | no | `1` makes the web process run the worker loop too. Meant for development; then do not also start `pnpm start:worker` unless you want two. |
| `ROS_CLOCK_START`, `ROS_SIM_SQUARE_OAUTH` | never in production | Test switches. `ROS_CLOCK_START` is refused in production; the simulated Square sign-in is refused with `live`. |

`docs/GOING_LIVE.md` says, provider by provider, where to get each credential and which webhook
address to register.

## 5. Install, migrate, bootstrap, check, build, start

Run everything from the repository root, with the environment loaded (section 4).

### Step 1. Install

```bash
pnpm install --frozen-lockfile
```

It ends with `Done in 4.2s using pnpm v10.28.2` (longer the first time).

### Step 2. Migrate the database

```bash
pnpm db:migrate
```

It applies the files in `db/migrations` in name order, each in its own transaction, and records
each one with a checksum in the table `schema_migrations`. On the empty database it printed
(there were 20 files when this was run; your count is however many `db/migrations` holds):

```
  applied  0001_foundation.sql
  applied  0002_tenancy.sql
  ...
  granted the role app_tenant to this database user
Applied 20 migrations; 0 already in place. The database is up to date.
```

The "granted" line appears once, when the database user is not a superuser. On Postgres 16 and
later the user that creates a role cannot switch to it until the role is granted to it; the
runner does that. Without it, every venue request would fail.

Run it again and nothing happens:

```
Nothing to do: all 20 migrations are already applied.
```

To look without changing anything: `pnpm db:migrate --status`. Before step 2 it printed
`0 applied, 20 pending, 0 changed.`, a line per pending file, and exited with code 1.

The runner refuses a migration file whose contents changed after it was applied
(`Migration <file> changed after it was applied. Add a new migration instead.`) and stops
there. Two runners started at once do not collide: one waits for the other.

### Step 3. Make the first platform admin

```bash
pnpm bootstrap:admin --email you@example.com --name "Your Name"
```

```
you@example.com is now a platform admin (1 in total).
They sign in at /platform/login on the platform host, with a code emailed to that address.
```

A platform admin can onboard venues, see every organisation and open support access. It is not
a role inside any venue. There are no passwords anywhere: every sign-in is a 6-digit code sent
by email.

Running it again changes nothing:

```
you@example.com is already a platform admin. Nothing changed (1 in total).
```

A different address is refused once an admin exists, so a typo cannot make a second admin
without you noticing. To add one on purpose: `pnpm bootstrap:admin --email other@example.com --add`.

### Step 4. Check the configuration

```bash
pnpm check:config
```

It calls no provider and changes nothing. It prints what the configuration is, then a `WARN`
line for anything that will start but not work well, then a `FIX` line for anything the app
cannot start with. Exit code 1 if there is any `FIX` line. No value is ever printed, only names.

With only `DATABASE_URL`, `ROS_ENV=production` and `ROS_ADAPTERS=live` set, it printed:

```
FIX   RESEND_API_KEY and RESEND_WEBHOOK_SECRET are not set (Resend (email) is required: sign-in codes and receipts go by email)
FIX   ROS_PLATFORM_SENDING_DOMAIN is not set (the domain transactional email is sent from; it must be verified at Resend)
FIX   ROS_MASTER_KEY is not set (32 random bytes, base64: openssl rand -base64 32)
FIX   ROS_SIGNING_KEY is not set (32 random bytes, base64: openssl rand -base64 32)
FIX   ROS_PLATFORM_HOST is not set (the host the console and webhooks live on)
FIX   ROS_TENANT_ROOT_DOMAIN is not set (the domain venue sites live under)

6 things to fix before the app will start. 0 warnings.
```

With everything set it ends:

```
  Database "pipedline" on Postgres 18.4, as user "pipedline".
  All 20 migrations are applied.
  1 platform admin, 0 organisations.

Configuration is complete. 0 warnings.
```

It also checks the database: that it can be reached, that every migration is applied and none
has changed, that this user can act as `app_tenant`, and that this user owns the tables.

`pnpm smoke:live` goes one step further and makes one read-only call to each configured
provider, to prove the credentials are accepted. It was not run with real credentials here.

### Step 5. Build the web app

```bash
pnpm build
```

It needs no application variables and no database. It ends with the list of routes and took 16
seconds here. Rebuild after every code change. The worker needs no build.

### Step 6. Start

Two processes, each with the same environment:

```bash
pnpm start:web       # listens on PORT (default 3000), all interfaces
pnpm start:worker
```

Behind a reverse proxy on the same machine: `pnpm start:web --hostname 127.0.0.1`.

The web app prints `✓ Ready in 102ms`. The worker prints one line of JSON:

```
{"level":"info","msg":"worker started","mode":"live","env":"production"}
```

In `live` mode each also prints which providers are real, by name:

```
{"level":"info","msg":"adapters","mode":"live","real":["message:resend","sending_domain:resend"],"email":"resend","sms":"twilio","model":"none","storage":"none"}
```

Both commands run the checks from step 4 first and refuse to start, listing every `FIX` line,
if the configuration is incomplete or the database has migrations pending. For example, with
simulators asked for in production:

```
The worker was not started.

FIX   ROS_ADAPTERS=sim cannot run with ROS_ENV=production: simulated providers are refused in production. Use ROS_ADAPTERS=live, or ROS_ENV=development for a trial.
```

To stop either process send it `SIGTERM`. The worker finishes the job in hand first and logs
`worker stopping`. Jobs are safe to resume.

Keeping the two processes running after a crash or a reboot is up to your process manager.
None is provided.

## 6. First use

The addresses below assume `ROS_PLATFORM_HOST=console.example.com`.

1. **The platform admin signs in** at `https://console.example.com/platform/login` with the
   address from step 3. `/platform/tenants` lists every organisation.
2. **A venue is started** in one of two ways:
   - With `ROS_SELF_SERVE=1`: the owner opens `https://console.example.com/start`, enters an
     email address, enters the code, and names the venue. They land in the console as its owner.
   - Without it: the platform admin onboards the venue at `/platform/onboarding`. This path
     was not run for this guide.
3. **The venue is a draft.** Its organisation has status `onboarding` and its venue `setup`. Its
   site answers 404 until the owner takes it live.
4. **The owner connects an assistant.** In the console, Settings, Assistants, "Create key". The
   key (`ros_agent_…`) is shown once. The assistant endpoint is
   `https://console.example.com/api/mcp` (MCP over streamable HTTP, `Authorization: Bearer <key>`).
   The first tool to call is `setup_status`. It says what is done and what is next.
5. **Staff sign in** at `https://console.example.com/login`. That page only sends a code to an
   address that already belongs to a venue.

## 7. What was verified, and in which mode

No real provider key was used. So the run was done twice against the same database.

### Production mode (`ROS_ENV=production`, `ROS_ADAPTERS=live`)

Without email credentials production does not start at all. The runtime stops with
`ROS_ADAPTERS=live cannot start` and the list from step 4. That is the first place it stops.

With placeholder values of the right shape (`RESEND_API_KEY=re_…`, `RESEND_WEBHOOK_SECRET=whsec_…`)
both processes started, and these were checked with `curl`:

| Request | Answer |
|---|---|
| `GET /login`, `/platform/login`, `/start` | 200 |
| `GET /console` (not signed in) | 307 to `/login` |
| `GET /dev`, `/dev/inbox`, `/dev/pos-signin`, `/dev/pos-signin/decide`, `/api/dev/sim` | 404 |
| `POST /api/dev/ops/sale` | 404 |
| `GET /sites/anything.tables.localhost` (a venue path typed by hand) | 404 |
| `GET /login` with a header `x-ros-host: anything.tables.localhost` | 200, the platform page: the header is ignored |
| `GET /` with `Host: nobody.tables.localhost` (no such venue) | 404 |
| `POST /api/mcp` with no key | 401, with a `WWW-Authenticate` header |

So the development tools are closed in production. They exist only when a provider is
simulated, and production refuses simulators.

**The second place it stops is sign-in.** Asking for a sign-in code at `/platform/login` made
the app call Resend, which refused the placeholder key. The page showed the app's error page and
the web log showed `ResendApiError: resend: 401 on /emails (validation_error)`. No code is
delivered, so nobody can sign in, and nothing past sign-in can be reached. Everything beyond
this point in production mode is unverified.

### Trial mode (`ROS_ENV=development`, `ROS_ADAPTERS=sim`)

The same build, the same database, the web app and the worker as two processes, driven by a
real browser (Playwright) and `curl`:

1. Open sign-in at `/start` with an address nobody had seen: code requested, code read from the
   simulated inbox (`/api/dev/sim`), code entered. Signed in.
2. Self-serve start: named the venue "Harbour Kitchen". Landed on `/console`, heading "Overview".
3. Created an assistant key in the console.
4. Connected to `/api/mcp` with that key using `curl`: `initialize` returned 200 and the server's
   instructions; `tools/list` returned 19 tools; `tools/call setup_status` returned
   `"summary":"Harbour Kitchen is a draft: 0 of 5 setup steps are done. It is not public until it goes live."`
   A wrong key returned 401.
5. The platform admin from step 3 signed in at `/platform/login`; `/platform/tenants` listed
   Harbour Kitchen.
6. The database, read back afterwards:

```
orgs:            harbour-kitchen | Harbour Kitchen | onboarding
venues:          Harbour Kitchen | setup | Australia/Sydney
platform_admins: admin@example.com | admin
users:           admin@example.com, owner@harbour-kitchen.example
staff:           owner@harbour-kitchen.example | owner | active
domains:         harbour-kitchen.tables.localhost | primary | verified
onboardings:     self_serve | review
agent_keys:      Self-hosting check | not revoked
jobs:            9 succeeded (run by the separate worker process)
```

7. `pnpm db:migrate` again: `Nothing to do: all 20 migrations are already applied.`
8. With `ROS_SELF_SERVE` unset, `/start` answered 404.

In trial mode `/dev`, `/dev/inbox` and `/api/dev/sim` answered 200. That is how the code was
read, and it is why this mode must never face the internet.

One limit of trial mode with two processes: simulated providers live in each process's memory.
Sign-in codes are sent by the web process and appear in its `/dev/inbox`. Messages sent by jobs
are "sent" inside the worker and appear nowhere. For a trial where you want to see those too,
set `ROS_INLINE_WORKER=1` on the web app and do not start the worker.

## 8. Putting it behind a domain

The web app decides what a request is for from its `Host` header, and nothing else:

- `Host` equal to `ROS_PLATFORM_HOST`: the console, `/platform`, `/api/mcp`, `/webhooks/…`, `/start`.
- Any other `Host`: a venue's site. The host is looked up in the `domains` table. An unknown
  host is a 404. A venue cannot be reached by typing a path.

So you need:

| What | DNS | Example |
|---|---|---|
| The platform host | One record to your server | `console.example.com` |
| Venue sites | One wildcard record to your server | `*.tables.example.net` |

Each venue gets `<slug>.<ROS_TENANT_ROOT_DOMAIN>` when it is created, and that row is already
marked verified. No DNS change is needed per venue.

Put the console on a different registrable domain from the venue sites if you can
(`example.com` and `example.net` above). Session cookies are host-only either way; a separate
domain is the safer layout. `pnpm check:config` warns if the console sits inside the venue domain
and refuses the two being the same host.

A reverse proxy in front must:

- **Terminate TLS** for the platform host and for the wildcard. A wildcard certificate needs a
  DNS challenge with most certificate authorities. Keep `ROS_SCHEME` unset (it is `https` in
  production) so cookies are `Secure` and links are `https`.
- **Pass the `Host` header through unchanged.** If the app sees the proxy's own host (for
  example `127.0.0.1:3000`), every page is a 404. This was seen here.
- **Set `X-Forwarded-For` itself**, replacing whatever the client sent. The app takes the first
  address in that header as the caller for its rate limits (sign-in codes, self-serve starts,
  the assistant endpoint). A proxy that passes a client's own header through lets a caller
  dodge those limits.
- **Allow request bodies up to 10 MB.** Image uploads are up to 8 MB.

**A venue's own domain** (`www.their-venue.com.au`): the only adapter that attaches one drives
the Vercel domains API, and it has never been run against Vercel. On your own host, without
it, the custom-domain step in the console stays blocked. Adding a row to `domains` by hand and
pointing the DNS at your proxy has not been tried. Treat custom domains as not available.

No proxy, TLS or DNS set-up was run for this guide. The host rules above were checked with
`curl` and a `Host` header against the app directly.

## 9. Providers: what works without each

`pnpm check:config` prints this list for your own configuration.

| Provider | Without it |
|---|---|
| Email (Resend) | `live` mode will not start. With a wrong key it starts, but no sign-in code is delivered, so **nobody can sign in**: not staff, not the platform admin, not guests. Email is the only way in. |
| SMS (Twilio) | Texts fail and are recorded as failed. Guests can still sign in by email. |
| Square | No Square sign-in, no sales from the till, no card payments online. |
| Vercel | No custom domains. Sites still answer on `<slug>.<ROS_TENANT_ROOT_DOMAIN>`. |
| Model (Anthropic) | Menu import from a link and other model features answer "The assistant model is not set up on this platform yet." A venue's own assistant over `/api/mcp` is not affected: it brings its own model. |
| Couriers, Klaviyo, Meta, remote services | Not offered to venues. |
| File storage | **There is no real storage adapter.** In `live` mode every image upload is refused with "File storage is not set up on this platform yet." In trial mode uploads are kept in memory and lost on restart. |

State of the real adapters, from `docs/STATUS.md`: Square has been run against the Square
sandbox. Every other real adapter (Resend, Twilio, Vercel, the couriers, Klaviyo, Meta, the
model) is written and has never been called live.
The first real run of each is yours. `docs/GOING_LIVE.md` has the order to do it in.

## 10. Upgrading and backup

### Upgrading

```bash
git pull
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
# restart the web app and the worker
```

Migrations only add; a released migration file is never edited. Run `pnpm db:migrate` before
starting the new code: `pnpm start:web` and `pnpm start:worker` refuse to start while a
migration is pending. If the database is ahead of the code (you rolled the code back), the
check says so: `the code is older than the database`.

Of this sequence, `pnpm install`, `pnpm db:migrate` (including a second run and an added
migration, in the tests) and `pnpm build` were run. A real upgrade from one release to the
next, with the old code still serving during the migration, was not.

### Backup

Back up two things. Neither is any use without the other.

1. **The database.** Everything is in it: venues, guests, orders, the job queue, and provider
   credentials (sealed). Use your Postgres host's backups or `pg_dump`.
2. **`ROS_MASTER_KEY` and `ROS_SIGNING_KEY`.** Store them outside the database backup. Without
   the master key the sealed credentials in a restored database cannot be opened, and every
   venue must reconnect its providers. A new signing key only voids confirmations and provider
   sign-ins that were in progress.

Nothing is stored on the app server's disk. Uploaded files are not stored at all yet (section 9).

No backup or restore was run for this guide. `pg_dump` is not installed on the machine it was
written on.

## 11. Not covered, not verified

- **Containers.** No Docker or Compose files. Docker was not available to test them, so none
  are provided.
- **Production past sign-in.** No real email key was used. In production mode nothing after
  "ask for a sign-in code" has been run (section 7).
- **Every provider, live.** No real credential was used. `pnpm smoke:live` has never been run
  with real credentials.
- **A venue's public site in a self-hosted run.** The venue made here stayed a draft, so its
  host answered 404, as designed. Taking a venue live and loading its site on its own host was
  not done in this run. (The repository's own tests do it, in the development harness.)
- **Platform-admin onboarding** (`/platform/onboarding`) in a self-hosted run. Only the admin's
  sign-in and the tenants list were checked.
- **The `/start` page** is new and minimal: three forms. It has no automated browser test yet.
- **Reverse proxy, TLS, DNS.** Not set up. Only the `Host` rules were checked.
- **Custom domains** for venues on your own host.
- **Postgres other than 18.4**, and managed Postgres services. Some services do not let a user
  create roles or extensions; step 2 would then fail on the first migration.
- **Backup and restore.**
- **More than one web process.** Each web process caches published site pages in its own
  memory for up to `ROS_SITE_CACHE_SECONDS`. With two, a publish can take that long to show on
  the other. More than one worker is supported by the job queue but was not run here.
- **Process supervision, log shipping, monitoring, alerts.** Both processes log to standard
  output. Nothing else is provided.
- **Load.** One browser and one assistant connection.
- **Second factor for platform admins.** Not built. A platform admin is as safe as their mailbox.
- **Security review of an internet-facing deployment.** `docs/THREAT_MODEL.md` section 12 lists
  what is still open (secret vault, data-handling terms, consent wording, incident plan). Read it
  before holding real guests' data.
