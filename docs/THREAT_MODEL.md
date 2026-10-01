# THREAT_MODEL — security decided at design time

> What is specific to this platform, decided before the code was written. **Tier:** revenue-critical,
> multi-tenant, guest PII, payments adjacent, assistants with write access → OWASP ASVS Level 2
> as the baseline, Level 3 on authentication, tenant isolation, payment and agent-write paths.
>
> Written 2026-09-30, before any code. §12 is the list of things still undecided.

## 1. How to use this

Each module inherits the slice of this document that touches it. The slice becomes part of the
module's contract, its tests include the negative cases in §11, and the pre-release security
review checks the diff against this file. An open item in §12 that touches a module must be
closed or explicitly accepted before that module ships.

## 2. What makes this platform different from a single-business app

1. **One database holds many businesses' customers.** A single missed tenant check is a breach
   of every venue at once, and each venue's competitors are other tenants.
2. **The valuable asset is the sensitive one.** The identity graph and ledger are why the
   platform exists and what an attacker, a careless plug or a curious assistant would want.
3. **Most of the surface is public and unauthenticated.** Tenant sites, QR menus, ordering and
   checkout take input from anyone with a phone.
4. **Assistants can act.** The hub gives a language model tools that change a venue's state,
   and some of what those models read is written by strangers.
5. **We are a separate company from every venue.** We hold their customers' data as their
   service provider, under card-scheme and privacy rules that bind them and reach us.

## 3. Actors and trust

| Principal | Authenticates by | Trust | Reaches |
|---|---|---|---|
| Anonymous guest | nothing | untrusted | tenant site, QR menu, ordering, checkout |
| Known guest | one-time code, per org | low | own orders, loyalty, consents at that org only |
| Venue staff | platform login, role per venue | medium | console for venues they are assigned |
| Venue owner | platform login + second factor | high within their org | all of the org: exports, keys, connections, billing |
| Kitchen or counter screen | device token, one venue | low, narrow | tickets and bump for that venue; nothing else |
| A staff member's assistant | agent key or OAuth sign-in | never more than that staff member; reads unless they allowed changes | the hub's tools |
| A plug (connected service) | its connection's token | limited to declared scopes | its own adapter or tools |
| Webhook sender (Square, courier, email, SMS) | signature | untrusted until verified | one ingest endpoint each |
| Background worker | service credential | high; must set tenant context per job | everything, so it is the most dangerous code |
| Platform admin (us) | separate table, second factor | highest | tenant health, support access on the record |

Trust boundaries, each needing a control: browser → web app · web app → database · worker →
database · assistant → hub · hub → plug · provider → webhook · web app → provider · one org →
another org (never crossed) · platform → Criota (totals only).

## 4. Data classification

| Class | Examples | Rules |
|---|---|---|
| **Restricted** | card identifiers (fingerprint, account reference), provider tokens and secrets, agent keys | hashed or vaulted; never logged, never in prompts, never returned by any tool or API; card identifiers only with consent and only as a per-org keyed hash (`SCHEMA.md` §2a) |
| **Personal** | guest name, email, phone, birthday, allergy notes, order and visit history, consent records | tenant-scoped; minimised in logs and prompts; exportable and deletable per guest |
| **Commercial** | a venue's sales, menu costs, campaign results | tenant-scoped; never visible to another org or in any cross-tenant benchmark without that venue's opt-in |
| **Public** | menu, hours, published pages | cached per tenant |

We never hold card numbers. Card entry happens in the payment provider's hosted fields and
money moves merchant-direct.

## 5. Tenant isolation (the control everything else rests on)

Three layers, all required:

1. **Row-level security on every table**, default deny, keyed on claims in the session token.
   A staff member who belongs to two orgs has one active org per session; policies check
   membership, not a claim the client could set.
2. **The application never takes a tenant id from the client.** Tenant comes from the host
   (public surfaces), the session (console) or the key (hub).
3. **Object-level checks** on every route that takes an id. An id from another tenant returns
   not-found, not forbidden.

Specific risks:

- **Workers bypass row-level security.** A job that forgets its tenant filter reads everyone.
  Every job carries `org_id`, runs through a helper that sets tenant context, and unscoped
  queries in worker code fail lint. No job takes a list of tenants and loops with shared state.
- **Host-based routing.** Tenant is resolved only from the `domains` table, only for verified
  hosts. The cache key includes the host. Forwarded-host headers are trusted only from our edge.
- **Cache leakage.** A page cached for one tenant must never be served to another; every cached
  entry carries the tenant tag. No personal data is ever in a statically cached page.
- **Cross-tenant joins on identity.** Forbidden in code and impossible for card identifiers by
  construction (per-org hash). Email and phone are not hashed per org, so the rule for them is
  policy plus a test: no query joins `customer_identities` across `org_id`.
- **Backups.** One database means one restore point for everyone. Keep a per-tenant logical
  export so one venue's mistake can be undone without rolling back the rest.

The leak test (two orgs, every table, every role) runs in CI and against tenant zero's real data.

## 6. Public surfaces

- **Stored cross-site scripting through tenant content.** Pages, menu text, and especially
  `custom_head_snippet` are written by one party and rendered to another. Render page blocks as
  data, never as markup. Replace the free snippet with named integrations (an analytics id, a
  pixel id) that we template ourselves.
- **Cookie scope.** Tenant sites on subdomains of the platform domain must not be able to read
  or set the console's session. The console and the hub live on a different registrable domain
  from tenant sites, and the tenant-site domain is on the public suffix list or cookies are
  host-only.
- **Ordering abuse.** Prices, totals, discounts and availability are computed on the server
  from the menu; the client sends item ids and quantities. Payment is confirmed before anything
  reaches the kitchen, so a prank cannot print tickets. Checkout carries an idempotency key.
  Per-device and per-venue rate limits.
- **QR codes.** Codes are random, not sequential. A code reveals a table label, nothing else.
- **One-time codes.** Rate-limited per destination and per sender; no message that reveals
  whether an email or phone is a customer.
- **Menu import.** Fetching a venue's old site or PDF is a server-side fetch of a supplied URL:
  allowlist schemes, block internal ranges, cap size and time. The extracted text goes to a
  model as data with no tools available to it, and a person confirms every item.
- **Custom domains.** Verify control before serving. On offboarding, remove the domain from the
  project so a lapsed DNS record cannot be pointed at someone else's content.

## 7. The hub and assistants

The contract in `modules/hub.md` §2 is the control set: tenant from the key, tools pinned to
console actions, output allowlists, two-call confirmed writes, audit without argument values,
hashed revocable keys, a key never exceeding its staff member.

Threats specific to this surface:

| Threat | Control |
|---|---|
| Instructions hidden in guest-written text (a review, an order note) steer the assistant | returned as labelled, length-capped quoted content; every write still needs the person's yes; no tool both reads guest text and changes state in one call |
| A remote plug changes its tool descriptions after review | digest of the reviewed tool list; any change withdraws the plug until re-reviewed |
| A plug's tool output tells the assistant to call another plug's tool | the gateway labels which plug produced what; writes are confirmed with the plug named in the question |
| Bulk extraction of the guest list through many small reads | guest-level reads off by default, their own scope, paginated, rate-limited per key and per org, no export tool |
| A leaked agent key | reads only unless changes were allowed; short lifetime; revocable; every use logged with the key's name |
| The person approves something different from what runs | the question is rebuilt from current state and must match; the note is single-use and bound to the key, tool and arguments |
| A hosted agent sends something it should not | deterministic orchestration; outward actions only through the outbox with an idempotency key; money-touching actions never autonomous |

Model calls carry the minimum: aggregates and first names where a name is needed. No Restricted
data ever enters a prompt or a trace.

## 8. Connections, secrets and webhooks

- Provider tokens live in a vault; the database holds a reference. Refresh is central; an
  expired or revoked token marks the connection unhealthy and withdraws its tools.
- Least scope per connection: read-only until a module needs to write.
- Every webhook is signature-verified on the raw body, deduplicated by event id, and treated as
  a hint: re-fetch the record from the provider before acting. A reconciliation poll backstops
  lost events.
- Device tokens for kitchen and counter screens are bound to one venue and one purpose,
  revocable from the console, and rotate on re-pairing.
- No secret in source, logs, traces, prompts or error messages. A leaked secret is rotated, not
  deleted from history.

## 9. Money, points and staff

- Loyalty points are a liability the venue owes. Burn on confirmed payment, never on code issue.
  Redemption codes are single-use with a short expiry.
- Staff adjustments, force-confirms, refunds and comps carry an actor and a reason, are
  audit-logged, and above a venue-set threshold need a manager.
- The audit log is append-only and readable by the venue owner. Our own support access to a
  tenant is recorded there too, with the reason, where the venue can see it.
- Platform admins are a separate table with a second factor. No platform role exists inside a
  tenant's org, so a compromised venue account cannot escalate across tenants.

## 10. Comms, consent and the rules that bind us through venues

- A venue can only message guests who hold the matching consent in that org; suppression is
  checked at send time and survives re-imports.
- An imported list with no consent provenance is quarantined, not sendable.
- Marketing goes out on the venue's own verified domain, with per-org caps, so one venue cannot
  burn the others' deliverability or use us as a spam relay.
- Card recognition follows `SCHEMA.md` §2a. Nothing may depend on it until Square has answered
  whether a third-party platform may hold the reference for a seller.
- Guests can see, withdraw and delete per purpose. A venue leaving gets its data exported and
  then deleted.
- A breach here is a breach of many businesses' customers. Write the incident plan, including
  who notifies whom, before the first external venue. This document is not legal advice; a
  privacy lawyer settles the consent wording, the agreement with venues, and notification duties.

## 11. Negative tests every module carries

| Case | Expected |
|---|---|
| Request with no session to a console route | 401 |
| Id belonging to another org | 404 |
| Staff role below what the action needs | 403 |
| Tool call with a key lacking the scope | tool not offered |
| Write tool with no confirmation, a reused one, or an expired one | nothing changes |
| Webhook with a bad signature | rejected, nothing stored |
| Same webhook or checkout twice | one effect |
| Client-supplied price or total | ignored; server value used |
| Script in a page block, menu item or note | rendered as text |
| Module disabled | its routes and tools return not-found |
| Any response, log line or trace searched for a card identifier | none found |

## 12. Open items (decide before Stage 0 is called done)

| # | Item | Owner |
|---|---|---|
| 1 | Which vault holds provider tokens | build |
| 2 | Session model for a person who is staff at two orgs | build |
| 3 | The worker tenant-context helper and the lint rule that enforces it | build |
| 4 | Where model calls are processed, and whether venues need an Australian-region guarantee | founder + lawyer |
| 5 | The data-handling agreement between the platform and a venue | founder + lawyer |
| 6 | Square's written answers on the card reference (`VERIFY.md` #12), especially question 4 | founder |
| 7 | Consent wording for the four purposes | founder + lawyer |
| 8 | Incident and breach-notification plan | founder |
| 9 | Replacing `custom_head_snippet` in `modules/website.md` with named integrations | build |
