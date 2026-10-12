import type { OrderStatus } from './contract';

/**
 * The three independent status axes of an order (docs/COMMERCE_ADMIN_PATTERNS.md section 2.2,
 * pattern 2), each derived from columns the order already has, plus where it came from. They are
 * never fused into one field: a docket needs what the kitchen is doing, what the money is doing
 * and how the food leaves, and each is a badge and a filter of its own.
 *
 *   kitchen   what the kitchen is doing with it
 *   money     what the guest's money is doing
 *   leaves    how the food leaves the kitchen
 *   source    where the order came from ("Came from")
 */

export type OrderChannel = 'pickup' | 'delivery' | 'dine-in-qr';
export type OrderPaymentStatus = 'unpaid' | 'paid' | 'refunded' | 'partially_refunded' | 'failed';
export type OrderSource = 'website' | 'qr' | 'phone' | 'assistant' | 'square';

/** The kitchen axis. `none`: not yet with the kitchen (a draft or an unpaid checkout). `stopped`: taken off (rejected, cancelled, refunded). */
export type KitchenAxis = 'none' | 'new' | 'accepted' | 'cooking' | 'ready' | 'collected' | 'delivered' | 'served' | 'stopped';
/** The money axis. `due`: a phone or function order the guest has not paid yet. `voided`: never paid and never will be. */
export type MoneyAxis = 'unpaid' | 'due' | 'paid' | 'partly_refunded' | 'refunded' | 'voided';
export type LeavesAxis = 'pickup' | 'table' | 'delivery';

export const KITCHEN_AXES: KitchenAxis[] = ['none', 'new', 'accepted', 'cooking', 'ready', 'collected', 'delivered', 'served', 'stopped'];
export const MONEY_AXES: MoneyAxis[] = ['unpaid', 'due', 'paid', 'partly_refunded', 'refunded', 'voided'];
export const LEAVES_AXES: LeavesAxis[] = ['pickup', 'table', 'delivery'];
export const ORDER_SOURCES: OrderSource[] = ['website', 'qr', 'phone', 'assistant', 'square'];

export const KITCHEN_WORDS: Record<KitchenAxis, string> = {
  none: 'Not with the kitchen yet',
  new: 'New',
  accepted: 'Accepted',
  cooking: 'Cooking',
  ready: 'Ready',
  collected: 'Collected',
  delivered: 'Delivered',
  served: 'Served',
  stopped: 'Taken off',
};

export const MONEY_WORDS: Record<MoneyAxis, string> = {
  unpaid: 'Unpaid',
  due: 'Due',
  paid: 'Paid',
  partly_refunded: 'Partly refunded',
  refunded: 'Refunded',
  voided: 'Voided',
};

export const LEAVES_WORDS: Record<LeavesAxis, string> = { pickup: 'Pickup', table: 'Table', delivery: 'Delivery' };

export const SOURCE_WORDS: Record<OrderSource, string> = {
  website: 'Website',
  qr: 'QR',
  phone: 'Phone',
  assistant: 'Inside assistants',
  square: 'Square',
};

export interface AxisInput {
  status: OrderStatus;
  payment_status: OrderPaymentStatus;
  channel: OrderChannel;
  source: OrderSource;
}

export interface OrderAxes {
  kitchen: KitchenAxis;
  money: MoneyAxis;
  leaves: LeavesAxis;
  source: OrderSource;
}

export const leavesOf = (channel: OrderChannel): LeavesAxis => (channel === 'dine-in-qr' ? 'table' : channel);

/** The channel a "how it leaves" filter means. */
export const channelOf = (leaves: LeavesAxis): OrderChannel => (leaves === 'table' ? 'dine-in-qr' : leaves);

export function kitchenOf(o: Pick<AxisInput, 'status' | 'channel'>): KitchenAxis {
  switch (o.status) {
    case 'draft':
    case 'pending_payment':
      return 'none';
    case 'placed':
      return 'new';
    case 'accepted':
      return 'accepted';
    case 'preparing':
      return 'cooking';
    case 'ready':
      return 'ready';
    case 'completed':
      return o.channel === 'delivery' ? 'delivered' : o.channel === 'dine-in-qr' ? 'served' : 'collected';
    default:
      return 'stopped';
  }
}

export function moneyOf(o: Pick<AxisInput, 'status' | 'payment_status' | 'source'>): MoneyAxis {
  switch (o.payment_status) {
    case 'paid':
      return 'paid';
    case 'partially_refunded':
      return 'partly_refunded';
    case 'refunded':
      return 'refunded';
    default:
      // Never paid. An order that will never be paid is voided; a phone or function order is due; the rest wait for a card.
      if (o.status === 'cancelled' || o.status === 'rejected' || o.status === 'refunded') return 'voided';
      return o.source === 'phone' ? 'due' : 'unpaid';
  }
}

export function axesOf(o: AxisInput): OrderAxes {
  return { kitchen: kitchenOf(o), money: moneyOf(o), leaves: leavesOf(o.channel), source: o.source };
}

/** The statuses a kitchen-axis filter means. `collected`, `delivered` and `served` are `completed` plus a channel (see `kitchenChannels`). */
export function kitchenStatuses(k: KitchenAxis): OrderStatus[] {
  switch (k) {
    case 'none':
      return ['draft', 'pending_payment'];
    case 'new':
      return ['placed'];
    case 'accepted':
      return ['accepted'];
    case 'cooking':
      return ['preparing'];
    case 'ready':
      return ['ready'];
    case 'collected':
    case 'delivered':
    case 'served':
      return ['completed'];
    default:
      return ['rejected', 'cancelled', 'refunded'];
  }
}

/** The channel a completed order must have for `collected`, `delivered` or `served`; null for the other kitchen axes. */
export function kitchenChannel(k: KitchenAxis): OrderChannel | null {
  return k === 'collected' ? 'pickup' : k === 'delivered' ? 'delivery' : k === 'served' ? 'dine-in-qr' : null;
}
