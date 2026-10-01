# loyalty — module guide

## What it owns

An org-wide points programme (earn at one venue, burn at another) that follows the ledger:
points are earned from recorded sales with nothing needed at the till, rewards are redeemed at
the counter with a single-use code or online through checkout. The points ledger
(`loyalty_transactions`, written only through `points.ts` `writePoints`) is append-only.

- Tables (`loyaltyModule.tables`): `loyalty_programs`, `loyalty_tiers`, `loyalty_accounts`, `loyalty_transactions`, `rewards`, `redemptions`.
- Toggleable (key `loyalty`), switched on per venue. `dependsOn: ['identity', 'ledger', 'comms']`.
- Gate: `assertLoyaltyOn(ctx, venueId?)` (in `points.ts`, not exported) — with a venue, the module must be on there; without one, on at some venue in the org. Otherwise `module_disabled`.
- Roles: "front of house" below means `requireStaff` with `anyOf: GUEST_FACING_ROLES` (`front_of_house`, `host`, or any role from manager up).

## Public functions by purpose

Console — programme (org-wide; manager unless stated):
- `getProgramSettings(ctx)`, `saveProgram(ctx, programInput)` — one programme per org, saved in place; `isActive: false` pauses earning and redeeming.
- `saveTier(ctx, tierInput)`, `deleteTier(ctx, tierId)`; `saveReward(ctx, rewardInput)`; `listRewards(ctx, { includeInactive? })` (`read_only`).
- `listMembers(ctx, input)`, `setMemberStatus(ctx, { accountId, status, reason })` — manager.
- `adjustPoints(ctx, { venueId, accountId, points, reason, requestKey? })` — manager at the venue; owner when `|points|` > `ownerAdjustmentAbovePoints`.
- `forceConfirmRedemption(ctx, forceConfirmInput)` — manager; owner when `allowStaffForceConfirm` is off.
- `getLoyaltySummary(ctx, { days })` — `read_only`; totals only.
- `backfillEarning(ctx, backfillInput)` — internal or manager.

Counter (front of house at the venue):
- `lookupMember`, `searchMembers`, `getMemberCard`, `listCounterRedemptions`, `getAccount` (also the owning guest).
- `enrolAtCounter(ctx, counterEnrolInput)` — phone or email required; refused when `counterEnrolment` is off. Records no marketing consent.
- `issueRedemption(ctx, { venueId, accountId?, rewardId })` — front of house, or a signed-in guest for themself. Holds points; spent only when a matching sale arrives.
- `voidRedemption(ctx, { redemptionId, reason? })` — the owning guest or front of house at the issuing venue.

Guest-facing:
- `getProgram(ctx)` — no role check (the public site).
- `joinLoyalty(ctx, { venueId? })`, `getMyLoyalty(ctx, { venueId? })`, `getMyLoyaltyHistory(ctx, historyInput)` — `requireGuest`.
- `rewardCheckoutCode(rewardId)` — the code checkout submits (`REWARD-<id>`) for a reward the guest picked.

Other modules / internal:
- `importMember(ctx, importMemberInput)` — internal only, no message sent.
- `enrolFromCheckout`, `loyaltyAdjuster`, `earnForSale`, `pointsFor` — exported for the hooks below and for back-office scripts, not for routes.
- Job bodies: `expireStaleRedemptions`, `expirePoints`, `refreshTiers`, `awardBirthdayBonuses`.

## Hooks

Defines none. Registers (`hooks.ts`):
- `ledger.onTransactionRecorded` — links an online order's sale to its redemption, releases redemptions on a refunded sale, matches counter sales to issued codes (by code, or by venue + time window + amount when `matchByAmount`), then `earnForSale` (earn on completion, proportional reverse on refund).
- `ordering.registerCheckoutAdjuster(loyaltyAdjuster)` — key `loyalty`; `quote` prices `REWARD-<id>` codes (guest must be signed in and an active member), `commit` spends points after payment, `release` returns them.
- `ordering.onOrderStatusChanged(enrolFromCheckout)` — enrols a customer whose order carries the `loyalty_join` flag (`LOYALTY_JOIN_FLAG`) once it is paid; does nothing if loyalty is off there.
- `identity.onCustomerMerge` — moves or merges accounts (balance crosses as a `transfer` pair), then backfills the winner.
- `identity.onCustomerErase` — voids issued codes, zeroes the balance, closes and unlinks the account.
- `identity.registerCustomerDataProvider('loyalty', ...)`.

## Config surface

Per venue (`loyaltyConfig`): `earnHere`, `earnChannels` (dine-in, pickup, delivery, catering, retail), `earnLookbackHours` (a sale this long before joining still earns), `redeemHere`, `redemptionExpiryMinutes` (counter code life), `lateSaleGraceMinutes`, `matchByAmount`, `allowStaffForceConfirm`, `identifyBy` (phone, email, qr, name), `counterEnrolment`, `ownerAdjustmentAbovePoints`.

Org-wide settings are rows, not a settings namespace: `loyalty_programs` (`programInput`: earn model `points_per_dollar | visits | stamps`, rate, rounding, point value, expiry `none | rolling | fixed` + months, enrolment and birthday bonus, terms URL), `loyalty_tiers`, `rewards` (`fixed | percent | free_item`, limits, venues, days, dates).

## Jobs, schedules, events, templates, tools

- Jobs / schedules (org scope, only orgs with loyalty on somewhere): `loyalty.sweep_redemptions` every 5 min; `loyalty.expire_points` daily (also runs `refreshTiers`); `loyalty.birthday_bonus` every 180 min.
- Events: `loyalty.enrolled`, `loyalty.earned`, `loyalty.earn_reversed`, `loyalty.redemption_issued`, `loyalty.redeemed`, `loyalty.redemption_expired`, `loyalty.redemption_released`, `loyalty.expired`, `loyalty.adjusted`, `loyalty.bonus_awarded`, `loyalty.tier_changed`.
- Templates: `loyalty.welcome` (email + sms, transactional), `loyalty.birthday` (email + sms, marketing).
- Tools: `loyalty_summary` (read, scope `loyalty:read`, totals only).

## Simulated vs real

No ports of its own. Messages go through `comms.queueMessage`; sales arrive through the ledger from whatever POS or ordering recorded them.

## Known gaps

- The merge hook backfills with `loyaltyModule.defaultConfig.earnLookbackHours`, not the venue's configured value.
- `visits` and `stamps` earn models award a flat `points_per_dollar` per sale; there is no separate stamp-card logic.
