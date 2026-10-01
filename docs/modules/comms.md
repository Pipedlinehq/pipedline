# MODULE — `comms` (spine; email + SMS)

You have built Resend/Twilio pipes before. What changes at hundreds of tenants is isolation,
deliverability, and consent.

## 1. Outbox — never send from a request handler

```sql
messages(id, org_id, venue_id NULL, customer_id NULL,
         channel,          -- 'email' | 'sms'
         kind,             -- 'transactional' | 'marketing'
         template_key, payload jsonb,
         to_address, from_identity_id,
         status,           -- 'queued' | 'sending' | 'sent' | 'delivered' | 'bounced' | 'failed' | 'suppressed'
         provider, provider_message_id,
         attempts, next_attempt_at, error,
         idempotency_key UNIQUE,
         queued_at, sent_at, delivered_at)

message_events(id, message_id, event, occurred_at, metadata jsonb)
-- delivered, opened, clicked, bounced, complained, unsubscribed
```

The request writes the `messages` row **in the same transaction as the business change**. A
Railway worker drains the queue. This gives you retries, per-tenant throttling, provider
failover, and an audit trail — none of which can be bolted on later.

## 2. Deliverability isolation (the failure mode that hurts everyone)

| Kind | Sending identity | Why |
|---|---|---|
| Transactional | platform-owned domain | you control volume + content; reputation stays clean |
| Marketing | **per-org verified domain** | their list, their reputation, isolated blast radius |

One tenant blasting a stale purchased list on a shared domain drags every other tenant's inbox
placement down with it. Per-org marketing domains are set up during onboarding (DNS records
surfaced alongside the website DNS — same conversation, one ask).

```sql
sending_identities(id, org_id, channel, kind, domain NULL, from_email, from_name,
                   sms_sender_id NULL, provider_domain_id, verified_at, status)
```

## 3. SMS specifics

- **Twilio subaccount per org** — isolation, per-tenant billing attribution, independent
  suspension if one tenant misbehaves.
- **AU sender ID / A2P registration has real lead time.** Start it on day one of onboarding.
  This is the most common cause of a launch slipping.
- Quiet hours per venue timezone. Never send marketing SMS at 7am because the worker woke up.
- Cost per message is real and per-tenant — meter it, cap it, and show it in their console.

## 4. Consent & suppression (Spam Act 2003)

```sql
-- consents: defined in SCHEMA.md §2a (one row per purpose, with the wording version shown).
-- comms reads the 'marketing_email' and 'marketing_sms' purposes.
suppressions(id, org_id, channel, value, reason, created_at)
-- reason: 'unsubscribed' | 'bounced_hard' | 'complained' | 'manual'
```

- Consent is **per-org** — subscribing at one restaurant is not consent for another.
- Record source, timestamp, and IP. You will be asked to prove it.
- Suppression is checked at send time in the worker, and **survives list re-imports** — the
  classic bug is a restaurant re-uploading a CSV and resurrecting unsubscribes.
- Every marketing message carries unsubscribe + sender identification.
- Transactional messages are exempt from consent but must genuinely be transactional. An
  "order confirmation" containing a promotion is a marketing message.

## 5. Templates

Per-org templates layered over platform defaults: platform ships a working default for every
`template_key`; an org may override copy and styling; brand tokens are injected automatically
so emails match their site without design work.

Render server-side in the worker, not the request path. Store a rendered snapshot on send so
"what did this guest actually receive" is answerable during a dispute.

## 6. Per-tenant limits

Rate limits and daily caps per org on both channels, so no single tenant exhausts a shared
provider quota or runs up an unexpected bill.

## 7. Bring-your-own email platform (added 2026-09-30)

A venue that followed the handbook, or any venue with history, arrives with a list and working
flows in an email platform it already pays for (one venue we know: about 8,400 subscribers and
live flows in Klaviyo). Forcing a migration on day one loses deals and risks their sender
reputation. So email platforms are tiered the way POS systems are.

| Tier | Who sends | What we do | Platform |
|---|---|---|---|
| **Native** | we do, through the outbox | everything in §1–§6 | Resend + Twilio |
| **Connected** | their platform; their flows stay | push profiles, consents and events to it; pull unsubscribes, bounces and engagement back | Klaviyo first |

```ts
interface EspAdapter {
  key: string                                    // 'resend' | 'klaviyo'
  capabilities: {
    transactional: boolean
    marketing: boolean
    sms: boolean
    flows: 'ours' | 'theirs'
    suppressionSync: 'push' | 'pull' | 'both'
    engagementEvents: boolean
  }
  upsertProfile(orgId, customer, consents): Promise<void>
  trackEvent(orgId, customerId, event): Promise<void>      // order placed, points earned, visit
  send?(message): Promise<{ providerId: string }>          // native tier only; idempotent on our key
  pullSuppressions(orgId, since): Promise<Suppression[]>
  onWebhook(payload): Promise<MessageEvent[]>
}
```

Rules:

- **Transactional messages are always native.** Order confirmations and receipts do not depend
  on a venue's marketing platform.
- **An unsubscribe anywhere is an unsubscribe everywhere.** Our `consents` and `suppressions`
  are the record; the adapter keeps the connected platform in step in both directions. A
  conflict resolves to "not consented".
- A connected venue can move to native later by importing its list with consent provenance. It
  is a config change plus an import, not a rebuild.
- What the connected platform can do through its API is to be confirmed before building
  (`VERIFY.md` #17).
