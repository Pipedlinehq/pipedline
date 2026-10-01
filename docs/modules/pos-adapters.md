# POS STRATEGY — Which POS systems to support, and how

## The honest recommendation: tiered, not universal

"Integrate any POS" sounds like it removes a sales objection. It actually creates a permanent
treadmill — every adapter is built once and **maintained forever**, and the Australian POS long
tail (Impos, Idealpos, Redcat, Bepoz, Abacus) is largely partner-gated with thin or no public
APIs. Ten adapters is ten things that break while you are trying to build loyalty.

But the objection is real: *"we're not changing POS"* will kill deals if your answer is
"then we can't help you." So the posture is **tiered degradation, declared up front**.

| Tier | What we get | What the venue gets | POS |
|---|---|---|---|
| **1 — Deep** | itemised transactions · customer/card identity · discount write-back · webhooks | everything: in-venue loyalty earn+burn, full attribution, KDS from POS | Square, Lightspeed |
| **2 — Read** | transactions, maybe identity, no write-back | loyalty burns via manual staff discount; attribution works; reporting works | anything with a usable orders/payments API, or via middleware |
| **3 — None** | nothing from in-venue | website, bookings, online ordering, online-only loyalty earn, comms, campaigns | closed POS |

**Tier 3 is still a real product.** Website + bookings + pickup ordering + comms is most of what
a restaurant is buying. Be explicit in the sales call that dine-in spend is invisible until they
integrate — then sell the Tier 1 migration as the upgrade. Overpromising here creates churn at
month three, which is far more expensive than losing the deal.

## The scoring rubric — evaluate on identity, not on "has an API"

Every POS gets scored on four things, in this order:

1. **Itemised transactions** — lines, modifiers, discounts, not just a payment total. Without
   lines you cannot do menu-mix, COGS, or item-level attribution.
2. **A stable customer or card identifier.** *This is the one that matters.* It is what turns an
   anonymous walk-in into an attributable customer, and it is the entire reason you own this
   layer instead of renting it. A POS that gives you payments with no durable identifier gives
   you revenue reporting, not the asset.
3. **Discount / order write-back.** Determines whether in-venue loyalty redemption is one tap or
   a manual staff workaround.
4. **Webhooks.** Polling works but adds latency and cost; near-real-time is what makes loyalty
   feel instant at the counter.

Most POS comparisons rank on #1 and #4. Rank on **#2**. It is the difference between a reporting
tool and the platform you are actually trying to build.

## Recommended sequence

**1. Square first.** Best-documented API in the category, self-serve OAuth (no partner approval
queue), strong AU presence, and you already know it. It is also the easiest thing to *sell into*
— venues can adopt it without a partner process. Deep tier.

**2. Lightspeed second.** The strongest AU install base among venues that already have a real
POS, particularly hospitality (K-Series). This is the adapter that unlocks existing multi-site
operators — the customers worth the most to you. Deep tier.

**3. For the AU long tail, buy middleware rather than build eight adapters.** There is
Australian POS middleware built precisely for this problem — one API fanning out to Impos,
Idealpos, Redcat, Bepoz, Lightspeed and others (**Doshii** is the name to evaluate first).
Renting that is almost certainly cheaper than maintaining eight partner relationships, and it
converts the long tail from "no" to Tier 2 in one integration.

Caveat, and it is the important one: **middleware usually normalises orders and payments, and
usually does not carry the customer/card identity you need.** Evaluate it against rubric item
#2 specifically before committing — if it only delivers transactions, it buys you Tier 2 and
never Tier 1, which is fine as long as you priced and sold it that way. See `VERIFY.md`.

**Do not build direct adapters for individual long-tail POS systems** unless a single one shows
up in enough of your pipeline to pay for its own maintenance. Let the pipeline tell you.

## The adapter contract — build this before the second adapter

Define it now, so adding a POS is writing an adapter, never reshaping the ledger.

```ts
interface PosAdapter {
  key: string                                   // 'square' | 'lightspeed' | 'doshii' | 'manual'
  capabilities: {
    itemisedLines: boolean
    customerIdentity: 'none' | 'card_fingerprint' | 'customer_id' | 'both'
    writeBack: 'none' | 'discount' | 'order'
    webhooks: boolean
    realtime: boolean
  }
  connect(venueId): Promise<ConnectionResult>          // OAuth / API key / partner handshake
  ingest(venueId, since): AsyncIterable<CanonicalTransaction>
  onWebhook(payload): Promise<CanonicalTransaction[]>
  resolveIdentity(txn): Promise<IdentityHint[]>        // → customer_identities
  applyDiscount?(venueId, orderRef, discount): Promise<Result>   // Tier 1 only
  pushOrder?(venueId, order): Promise<Result>                    // if POS accepts inbound orders
}
```

Everything lands as a `CanonicalTransaction` written to the one `transactions` ledger with
`source` and `external_ref`. `capabilities` is what the console reads to decide which features
to show a venue — so a Tier 2 venue simply doesn't see the one-tap redemption button, rather
than seeing a button that fails.

**`capabilities` is also your sales collateral.** It tells a prospect exactly what they get on
their current POS, before they sign, which is how you avoid the month-three churn conversation.

## How this interacts with building your own POS

The tiers are not competing with the `pos` module — they feed it. A venue on a closed POS is
exactly the venue that eventually adopts yours, because you can show them what they are missing
from their own reporting. Tier 3 venues are your POS pipeline, and `modules/pos.md` P1
(order-entry only) is the low-risk on-ramp.
