# ordering — module guide

> Written on 2026-10-01 from an in-progress state: another session was editing this module
> while this was read (files touched that morning: `payment.ts`, `orders.ts`, `contract.ts`,
> `status.ts`, `pricing.ts`, `fulfilment.ts`, `module.ts`, `index.ts`). Check names against
> `index.ts` before relying on them.

## What it owns

Pickup, delivery and table (QR) orders: server-side cart pricing, slot pacing, checkout,
card payment, status, refunds, the kitchen order screen, and pushing orders to a venue POS.

- Tables (`orderingModule.tables`): `orders`, `order_items`, `order_status_history`, `payments`, `refunds`, `kitchen_tickets`, `ticket_events`.
- Toggleable (key `ordering`). `dependsOn: []`.
- Uses: `menu` (`getOrderableItems`, `menuItemRef`), `ledger` (`recordTransaction`), `identity` (`resolveCustomer`, `grantConsent`), `comms` (`queueMessage`, `defineTemplate`), `events` (`trackInSession`), `tenancy`, connections (`findConnectionFor`, `adapterFor`). The POS push planner reads `menu_items.pos_catalog_id` directly.

## Public functions by purpose

Guest-facing / public (no role check unless stated; org from the host):
- `priceCart(ctx, cartInput)` — prices from the server; guest-fixable problems come back as `issues` (`CartIssueCode`) and rejected codes.
- `getPickupSlots(ctx, { venueId, date?, itemCount?, prepMinutes? })` — ASAP estimate plus slots with room.
- `createOrder(ctx, createOrderInput)` — anon or guest; staff must be `kitchen`+; a device is forbidden. Idempotent on `idempotencyKey`, rate-limited, holds the slot as `pending_payment`, resolves the customer, records ticked consents, stores `flags`, enqueues `ordering.expire_unpaid` at `payment_hold_minutes`. Nothing charged, nothing sent to the kitchen.
- `getCheckoutOptions(app, actor, venueId)` — app-level; processor client config, toggles, consent wordings.
- `payOrder(app, actor, { trackingToken | orderId, sourceToken? })` — app-level, three steps (mark; charge through `once` kind `payment`; settle). Token holder, the guest who owns the order, or staff `kitchen`+. Settling writes the ledger row, the kitchen ticket, the confirmation, commits adjusters, runs status handlers, enqueues a POS push.
- `trackOrder(ctx, token)`, `cancelUnpaidOrder(ctx, token)` — holding the tracking token is the permission.
- `orderByTrackingToken(ctx, token)` — `{ orderId, venueId, channel }`.

Console:
- `getOrder(ctx, orderId)`, `listOrders(ctx, listOrdersInput)` — `read_only`.
- `updateOrderStatus(ctx, { orderId, status, reason? })` — `requireDevice(.., 'kitchen')` (paired screen or staff `kitchen`+); cancelling a paid order needs a manager. Reject/cancel needs a reason, enqueues `ordering.refund` if paid, notifies the guest. `acceptOrder`, `rejectOrder` wrap it.
- `refundOrder(app, actor, { orderId, amountCents?, reason, idempotencyKey })` — app-level, manager.
- `clearOrderAttention(ctx, orderId)` — manager.

Kitchen screen (`requireDevice(ctx, venueId, 'kitchen')`):
- `listLiveTickets(ctx, { venueId?, keepBumpedMinutes? })`, `recordTicketEvent(ctx, input)`, `recordTicketEvents(ctx, { events })` — screen events `SCREEN_EVENTS` = viewed, acknowledged, ready, bumped, recalled; idempotent per `key`; ticket state is the fold of `ticket_events`.

Other modules (delivery, qr):
- Internal callers only: `completeOrderByCourier`, `cancelUndeliverableOrder`, `refundForDelivery`, `switchOrderToPickup`, `flagOrderForStaff`.
- `getOrderForFulfilment(ctx, orderId)` — internal, or staff `read_only`. `orderAmounts(ctx, orderId)` — no role check, nothing personal.
- `tableSessionTotals(ctx, sessionIds)` — for qr; limited to venues the caller can see.
- `orderPushMode(app, conn)` — `before_payment | after_payment | none` from the POS adapter.

## Hooks

Defined in `contract.ts` (types and registries only; ordering never imports the modules that plug in):
- `registerCheckoutAdjuster({ key, quote, commit, release? })` — codes at checkout. Registered by `loyalty/hooks.ts` and `offers/hooks.ts`. `commit` runs after payment under a savepoint; a refused commit means the venue absorbs the discount and the order is flagged.
- `onOrderStatusChanged(handler)` — same transaction as every status change. Registered by `delivery/dispatch.ts` and `loyalty/hooks.ts` (`enrolFromCheckout`).
- `registerDeliveryPricing({ getQuote, attachToOrder })` — slot; registered by `delivery/quote.ts`.
- `registerTableOrdering({ resolveForOrder, openSession })` — slot; registered by `qr/resolve.ts`.

Registers elsewhere (`hooks.ts`): `identity.onCustomerMerge`, `identity.onCustomerErase` (clears name, contact, notes, session on orders, item notes, ticket guest name/notes), `identity.registerCustomerDataProvider('orders', ...)`.

## Config surface (`orderingConfig`, per venue)

- `pickup_enabled`, `asap_enabled`.
- Pacing: `slot_minutes`, `max_orders_per_slot`, `max_items_per_slot` (null = no cap), `lead_time_minutes`, `cutoff_before_close_minutes`, `max_days_ahead`.
- Tips: `tipping_enabled`, `tip_presets`, `max_tip_percent`.
- `min_order_cents`, `exclude_alcohol` (pickup and delivery), `promo_codes_enabled`.
- Kitchen: `kitchen_routing` (`screen | email | sms`), `kitchen_email`, `manager_sms`, `alert_repeat_seconds`, `auto_accept`, `screen_can_reject`.
- `payment_hold_minutes` — how long an unpaid order holds its slot.

No org-level settings namespace.

## Jobs, schedules, events, templates, tools

- Jobs: `ordering.expire_unpaid`, `ordering.pos_push`, `ordering.refund`, `ordering.reconcile_payments`. Schedule `ordering.reconcile_payments` every 5 minutes, org scope, only orgs with a pending payment or refund (`PAYMENT_SETTLE_MINUTES` = 2 before a pending payment is looked up).
- Events: `cart.item_added`, `cart.item_removed`, `checkout.started` (client), `order.placed`, `payment.failed`, `order.paid`, `order.accepted`, `order.preparing`, `order.ready`, `order.completed`, `order.recalled`, `order.rejected`, `order.cancelled`, `order.refunded`, `ticket.acknowledged`, `order.pushed_to_pos`, `order.flagged`, `payment.reconciled`.
- Templates (email + sms each, transactional): `order.confirmed`, `order.ready`, `order.cancelled`, `order.refunded`, `order.kitchen_new`.
- Tools: `orders_list` (read, `orders:read`), `order_decide` (write, sensitive, `orders:write`, `minRole: 'kitchen'`, accept or reject a `placed` order).

## Simulated vs real

- Ports: `payment` (createPayment, lookupPayment, refund, getRefund, clientConfig) and `pos` (pushOrder, `capabilities.orderPush`), chosen per venue connection.
- Real: `packages/adapters/src/square` implements both (POS `orderPush: 'before_payment'`). Its payment lookup and refund-status paths are tested only against stubbed payloads ("unverified live", no credentials).
- Simulators: `sim/payment.ts`, `sim/pos.ts` (push mode switchable in tests).
- Messages go through comms; no direct messaging port here.

## Known gaps

- Under active change at the time of writing (see the note at the top).
- An order whose payment stays unconfirmed is re-checked every 10 minutes up to 12 rounds, then the payment is marked `failed` / `unconfirmed` and the order cancelled; reconciliation can still find the charge and refund it.
