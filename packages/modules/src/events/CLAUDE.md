# events

## What it owns

The first-party analytics stream: visitor sessions (with their first-touch attribution) and the
append-only `events` table that every module's `track` writes to. Spine module, no dependencies.

Tables (`eventsModule.tables`): `events` (`@append_only`), `visitor_sessions`, and since the console
depth pass (migration `0760_console_views_notes.sql`) `console_views` (saved list views per venue)
and `staff_notes` (the team's notes on a record, the timeline). The last two are the console's own
record-keeping; they sit here because the activity stream is where a record's history is read from.

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

Console (docs/CONSOLE_IA.md section 9, wave 1; the venue is always a request, checked by role):
- Saved views (`views.ts`): `listConsoleViews(ctx, { venueId, page })` (any staff role at the venue);
  `saveConsoleView(ctx, { venueId, page, name, filters, id? })` (kitchen, front of house, host,
  manager, owner; not read-only; a name already used on that page at that venue is `invalid`; 30
  per page; `id` updates), `renameConsoleView(ctx, { id, name })`, `deleteConsoleView(ctx, id)`
  (another venue's or org's id is not found). `page` is one of `CONSOLE_VIEW_PAGES` (orders,
  bookings, customers, menu, offers, activity). Filters are short string tokens, as a URL carries
  them. Audited as `console.view_saved | view_updated | view_renamed | view_deleted`. Default views
  are the console's code, never rows.
- Staff notes (`notes.ts`): `listMentionableStaff(ctx, { venueId })` → active staff with a role at
  the venue (plus owners) as `{ id, name }`; `addStaffNote(ctx, { venueId, entityType: order|booking|customer,
  entityId, body })` → `StaffNoteView` with `mentions` (staff ids whose "@First" or "@First Last"
  appears in the body; `findMentions` is exported), `authorKind` 'staff' or 'agent' (an assistant
  writing for a person), `authorName`; `listStaffNotes(ctx, { venueId, entityType, entityId })`
  newest first; `deleteStaffNote(ctx, noteId)` by the author or a manager (soft: `deleted_at`;
  audited `note.removed`). Roles as for views. Bodies are staff-written text: render as text.
- History (`history.ts`): `listEntityEvents(ctx, { venueId, entityType, entityId })` → the record's
  own events from the stream (`properties->>order_id` / `booking_id`, or `customer_id`), newest first.
  The audit side of a timeline is core's `listEntityAudit`; the activity log is core's `listActivity`.

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
