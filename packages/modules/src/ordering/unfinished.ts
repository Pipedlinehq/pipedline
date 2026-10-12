import { z } from 'zod';
import { type Ctx, GUEST_FACING_ROLES, addMinutes, assertModule, audit, conflict, defineJob, defineSchedule, formatMoney, invalid, requireStaff, track } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { orderingModule, orderNudged, orderPurged } from './module';
import { notifyGuest, orderPageUrl, trackingUrl } from './notify';
import { type OrderView, getOrder, listOrders } from './orders';
import { firstName, itemSummary, loadItems, loadOrder } from './rows';

/**
 * "Didn't finish" (docs/COMMERCE_ADMIN_PATTERNS.md section 2.2, pattern 7): orders a guest
 * started, gave a contact for, and did not pay. Detection is the job in orders.ts
 * (`detectAbandonedOrderJob`), run once per order at the venue's threshold. Here: the list,
 * the one nudge, and the three-month purge.
 *
 * The nudge is transactional: one message about the guest's own order, no offer, no list, no
 * consent implied or recorded. The outbox still refuses an address that bounced or complained.
 * A second nudge is refused outright.
 */

const WORKER = { kind: 'worker' as const, job: 'ordering.unfinished' };
const PURGE_AFTER_DAYS = 92;

/** Who may see unfinished orders and nudge: those who deal with guests, and managers above them. */
const requireGuestFacing = (ctx: Ctx, venueId: string) => requireStaff(ctx, { venueId, minRole: 'host', anyOf: GUEST_FACING_ROLES });

export const listUnfinishedInput = z.object({ venueId: z.string().uuid(), limit: z.number().int().min(1).max(200).default(100) }).strict();

/** Orders a guest did not finish at a venue, newest first, recovered ones included (they carry the badge). Host, front of house, managers. */
export async function listUnfinishedOrders(ctx: Ctx, raw: z.input<typeof listUnfinishedInput>): Promise<OrderView[]> {
  const input = listUnfinishedInput.parse(raw);
  requireGuestFacing(ctx, input.venueId);
  return listOrders(ctx, { venueId: input.venueId, unfinished: true, limit: input.limit });
}

export const nudgeInput = z.object({ orderId: z.string().uuid() }).strict();

export interface NudgeResult {
  order: OrderView;
  /** How it went to the guest. */
  via: 'email' | 'sms';
  status: 'queued' | 'suppressed';
  reason?: string;
}

/** Everything `nudgeUnfinishedOrder` checks, without sending: the tools ask with it. */
export async function checkNudge(ctx: Ctx, orderId: string): Promise<OrderView> {
  const order = await loadOrder(ctx, z.string().uuid().parse(orderId));
  requireGuestFacing(ctx, order.venue_id);
  await assertModule(ctx, order.venue_id, orderingModule);
  if (!order.abandoned_at || order.purged_at) throw invalid(`Order ${order.reference} is not on the "didn't finish" list.`);
  if (order.nudge_sent_at) throw conflict(`The guest has already been sent the one nudge about order ${order.reference}.`);
  if (order.recovered_at) throw conflict(`Order ${order.reference} was recovered: the guest has ordered. There is nothing to nudge about.`);
  if (!order.customer_email && !order.customer_phone) throw invalid(`Order ${order.reference} has no email or phone to write to.`);
  return getOrder(ctx, order.id);
}

/**
 * Send the one nudge about an unfinished order. Host, front of house, managers. It says what was
 * in the order and where to finish it (its own pay page while it can still be paid; the venue's
 * order page once it has lapsed). Audited and tracked; the order remembers it was sent, so it is
 * never sent twice.
 */
export async function nudgeUnfinishedOrder(ctx: Ctx, raw: z.input<typeof nudgeInput>): Promise<NudgeResult> {
  const input = nudgeInput.parse(raw);
  const order = await loadOrder(ctx, input.orderId, { lock: true });
  requireGuestFacing(ctx, order.venue_id);
  await assertModule(ctx, order.venue_id, orderingModule);
  await checkNudge(ctx, order.id);
  const venue = await getVenue(ctx, order.venue_id);
  const items = await loadItems(ctx, order.id);
  const payable = order.status === 'pending_payment';
  const resume = payable ? `Finish paying here: ${await trackingUrl(ctx, order)}` : `Order again at ${await orderPageUrl(ctx, order.venue_id)}`;
  const sent = await notifyGuest(
    ctx,
    order,
    'order.nudge',
    { first_name: firstName(order), venue_name: venue.name, reference: order.reference, summary: itemSummary(items, order.currency, { prices: false }), total: formatMoney(order.total_cents, order.currency), resume_line: resume },
    'nudge',
  );
  if (!sent) throw invalid(`Order ${order.reference} has no email or phone to write to.`);
  const status = sent.status === 'queued' ? 'queued' : `suppressed:${sent.reason ?? 'suppressed'}`.slice(0, 60);
  await ctx.db.updateTable('orders').set({ nudge_sent_at: ctx.now(), nudge_message_id: sent.messageId, nudge_status: status }).where('id', '=', order.id).execute();
  await audit(ctx, { action: 'order.nudge_sent', entityType: 'order', entityId: order.id, venueId: order.venue_id, after: { reference: order.reference, via: sent.via, status, payable } });
  await track(ctx, orderNudged, { order_id: order.id, via: sent.via, status: sent.status }, { venueId: order.venue_id, customerId: order.customer_id });
  return { order: await getOrder(ctx, order.id), via: sent.via, status: sent.status, reason: sent.reason };
}

/**
 * Three months after an order was marked unfinished and never paid, the guest's details are
 * removed and it leaves the list. The row itself stays (its history is append-only and the
 * record of the attempt is the venue's), with nothing personal on it. Daily, per org.
 */
export const purgeUnfinishedOrdersJob = defineJob({
  kind: 'ordering.purge_unfinished',
  schema: z.object({ bucket: z.string().optional() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ordering.purge_unfinished needs an org');
    await app.tenant(job.orgId, WORKER, async (ctx) => {
      const cutoff = addMinutes(ctx.now(), -PURGE_AFTER_DAYS * 24 * 60);
      const stale = await ctx.db
        .selectFrom('orders')
        .select(['id', 'venue_id', 'reference', 'customer_id'])
        .where('abandoned_at', '<', cutoff)
        .where('purged_at', 'is', null)
        .where('payment_status', 'in', ['unpaid', 'failed'])
        .limit(500)
        .execute();
      for (const o of stale) {
        await ctx.db
          .updateTable('orders')
          .set({ customer_name: null, customer_email: null, customer_phone: null, customer_note: null, customer_id: null, purged_at: ctx.now() })
          .where('id', '=', o.id)
          .execute();
        await ctx.db.updateTable('order_items').set({ note: null }).where('order_id', '=', o.id).execute();
        await audit(ctx, { action: 'order.unfinished_purged', entityType: 'order', entityId: o.id, venueId: o.venue_id, after: { reference: o.reference } });
        await track(ctx, orderPurged, { order_id: o.id }, { venueId: o.venue_id });
      }
    });
  },
});

export const purgeUnfinishedOrdersSchedule = defineSchedule({
  key: 'ordering.purge_unfinished',
  everyMinutes: 24 * 60,
  scope: 'org',
  job: purgeUnfinishedOrdersJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  // Platform scheduler: asked outside any tenant, only "does this org have anything to purge".
  async appliesTo(app, orgId) {
    const row = await app.db.selectFrom('orders').select('id').where('org_id', '=', orgId).where('abandoned_at', 'is not', null).where('purged_at', 'is', null).limit(1).executeTakeFirst();
    return !!row;
  },
});
