# events

## What it owns

The first-party analytics stream: visitor sessions (with their first-touch attribution) and the
append-only `events` table that every module's `track` writes to. Spine module, no dependencies.

Tables (`eventsModule.tables`): `events` (`@append_only`), `visitor_sessions`.

`track`, `defineEvent`, `getEventDef` and `listEventDefs` live in core (`packages/core/src/events.ts`),
not here; this module adds sessions, the browser beacon and session-aware tracking.

## Public functions

Guest-facing (no role check; any principal the site gives the visitor):
- `touchSession(ctx, { sessionId, venueId?, landingPath?, referrer?, utm*?, creatorId?, campaignId?, code?, qrCodeId?, deviceClass? })` — insert the session once (first-touch fields are never overwritten) and track `session.started`; later calls only bump `last_seen_at`. Returns `{ created }`. Called by `apps/web/src/app/sites/[host]/api/session/route.ts`.
- `collect(ctx, { sessionId, venueId?, events })` — the browser beacon, 1 to 20 events. Only events declared `client: true` with valid properties are stored; others are counted as `dropped`. A client time is used only if it is in the past and within 10 minutes. Unknown session is `invalid`. Called by `.../api/collect/route.ts` (rate-limited there, 240/min per org+IP).

Other modules:
- `trackInSession(ctx, def, properties, { sessionId?, venueId?, customerId?, ... })` — `track` with the session's UTM/creator/campaign/code copied on, and venue/customer defaulted from the session. Used by ordering, qr, auth, fixtures.
- `getSessionAttribution(ctx, sessionId)` — the session's first-touch fields plus `customerId`, `venueId`; null if unknown.
- `linkSessionToCustomer(ctx, sessionId, customerId)` — sets `customer_id` only if it is still null.
- `eventDictionary()` — every declared event (name, module, description, `sent_by` browser/server, funnel, JSON-schema properties). Used by analytics.

Also exported: `sessionInput`, `collectInput` zod schemas.

## Hooks

Defines none. Registers on none. Note: `identity` writes `visitor_sessions.customer_id`
directly on merge and erase.

## Config surface

Venue config is empty. No org settings.

## Jobs, schedules, events, templates, tools

- Events declared here: `session.started` (server; funnel `order` step 1; `landing_path`, `referrer_host`, `device_class`), and browser-sendable (`client: true`): `page.viewed` (`path`, `title?`), `menu.viewed` (`surface: site|qr`, `table_label?`; funnel `order` step 2), `item.viewed` (`menu_item_id`, `name`), `link.clicked` (`kind: call|directions|booking|order|social|other`, `target?`).
- No jobs, schedules, templates or tools.

## Simulated vs real

No providers.

## Known gaps

- No dedicated test file for this module; `collect` is exercised through `test/commerce/checkout.test.ts`.
- No retention or pruning of `events` or `visitor_sessions` exists here.
