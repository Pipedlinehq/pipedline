import { z } from 'zod';
import { type Ctx, assertModule, audit, conflict, enqueue, forbidden, invalid, requireDevice, requireStaff } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { orderingModule } from './module';
import { notifyGuest } from './notify';
import { type OrderView, getOrder, loadOrderByToken, ownOrderView, transition } from './orders';
import { refundOrderJob } from './payment';
import { type OrderRow, firstName, loadOrder } from './rows';
import { moveOrder } from './tickets';

export const orderStatusInput = z.object({
  orderId: z.string().uuid(),
  status: z.enum(['accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled']),
  /** Needed to reject or cancel. The guest is told it, so write it for them. */
  reason: z.string().trim().min(3).max(300).optional(),
});

const paid = (o: OrderRow) => o.payment_status === 'paid' || o.payment_status === 'partially_refunded';

/**
 * Move an order along from the console or the kitchen screen.
 *
 *   accepted, preparing, ready, completed, rejected   any staff at the venue, or its paired kitchen screen
 *   cancelled                                         a manager once the order is paid (it sends money back)
 *
 * Rejecting or cancelling a paid order refunds it in full through the processor, takes it off
 * the kitchen's screen and tells the guest why. Marking a pickup ready tells the guest.
 */
export async function updateOrderStatus(ctx: Ctx, raw: z.input<typeof orderStatusInput>): Promise<OrderView> {
  const input = orderStatusInput.parse(raw);
  const order = await loadOrder(ctx, input.orderId, { lock: true });
  const stopping = input.status === 'rejected' || input.status === 'cancelled';
  if (input.status === 'cancelled' && paid(order)) requireStaff(ctx, { venueId: order.venue_id, minRole: 'manager' });
  else requireDevice(ctx, order.venue_id, 'kitchen');
  const cfg = await assertModule(ctx, order.venue_id, orderingModule);
  // A venue may keep turning orders down to people signed in, not a screen anyone can tap.
  if (input.status === 'rejected' && ctx.principal.kind === 'device' && !cfg.screen_can_reject) throw forbidden('Only staff can turn an order down here. Ask a manager.');
  if (stopping && !input.reason) throw invalid('Say why, in a sentence the guest can read.');
  if (input.status === 'rejected' && order.status !== 'placed') throw conflict('Only a new order can be rejected. Cancel it instead.');
  if (order.status === 'pending_payment' && !stopping) throw conflict('This order has not been paid yet.');
  if (order.status === 'pending_payment') {
    const charging = await ctx.db.selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
    if (charging) throw conflict('A payment for this order is being confirmed. Try again in a moment.');
  }

  const wasPaid = paid(order);
  const moved = await moveOrder(ctx, order, input.status, { reason: input.reason ?? null });

  if (stopping) {
    await audit(ctx, {
      action: input.status === 'rejected' ? 'order.rejected' : 'order.cancelled',
      entityType: 'order',
      entityId: order.id,
      venueId: order.venue_id,
      before: { status: order.status },
      after: { status: moved.status, reason: input.reason, refunds: wasPaid },
    });
    if (wasPaid) {
      // The money goes back as a consequence of the decision; the worker sends it.
      await enqueue(ctx, refundOrderJob, { orderId: order.id, reason: input.reason!, key: `stop:${order.id}` }, { key: `refund:stop:${order.id}` });
    }
    const venue = await getVenue(ctx, order.venue_id);
    await notifyGuest(
      ctx,
      moved,
      'order.cancelled',
      {
        first_name: firstName(moved),
        venue_name: venue.name,
        reference: moved.reference,
        reason: input.reason!,
        refund_line: wasPaid ? 'Your payment is being refunded in full to the card you paid with.' : 'You have not been charged.',
      },
      'stopped',
    );
  }
  return getOrderAfter(ctx, moved);
}

/** Staff get the console view; a kitchen screen, which is not staff, gets the order without contact details. */
async function getOrderAfter(ctx: Ctx, order: OrderRow): Promise<OrderView> {
  if (ctx.principal.kind === 'device') {
    const v = await ownOrderView(ctx, order);
    return { ...v, customerEmail: null, customerPhone: null, trackingToken: null };
  }
  return getOrder(ctx, order.id);
}

export const acceptOrder = (ctx: Ctx, orderId: string): Promise<OrderView> => updateOrderStatus(ctx, { orderId, status: 'accepted' });
export const rejectOrder = (ctx: Ctx, orderId: string, reason: string): Promise<OrderView> => updateOrderStatus(ctx, { orderId, status: 'rejected', reason });

/**
 * The guest backs out before paying, by the token their browser holds. After payment the venue
 * decides, because food may already be on the grill.
 */
export async function cancelUnpaidOrder(ctx: Ctx, trackingToken: string): Promise<void> {
  const order = await loadOrderByToken(ctx, trackingToken, { lock: true });
  await assertModule(ctx, order.venue_id, orderingModule);
  if (order.status === 'cancelled') return;
  if (order.status !== 'pending_payment') throw conflict('This order has been paid. Contact the venue to change it.');
  const charging = await ctx.db.selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'pending').executeTakeFirst();
  if (charging) throw conflict('A payment for this order is being confirmed. Wait a moment.');
  await transition(ctx, order, 'cancelled', { reason: 'Cancelled by the guest before paying.' });
}
