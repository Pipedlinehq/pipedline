# STATUS — what is built, what is verified, what is not

As at 2026-10-01, branch `hub-v1`. Direction: `docs/PIPEDLINE.md` (free, plugin-based, set up by the venue's own assistant). No real venue, no real provider and no production
deployment has touched this code. Everything below marked "verified" was verified on this
machine against a real Postgres and, for the browser suite, the production build of the web app.

## Verified

| Check | Result | How to run |
|---|---|---|
| Service tests (real Postgres, seeded two-org fixture) | 744 pass, 83 files, strict seeding | `pnpm test` |
| Browser end-to-end (production build, headless Chromium, database read back) | 135 pass, 33 files (includes an automated accessibility pass) | `pnpm e2e` |
| Typecheck, module boundaries, no tenant branching | clean | `pnpm gates` |

What those cover: tenant isolation on every table; consent and card-identifier rules; idempotent
ledger writes; POS ingest and webhooks; ordering, payment (decline, timeout, reconcile), kitchen
screen incl. offline replay; QR table ordering; delivery with courier failover; loyalty earn and
burn; offers; campaigns and lifecycle flows by mode; reviews with approved replies; the MCP
server, confirmed writes, OAuth sign-in, plug gateway and the Criota service-key boundary;
analytics against an independent oracle; website, onboarding to go-live, platform admin.

Since 2026-10-01 the suite also covers self-serve start and the 17 setup tools: a scripted assistant
takes a venue from an unseen email address to live through the MCP server alone
(`packages/modules/test/setup/`). No page in the web app calls self-serve start yet.

## Simulated only (never run against the real service)

Every provider. Real adapters exist for the ones marked "written"; none has been called live,
`ROS_ADAPTERS=live` (and `mixed`) switch each one on when its credentials are present: see `docs/GOING_LIVE.md`, `.env.example`, and `pnpm smoke:live` to check credentials.

| Provider | State | Needs |
|---|---|---|
| Square POS + payments | **verified against the Square sandbox** (2026-10-01): locations, order push, payment naming the order, idempotent retry, decline, read-back, updated-at paging, lookup, partial refund; full ingest + acceptance checks pass (`scripts/square-sandbox-check.ts`, `scripts/square-sandbox-ingest.ts`) | production credentials |
| Square OAuth sign-in | **verified against the sandbox** (2026-10-01): authorise, code exchange, single-use code, refresh (30-day tokens, refresh token stable), revoke, refusal after revoke (`scripts/square-sandbox-oauth.ts`). Sandbox quirk: a revoked access token gets HTTP 500 from `/v2/locations`, not 401 | a click-through of the console flow against the sandbox (`docs/GOING_LIVE.md` section 6): the console's Connect Square, callback, location choice, disconnect and reconnect are built and pass end to end against a **simulated** sign-in page only |
| Square webhooks | **verified against the sandbox** (2026-10-01) through a temporary tunnel and a throwaway subscription: real signature accepted, sale and refund reach the ledger by webhook alone, replay is a no-op, altered body refused (`scripts/square-sandbox-webhooks.ts`). Tested at the handler; the web route in front of it is covered by the simulated-POS e2e | a permanent public URL registered at Square |
| Uber Direct, DoorDash Drive | written; several webhook/status fields unconfirmed; AU availability unconfirmed | accounts |
| Klaviyo | written | API key |
| Meta Conversions API | written; online sales sent as `other` (no browser user agent captured) | dataset + token |
| Anthropic (model) | written; switches on with `ANTHROPIC_API_KEY` | key |
| Resend (email), Twilio (SMS) | written | keys, webhook secrets |
| Vercel (custom domains), Resend (sending domains) | written | tokens |
| File storage (media uploads) | simulator only | build adapter |
| Google Business Profile reviews | not written: API access is application-gated | Google approval |
| Criota MCP | simulated server mirroring the real tool catalogue; real server never called | access key |

## Not built

Bookings, full KDS (stations, coursing), own POS, marketplace order ingest, inventory, rostering,
gift cards (deferred by design: `docs/ROADMAP.md`). Also: PDF menu import, address geocoding,
SMS sender registration, voucher purchase, platform-admin second factor, analytics/pixel tags on
venue sites are built but off by default (`ROS_SITE_TAGS`) pending consent wording; per-venue custom domains; console screens for agent runs.

## Known gaps and risks

- **Card recognition** stays switched to "nothing may depend on it" until Square answers in
  writing (`docs/VERIFY.md` #11, #12).
- **Assistant writes** need an MCP client that supports the confirmation step; proven only with
  the reference client. Others get reads only.
- **Dev server memory**: `next dev` grew to ~14 GB over long runs on this machine. `pnpm e2e`
  therefore runs the production build under a 5 GB watchdog. Use `pnpm dev:stack` for short
  sessions and restart it.
- **Open threat-model items** (`docs/THREAT_MODEL.md` §12): vault choice, data-handling
  agreement, consent wording sign-off, incident plan.
- **Hosted agents**: a lifecycle flow runs at the stricter of its own mode and the venue's hub
  setting, so a venue must list the agent before anything sends. Weekly digest and ops watch exist;
  ops watch notifies nobody yet.
- **Site page cache is per process** (5-minute limit); a publish from another instance waits it out.
- **Scale**: 300 orgs / 2.4M sales tested (`scripts/scale-test.ts`): tenant queries 3–64 ms,
  no leak, no double-run jobs. Scheduler tick was batched afterwards and not re-measured.
- **Tenant zero**: `scripts/tenant-zero.ts` passes on a simulated 29k-sale history; never run on real Square.
- Accessibility is an automated axe pass only: no screen-reader or manual keyboard check.
- `approvals` expiry is scheduled only where campaigns is on; review reply drafts take the
  database clock for `created_at`; kitchen offline reopen is proven by hand, not by test.

## Run it

```bash
pnpm install
pnpm dev:stack -- --friday      # sites: http://oak-diner.tables.localhost:3000  console: http://localhost:3000/console
                                # sign-in codes: http://localhost:3000/dev/inbox   simulators: http://localhost:3000/dev
```
Fixture logins: `owner@oak-diner.test`, `manager@oak-group.test`, `admin@rosplatform.test` (platform).
