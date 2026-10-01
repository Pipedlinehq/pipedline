# ledger

## What it owns

The record of what was sold: one row per sale per `(source, externalRef)`, its lines, its
attribution to what brought the customer in, and POS ingest (poll, back-fill, webhooks).
Spine module; `dependsOn: ['identity']`.

Tables (`ledgerModule.tables`): `transactions`, `transaction_lines`, `transaction_attributions`,
`ingest_cursors`. It reads `customers` and `customer_touchpoints` (identity) for attribution and
reads/writes `connections` through core's connection functions.

## Public functions

Other modules / adapters (no role check; never expose as a route):
- `recordTransaction(ctx, txn: CanonicalTransaction, { venueId, customerId?, via? })` — idempotent on `(source, externalRef)`; a re-delivery with a changed status, refund, total or customer updates the row (lines rewritten only if the total changed). Resolves the customer from `identityHints` via `identity.resolveCustomer` and calls `identity.linkCard`. Rejects non-integer cents. Stores `raw` after `stripCardIdentifiers`. Returns `{ transaction, created, changed }`. Called by `ordering/payment.ts` and fixtures.
- `recordPosSale(ctx, conn, source, txn)` — the POS path over `recordTransaction`; skips sales at another location, sales `originatedHere`, and voids never seen before.
- `setCatalogResolver(resolver)` — slot the menu module fills (`menu/catalog.ts`) so lines get `menu_item_id`/category from POS item ids.
- `attributeTransaction(ctx, { id, customerId, occurredAt })` — writes `acquisition` (confidence 1) and `last_touch` (30-day window, confidence 0.7) rows at `ATTRIBUTION_VERSION` = 1.
- `reattribute(ctx, { since })`, `reattributeTransaction(ctx, txn)` — delete and recompute; internal. `reattributeTransaction` is used by `campaigns/hooks.ts`.
- `stripCardIdentifiers(raw)` — drops `fingerprint`, `payment_account_reference`, `par`, `card_fingerprint` keys at any depth.

Console:
- `listTransactions(ctx, { venueId?, from?, to?, customerId?, limit?, before? })` — staff `read_only`+; limited to visible venues; max 200.
- `getTransaction(ctx, id)` — staff `read_only`+ at the sale's venue; includes lines.
- `connectPos(ctx, { plugKey, venueId, externalAccountId, locationRef, credentials, scopes?, config?, expiresAt?, backfillMonths })` — manager at the venue. One provider location may feed one venue only. Rolling sync starts at connect time.
- `requestPosBackfill(ctx, { connectionId, months })` — manager; max `MAX_BACKFILL_MONTHS` (36). Re-asking widens, never narrows.
- `listPosConnections(ctx, { venueId? })` — staff `read_only`+; sync status per connection.

Platform / internal (take `App`, bypass RLS for lookup only):
- `listPosLocations(app, { plugKey, externalAccountId, credentials, config? })` — before `connectPos`; simulated plugs hidden in production.
- `ingestConnection(app, { orgId, connectionId, stream?, pageSize?, maxPages? })` — one poll or back-fill run; marks connection health.
- `handlePosWebhook(app, { plugKey, rawBody, headers, url })` — verify per-connection `webhookSecret`, claim, re-fetch each named sale, record in the connection's org/venue, release the claim on failure.
- `loadPosConnection(ctx, id)`, `findPosConnectionsByAccount(app, plugKey, accountId)`.

## Hooks

Defined: `onTransactionRecorded(hook)` — same transaction, on create and on any change (not a
plain replay); receives `(ctx, txn, { created, previousStatus, previousCustomerId, hints, discounts })`.
Must be idempotent. Registered by: `loyalty/hooks.ts`, `offers/hooks.ts`, `campaigns/hooks.ts`,
`comms/conversions.ts`. Slot `setCatalogResolver` (menu). Registers on none.

## Config surface

Venue config is empty. POS connection `config` must hold `locationRef`, optional
`overlapMinutes` (0-1440, default 10), optional `webhookUrl` (pins the URL used for signature checks).
Credentials on a POS connection: `accessToken`, `webhookSecret`. No org settings.

## Jobs, schedules, events, templates, tools

- Jobs: `ledger.pos_ingest` (`{ connectionId, stream: 'transactions' | 'backfill' }`, 4 attempts, queues a continuation when a run stops at the page limit), `ledger.pos_reconcile` (`{ bucket }`, one ingest job per live POS connection, restarts unfinished back-fills).
- Schedule: `ledger.pos_reconcile`, every 15 minutes, per org, only if the org has a live POS connection.
- Events: `transaction.recorded`, `transaction.refunded`.
- Plugs: `sim-pos` (simulated), `square` (OAuth; `SQUARE_READ_SCOPES`, `SQUARE_WRITE_SCOPES`).
- Audit: `pos.backfill_requested`, `connection.signin_started`.
- Tool: `connection_start` (write, scope `connections:write`, `minRole: 'manager'`), over `startPosSignIn(ctx, { plugKey, venueId, access: 'read_only' | 'full' })`: the same start as `startPosOAuth`, but allowed to a manager's assistant, and returning only the provider's sign-in link. The signed `state` in it is bound to the staff member behind the key; `completePosOAuth` still takes that person's console session and nothing else. `describePosSignIn`, `readOnlyScopes(plug)` are its helpers.

## Simulated vs real

POS adapter: simulator `packages/adapters/src/sim/pos.ts` and a real Square adapter
`packages/adapters/src/square/` (tested against a stubbed HTTP server in `test/ledger-ingest/square.test.ts`).

## Known gaps

- Nothing in `apps/` calls `handlePosWebhook`, `connectPos`, `listPosLocations` or the console reads yet; there is no webhook route or POS connect UI.
- The Square OAuth sign-in itself is not here: `connectPos` expects the caller to already hold the tokens.
- Only one attribution version exists; `reattribute` is not called by anything outside tests.
