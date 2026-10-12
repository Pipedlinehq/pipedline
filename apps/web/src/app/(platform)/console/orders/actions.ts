'use server';

import { headers } from 'next/headers';
import { addDays, zonedTimeToUtc } from '@ros/core';
import { ordering, qr } from '@ros/modules';
import { act, actApp, bulkAct, cents, int, nullableText, optText, text } from '@/lib/console-actions';
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

// ── Didn't finish (docs/COMMERCE_ADMIN_PATTERNS.md pattern 7) ──────────────────

/** The one nudge about an order a guest did not finish. The service refuses a second. */
export async function nudgeOrder(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  return act((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId }), {
    success: (r) =>
      r.status === 'queued'
        ? `A nudge about order ${r.order.reference} is on its way by ${r.via === 'email' ? 'email' : 'text message'}. That is the only one the guest will get.`
        : `The nudge about order ${r.order.reference} was not sent: ${(r.reason ?? 'the address is blocked').replace(/_/g, ' ')}. It will not be tried again.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}

// ── Phone and function orders (pattern 10) ─────────────────────────────────────

/**
 * Build a phone or function order from the console form. Items come as parallel `itemId` and
 * `qty` fields (empty rows are skipped); a manager may add one custom item. Times are typed in
 * the venue's own zone. Prices are the server's: the form sends ids and quantities only, except
 * the custom item's agreed price, which the service lets only a manager set.
 */
export async function createDraft(_prev: FormState, fd: FormData): Promise<FormState> {
  const itemIds = fd.getAll('itemId').map((v) => (typeof v === 'string' ? v.trim() : ''));
  const qtys = fd.getAll('qty').map((v) => (typeof v === 'string' ? Number(v) : Number.NaN));
  const lines = itemIds.map((id, i) => ({ menuItemId: id, qty: Number.isFinite(qtys[i]) && qtys[i]! > 0 ? Math.trunc(qtys[i]!) : 1 })).filter((l) => l.menuItemId);
  const customName = optText(fd, 'customName');
  const customPrice = cents(fd, 'customPrice');
  if (customName && (customPrice === undefined || !(customPrice >= 0))) return { ok: false, error: 'Give the custom item a price in dollars, like 450.00.' };
  const customItems = customName ? [{ name: customName, priceCents: customPrice!, qty: int(fd, 'customQty') || 1 }] : [];
  const channel = text(fd, 'channel') === 'dine-in-qr' ? ('dine-in-qr' as const) : ('pickup' as const);
  return act(
    (ctx, c) => {
      const tz = c.venue.timezone;
      const wanted = optText(fd, 'wantedAt');
      const hold = optText(fd, 'holdUntil');
      const wantedAt = wanted ? localToIso(wanted, tz) : null;
      // A hold "until a day" means the whole of that day.
      const holdUntil = hold && /^\d{4}-\d{2}-\d{2}$/.test(hold) ? zonedTimeToUtc(addDays(hold, 1), '00:00', tz).toISOString() : null;
      return ordering.createDraftOrder(ctx, {
        venueId: c.venue.id,
        channel,
        tableLabel: nullableText(fd, 'tableLabel'),
        lines,
        customItems,
        customer: { name: text(fd, 'name'), email: nullableText(fd, 'email'), phone: nullableText(fd, 'phone') },
        note: nullableText(fd, 'note'),
        wantedAt,
        holdUntil,
      });
    },
    {
      success: (o) => `Order ${o.reference} built: ${money(o.totalCents, o.currency)}. Nothing is charged yet. ${o.customerEmail || o.customerPhone ? 'Send the guest a pay link, or mark it paid.' : 'No email or phone was given, so a manager will need to mark it paid.'}`,
      revalidate: '/console/orders',
    },
  );
}

/** "2026-10-10T18:30" as typed in the venue's zone, as an instant. Anything else is handed on as is for the service to refuse. */
function localToIso(value: string, tz: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  return m ? zonedTimeToUtc(m[1]!, m[2]!, tz).toISOString() : value;
}

/** Send (or send again) the link the guest pays the whole amount with, on the venue's own order page. */
export async function sendPayLink(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  return act((ctx) => ordering.sendPayLink(ctx, { orderId }), {
    success: (r) =>
      r.status === 'queued'
        ? `A pay link for order ${r.order.reference} is on its way by ${r.via === 'email' ? 'email' : 'text message'}. The guest pays ${money(r.order.totalCents, r.order.currency)} on the order page.`
        : `The pay link for order ${r.order.reference} could not be sent: the address is blocked. Read the link out instead: ${r.payUrl}`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}

/** A manager records a phone or function order paid by cash or bank. The service settles it as a sale. */
export async function markPaid(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  const method = text(fd, 'method');
  if (method !== 'cash' && method !== 'bank' && method !== 'other') return { ok: false, error: 'Say how it was paid: cash, bank transfer or other.' };
  const reason = text(fd, 'reason');
  return act((ctx) => ordering.markDraftPaid(ctx, { orderId, method, reason }), {
    success: (o) => `Order ${o.reference} marked paid by ${method === 'bank' ? 'bank transfer' : method}. It is in the sales record and with the kitchen.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}

/** Drop a phone or function order nobody paid. */
export async function cancelDraft(_prev: FormState, fd: FormData): Promise<FormState> {
  const orderId = text(fd, 'orderId');
  const reason = text(fd, 'reason');
  return act((ctx) => ordering.cancelDraftOrder(ctx, { orderId, reason }), {
    success: (o) => `Order ${o.reference} cancelled. Nothing was charged.`,
    revalidate: ['/console/orders', `/console/orders/${orderId}`],
  });
}
