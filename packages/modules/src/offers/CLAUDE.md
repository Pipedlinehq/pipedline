# offers — module guide

## What it owns

Org-wide offers (docs/CONSOLE_IA.md section 9, pattern 6; `docs/modules/offers.md`), the
single-use per-guest codes of code offers, the uses of automatic offers, and surcharges.

An offer is **method** (`code`: each guest holds a single-use code; `automatic`: applied by itself
at checkout and matched from the till) × **applies_to** (`item`, `category`, `bill`, `delivery`)
× **audience** (`everyone`, `list` = a campaigns segment, `new_guests`, `loyalty_members`) ×
**when** (`starts_at`/`ends_at`, `days` 0–6, `services` by the venue's hours' names, a daily
`time_from`/`time_to` window, venue-local) × **combinability** (`combine_item`, `combine_bill`,
`combine_delivery`: both offers must allow each other's class) × **limits** (`per_guest_limit`,
`total_limit`). `status` is worked out at read time (`offerStatus`): active / scheduled / expired /
off. `summary` is written by the server (`offerSummary`): "$10 off any main for Lapsed 60+ days,
Tuesday to Thursday dinner, until 30 Nov, one per guest". An offer with none of the newer settings
reads exactly as before, so the welcome, come-back, voucher, birthday and creator offers are
instances of the model (method `code`, bill, everyone).

- Tables (`offersModule.tables`): `offers`, `offer_codes`, `offer_uses`, `surcharges` (migrations 0005, 0300, 0780).
- Toggleable (key `offers`), switched on per venue. `dependsOn: ['identity', 'ledger', 'comms']`. Calls campaigns' exported segment functions (`loadSegment`, `segmentNames`, `isSegmentMember`) for guest lists, and tenancy's `openWindows` for services; never their tables.
- Gate: `assertOffersOn(ctx, venueId?)` (in `definitions.ts`, not exported) — with a venue, on there; without, on at some venue in the org.
- "Front of house" below = `requireStaff` with `anyOf: GUEST_FACING_ROLES`.

## Public functions by purpose

Console:
- `saveOffer(ctx, offerInput)` — manager; create or update (with `id`). A `list` audience needs a segment of this org (else not found); an `item` offer a menu item of this org. Audited `offer.created` / `offer.updated`.
- `switchOffer(ctx, offerId, on)` — manager; audited `offer.switched`.
- `listOffers(ctx, { includeInactive?, active?, kind?, status?, method?, segmentId? })`, `getOffer(ctx, offerId)` — `read_only`. `status` is the console's Active · Scheduled · Expired · Switched off views.
- `offersUsingList(ctx, segmentId)` — `read_only`; the list page's "where it is used".
- `issueCode`, `issueCodes`, `listCodes`, `voidCode` — as before; refuse an automatic offer (no codes) and an ended offer.
- `getOffersSummary(ctx, { days? })` — `read_only`; per offer: issued/claimed/redeemed/expired/live, `uses` (redeemed codes + automatic uses not released), `discountCents`, `revenueCents` (the sales the offer sat on, net of refunds), plus `method`, `status`, `summary`.

Eligibility (eligibility.ts):
- `offerBlockedReason(ctx, offer, { venueId, customerId, at, channel })` — why the offer cannot be used now, in plain words, or null: on/off, dates, days, daily window, services (via `tenancy.openWindows`), who it is for, limits. Used by the code adjuster, the counter, the till match and automatic offers.
- `automaticAdjustments(ctx, draft, applied?, { deliveryFeeCents? })` — the automatic offers that apply to a `DraftOrder`, priced, as `Adjustment`s (`code: auto:<offerId>`, `ref: { offerId, auto: '1' }`), combinable with what is already on the bill, largest first otherwise. **Ordering must call this in `buildCart` after the code adjusters and before tax, and pass the result to `offersAdjuster.commit` / `release` like any adjustment; this module does not edit ordering.**
- `canCombine(a, b)`, `combinesWithApplied(ctx, offer, applied)`, `codeCombinesWith(ctx, code, applied)` — the combinability rule. A loyalty reward or any adjustment not ours counts as a whole-bill offer that combines with nothing. **Ordering must call `codeCombinesWith` for each typed code against the adjustments already accepted; `quote(ctx, draft, code)` cannot see them.**
- `offerUseCount(ctx, offerId, customerId?)`, `recordOfferUse`, `releaseOfferUses`, `tieUsesToSale` (internal).

Surcharges (surcharges.ts):
- `saveSurcharge(ctx, surchargeInput)` — manager at the venue (or any venue for an org-wide one). Kinds `public_holiday` (national days built in: `AU_NATIONAL_PUBLIC_HOLIDAYS` 2026–2028, plus the venue's own `dates`), `sunday`, `days`. `percent` as a person writes it (10 = 10%), stored `percent_bp`. **A name that means a payment-method surcharge is refused** (`isCardSurchargeName`) with `CARD_SURCHARGE_REFUSAL`: the ban from `CARD_SURCHARGE_BAN_DATE` (2026-10-01) on eftpos, Mastercard and Visa surcharges, source `CARD_SURCHARGE_BAN_SOURCE` (RBA). Audited `surcharge.set`.
- `listSurcharges(ctx, { venueId?, includeInactive? })`, `getSurcharge`, `deleteSurcharge` (audited `surcharge.deleted`).
- `applicableSurcharges(ctx, venueId, at)` — the surcharges in force at the venue in its own day: `{ id, name, percentBp, reason, notice }`. **Ordering must call this after discounts and before tax and add `surchargeAmountCents(base, percentBp)` per surcharge to the total, printing `notice` on the docket; this module does not edit ordering.** `surchargeDocketLines` / `surchargeDocketText` give the docket lines; `surchargeNotice(ctx, venueId)` the menu line ("A surcharge of 10% applies on Sundays.").

Counter, guest-facing and public functions (`checkCode`, `redeemCodeAtCounter`, `requestOfferCode`, `previewCode`, `claimCode`, `listMyCodes`, `getPublicOffer`): as before; they now also apply `offerBlockedReason`, and `getPublicOffer` answers not-found for an offer that is not active now or not a code offer.

## Hooks

Defines none. Registers (`hooks.ts`):
- `ledger.onTransactionRecorded` → `redeemFromSale`: codes as before; **a till discount whose name is an active automatic offer's name is a use** (`offer_uses`, once per sale, `offer.applied`); a sale later `refunded`/`voided` releases its codes and uses; an online order's codes and uses are tied to the sale for the sales-attributed figure.
- `ordering.registerCheckoutAdjuster(offersAdjuster)` — `quote` prices a code (what it comes off: a dish, a category, the bill) after `offerBlockedReason`; `commit` marks a code used, or records an automatic use when `ref.auto === '1'`; `release` gives either back.
- `identity.onCustomerMerge`, `identity.onCustomerErase`, `identity.registerCustomerDataProvider('offers', …)` — as before.

## Config surface

Per venue (`offersConfig`): unchanged (`acceptHere`, `matchTillDiscounts`, `staffRedeem`, `bulkIssueMax`, `paymentGraceMinutes`).

Per offer (`offerInput`): the fields above plus the earlier ones (`kind`, `discountKind`, `valueCents`, `percentOff`, `menuItemId`, `priceCents`, `minSpendCents`, `validityDays`, `requiresClaim`, `channels`, `validVenueIds`, `maxCodes`, `codePrefix`, `campaignId`, `creatorId`, `isActive`). Per surcharge (`surchargeInput`): `venueId` (null = every venue), `name`, `kind`, `percent`, `days`, `dates`, `isActive`.

## Jobs, schedules, events, templates, tools

- Job and schedule `offers.expire_codes`, as before.
- Events: `offer.issued`, `.claimed`, `.redeemed`, `.released` (also for a released use, `code_id: use:<id>`), `.expired`, `.voided`, `.redemption_refused`, **`offer.applied`** (an automatic use: `offer_id`, `use_id`, `via` online/till, `discount_cents`).
- Template: `offers.code`, as before.
- Tools: `offers_summary` (read, `offers:read`; now with `uses`, `method`, `status`, `summary` and a `status` filter), **`offer_set`** and **`offer_switch`** (write, `offers:write`, manager; the question is the server-written summary), **`surcharge_set`** (write, `offers:write`, manager, venue-scoped; refuses a card surcharge before asking) and **`surcharges_list`** (read, `offers:read`).
- Audit: `offer.created`, `offer.updated`, `offer.switched`, `offer.code_issued`, `offer.code_voided`, `offer.code_redeemed_by_staff`, `surcharge.set`, `surcharge.deleted`.

## Simulated vs real

No ports of its own. Messages go through `comms.queueMessage`; till sales arrive through the ledger.

## Known gaps

- Ordering calls `automaticAdjustments`, `codeCombinesWith` and `applicableSurcharges` from `ordering/bill.ts` (since 2026-10-13): automatic offers, typed codes and surcharges are on every online total, re-priced at quote and at order creation, with one `offer_uses` row per paid order.
- A `delivery` code offer is refused at `quote` (the draft carries no delivery fee); an automatic delivery offer is priced only when ordering passes `deliveryFeeCents`.
- State public holidays are the venue's own `dates`; only the national days are built in, for 2026–2028.
- The claim link in `offers.code` is empty until the org has a verified primary domain; `priceCents` is stored but nothing charges it.
