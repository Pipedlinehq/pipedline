# offers — module guide

## What it owns

Org-wide offer definitions and unique, single-use, per-guest codes (welcome, comeback, voucher,
birthday, creator, manual). A code is never applied by itself: the guest claims it, enters it at
checkout, or it arrives on a till sale / is marked by staff. Redeemed once however it is used.

- Tables (`offersModule.tables`): `offers`, `offer_codes`.
- Toggleable (key `offers`), switched on per venue. `dependsOn: ['identity', 'ledger', 'comms']`.
- Gate: `assertOffersOn(ctx, venueId?)` (in `definitions.ts`, not exported from `index.ts`) — with a venue, on there; without, on at some venue in the org.
- "Front of house" below = `requireStaff` with `anyOf: GUEST_FACING_ROLES` (`front_of_house`, `host`, or manager and up).

## Public functions by purpose

Console:
- `saveOffer(ctx, offerInput)` — manager; create or update (with `id`). Switching off stops new codes; issued codes stay good. Audited.
- `listOffers(ctx, { includeInactive? })`, `getOffer(ctx, offerId)` — `read_only`.
- `issueCode(ctx, { offerId, customerId?, source, notify? })` — internal (flows, campaigns) or manager. One live code per guest per offer (asking again returns it); `welcome` and `creator` are once per guest ever. No `customerId` = an unbound voucher code.
- `issueCodes(ctx, { offerId, customerIds, source, notify? })` — internal or manager; bulk, capped by `bulkIssueMax`; safe to re-run.
- `listCodes(ctx, listCodesInput)` — manager, or front of house when filtered to one `customerId`.
- `voidCode(ctx, { codeId, reason })` — manager; audited.
- `getOffersSummary(ctx, { days? })` — `read_only`; issued/claimed/redeemed/expired, discount, revenue per offer.

Counter:
- `checkCode(ctx, { venueId, code })` — front of house; is it good here, what it gives, whose it is. Changes nothing.
- `redeemCodeAtCounter(ctx, { venueId, code, transactionId? })` — front of house; refused when `staffRedeem` is off. Audited.

Guest-facing / public:
- `requestOfferCode(ctx, requestCodeInput)` — public sign-up for `welcome` / `creator` offers only; email or phone; rate-limited 10 per IP per 10 min. A new guest is stamped with creator/campaign/code acquisition; a known guest gets a marketing touch. Issued already claimed.
- `previewCode(ctx, { code })` — read only (a mail scanner following the link claims nothing). `claimCode(ctx, { code })` — marks claimed; an unbound code becomes the signed-in guest's. Both rate-limited 30 per IP per 10 min for non-staff; a guest cannot open another guest's code.
- `listMyCodes(ctx)` — `requireGuest`.

Other modules / jobs:
- `offersAdjuster` — registered with ordering (below). `expireCodes(ctx, filter?)` — the expiry job's work, also run before issuing.

## Hooks

Defines none. Registers (`hooks.ts`):
- `ledger.onTransactionRecorded` → `redeemFromSale`: a sale whose discounts carry one of our codes (code field, name, code-shaped words in the name) marks it redeemed, when `acceptHere` and `matchTillDiscounts`; a code that should not have been accepted is not marked and `offer.redemption_refused` is tracked. Also ties an online order's code to its ledger row, and releases codes whose sale is later `refunded` or `voided`.
- `ordering.registerCheckoutAdjuster(offersAdjuster)` — key `offers`; `quote` prices a code against the draft, `commit` marks it used after payment (refuses if another order used it), `release` gives it back.
- `identity.onCustomerMerge` — codes move to the winner; a duplicate live code for the same offer is voided.
- `identity.onCustomerErase` — voids unused codes and unlinks all codes from the guest.
- `identity.registerCustomerDataProvider('offers', ...)`.

## Config surface

Per venue (`offersConfig`): `acceptHere` (codes redeemable here), `matchTillDiscounts`, `staffRedeem`, `bulkIssueMax`, `paymentGraceMinutes` (a code that lapsed between pricing and payment is still honoured this long).

Per offer (`offerInput`, rows not settings): `kind`, `discountKind` (`fixed | percent | free_item`), `valueCents`, `percentOff`, `menuItemId`, `priceCents`, `minSpendCents`, `validityDays`, `requiresClaim`, `channels`, `validVenueIds`, `maxCodes`, `codePrefix` (default `ROS`), `campaignId`, `creatorId` (required for `creator`), `isActive`. No org-level settings namespace.

## Jobs, schedules, events, templates, tools

- Job `offers.expire_codes`; schedule `offers.expire_codes` every 60 min, org scope, only orgs with offers on somewhere.
- Events: `offer.issued`, `offer.claimed`, `offer.redeemed`, `offer.released`, `offer.expired`, `offer.voided`, `offer.redemption_refused`.
- Template: `offers.code` (email + sms, marketing; comms enforces consent and suppression).
- Tool: `offers_summary` (read, scope `offers:read`, totals only).

## Simulated vs real

No ports of its own. Messages go through `comms.queueMessage`; till sales arrive through the ledger.

## Known gaps

- The claim link in `offers.code` is an empty string until the org has a verified primary domain (`claimUrl`).
- `priceCents` is stored on the offer and returned in `OfferView`, but nothing in the module charges it.
