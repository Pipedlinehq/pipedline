# Going live: real providers

How to switch each provider from its simulator to the real service. Read `docs/STATUS.md`
first: **no adapter in this repository has been called against its provider.** Each was written
from the provider's published documentation and tested against payloads built from that
documentation. Treat the first sandbox run of each as its verification, and expect to fix
field names.

## 1. Modes

| `ROS_ADAPTERS` | What runs | Where |
|---|---|---|
| `sim` (default) | every provider simulated | development, tests |
| `mixed` | real where its variables are set, simulated otherwise | staging, bringing providers up one at a time. **Refused when `ROS_ENV=production`.** |
| `live` | real providers only, no simulator anywhere | production |

A provider is registered only when its variables are present. A provider that is half set (an
account id without its token) stops the process with one message listing every problem. `live`
also refuses to start without the database, Resend and a platform sending domain, and in
production without the two keys and the two hosts. The message names variables, never values.

The composition root is `packages/runtime/src/index.ts` (`composeAdapters`), the per-provider
checks are `packages/runtime/src/env.ts`, the wiring is `packages/runtime/src/live.ts`.

## 2. One command to check credentials

```bash
pnpm smoke:live      # reads the environment, and .env in the repo root if present
```

One read-only call per configured provider (list domains, fetch the account, list locations…),
`PASS` / `FAIL` / `skip` per provider, exit code 1 if anything failed. It writes nothing, sends
nothing and prints no secret. Run it after setting each provider's variables.

The message webhook routes can be checked with one command too. Before the provider is
configured the route answers 404; once it is, an unsigned request answers 401, which shows the
route exists and is checking signatures:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$ROS_PLATFORM_HOST/webhooks/messages/resend -d '{}'   # 401
```

## 3. Core (required)

| Variable | What |
|---|---|
| `DATABASE_URL` | Postgres. Apply `db/migrations` first. |
| `ROS_MASTER_KEY`, `ROS_SIGNING_KEY` | 32 random bytes each, base64 (`openssl rand -base64 32`). The master key seals every provider token; losing it loses every connection. Required in production. |
| `ROS_PLATFORM_HOST` | host of the console, the hub and all webhooks, e.g. `console.example.com` |
| `ROS_TENANT_ROOT_DOMAIN` | venue sites live at `<slug>.<this>`; a different registrable domain from the platform host |
| `ROS_PLATFORM_SENDING_DOMAIN` | transactional email goes out as `<venue-slug>@<this>`; must be verified at Resend |
| `ROS_ENV`, `ROS_SCHEME`, `ROS_DB_POOL` | optional |

Verify: `pnpm smoke:live` → `PASS  Database`.

## 4. Providers

### Resend (email) — required for live

| | |
|---|---|
| Variables | `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `ROS_PLATFORM_SENDING_DOMAIN` |
| Key permission | **Full access**. A "Sending access" key cannot manage domains, so per-venue sending domains and the smoke check would fail. |
| Webhook URL | `https://<ROS_PLATFORM_HOST>/webhooks/messages/resend` |
| Webhook events | `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.failed`, `email.suppressed` |
| Where the secret comes from | the webhook's "Signing secret" in the Resend dashboard (`whsec_…`) |
| Registers | `message:resend`, `sending_domain:resend` |
| Verify | `pnpm smoke:live` → `PASS  Resend (email)  key accepted; N domain(s); <sending domain> is verified`. Then in the Resend dashboard, send a test event to the webhook and expect a 200. |

Before sending: add `ROS_PLATFORM_SENDING_DOMAIN` as a domain at Resend and verify its DNS
records. Each venue's own marketing domain is registered by onboarding through the same key.
Open and click events arrive only if tracking is switched on for the domain at Resend.

### Twilio (SMS) — optional

| | |
|---|---|
| Variables | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`; optional `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_WEBHOOK_URL`, `ROS_PLATFORM_SMS_SENDER` |
| Webhook URL | `https://<ROS_PLATFORM_HOST>/webhooks/messages/twilio`, used for both: (a) delivery status, which the adapter sets on every message as `StatusCallback`, nothing to register; (b) **inbound messages**, which you set on the number or Messaging Service ("A message comes in": HTTP POST) |
| Signing | Twilio signs with the account's Auth Token; there is no separate webhook secret. Rotating the Auth Token means updating `TWILIO_AUTH_TOKEN`. |
| Recommended | a Messaging Service with **Advanced Opt-Out** on, so Twilio sends `OptOutType` |
| Registers | `message:twilio` |
| Verify | `pnpm smoke:live` → `PASS  Twilio (SMS)  credentials accepted; account is active`. Then text the number and check the Twilio debugger for a 200 from the webhook. |

Without Twilio, live mode still starts; texts fail and are recorded as failed. Things to know:

- Twilio signs the exact public URL. If a proxy changes what the app sees, set `TWILIO_WEBHOOK_URL`.
- Twilio has no idempotency key. A crash between Twilio accepting a text and the platform
  recording it can, rarely, send it twice.
- A STOP sent to the shared platform number cannot be tied to one venue and is acknowledged but
  not recorded. Twilio blocks further texts itself; the resulting error 21610 is recorded as an
  opt-out in the org whose text hit it.
- Our webhook answers inbound messages with JSON, where Twilio expects TwiML or an empty
  body. Check the Twilio debugger after the first inbound text.
- Australian alphanumeric sender IDs must be registered; sender registration is not built.

### Vercel (custom domains) — optional

| | |
|---|---|
| Variables | `VERCEL_API_TOKEN`, `VERCEL_PROJECT_ID` (id or name of the web project), `VERCEL_TEAM_ID` (when the project belongs to a team) |
| Token scope | an access token scoped to the team that owns the project |
| Webhook | none |
| Registers | `hosting:vercel` |
| Verify | `pnpm smoke:live` → `PASS  Vercel (custom domains)  token and project accepted; N domain(s) on the project` |

Without it, the onboarding step "custom domain" stays blocked with "No web host is configured".
A domain counts as verified only when Vercel reports it verified for the project and its DNS as
correctly configured.

### Square (POS, payments, sign-in) — optional

| | |
|---|---|
| Variables | `SQUARE_APPLICATION_ID`, `SQUARE_APPLICATION_SECRET`, `SQUARE_ENVIRONMENT` (`sandbox` or `production`), `SQUARE_WEBHOOK_SIGNATURE_KEY`, optional `SQUARE_WEBHOOK_URL` |
| OAuth redirect URL | `https://<ROS_PLATFORM_HOST>/console/connections/square/callback`, set as the **Redirect URL** on the application's OAuth page in the Square Developer Console (per environment: the sandbox application has its own). It must match exactly. The adapter sends no `redirect_uri`: Square uses the registered one (verified against the sandbox). For a local click-through register `http://localhost:3000/console/connections/square/callback` on the sandbox application (section 6). |
| OAuth scopes | read: `MERCHANT_PROFILE_READ`, `PAYMENTS_READ`, `ORDERS_READ`; for online payments and orders on the till: `PAYMENTS_WRITE`, `ORDERS_WRITE` |
| Webhook URL | `https://<ROS_PLATFORM_HOST>/webhooks/pos/square` |
| Webhook events | `payment.created`, `payment.updated`, `refund.created`, `refund.updated` |
| Where the secret comes from | the webhook subscription's "Signature key". It is per application, so it comes from the environment and is copied onto each connection at sign-in. |
| Registers | `pos:square`, `payment:square`, `oauth:square` |
| Verify | `SQUARE_SMOKE_ACCESS_TOKEN=<sandbox test account token> pnpm smoke:live` → `PASS  Square …  access token accepted (sandbox); N location(s)`. The application id and secret are only exercised by a real sign-in: connect a sandbox seller in the console. |

Tokens: an access token lasts 30 days. The `ledger.pos_oauth_sweep` schedule (every 6 hours)
renews each token once it is a week old. A refused renewal marks the connection unhealthy and
emails the person who connected it. **The worker must be running** for this to happen.

Changing `SQUARE_WEBHOOK_SIGNATURE_KEY` does not update existing connections: each holds the
key it was connected with. Venues reconnect, or the key is left alone.

### Uber Direct, DoorDash Drive (couriers) — optional

| | Uber Direct | DoorDash Drive |
|---|---|---|
| Variable | `UBER_DIRECT_ENABLED=1` | `DOORDASH_DRIVE_ENABLED=1` |
| Credentials | per venue, entered when the venue connects: customer id, client id, client secret, webhook signing key | per venue: developer id, key id, signing secret, and the Authorization header value set for the webhook |
| Scope | `eats.deliveries` | a Drive access key |
| Webhook URL | `https://<ROS_PLATFORM_HOST>/webhooks/couriers/uber-direct` | `https://<ROS_PLATFORM_HOST>/webhooks/couriers/doordash-drive` |
| Verify | no read-only call exists without a venue's credentials: connect a sandbox account and request a quote from the checkout | the same |

The switch only says "this deployment offers the provider". Several webhook and status fields of
both are unconfirmed, and Australian availability is unconfirmed (`docs/STATUS.md`).

### Klaviyo, Meta Conversions API — optional

| | Klaviyo | Meta Conversions API |
|---|---|---|
| Variable | `KLAVIYO_ENABLED=1` | `META_CAPI_ENABLED=1` |
| Credentials | per org: a private API key | per venue: dataset (pixel) id and a system-user access token |
| Scopes | `profiles:read`, `profiles:write`, `events:write`, `subscriptions:write`, `lists:write` | the token must be able to send events to the dataset |
| Webhook | none (suppressions are pulled every 15 minutes) | none |
| Verify | connect in the console, then check `comms.emailPlatformStatus` shows a completed sync | set `testEventCode` on the connection and watch Events Manager's "Test events" tab |

### Criota (remote MCP) — optional

| | |
|---|---|
| Variable | `CRIOTA_MCP_URL` (https) |
| Credentials | per venue: the access key the venue creates at Criota |
| Webhook | none |
| Registers | `remote_mcp:criota` |
| Verify | `CRIOTA_SMOKE_ACCESS_KEY=<a key> pnpm smoke:live` → `PASS  Criota …  N tool(s) offered` (lists tools; calls none). The platform must also review the tool list (`hub.reviewPlug`) before any tool is offered. |

### Anthropic (model) — optional in every mode

| | |
|---|---|
| Variables | `ANTHROPIC_API_KEY`; optional `ROS_LLM_MODEL_FAST`, `ROS_LLM_MODEL_QUALITY`, `ROS_LLM_FALLBACKS=off` |
| Verify | `pnpm smoke:live` → `PASS  Anthropic (model)  key accepted` (lists models; generates nothing) |

Used whenever the key is set, in any mode. Without it in live mode, menu import and reply
drafting answer "The assistant model is not set up on this platform yet."

## 5. Not available live

- **File storage.** There is no real storage adapter. In live mode an upload is refused with
  "File storage is not set up on this platform yet." rather than held in memory and lost.
- **Google Business Profile reviews.** No adapter (API access is application-gated).
- **SMS sender registration.**

## 6. Square sign-in in the console

Built: Settings → Connected services → **Connect Square** (`apps/web/src/app/(platform)/console/settings/connections/`).
A manager of the venue chooses what Square may let us do (read sales only, the default; or also send
online orders and take payment, which online ordering needs) and how much history to bring in, and is
sent to Square. Square sends them back to the callback route above
(`apps/web/src/app/(platform)/console/connections/[plug]/callback/`), which takes the org and the
person from the signed-in session and calls `ledger.completePosOAuth`. One location connects
straight away; several are listed to choose from; Deny, an expired or altered `state`, a location
another venue holds and a person who is no longer a manager are each said plainly and connect nothing.
A signed-out person is sent to sign in and returned to the callback with its query intact. The row
then shows health, last sync, that the sign-in renews itself, a reconnect prompt when Square has
refused the saved sign-in, and Disconnect (which also ends the access at Square).

Without `SQUARE_APPLICATION_ID` and `SQUARE_APPLICATION_SECRET` the screen says Square sign-in is not
configured on this deployment and offers no button.

### A simulated Square sign-in (development and tests)

`ROS_SIM_SQUARE_OAUTH=1` makes "Connect Square" open a stand-in sign-in page on the platform host
(`/dev/pos-signin`: a merchant account name, Allow, Deny) backed by the simulated POS, so the whole
flow can be clicked through, and is tested end to end (`tests/e2e/48-console-square-signin.e2e.ts`),
with no Square account. `pnpm dev:stack` and `pnpm e2e` switch it on. It cannot reach production:
it exists only inside the simulator set, which `ROS_ENV=production` refuses to build; it is a
start-up error with `ROS_ADAPTERS=live`; real Square credentials always win over it; and its page
and tools are a 404 unless providers are simulated (`packages/adapters/src/sim/oauth.ts`,
`packages/runtime/src/index.ts`).

### Clicking through the real Square sandbox locally

Not yet done by anyone: the service functions were verified against the sandbox from a script
(`scripts/square-sandbox-oauth.ts`), the console flow only against the simulated sign-in.

1. In the Square Developer Console, open the **Sandbox** application → OAuth, and set the Redirect URL to
   `http://localhost:3000/console/connections/square/callback`. (The script's `http://localhost:4567/callback`
   no longer applies: Square keeps one Redirect URL per application and environment.)
2. `.env.local` in the repo root holds `SQUARE_APPLICATION_ID` (the `sandbox-…` id),
   `SQUARE_APPLICATION_SECRET` and `SQUARE_ENVIRONMENT=sandbox`. `pnpm dev:stack` reads that file;
   a variable set in the shell wins. Never commit it.
3. In the browser you will use, open the sandbox test account's seller dashboard from the Developer
   Console first (Square's sandbox sign-in needs that session).
4. `ROS_ADAPTERS=mixed pnpm dev:stack -- --friday`. The web process logs one `adapters` line whose
   `real` list must include `pos:square`, `payment:square`, `oauth:square`. If Square is missing
   from it, the variables were not read; if the process stops with a list of problems, fix those.
   This starts a development server: keep the session short and stop it afterwards (`docs/STATUS.md`, dev server memory).
5. Sign in at `http://localhost:3000/console` as `owner@oak-diner.test` (the code is at `http://localhost:3000/dev/inbox`).
6. Settings → Connected services → Connect Square. Leave "Read sales only", pick the history to fetch,
   press **Connect Square**. The address bar must show `connect.squareupsandbox.com`. Press Allow.
7. Expect to land on Connected services with "Square is connected…" and a Square row marked Connected.
   If history was asked for, the test account's past sales reach the ledger shortly after. A sandbox
   account with several locations shows the location list first.
8. Also worth doing once each: press Deny at Square; reload the callback URL after connecting (a spent
   code: "Square did not accept that sign-in"); Disconnect, then check in the test account's dashboard
   that the application no longer has access.

Known limits of the flow:

- A person who closes the tab at the location list leaves that sign-in sealed and unused; nothing
  sweeps it, and its token is not ended at Square until it expires (30 days). "Leave without
  connecting" does both.
- A person who belongs to several organisations and is signed out when Square sends them back is
  asked which organisation and then lands on the console home, not back on the callback: they start again.
- A venue connected read-only has a Square connection that `findConnectionFor(ctx, 'payment', …)`
  can still choose for online payment, which a read-only token cannot take. Until that lookup
  respects scopes, connect a venue that takes online orders with read-and-write.

## 7. Order of work for a first live venue

1. Core variables, `ROS_ADAPTERS=mixed`, `pnpm smoke:live`.
2. Resend: verify the platform sending domain, register the webhook, sign in to the console by email code.
3. Vercel, then a custom domain through onboarding.
4. Square sandbox: connect it in the console (section 6), check sales arrive, pay an online order, refund it.
5. Twilio, couriers, Klaviyo, Meta as the venue needs them.
6. Only then `ROS_ADAPTERS=live` with `ROS_ENV=production`.
