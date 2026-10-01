import { type Ctx, hookList, keyedRegistry, register, slot } from '@ros/core';

/**
 * How other modules take part in an order without the ordering module knowing about them.
 * This file is the contract between ordering and loyalty, offers and delivery; it holds types
 * and registries only. Ordering calls what is registered; it never imports those modules.
 */

export interface DraftLine {
  menuItemId: string;
  name: string;
  category: string | null;
  qty: number;
  /** Item price plus chosen modifiers, per unit. */
  unitPriceCents: number;
  lineTotalCents: number;
  isAlcohol: boolean;
}

/** An order being priced, before anything is saved or charged. Prices are the server's own. */
export interface DraftOrder {
  venueId: string;
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  customerId: string | null;
  lines: DraftLine[];
  subtotalCents: number;
  at: Date;
}

/** A discount one code produces on one order. */
export interface Adjustment {
  /** The adjuster that produced it. */
  adjuster: string;
  code: string;
  /** What the guest and the receipt see, e.g. "Welcome offer: $10 off". */
  label: string;
  /** Positive cents off the subtotal. Never more than the subtotal. */
  amountCents: number;
  /** What the adjuster needs to commit or release later. Stored with the order. */
  ref: Record<string, string>;
}

export interface CheckoutAdjuster {
  key: string;
  /**
   * Price the discount a code gives on this draft. Changes nothing.
   *   - return null when the code is not one of yours
   *   - throw AppError('invalid', <plain words>) when it is yours but cannot be used here
   */
  quote(ctx: Ctx, draft: DraftOrder, code: string): Promise<Adjustment | null>;
  /**
   * The order has been paid. Mark the code used, in the same transaction. Idempotent: it is
   * called again if the payment confirmation is replayed.
   */
  commit(ctx: Ctx, args: { orderId: string; venueId: string; customerId: string | null; transactionId: string | null; adjustment: Adjustment }): Promise<void>;
  /** A paid order was cancelled or fully refunded: give the code back. Idempotent. */
  release?(ctx: Ctx, args: { orderId: string; adjustment: Adjustment }): Promise<void>;
}

const adjusters = keyedRegistry<CheckoutAdjuster>('ordering.adjusters');

export function registerCheckoutAdjuster(adjuster: CheckoutAdjuster): void {
  register(adjusters, adjuster.key, adjuster, 'Checkout adjuster');
}

export function checkoutAdjusters(): CheckoutAdjuster[] {
  return [...adjusters.values()];
}

export function getCheckoutAdjuster(key: string): CheckoutAdjuster | undefined {
  return adjusters.get(key);
}

export type OrderStatus =
  | 'draft'
  | 'pending_payment'
  | 'placed'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'completed'
  | 'rejected'
  | 'cancelled'
  | 'refunded';

export interface OrderSnapshot {
  id: string;
  venueId: string;
  customerId: string | null;
  reference: string;
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  status: OrderStatus;
  totalCents: number;
  subtotalCents: number;
  promisedAt: Date | null;
  transactionId: string | null;
  sessionId: string | null;
  /**
   * Choices the guest made at checkout that another module acts on, e.g. 'loyalty_join'.
   * Ordering stores and passes them on; it does not interpret them.
   */
  flags: string[];
}

type StatusHandler = (ctx: Ctx, order: OrderSnapshot, change: { from: OrderStatus | null; to: OrderStatus }) => Promise<void>;
const statusHandlers = hookList<StatusHandler>('ordering.statusHandlers');

/**
 * Runs in the same transaction as every order status change. Delivery requests a courier when
 * an order is accepted; other modules react here rather than reading the orders table.
 * Handlers must be idempotent and must not call a provider (enqueue a job instead).
 */
export function onOrderStatusChanged(handler: StatusHandler): void {
  statusHandlers.add(handler);
}

export function orderStatusHandlers(): StatusHandler[] {
  return statusHandlers.all();
}

/**
 * Delivery's side of checkout. A courier quote is fetched before checkout (a provider call,
 * outside any transaction) and saved by the delivery module; ordering then asks for its price
 * and attaches it to the order it creates.
 */
export interface DeliveryPricing {
  /**
   * The saved quote, or null when it is unknown, used, or for another venue. The fee is worked
   * out here from the cart the server priced (`subtotalCents`), never from the browser. `issue`
   * is plain words for a guest-fixable reason the cart cannot be delivered (below the minimum,
   * alcohol not delivered here); an expired quote is answered with its `expiresAt`.
   */
  getQuote(
    ctx: Ctx,
    args: { deliveryId: string; venueId: string; subtotalCents?: number; containsAlcohol?: boolean },
  ): Promise<{ customerFeeCents: number; expiresAt: Date; dropoffEta: Date | null; issue?: string | null } | null>;
  /** Tie the quoted delivery to the order being created, in the same transaction. */
  attachToOrder(ctx: Ctx, args: { deliveryId: string; orderId: string }): Promise<void>;
}

const deliveryPricing = slot<DeliveryPricing>('ordering.deliveryPricing');

export function registerDeliveryPricing(impl: DeliveryPricing): void {
  deliveryPricing.set(impl);
}

export function getDeliveryPricing(): DeliveryPricing | null {
  return deliveryPricing.get();
}

/**
 * The table's side of a QR order. The qr module owns the codes and the table sessions; ordering
 * asks it what a scanned code means and never reads those tables. The code comes from the
 * guest's phone, so everything about the table is looked up here, server-side.
 */
export interface TableContext {
  qrCodeId: string;
  /** The venue's own name for the table, e.g. "12" or "Bar". Null for a code with no table. */
  tableLabel: string | null;
  /** The venue keeps alcohol out of QR ordering: staff bring the drink and make the call. */
  excludeAlcohol: boolean;
  tippingEnabled: boolean;
  tipPresets: number[];
}

export interface TableOrdering {
  /**
   * What this code allows at this venue. Throws not-found when the code is unknown, inactive,
   * another venue's or another org's, or when QR ordering is not switched on there.
   */
  resolveForOrder(ctx: Ctx, args: { venueId: string; code: string }): Promise<TableContext>;
  /** The table's open session, opened if there is none. Rounds at one table share it. Same transaction as the order. */
  openSession(ctx: Ctx, args: { venueId: string; qrCodeId: string; tableLabel: string }): Promise<string>;
}

const tableOrdering = slot<TableOrdering>('ordering.tableOrdering');

export function registerTableOrdering(impl: TableOrdering): void {
  tableOrdering.set(impl);
}

export function getTableOrdering(): TableOrdering | null {
  return tableOrdering.get();
}
