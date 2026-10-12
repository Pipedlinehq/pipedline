'use server';

import { headers } from 'next/headers';
import { ordering, qr } from '@ros/modules';
import { act, actApp, bulkAct, cents, int, optText, text } from '@/lib/console-actions';
import { getStaffSession } from '@/lib/staff';
import { app } from '@/lib/runtime';
import { money } from '@/ui/format';
import type { FormState } from '@/ui/client';

const STEP_WORDS: Record<string, string> = { accepted: 'accepted', preparing: 'marked as preparing', ready: 'marked ready', completed: 'completed' };

/** Move an order along (accept, preparing, ready, completed). The service checks the role and the order's venue. */
export async function advanceOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  const status = text(fd, 'status') as 'accepted' | 'preparing' | 'ready' | 'completed';
  return act((ctx) => ordering.updateOrderStatus(ctx, { orderId, status }), {
    success: (o) => `Order ${o.reference} ${STEP_WORDS[status] ?? 'updated'}.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}

/** Reject a new order or cancel one under way. A paid order is refunded in full by the service. */
export async function stopOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  const status = text(fd, 'status') === 'rejected' ? 'rejected' : 'cancelled';
  const reason = text(fd, 'reason');
  return act((ctx) => ordering.updateOrderStatus(ctx, { orderId, status, reason }), {
    success: (o) => `Order ${o.reference} ${status}. The guest has been told why${o.paymentStatus === 'paid' || o.refundedCents > 0 ? ' and their payment is being refunded' : ''}.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}

/** Give money back through the processor. App-level: the service opens its own transactions around the provider call. */
export async function refund(_prev: FormState, fd: FormData): Promise<FormState> {
  const session = await getStaffSession();
  const h = await headers();
  const orderId = text(fd, 'orderId');
  const amount = cents(fd, 'amount');
  if (amount !== undefined && !(amount > 0)) return { ok: false, error: 'Enter the amount in dollars, like 12.50, or leave it empty to refund everything left.' };
  const reason = text(fd, 'reason');
  const idempotencyKey = text(fd, 'idempotencyKey');
  return actApp(
    () =>
      ordering.refundOrder(
        app(),
        { orgId: session.orgId, principal: session.principal, ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() },
        { orderId, reason, idempotencyKey, ...(amount !== undefined ? { amountCents: amount } : {}) },
      ),
    {
      success: (r) =>
        r.status === 'completed'
          ? `Refunded ${money(r.amountCents, r.order.currency)}${r.full ? ': the order is now refunded in full' : ''}.`
          : r.status === 'pending'
            ? `The refund of ${money(r.amountCents, r.order.currency)} is with the card processor; it will show here when it confirms.`
            : r.status === 'nothing_to_refund'
              ? 'There is nothing left to refund on this order.'
              : 'The card processor refused the refund. Nothing was taken back; try again or refund at the terminal.',
      revalidate: ['/console/orders', `/console/orders/${orderId}`],
    },
  );
}

/** Close a table's session when the guests leave, so the next party starts fresh. */
export async function closeTable(_prev: FormState, fd: FormData): Promise<FormState> {
  const sessionId = text(fd, 'sessionId');
  const covers = int(fd, 'covers');
  const label = optText(fd, 'label') ?? 'The table';
  if (covers !== undefined && !(covers >= 1)) return { ok: false, error: 'Covers must be a whole number of guests, or left empty.' };
  return act((ctx) => qr.closeTableSession(ctx, { sessionId, ...(covers ? { covers } : {}) }), {
    success: `${label} is closed. The next scan starts a new session.`,
    revalidate: '/console/orders',
  });
}

/** A manager has dealt with an order that was flagged for staff. The flag's words stay on the audit log. */
export async function clearAttention(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  const reference = optText(fd, 'reference') ?? 'The order';
  const r = await act((ctx) => ordering.clearOrderAttention(ctx, orderId), {
    success: `${reference} is marked as dealt with.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
  return r.ok ? { ok: true, message: r.message } : r;
}

const BULK_STATUS = new Set(['accepted', 'preparing', 'ready', 'completed', 'cancelled', 'rejected']);
const BULK_WORDS: Record<string, (n: number) => string> = {
  accepted: (n) => `${n} ${n === 1 ? 'order' : 'orders'} accepted.`,
  preparing: (n) => `${n} ${n === 1 ? 'order' : 'orders'} marked as preparing.`,
  ready: (n) => `${n} ${n === 1 ? 'order' : 'orders'} marked ready.`,
  completed: (n) => `${n} ${n === 1 ? 'order' : 'orders'} completed.`,
  cancelled: (n) => `${n} ${n === 1 ? 'order' : 'orders'} cancelled. The guests have been told${n === 1 ? '' : ''}; paid orders are being refunded.`,
  rejected: (n) => `${n} ${n === 1 ? 'order' : 'orders'} rejected and refunded.`,
};

/**
 * The bulk bar's action (docs/CONSOLE_IA.md section 9, wave 1): the same status change as the
 * row button, once per selected order, each in its own transaction so one refusal (a paid order
 * a host may not cancel, an order already further along) leaves the rest done and is named.
 */
export async function bulkOrders(_prev: FormState, fd: FormData): Promise<FormState> {
  const status = text(fd, 'action');
  if (!BULK_STATUS.has(status)) return { ok: false, error: 'That is not something that can be done to orders in bulk.' };
  const reason = text(fd, 'reason');
  if ((status === 'cancelled' || status === 'rejected') && reason.length < 3) return { ok: false, error: 'Say why: the guests are told this.' };
  return bulkAct(fd, (ctx, _c, orderId) => ordering.updateOrderStatus(ctx, { orderId, status: status as 'accepted', ...(reason ? { reason } : {}) }), {
    done: BULK_WORDS[status]!,
    revalidate: '/console/orders',
  });
}
