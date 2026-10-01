# VERIFY — Assumptions to confirm against live docs before building on them

These are load-bearing architecture assumptions drawn from general knowledge. **Confirm each
against current vendor documentation before it becomes a dependency** — SaaS capability sets
move, and several of these decide module design rather than just implementation detail.

| # | Assumption | Depends on it | Priority |
|---|---|---|---|
| 1 | Square Payments exposes a **stable card fingerprint** (or equivalent durable identifier) on payments | Automatic in-venue identity resolution → the whole Criota attribution loop for dine-in | **critical** |
| 2 | Square Orders API allows pushing a discount onto an open order from an external system | One-tap in-venue loyalty redemption vs. manual staff workaround | high |
| 3 | Square OAuth supports self-serve per-merchant connection without partner approval | Onboarding time-to-live | high |
| 4 | Vercel supports hundreds of custom domains on one project, added via API, with acceptable limits | The entire multi-tenant routing model | **critical** |
| 5 | Resend supports many per-org verified sending domains under one account, provisioned by API | Marketing deliverability isolation | high |
| 6 | Twilio subaccounts + AU sender ID / A2P registration timelines and requirements | Onboarding critical path — this is the usual launch-slipper | high |
| 7 | **Doshii** (or equivalent AU POS middleware) — coverage list, and specifically whether it carries **customer/card identity**, not just orders | Whether the AU long tail can ever reach Tier 1 or is permanently Tier 2 | **critical** |
| 8 | Lightspeed K-Series API: itemised lines, customer identity, discount write-back, webhooks | Adapter #2 scope | high |
| 9 | Next.js cache tag limits / behaviour at hundreds of tenants and tags | Per-tenant revalidation model | medium |
| 10 | Supabase pooler connection limits at expected concurrency | Request-path stability | medium |

| 11 | Square's card `fingerprint` is the **same value across different merchants** connected to one application (the docs say "across multiple locations within a single application"). Test with two sandbox merchants | Whether raw storage would create a cross-merchant key; `SCHEMA.md` §2a hashes per org either way | **critical** |
| 12 | The account-level reference (PAR) is returned on **Australian** Square payments, and Square will say in writing what a merchant may do with it. Six questions to Square are drafted and not yet sent. | Whether opted-in card recognition survives phone wallets at all | **critical** |
| 13 | Which assistants support the MCP confirmation step (the server asking the person a question mid-call). Criota's server already falls back to read-only when an assistant cannot | Whether writes through `hub` work in the assistants venues actually use | high |
| 14 | An order pushed to Square by API shows on the venue's existing order screen, kitchen display and printer. A search on 2026-09-30 found pickup-type orders do, and a forum report that delivery-type orders do not. Dine-in (QR) is untested | Whether Square venues need our KDS at all for online, QR and delivery orders | high |
| 15 | Uber Direct and DoorDash Drive: Australian onboarding terms for a platform acting for many venues, coverage outside metro areas, alcohol and ID handling | `modules/delivery.md` part A | high |
| 16 | The current card-surcharge rule (research notes record a ban from 1 Oct 2026) and what fee lines remain allowed | QR and online checkout | medium |
| 17 | Klaviyo's API: profile and consent sync, custom events, suppression and engagement pull, webhooks | The connected tier in `modules/comms.md` §7 | high |

**Update 2026-09-30 on #1.** Partly answered by one venue's live data and the channel
research. A fingerprint exists and is stable for a physical card, but about 79% of in-store
payments are contactless and the fingerprint alone recovers about 1 in 6. The account-level
reference covers about 74% of card payments (EFTPOS 0%), is absent from Square's documentation,
and is restricted by Mastercard and Visa rules to opted-in services. So #1 is "true, but much
weaker than assumed, and opt-in only". #11 and #12 replace it as the open questions.

**Do #4, #7, #11 and #12 first.** Each one, if false, changes a module's design rather than its
implementation:

- **#1 false** → in-venue identity needs an explicit guest action every visit (phone/QR at the
  counter), which materially changes loyalty UX and weakens dine-in attribution. Worth knowing
  before designing the counter flow.
- **#4 false** → the routing model changes to multiple projects or a proxy layer.
- **#7 false** → the AU long tail is permanently Tier 2, which changes what you can promise in
  the sales call and how you price it.
