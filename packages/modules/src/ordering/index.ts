/**
 * Online ordering: what the web app, the console, the kitchen screen and other modules call.
 * Everything here makes its own checks. The pieces these are built from (status transitions
 * with no role check, row loaders, slot maths) stay inside the module's own files.
 */
export * from './module';
export * from './contract';
export * from './templates';
export * from './tools';

export { type CartInput, type CartIssue, type CartIssueCode, type PricedCart, type PricedLine, type PricedModifier, cartInput, cartLineInput, priceCart } from './pricing';
export { type SlotBoard, type Timing, getPickupSlots, slotsInput } from './slots';
export {
  type OrderItemView,
  type OrderView,
  type TrackedOrder,
  createOrder,
  createOrderInput,
  expireUnpaidOrderJob,
  getOrder,
  listOrders,
  listOrdersInput,
  listMyOrders,
  myOrdersInput,
  type MyOrder,
  tableSessionTotals,
  trackOrder,
} from './orders';
export {
  type TicketBoard,
  type TicketView,
  SCREEN_EVENTS,
  listLiveTickets,
  liveTicketsInput,
  recordTicketEvent,
  recordTicketEvents,
  ticketEventInput,
  ticketEventsInput,
} from './tickets';
export {
  type Actor,
  type CheckoutOptions,
  type PayResult,
  type RefundResult,
  getCheckoutOptions,
  payInput,
  payOrder,
  PAYMENT_SETTLE_MINUTES,
  type ReconcileResult,
  orderPushMode,
  pushOrderToPosJob,
  reconcilePayments,
  reconcilePaymentsJob,
  reconcilePaymentsSchedule,
  refundInput,
  refundOrder,
  refundOrderJob,
} from './payment';
export {
  type FulfilmentOrder,
  cancelUndeliverableOrder,
  clearOrderAttention,
  completeOrderByCourier,
  flagOrderForStaff,
  getOrderForFulfilment,
  orderAmounts,
  orderByTrackingToken,
  refundForDelivery,
  switchOrderToPickup,
} from './fulfilment';
export { acceptOrder, cancelUnpaidOrder, orderStatusInput, rejectOrder, updateOrderStatus } from './status';
export { type OrderRefundView, listOrderRefunds } from './refund-list';
import './hooks';
