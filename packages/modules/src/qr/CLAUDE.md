# qr — module guide

## What it owns

Dynamic QR codes that point at `/q/<code>` on the venue's own host (the destination is resolved
server-side, so nothing is reprinted), the table context a scan carries, and table sessions that
group a table's paid rounds.

- Tables (`qrModule.tables`): `qr_codes`, `table_sessions`.
- Toggleable (key `qr`). `dependsOn: []`: ordering is only needed at stage `order` and is
  checked at runtime with `getModule(ctx, venueId, orderingModule)`.
- Uses: `events/sessions` (`touchSession`, `trackInSession`), `ordering/contract` (`registerTableOrdering`), `ordering/orders` (`tableSessionTotals`).

## Public functions by purpose

Console (all call `assertModule(ctx, venueId, qrModule)`):
- `createQrCode(ctx, input)` — manager. Kinds `menu | table | counter | campaign`; table and counter need a `label`. `targetPath` must be a path on the site (no full URL), default `/menu`. Campaign fields: `campaignId`, `creatorId`, `offerId`. Code is `newSlug(10)`, unique platform-wide, retried on clash. Audits `qr.code_created`.
- `createTableCodes(ctx, { venueId, labels, area?, printBatch? })` — manager. One code per table label; a label with an active table code keeps it. Audits `qr.table_codes_created`.
- `updateQrCode(ctx, id, input)` — manager. Change label, area, target, campaign fields, print batch, `isActive`. Audits `qr.code_updated`.
- `deactivateQrCode(ctx, id)` — manager; `updateQrCode` with `isActive: false`.
- `listQrCodes(ctx, { venueId, kind?, includeInactive? })` — `read_only`.
- `listTableSessions(ctx, { venueId, open?, limit? })` — `read_only`. Each session with `orders` and `totalCents` from `tableSessionTotals`.
- `closeTableSession(ctx, { sessionId, covers? })` — staff `kitchen` or above. Tracks `table_session.closed` (reason `staff`), audits `qr.table_session_closed`.

Guest-facing / public:
- `resolveQrCode(ctx, { code, sessionId?, referrer?, deviceClass? })` — no role check. Rate-limited per IP (60 / 10 min) and per venue (5000 / 10 min) for non-internal callers. Increments `scan_count`, starts or refreshes the visitor session (utm source `qr`, medium = kind, creator/campaign/qr code id), tracks `qr.scanned`, returns `QrResolution` (target path, table, `stage`, `canOrder`, alcohol/prices/tipping/prompts from config, campaign fields, `sessionId`). Unknown, inactive, other-org code or module off: not found.

Jobs (internal only):
- `closeIdleSessionsJob` / `closeIdleSessionsSchedule` — see below. The function behind them, `closeIdleTableSessions`, is not exported from `index.ts`.

## Hooks

- Registers `registerTableOrdering` (the ordering contract, `ordering/contract.ts`) in `resolve.ts`:
  - `resolveForOrder(ctx, { venueId, code })` — not found unless the code is this venue's, QR is on and `stage === 'order'`; `invalid` for a non-table code when `require_table`. Returns `qrCodeId`, `tableLabel`, `excludeAlcohol`, `tippingEnabled`, `tipPresets`.
  - `openSession(ctx, args)` → `openTableSession` (not exported from `index.ts`): reuses the table's open session unless idle past `session_idle_minutes`, closing stale ones (tracks `table_session.closed` reason `idle`), else inserts one and tracks `table_session.opened`. Runs in ordering's transaction.
- Defines no hooks of its own.

## Config surface (`qrConfig`, per venue)

- `stage` — `view` (menu only) or `order` (order and pay from the table; needs ordering on). Default `view`.
- `exclude_alcohol` — keep alcohol out of phone orders.
- `require_table` — only table/counter codes may order. Default true.
- `tipping_enabled`, `tip_presets` (percent, max 6).
- `session_idle_minutes` — idle time before a table session closes (5–720, default 120).
- `show_prices`.
- `receipt_email_prompt`, `loyalty_prompt` — optional boxes on the table checkout.

No org-level settings namespace.

## Jobs, schedules, events, templates, tools

- Job `qr.close_idle_sessions` (no payload); schedule `qr.close_idle_sessions`, every 10 minutes, org scope, applies only to orgs with `qr` enabled at some venue.
- Events: `qr.scanned`, `table_session.opened`, `table_session.closed`.
- Templates: none. Tools: none.

## Simulated vs real

No ports or adapters.

## Known gaps

- `table_sessions.covers` is only set when staff pass it to `closeTableSession`.
- No assistant tools are declared for QR.
