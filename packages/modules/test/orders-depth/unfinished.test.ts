import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { comms, ordering } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, pay, placeOrder } from '../commerce/helpers';
import { YES, issueKey, rawToolCall, roomForKeys } from '../hub/helpers';

/**
 * "Didn't finish" (docs/COMMERCE_ADMIN_PATTERNS.md pattern 7): an order a guest started, gave a
 * contact for, and did not pay. Detection at the threshold and not before; the one nudge, a
 * transactional message with no consent behind it and the outbox's suppressions honoured; the
 * Recovered mark when the guest comes back; the three-month purge; the roles; the assistant tool.
 */
describe('orders a guest did not finish', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const row = (id: string) => t.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const events = (orderId: string, name: string) => t.db.selectFrom('events').select(['name', 'properties']).where('name', '=', name).where(sql<boolean>`properties->>'order_id' = ${orderId}`).execute();
  const nudges = (orderId: string) => t.db.selectFrom('messages').selectAll().where('idempotency_key', '=', `order:${orderId}:nudge`).execute();
  const audits = (orderId: string, action: string) => t.db.selectFrom('audit_log').select(['action', 'actor_kind', 'after']).where('entity_id', '=', orderId).where('action', '=', action).execute();
  const detect = () => drainJobs(t.app, { kinds: ['ordering.detect_abandoned', 'ordering.expire_unpaid'] });
  const asHost = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('host'), fn);
  const configure = (config: Record<string, unknown>) => t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venueId(), config: config as never }));

  beforeAll(async () => {
    t.clock.set(QUIET_EVENING);
    await roomForKeys(t.app, t.fixture);
  });
  beforeEach(() => t.clock.set(QUIET_EVENING));

  it('an unpaid order with a contact is counted as unfinished at the threshold and not a minute before; one without a contact, a table order and a paid order never are', async () => {
    const email = `left.${randomUUID().slice(0, 8)}@example.com`;
    const left = await placeOrder(t, diner(), venueId(), { customer: { name: 'Lee Left', email } });
    const noContact = await placeOrder(t, diner(), venueId(), { channel: 'dine-in-qr', qrCode: (await t.db.selectFrom('qr_codes').select('code').where('venue_id', '=', venueId()).where('kind', '=', 'table').executeTakeFirstOrThrow()).code, customer: {} });
    const paid = await placeOrder(t, diner(), venueId());
    await pay(t, diner(), paid);
    // The check is booked for the threshold (10 minutes by default); a table order gets none.
    const jobs = await t.db.selectFrom('jobs').select(['payload', 'run_at']).where('kind', '=', 'ordering.detect_abandoned').where('org_id', '=', diner().orgId).execute();
    const forLeft = jobs.find((j) => (j.payload as { orderId: string }).orderId === left.id)!;
    expect(forLeft.run_at.toISOString()).toBe('2026-10-01T08:10:00.000Z');
    expect(jobs.some((j) => (j.payload as { orderId: string }).orderId === noContact.id)).toBe(false);

    t.clock.advanceMinutes(9);
    await detect();
    expect((await row(left.id)).abandoned_at).toBeNull();
    t.clock.advanceMinutes(1);
    await detect();
    const marked = await row(left.id);
    expect(marked.abandoned_at).toEqual(new Date('2026-10-01T08:10:00.000Z'));
    expect(marked.status).toBe('pending_payment');
    expect(await events(left.id, 'order.abandoned')).toMatchObject([{ properties: { order_id: left.id, channel: 'pickup', minutes_since_started: 10 } }]);
    expect((await row(paid.id)).abandoned_at).toBeNull();
    expect((await row(noContact.id)).abandoned_at).toBeNull();

    // The list for staff, and the badge's columns. (The fixtures' own declined-card checkouts are on it too.)
    const listed = await asHost((ctx) => ordering.listUnfinishedOrders(ctx, { venueId: venueId() }));
    expect(listed.map((o) => o.id)).toContain(left.id);
    expect(listed.map((o) => o.id)).not.toContain(paid.id);
    expect(listed.map((o) => o.id)).not.toContain(noContact.id);
    expect(listed.find((o) => o.id === left.id)).toMatchObject({ abandonedAt: marked.abandoned_at, nudgeSentAt: null, nudgeStatus: null, recoveredAt: null, customerEmail: email });
    expect(listed.every((o) => o.abandonedAt && (o.customerEmail || o.customerPhone))).toBe(true);
    // The default list still leaves it out; the badge's own filter brings it in.
    expect((await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), limit: 200 }))).map((o) => o.id)).not.toContain(left.id);
    expect((await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), unfinished: true }))).map((o) => o.id)).toContain(left.id);

    // The hold runs out: the order lapses and is cancelled, and stays on the list as lapsed.
    t.clock.advanceMinutes(5);
    await detect();
    const lapsed = await row(left.id);
    expect(lapsed).toMatchObject({ status: 'cancelled', rejected_reason: 'Not paid in time.' });
    expect(lapsed.lapsed_at).not.toBeNull();
    expect((await asHost((ctx) => ordering.listUnfinishedOrders(ctx, { venueId: venueId() }))).map((o) => o.id)).toContain(left.id);
  });

  it('a threshold past the payment hold still catches the lapsed order; one the guest cancelled is not unfinished', async () => {
    await configure({ abandoned_after_minutes: 20 });
    const lapsing = await placeOrder(t, diner(), venueId(), { customer: { name: 'Lou Late', email: `lou.${randomUUID().slice(0, 8)}@example.com` } });
    const changedMind = await placeOrder(t, diner(), venueId(), { customer: { name: 'Mia Mind', email: `mia.${randomUUID().slice(0, 8)}@example.com` } });
    await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.cancelUnpaidOrder(ctx, changedMind.trackingToken!));
    t.clock.advanceMinutes(20);
    await detect();
    expect(await row(lapsing.id)).toMatchObject({ status: 'cancelled' });
    expect((await row(lapsing.id)).abandoned_at).not.toBeNull();
    expect((await row(changedMind.id)).abandoned_at).toBeNull();
    await configure({ abandoned_after_minutes: 10 });
  });

  it('the one nudge: a transactional message about the guest\'s own order, no consent row, never a second, and the roles', async () => {
    const email = `nina.${randomUUID().slice(0, 8)}@example.com`;
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Nina Nudge', email } });
    // Not on the list yet: nothing to nudge.
    await expect(asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'invalid' });
    t.clock.advanceMinutes(10);
    await detect();

    // The kitchen may not; a read-only role at another organisation finds nothing; the other org's manager finds nothing.
    await expect(t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.listUnfinishedOrders(ctx, { venueId: venueId() }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('accounts'), (ctx) => ordering.listUnfinishedOrders(ctx, { venueId: t.fixture.group.venues.cbd!.id }))).rejects.toMatchObject({ code: 'forbidden' });

    const r = await asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }));
    expect(r).toMatchObject({ via: 'email', status: 'queued' });
    expect(r.order).toMatchObject({ nudgeStatus: 'queued' });
    const m = await nudges(order.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'transactional', template_key: 'order.nudge', channel: 'email', to_address: email, status: 'queued' });
    const after = await row(order.id);
    expect(after.nudge_sent_at).toEqual(t.clock());
    expect(after.nudge_message_id).toBe(m[0]!.id);
    // Nothing about marketing: the guest holds no consent row because of this.
    expect(await t.db.selectFrom('consents').select('id').where('customer_id', '=', after.customer_id!).execute()).toEqual([]);
    expect(await audits(order.id, 'order.nudge_sent')).toMatchObject([{ actor_kind: 'staff', after: { via: 'email', status: 'queued', payable: true } }]);
    expect(await events(order.id, 'order.nudged')).toMatchObject([{ properties: { via: 'email', status: 'queued' } }]);
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const sent = t.sim.email.sent.filter((e) => e.to === email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Your order at Oak Diner was not finished');
    // While the order can still be paid, the nudge points at its own pay page.
    expect(sent[0]!.body).toContain(`Finish paying here: http://`);
    expect(sent[0]!.body).toContain(`/order/t/${after.tracking_token}`);
    expect(sent[0]!.body).not.toMatch(/offer|discount|unsubscribe/i);

    // Never twice, from anyone.
    await expect(asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(t.app.tenant(diner().orgId, await diner().as('manager'), (ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'conflict' });
    expect(await nudges(order.id)).toHaveLength(1);
    expect(t.sim.email.sent.filter((e) => e.to === email)).toHaveLength(1);
  });

  it('a lapsed order\'s nudge points at the order page; an address that bounced is not written to, and that counts as the one nudge', async () => {
    const email = `bounced.${randomUUID().slice(0, 8)}@example.com`;
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Bo Bounce', email } });
    t.clock.advanceMinutes(16);
    await detect();
    expect((await row(order.id)).status).toBe('cancelled');
    await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.addSuppression(ctx, 'email', email, 'bounced_hard'));
    const r = await asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }));
    expect(r).toMatchObject({ status: 'suppressed', reason: 'bounced_hard' });
    expect((await row(order.id)).nudge_status).toBe('suppressed:bounced_hard');
    expect((await nudges(order.id))[0]).toMatchObject({ status: 'suppressed', error: 'bounced_hard' });
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(t.sim.email.sent.filter((e) => e.to === email)).toEqual([]);
    await expect(asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'conflict' });

    // A guest who merely unsubscribed from marketing still gets the transactional nudge.
    const email2 = `unsub.${randomUUID().slice(0, 8)}@example.com`;
    const order2 = await placeOrder(t, diner(), venueId(), { customer: { name: 'Una Unsub', email: email2 } });
    t.clock.advanceMinutes(16);
    await detect();
    await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.addSuppression(ctx, 'email', email2, 'unsubscribed'));
    expect(await asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: order2.id }))).toMatchObject({ status: 'queued' });
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const sent = t.sim.email.sent.filter((e) => e.to === email2);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatch(/Order again at http:\/\/.+\/order$/m);
  });

  it('Recovered flips when the guest pays the order after all, or places and pays a new one; a nudge is then refused', async () => {
    // Paid after all, within the hold.
    const email = `back.${randomUUID().slice(0, 8)}@example.com`;
    const sameOrder = await placeOrder(t, diner(), venueId(), { customer: { name: 'Remy Return', email } });
    t.clock.advanceMinutes(10);
    await detect();
    expect((await row(sameOrder.id)).abandoned_at).not.toBeNull();
    const paid = await pay(t, diner(), sameOrder);
    expect(paid.status).toBe('paid');
    expect(paid.status === 'paid' && paid.order.recoveredAt).toEqual(t.clock());
    expect(await row(sameOrder.id)).toMatchObject({ recovered_order_id: sameOrder.id, payment_status: 'paid' });
    expect(await events(sameOrder.id, 'order.recovered')).toMatchObject([{ properties: { by: 'same_order', recovered_order_id: sameOrder.id } }]);
    await expect(asHost((ctx) => ordering.nudgeUnfinishedOrder(ctx, { orderId: sameOrder.id }))).rejects.toMatchObject({ code: 'conflict' });

    // Lapsed, then a new order by the same guest (same email, no sign-in) is paid.
    t.clock.set(QUIET_EVENING);
    const email2 = `again.${randomUUID().slice(0, 8)}@example.com`;
    const first = await placeOrder(t, diner(), venueId(), { customer: { name: 'Ana Again', email: email2 } });
    t.clock.advanceMinutes(16);
    await detect();
    expect(await row(first.id)).toMatchObject({ status: 'cancelled' });
    expect((await row(first.id)).abandoned_at).not.toBeNull();
    const second = await placeOrder(t, diner(), venueId(), { customer: { name: 'Ana Again', email: email2 } });
    expect((await row(first.id)).recovered_at).toBeNull();
    await pay(t, diner(), second);
    expect(await row(first.id)).toMatchObject({ recovered_order_id: second.id });
    expect((await row(first.id)).recovered_at).toEqual(t.clock());
    expect(await events(first.id, 'order.recovered')).toMatchObject([{ properties: { by: 'new_order', recovered_order_id: second.id } }]);
    expect((await row(second.id)).abandoned_at).toBeNull();
    const listed = await asHost((ctx) => ordering.listUnfinishedOrders(ctx, { venueId: venueId() }));
    expect(listed.find((o) => o.id === first.id)).toMatchObject({ recoveredAt: t.clock(), recoveredOrderId: second.id });

    // Ordered again and paid before the check ran: recovered on arrival.
    t.clock.set(QUIET_EVENING);
    const email3 = `quick.${randomUUID().slice(0, 8)}@example.com`;
    const slow = await placeOrder(t, diner(), venueId(), { customer: { name: 'Quinn Quick', email: email3 } });
    t.clock.advanceMinutes(2);
    const quick = await placeOrder(t, diner(), venueId(), { customer: { name: 'Quinn Quick', email: email3 } });
    await pay(t, diner(), quick);
    t.clock.advanceMinutes(8);
    await detect();
    expect(await row(slow.id)).toMatchObject({ recovered_order_id: quick.id });
    expect((await row(slow.id)).abandoned_at).not.toBeNull();
  });

  it('three months on, the guest\'s details are removed from an unfinished order that was never paid, and it leaves the list', async () => {
    const email = `old.${randomUUID().slice(0, 8)}@example.com`;
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Old Order', email }, note: 'Extra napkins', lines: [{ menuItemId: (await menuOf(t, diner(), venueId())).plain().id, qty: 1, note: 'no salt' }] });
    t.clock.advanceMinutes(16);
    await detect();
    // The purge runs daily, per org with something to purge; nothing happens before three months.
    t.clock.advanceDays(60);
    await tickSchedules(t.app, { only: ['ordering.purge_unfinished'] });
    await drainJobs(t.app, { kinds: ['ordering.purge_unfinished'] });
    expect((await row(order.id)).purged_at).toBeNull();
    t.clock.advanceDays(33);
    await tickSchedules(t.app, { only: ['ordering.purge_unfinished'] });
    await drainJobs(t.app, { kinds: ['ordering.purge_unfinished'] });
    const purged = await row(order.id);
    expect(purged).toMatchObject({ customer_name: null, customer_email: null, customer_phone: null, customer_note: null, customer_id: null, status: 'cancelled', total_cents: order.totalCents });
    expect(purged.purged_at).not.toBeNull();
    expect((await footprint(t, order.id)).order.id).toBe(order.id);
    expect((await t.db.selectFrom('order_items').select('note').where('order_id', '=', order.id).execute()).map((i) => i.note)).toEqual([null]);
    expect(await audits(order.id, 'order.unfinished_purged')).toHaveLength(1);
    expect(await events(order.id, 'order.purged')).toHaveLength(1);
    expect((await asHost((ctx) => ordering.listUnfinishedOrders(ctx, { venueId: venueId() }))).map((o) => o.id)).not.toContain(order.id);
    // Running again finds nothing more to do.
    t.clock.advanceDays(1);
    await tickSchedules(t.app, { only: ['ordering.purge_unfinished'] });
    await drainJobs(t.app, { kinds: ['ordering.purge_unfinished'] });
    expect(await audits(order.id, 'order.unfinished_purged')).toHaveLength(1);
  });

  it('the assistant: orders_list shows the unfinished list, order_nudge asks first, changes nothing until the yes, and a replayed yes sends nothing more', async () => {
    // Only an owner may let a key make changes; the roles themselves are checked on the service above.
    const writer = await issueKey(t.app, diner().orgId, await diner().as('owner'), { scopes: ['orders:read', 'orders:write'], canWrite: true });
    const email = `tool.${randomUUID().slice(0, 8)}@example.com`;
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Toni Tool', email } });
    t.clock.advanceMinutes(10);
    await detect();

    const listed = await rawToolCall(t.app, writer.key, 'orders_list', { show: 'unfinished' });
    const rows = (listed.answer!.structured as { orders: Array<Record<string, unknown>> }).orders;
    expect(rows.find((o) => o.order_id === order.id)).toMatchObject({ came_from: 'Website', kitchen: 'Not with the kitchen yet', money: 'Unpaid', leaves: 'Pickup', unfinished: { nudge: 'not sent', recovered: false } });
    expect(JSON.stringify(rows)).not.toContain(email);
    // Where it came from is a filter too.
    const fromPhone = await rawToolCall(t.app, writer.key, 'orders_list', { show: 'unfinished', came_from: 'phone' });
    expect((fromPhone.answer!.structured as { orders: unknown[] }).orders).toEqual([]);

    const ask = await rawToolCall(t.app, writer.key, 'order_nudge', { order: order.reference });
    expect(ask.asking!.question).toBe(`Send the guest one email about order ${order.reference} at Oak Diner (1 item, $${(order.totalCents / 100).toFixed(2)}, pickup), which they started but did not pay for? It says what was in it and where to finish. It is the only nudge they will get.`);
    expect(await nudges(order.id)).toEqual([]);
    expect((await row(order.id)).nudge_sent_at).toBeNull();
    const yes = await rawToolCall(t.app, writer.key, 'order_nudge', { order: order.reference }, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false, structured: { order_id: order.id, reference: order.reference, via: 'email', status: 'queued' } });
    expect(await nudges(order.id)).toHaveLength(1);
    const again = await rawToolCall(t.app, writer.key, 'order_nudge', { order: order.reference }, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(again.answer?.isError).toBe(true);
    expect(await nudges(order.id)).toHaveLength(1);
    expect(await audits(order.id, 'order.nudge_sent')).toMatchObject([{ actor_kind: 'agent' }]);
    // Asking again is refused before anyone is asked.
    const twice = await rawToolCall(t.app, writer.key, 'order_nudge', { order: order.reference });
    expect(twice.asking).toBeNull();
    expect(twice.answer?.isError).toBe(true);
  });
});
