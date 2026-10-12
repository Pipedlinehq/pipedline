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
- `getCustomer(ctx, customerId)` — staff in `GUEST_FACING_ROLES`, the guest themself, or internal. `notes` is null for the guest. A merged id answers as the winner (except to a guest). The view carries `suburb` and `postcode` (migration 0780).
- `searchCustomers(ctx, { q, limit? })` — staff in `GUEST_FACING_ROLES`; max 50.
- `listCustomers(ctx, { venueId?, q?, createdSince?, consent?, regular?: { minVisits, withinDays }, lapsedDays?, query?, limit? })` — the Customers index with its views (docs/CONSOLE_IA.md section 9, wave 1). Same roles. Rows are `CustomerListRow` = summary + `visits` and `lastVisitAt`, counted from `transactions` (a spine table identity may read), at `venueId` when given; `consent` keeps guests holding that consent now; `query` is a guest-list rule in the plain query language (below), so a list's members can be read back; most recent visit first; max 200.
- `updateCustomer(ctx, customerId, input)` — same readers; a guest cannot set `notes`. Also `suburb`, `postcode`.

Guest lists, the grammar and its SQL (`list-grammar.ts`, pure, no imports; `lists.ts`; docs/CONSOLE_IA.md section 9, pattern 5). The identity spine owns the language because both campaigns (segments) and offers (who an offer is for) read it; campaigns owns the stored lists (`segments`, definition `{ query }`).
- Grammar: `query := group ("or" group)*`, `group := clause ("and" clause)*`, `clause := "(" query ")" | field operator value`. Fields: last visit, first visit, visits, spend, average spend, said yes to email, said yes to texts, loyalty member, no-shows, suburb, source (`LIST_FIELDS`, with the operators per kind in `OPERATORS`). Operators: more than / less than / is / is not (numbers, money as `$500`, yes/no, text), within the last N days / more than N days ago / is never (dates). "and" binds before "or"; at most `MAX_CLAUSES` (10) conditions; text under 600 characters; anything else is refused in a sentence (`ListQueryError`, surfaced as `invalid`).
- `parseListQuery(text)` → `ListNode`; `listText(node)` → the canonical text (round-trips); `listWords(node)` → "Guests who …"; `clauseText`, `countClauses`, `fieldInfo`, `sameList`.
- `compileListQuery(node, { now, venueId? })` → one boolean `RawBuilder` over `customers c`: every field is a fixed column or correlated sub-select written in `lists.ts` (sales from `transactions` excluding voided, net of refunds; consents; `events` for `loyalty.enrolled` and `booking.no_show`; `c.suburb`; `c.acquisition_source`); every typed value is a bound parameter. `listWhere(ctx, node, frame)` adds the org and active-status guards; `countListMembers`, `isListMember`, `reachableByListSql(channel)` (address + consent + not suppressed, the count-side twin of comms' send-time check).
- First visit is the first counted sale, else when the record was made; last visit is the last counted sale (null = "never"). Average spend is spend / visits, false with no visits.
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

- `suburb` and `postcode` are filled by staff (the guest page) or `updateCustomer`; nothing copies a delivery address onto the guest record yet, so "suburb is …" lists cover guests whose suburb has been written down.
- `exportCustomer`, `eraseCustomer` and `mergeCustomers` are called only from tests; no console or guest route uses them yet.
- Merge and erase write `transactions`, `transaction_attributions` and `visitor_sessions` directly rather than through ledger/events functions.
- There is no function to manage `consent_wordings`; rows come from migrations/seeds.
