# ordering — module guide

> Updated 2026-10-13 for the console depth pass, wave 2 (patterns 2, 7 and 10 of
> `docs/COMMERCE_ADMIN_PATTERNS.md` section 3; `docs/CONSOLE_IA.md` section 9), and again the same
> day for the bill: channel prices, automatic offers, code combinability and surcharges on totals
> (`bill.ts`). The "as built" sections of `docs/modules/ordering.md` have the same in prose.

## What it owns

Pickup, delivery and table (QR) orders: server-side cart pricing on the order's own menu channel,
the bill (codes, automatic offers, surcharges, delivery, tax, tip), slot pacing, checkout, card
payment, status, refunds, the kitchen order screen, pushing orders to a venue POS, the record of
orders a guest did not finish, and phone and function orders built by staff.

- Tables (`orderingModule.tables`): `orders`, `order_items`, `order_status_history`, `payments`, `refunds`, `kitchen_tickets`, `ticket_events`.
  Migrations `0004`, `0100`, `0101`, `0110`, `0770_orders_bookings_depth.sql` (source, hold, pay link, paid-by, didn't-finish columns), `0810_order_surcharges.sql` (`surcharge_cents`, `surcharges` jsonb).
- Toggleable (key `ordering`). `dependsOn: []`.
- Uses: `menu` (`getOrderableItems` with the order's channel as the surface, `menuItemRef`), `offers` (**only from `bill.ts`**: `automaticAdjustments`, `codeCombinesWith`, `applicableSurcharges`, `surchargeNotice`, `percentWords`; each applies only where the offers plugin is on at the venue), `ledger` (`recordTransaction`), `identity` (`resolveCustomer`, `grantConsent`, normalisers), `comms` (`queueMessage`, `defineTemplate`), `events` (`trackInSession`), `tenancy`, connections (`findConnectionFor`, `adapterFor`). The POS push planner reads `menu_items.pos_catalog_id` directly.

## The bill (`bill.ts`, `pricing.ts`)

`buildCart` prices every line from `getOrderableItems(ctx, venueId, ids, { surface: channel === 'dine-in-qr' ? 'qr' : channel, at })`:
the channel's price list applies and an item hidden from that channel is not found. Then, in this order:

1. the codes the guest typed, each priced by the first `CheckoutAdjuster` that knows it, then checked with `codeClash` (offers' `codeCombinesWith`) against the adjustments already accepted — a refusal is a `rejectedCodes` entry in the offers module's words and `createOrder` refuses the order with it;
2. the delivery quote (on the subtotal after codes);
3. `automaticOffers` (offers' `automaticAdjustments` for this guest, venue and moment, with the delivery fee), each capped like a code's discount; `code` is `auto:<offerId>`, `ref.auto = '1'`;
4. `surchargesFor(ctx, venueId, at, subtotal − discounts)` for the day the order is for (`at` = the slot start, else now), each `{ id, name, percentBp, reason, notice, amountCents }`;
5. tax on subtotal − discounts + surcharges + delivery; tip.

`PricedCart`, `OrderView` and `TrackedOrder` carry `adjustments[]` (`label` is the offer's name and plain-words summary; `automatic` on the views), `surcharges[]`, `surchargeCents`, `surchargeNotices[]` and `breakdown: TotalsLine[]` (`totalsBreakdown`: subtotal · each adjustment · each surcharge · delivery · tip · tax · total · refunded — the one list every surface prints). `surchargeLabel(s)` = "Sunday surcharge (10%, Sunday)". `ordering.surchargeNotice(ctx, venueId)` is the menu line for the site's menu and order pages (`CheckoutOptions.surchargeNotice`); null when offers is off at the venue. Everything is worked out afresh at every quote and at `createOrder`; the order freezes `adjustments`, `surcharges`, `surcharge_cents`. The till push lists surcharges as service charges beside the delivery fee.

## The three status axes and "Came from" (`axes.ts`)

Derived from the row, never stored (`axesOf`, `kitchenOf`, `moneyOf`, `leavesOf`; `OrderView.axes`):
- **kitchen**: `none` (draft, pending_payment) · `new` (placed) · `accepted` · `cooking` (preparing) · `ready` · `collected` | `delivered` | `served` (completed, by channel) · `stopped` (rejected, cancelled, refunded).
- **money**: `paid` · `partly_refunded` · `refunded` from `payment_status`; otherwise `voided` when the order is cancelled, rejected or refunded, `due` when `source` is `phone`, else `unpaid`.
- **leaves**: pickup · table (dine-in-qr) · delivery.
- **source** (stored, `orders.source`, enum `order_source`): `website` (default) · `qr` (set for a table order) · `phone` (drafts) · `assistant` (the venue site passes it for a cart a guest's assistant handed over; `createOrderInput.source` accepts only website | assistant) · `square` (reserved for the till).
Words for the console and the tools: `KITCHEN_WORDS`, `MONEY_WORDS`, `LEAVES_WORDS`, `SOURCE_WORDS`. Filters: `kitchenStatuses(axis)`, `kitchenChannel(axis)`, `channelOf(leaves)`.

## Public functions by purpose

Guest-facing / public (no role check unless stated; org from the host):
- `priceCart(ctx, cartInput)` — prices from the server on the order's channel, with the automatic offers and surcharges of the moment (see "The bill"); guest-fixable problems come back as `issues` (`CartIssueCode`) and rejected codes (a code that cannot sit with another is one).
- `getPickupSlots(ctx, { venueId, date?, itemCount?, prepMinutes? })` — ASAP estimate plus slots with room.
- `createOrder(ctx, createOrderInput)` — anon or guest; staff must be `kitchen`+; a device is forbidden. Idempotent on `idempotencyKey`, rate-limited, resolves the customer first (so a per-guest offer limit is counted for them), prices the cart afresh (the quote is not trusted; a rejected code refuses the order), holds the slot as `pending_payment`, records ticked consents, stores `flags`, `source`, `adjustments`, `surcharges` and `surcharge_cents`, enqueues `ordering.expire_unpaid` at `payment_hold_minutes` and, for a pickup or delivery with an email or phone, `ordering.detect_abandoned` at `abandoned_after_minutes`. Nothing charged, nothing sent to the kitchen.
- `getCheckoutOptions(app, actor, venueId)` — app-level; processor client config, toggles, consent wordings.
- `payOrder(app, actor, { trackingToken | orderId, sourceToken? })` — app-level, three steps (mark; charge through `once` kind `payment`; settle). Token holder, the guest who owns the order, or staff `kitchen`+. Charges the order's stored total: the quote is never re-trusted and never re-priced here. Settling writes the ledger row (tender from the payment: card, or cash | bank | other for a manual one), the kitchen ticket, the confirmation, commits adjusters (an automatic offer becomes one `offer_uses` row with the sale's `transaction_id`, once however often the payment is replayed; each committed adjustment is audited `order.offer_applied`), runs status handlers, marks recovered unfinished orders (`markRecoveredOrders`), enqueues a POS push (not for a manual payment).
- `trackOrder(ctx, token)`, `cancelUnpaidOrder(ctx, token)` — holding the tracking token is the permission. The site serves the page at `/order/t/<token>` (`trackingUrl`), with the pay panel while the order waits for payment.
- `orderByTrackingToken(ctx, token)` — `{ orderId, venueId, channel }`.

Console:
- `getOrder(ctx, orderId)`, `listOrders(ctx, listOrdersInput)` — `read_only`. Filters: `statuses`, `live`, `channel`, `from`/`to`, `tableSessionId`, `needsAttention`, `reference`, and the axes `kitchen[]`, `money[]`, `leaves[]`, `source[]`, plus `unfinished` (abandoned, not purged) and `drafts` (phone orders in draft or pending_payment). Drafts and unpaid checkouts are left out unless a filter means them (a status, `kitchen: none`, `money: unpaid | due`, `unfinished`, `drafts`).
- `updateOrderStatus(ctx, { orderId, status, reason? })` — `requireDevice(.., 'kitchen')` (paired screen or staff `kitchen`+); cancelling a paid order needs a manager. Reject/cancel needs a reason, enqueues `ordering.refund` if paid, notifies the guest. `acceptOrder`, `rejectOrder` wrap it.
- `refundOrder(app, actor, { orderId, amountCents?, reason, idempotencyKey })` — app-level, manager. Refuses (`invalid`) an order paid by cash or bank: the refund is given the same way, at the till.
- `clearOrderAttention(ctx, orderId)` — manager.

Didn't finish (`unfinished.ts`; host, front of house, managers via `requireStaff({ minRole: 'host', anyOf: GUEST_FACING_ROLES })`):
- `listUnfinishedOrders(ctx, { venueId, limit? })` — abandoned, not purged, newest first; recovered ones included (they carry the badge).
- `checkNudge(ctx, orderId)` — the checks without sending (the tool asks with it): on the list, not nudged, not recovered, has a contact.
- `nudgeUnfinishedOrder(ctx, { orderId })` → `{ order, via, status, reason? }` — one transactional `order.nudge` (email, else SMS), key `order:<id>:nudge`; `resume_line` points at the order's pay page while it is `pending_payment`, else at the venue's order page (`orderPageUrl`). Records `nudge_sent_at`, `nudge_message_id`, `nudge_status` (`queued` | `suppressed:<reason>`); audits `order.nudge_sent`; tracks `order.nudged`. A second nudge is `conflict`, whoever asks. No consent is read or written; the outbox's bounced/complained suppressions stand (an unsubscribe does not stop it: transactional).
- In `orders.ts`: `detectAbandonedOrderJob` (marks `abandoned_at`, tracks `order.abandoned`, and recovers at once if a later order by the same guest is already paid); `markRecoveredOrders(ctx, paidOrder)` (the order itself if unfinished, and earlier unfinished orders at the venue by the same `customer_id`, email or phone → `recovered_at`, `recovered_order_id`, event `order.recovered` with `by: same_order | new_order`). The expiry job sets `lapsed_at` when it cancels an unpaid order, so the check can tell a lapse from a guest's cancel.
- `purgeUnfinishedOrdersJob` / `purgeUnfinishedOrdersSchedule` — daily, per org with something to purge: three months after `abandoned_at`, never paid → name, contact, note, `customer_id` and item notes cleared, `purged_at` set, audited `order.unfinished_purged`, event `order.purged`. The row stays: `order_status_history` is append-only and offers or the ledger may point at the order.

Phone and function orders (`drafts.ts`; host, front of house, managers unless stated):
- `planDraftOrder(ctx, createDraftInput)` → `DraftPlan` — the checks and prices without the write. `createDraftInput`: `venueId`, `channel` pickup | dine-in-qr (+ `tableLabel`), `lines[]` (`menuItemId`, `qty`, `modifierIds`, `note`), `customItems[]` (`name`, `priceCents`, `qty`, `note`; **manager only**, `forbidden` otherwise), `customer` (`name` required, `email?`, `phone?`), `note`, `wantedAt` (ISO; the pickup time or the function's date and time), `holdUntil` (ISO; at most a day after `wantedAt`). Menu lines are priced from `getOrderableItems` at the wanted time on the order's channel (`pickup`, or `qr` for a table); an 86'd item is `invalid` (add it as a custom item), `exclude_alcohol` applies to pickup, required choices are enforced; no slot, minimum or booking window. The surcharges for the wanted day (else today) are added as on every bill (`surcharges`, `surchargeCents`); **no automatic offer** is applied to a staff-built order. Tax from the org. A client-supplied price on a menu line is dropped by the schema.
- `createDraftOrder(ctx, input)` → `OrderView` — status `draft`, `payment_status` unpaid, `source` phone, `promised_at` = wanted time, `hold_until`, a tracking token, `idempotency_key` `draft:<uuid>`; resolves the customer (`via: 'phone-order'`); history row; status handlers; audit `order.draft_created`; event `order.drafted`.
- `checkPayLink(ctx, orderId)` → `{ order, until }`; `sendPayLink(ctx, { orderId })` → `PayLinkResult { order, payUrl, via, status, until }` — needs a contact, a total above zero, a payment connection, and a hold or wanted time still ahead. A draft moves to `pending_payment` and `ordering.expire_unpaid` is booked for `until` (= `hold_until` ?? `promised_at` ?? 30 days); `order.pay_link` is sent with the tracking URL; `pay_link_sent_at` set; audit `order.pay_link_sent`; event `order.pay_link_sent`. Sending again sends again (key carries the time). The guest pays the **whole** amount with `payOrder` by tracking token.
- `checkMarkPaid(ctx, orderId)`; `markDraftPaid(ctx, { orderId, method: cash | bank | other, reason })` — **manager**. Inserts a `payments` row with provider `manual` (`MANUAL_PROVIDER`, key `pay:<id>:manual`, `external_ref` `manual:<id>`), sets `orders.paid_by`, then `settlePayment` exactly as a card: ledger (tender = the method), ticket, confirmation, placed (and accepted if `auto_accept`), recovery marks; no POS push. Audit `order.marked_paid` with the reason; event `order.marked_paid`. Twice is `conflict`.
- `cancelDraftOrder(ctx, { orderId, reason })` — draft → cancelled, audit `order.draft_cancelled`; no message (nothing was charged).
- `expireDraftsJob` / `expireDraftsSchedule` — daily, per org with a draft: `status = draft` and `updated_at` over 365 days → cancelled "Not used for a year.", audit `order.draft_expired`, event `order.draft_expired`.
- **Deposits are not built.** `payOrder` charges `total_cents` once and `settlePayment` flips the order to paid, writes the sale and the kitchen docket in the same step. "Deposit now, balance on the day" would need a partial-payment state on the order (`payment_status` has none), two charges under two keys, a ledger row that is not yet a sale, a docket that waits, and refund rules for each half. None of that is a clean extension of the current path, so the pay link is for the full amount; a venue taking a deposit records it outside the order and marks the order paid when the balance arrives.

Kitchen screen (`requireDevice(ctx, venueId, 'kitchen')`):
- `listLiveTickets(ctx, { venueId?, keepBumpedMinutes? })`, `recordTicketEvent(ctx, input)`, `recordTicketEvents(ctx, { events })` — screen events `SCREEN_EVENTS` = viewed, acknowledged, ready, bumped, recalled; idempotent per `key`; ticket state is the fold of `ticket_events`. `TicketView.bill` is the order's `TotalsLine[]` (the screen prints the offers and surcharges at the foot of the card, with the notice); `chargesText(order)` is the same for the kitchen email docket (`charges_line`). A ticket is created at payment, whatever the wanted time: a function order paid weeks ahead is on the screen from then, with `target_ready_at` = the wanted time (known gap).

Other modules (delivery, qr):
- Internal callers only: `completeOrderByCourier`, `cancelUndeliverableOrder`, `refundForDelivery`, `switchOrderToPickup`, `flagOrderForStaff`.
- `getOrderForFulfilment(ctx, orderId)` — internal, or staff `read_only`. `orderAmounts(ctx, orderId)` — no role check, nothing personal.
- `tableSessionTotals(ctx, sessionIds)` — for qr; limited to venues the caller can see.
- `orderPushMode(app, conn)` — `before_payment | after_payment | none` from the POS adapter.

## Hooks

Defined in `contract.ts` (types and registries only; ordering never imports the modules that plug in, with one documented exception: `bill.ts` calls the offers module for automatic offers, code combinability and surcharges, which are part of every total rather than a code a guest types):
- `registerCheckoutAdjuster({ key, quote, commit, release? })` — codes at checkout. Registered by `loyalty/hooks.ts` and `offers/hooks.ts`. `commit` runs after payment under a savepoint; a refused commit means the venue absorbs the discount and the order is flagged. The offers adjuster's `commit` also records an automatic offer's use (`ref.auto === '1'`).
- `onOrderStatusChanged(handler)` — same transaction as every status change (a draft's creation included: `{ from: null, to: 'draft' }`). Registered by `delivery/dispatch.ts` and `loyalty/hooks.ts` (`enrolFromCheckout`).
- `registerDeliveryPricing({ getQuote, attachToOrder })` — slot; registered by `delivery/quote.ts`.
- `registerTableOrdering({ resolveForOrder, openSession })` — slot; registered by `qr/resolve.ts`.

Registers elsewhere (`hooks.ts`): `identity.onCustomerMerge`, `identity.onCustomerErase` (clears name, contact, notes, session on orders, item notes, ticket guest name/notes), `identity.registerCustomerDataProvider('orders', ...)`.

## Config surface (`orderingConfig`, per venue)

- `pickup_enabled`, `asap_enabled`.
- Pacing: `slot_minutes`, `max_orders_per_slot`, `max_items_per_slot` (null = no cap), `lead_time_minutes`, `cutoff_before_close_minutes`, `max_days_ahead`.
- Tips: `tipping_enabled`, `tip_presets`, `max_tip_percent`.
- `min_order_cents`, `exclude_alcohol` (pickup and delivery, and pickup drafts), `promo_codes_enabled`.
- Kitchen: `kitchen_routing` (`screen | email | sms`), `kitchen_email`, `manager_sms`, `alert_repeat_seconds`, `auto_accept`, `screen_can_reject`.
- `payment_hold_minutes` — how long an unpaid order holds its slot.
- `abandoned_after_minutes` (default 10) — when an unpaid checkout with a contact counts as "didn't finish".

No org-level settings namespace.

## Jobs, schedules, events, templates, tools

- Jobs: `ordering.expire_unpaid`, `ordering.detect_abandoned`, `ordering.pos_push`, `ordering.refund`, `ordering.reconcile_payments`, `ordering.purge_unfinished`, `ordering.expire_drafts`. Schedules: `ordering.reconcile_payments` every 5 minutes (orgs with a pending payment or refund; `PAYMENT_SETTLE_MINUTES` = 2); `ordering.purge_unfinished` and `ordering.expire_drafts` daily, org scope, only orgs with something to do.
- Events: `cart.item_added`, `cart.item_removed`, `checkout.started` (client), `order.placed`, `payment.failed`, `order.paid`, `order.accepted`, `order.preparing`, `order.ready`, `order.completed`, `order.recalled`, `order.rejected`, `order.cancelled`, `order.refunded`, `ticket.acknowledged`, `order.pushed_to_pos`, `order.flagged`, `payment.reconciled`, `order.abandoned`, `order.nudged`, `order.recovered`, `order.purged`, `order.drafted`, `order.pay_link_sent`, `order.marked_paid`, `order.draft_expired`.
- Templates (email + sms each, transactional): `order.confirmed`, `order.ready`, `order.cancelled`, `order.refunded`, `order.kitchen_new` (with `charges_line`: the offers and surcharges on the order and each surcharge's notice), `order.nudge`, `order.pay_link`.
- Tools: `orders_list` (read, `orders:read`; `show`: waiting · live · recent · unfinished · drafts; `came_from`; rows carry kitchen/money/leaves/came_from words, `unfinished { since, nudge, recovered }`, `hold_until`, `pay_link_sent_at`), `order_decide` (write, sensitive, `orders:write`, `minRole: 'kitchen'`), `order_nudge` (write, sensitive, `minRole: 'host'`), `order_draft_create` (write, `minRole: 'host'`; the custom item needs a manager behind the key), `order_pay_link_send` (write, sensitive, `minRole: 'host'`), `order_mark_paid` (write, sensitive, `minRole: 'manager'`). Each write is propose (nothing changes) then commit; questions name the order by reference, total and kind.
- Audit actions: `order.rejected`, `order.cancelled`, `order.refund_requested`, `order.refunded`, `order.discount_absorbed`, `order.offer_applied` (each adjustment committed at payment: `code`, `label`, `amountCents`, `automatic`, `offerId`, `transactionId`), `order.attention_cleared`, `order.switched_to_pickup`, `order.nudge_sent`, `order.unfinished_purged`, `order.draft_created`, `order.pay_link_sent`, `order.marked_paid`, `order.draft_cancelled`, `order.draft_expired`. Words for each in `apps/web/src/lib/console-activity-words.ts` (`order.offer_applied` has none yet and falls back to the plain reading; the event `offer.applied` has its words).

## Simulated vs real

- Ports: `payment` (createPayment, lookupPayment, refund, getRefund, clientConfig) and `pos` (pushOrder, `capabilities.orderPush`), chosen per venue connection.
- Real: `packages/adapters/src/square` implements both (POS `orderPush: 'before_payment'`). Its payment lookup and refund-status paths are tested only against stubbed payloads ("unverified live", no credentials).
- Simulators: `sim/payment.ts`, `sim/pos.ts` (push mode switchable in tests).
- Messages go through comms; no direct messaging port here. A manual payment (`provider = 'manual'`) touches no provider.

## Tests

- `packages/modules/test/commerce/`, `commerce-2/` (checkout, payments, delivery, refunds).
- `packages/modules/test/orders-depth/`: `axes.test.ts` (every status combination; filters), `unfinished.test.ts` (threshold and not before; the one nudge, transactional, no consent row, suppression; Recovered both ways; purge; roles; the tools), `drafts.test.ts` (server pricing; custom item only for managers; the pay link paying through `payOrder`; mark paid with the ledger tender; cancel; the yearly expiry; the tools), `bill.test.ts` (delivery and pickup price lists; hidden from Pickup; an automatic offer as a line, one use with the sale, audited, not two on replay; code combinability both ways and the offer's own rules; per-guest limit per guest; a Sunday surcharge on the quote, the order, the docket, the receipt, a phone order and a Sunday slot ordered on Saturday, not on Monday or Tuesday, and none with offers off; a tampered client total ignored; quote and final total agreeing, and differing when an offer ended). Browser: `tests/e2e/63-console-orders-depth.e2e.ts`, `67-site-order-offers.e2e.ts`.

## Known gaps

- An order whose payment stays unconfirmed is re-checked every 10 minutes up to 12 rounds, then the payment is marked `failed` / `unconfirmed` and the order cancelled; reconciliation can still find the charge and refund it.
- Deposits (see above). Editing an open order. A kitchen docket for a function order appears at payment, not nearer the day.
- The console's hand-built order form picks only items with no required choice; items that need a choice are added by the assistant (`order_draft_create` takes `option_ids`) or as a custom item.
- Recovery matches a later paid order by the same `customer_id`, email or phone at the same venue; a guest who orders again at another venue of the organisation is not counted as recovered.
- The bill: a staff-built phone or function order carries its day's surcharge but no automatic offer. The ledger's `CanonicalTransaction` has no surcharge field (the sale's total includes it; `subtotal_cents` is the food, as with the delivery fee). A "free delivery" automatic offer counts among the discounts the surcharge comes after. An automatic offer that ends between checkout and payment is honoured at the price shown, as a code is (its use is still recorded). A code typed after a loyalty reward is checked against it; a reward typed after a code is not (loyalty has no combinability rule).
