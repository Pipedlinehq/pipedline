# identity

## What it owns

Customers, the identities that recognise them (email, phone, hashed card, loyalty QR, POS
customer id, device id), merges, the write-once acquisition stamp plus later touchpoints, and
consents with their proof trail. Spine module, no dependencies.

Tables (`identityModule.tables`): `customers`, `customer_identities`, `customer_merges`,
`customer_touchpoints`, `consents`, `consent_events`, `consent_wordings`.

It also writes `customer_id` on `transactions`, `transaction_attributions` (ledger) and
`visitor_sessions` (events) during merge and erase.

## Public functions

Other modules (the entry point for any surface that sees a guest):
- `resolveCustomer(ctx, { hints, via, venueId?, profile?, acquisition?, createIfMissing?, verified? })` — find, create or merge. Oldest record wins a merge. Cards are looked up only as a per-org HMAC, never create a customer, and are attached only with `card_recognition` consent. Acquisition is stamped on create; on an existing customer a creator/campaign/code becomes a `customer_touchpoints` row. Blank profile fields are filled, never overwritten. Returns `{ customerId, created, mergedFrom }`.
- `linkCard(ctx, customerId, hints, via)` — attach card hints; returns 0 without consent.
- `hasConsent(ctx, customerId, purpose)` — no role check.
- `currentWording(ctx, purpose)`, `currentWordings(ctx)` — org's latest wording, else the platform default.
- Normalisers: `normaliseEmail`, `normalisePhone` (E.164, AU default), `hashCardIdentifier(app, orgId, kind, raw)`, `toStoredIdentities(app, orgId, hints)`.

Console / guest:
- `getCustomer(ctx, customerId)` — staff in `GUEST_FACING_ROLES`, the guest themself, or internal. `notes` is null for the guest. A merged id answers as the winner (except to a guest).
- `searchCustomers(ctx, { q, limit? })` — staff in `GUEST_FACING_ROLES`; max 50.
- `updateCustomer(ctx, customerId, input)` — same readers; a guest cannot set `notes`.
- `getConsents(ctx, customerId)` — staff, the guest, or internal.
- `grantConsent(ctx, input)` — refuses staff and devices; a guest only for self; `source: 'import'` only from internal code, needs `sourceDetail`, and never for `card_recognition`.
- `revokeConsent(ctx, input)` — guest (self), staff (on request) or internal; not anon or device. Revoking `card_recognition` deletes card identities.
- `mergeCustomers(ctx, { winnerId, loserId, reason })` — manager, or internal. `mergeCustomersUnchecked` skips the role check; for resolution only, never a route.
- `exportCustomer(ctx, customerId)` — the guest, or owner if staff. Card identities shown as `(linked)`.
- `eraseCustomer(ctx, customerId)` — the guest, or owner if staff. Deletes identities and consents, nulls contact/profile fields, sets status `deleted`, unlinks ledger and session rows (sales rows stay).

Consent purposes: `card_recognition`, `marketing_email`, `marketing_sms`, `ad_platform_sharing`.

## Hooks

Defined here (all run inside the caller's transaction):
- `onCustomerMerge(handler)` — before the loser is marked merged. Registered by: delivery, loyalty, offers, analytics, ordering, campaigns (`*/hooks.ts`).
- `onCustomerErase(handler)` — before identity rows are removed. Registered by: delivery, loyalty, offers, analytics, ordering, campaigns.
- `registerCustomerDataProvider(name, provider)` — adds a key to `exportCustomer`. Registered: `deliveries`, `loyalty`, `offers`, `analytics`, `orders`, `campaigns`.
- `onConsentChanged(handler)` — after grant or revoke. Registered by: `comms/suppression.ts`, `comms/esp.ts`, `campaigns/hooks.ts`.

Registers on none.

## Config surface

Venue config is empty. No org settings namespace. Wording comes from `consent_wordings`
(org-specific or `org_id` null for the platform default).

## Jobs, schedules, events, templates, tools

- Events: `customer.created` (`acquisition_source`, `via`), `customer.merged` (`loser_customer_id`, `reason`), `consent.changed` (`purpose`, `action`, `source`).
- Tool: `guest_lookup` (read, scope `guests:read`; at most 5 matches; no card data or staff notes).
- No jobs, schedules or templates.
- Audit: `customer.updated`, `customer.exported`, `customer.erased`, `customer.merged`, `consent.revoked` (grants are recorded in `consent_events`, not audit).

## Simulated vs real

No providers. Card hashing uses `app.secrets.orgKey(orgId, 'identity_hmac')`.

## Known gaps

- `exportCustomer`, `eraseCustomer` and `mergeCustomers` are called only from tests; no console or guest route uses them yet.
- Merge and erase write `transactions`, `transaction_attributions` and `visitor_sessions` directly rather than through ledger/events functions.
- There is no function to manage `consent_wordings`; rows come from migrations/seeds.
