import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ordering } from '@ros/modules';
import { QUIET_EVENING, anon, footprint, menuOf, okCard } from '../commerce/helpers';
import { YES, issueKey, rawToolCall, roomForKeys } from '../hub/helpers';

/**
 * Phone and function orders (docs/COMMERCE_ADMIN_PATTERNS.md pattern 10): built by staff, priced
 * by the server, paid in full through the venue's own checkout by a link or marked paid by a
 * manager. Every write is read back: the rows, the audit entry, the event, the message, the job,
 * the ledger. Negative cases: a host adding a custom item, a client-supplied price, another
 * organisation's id, a second mark-paid, a refund on a cash order.
 */
describe('phone and function orders', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const row = (id: string) => t.db.selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const items = (id: string) => t.db.selectFrom('order_items').selectAll().where('order_id', '=', id).orderBy('line_no').execute();
  const audits = (id: string) => t.db.selectFrom('audit_log').select(['action', 'actor_kind', 'after']).where('entity_id', '=', id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
  const events = (id: string) => t.db.selectFrom('events').select(['name', 'properties']).where(sql<boolean>`properties->>'order_id' = ${id}`).orderBy('occurred_at').execute();
  const messages = (id: string) => t.db.selectFrom('messages').selectAll().where('idempotency_key', 'like', `order:${id}:%`).orderBy('queued_at').execute();
  const asHost = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('host'), fn);
  const asManager = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('manager'), fn);
  const WANTED = '2026-10-10T08:00:00.000Z';
  const HOLD = '2026-10-10T13:00:00.000Z';

  beforeAll(async () => {
    t.clock.set(QUIET_EVENING);
    await roomForKeys(t.app, t.fixture);
  });
  beforeEach(() => t.clock.set(QUIET_EVENING));

  async function draft(over: Partial<Parameters<typeof ordering.createDraftOrder>[1]> = {}, who: 'host' | 'manager' = 'host') {
    const m = await menuOf(t, diner(), venueId());
    const burger = m.byName('Cheeseburger');
    const fries = m.plain();
    const input: Parameters<typeof ordering.createDraftOrder>[1] = {
      venueId: venueId(),
      channel: 'pickup',
      lines: [
        { menuItemId: burger.id, qty: 2 },
        { menuItemId: fries.id, qty: 1 },
      ],
      customer: { name: 'Fran Function', email: `fran.${randomUUID().slice(0, 8)}@example.com` },
      note: 'Birthday lunch',
      wantedAt: WANTED,
      holdUntil: HOLD,
      ...over,
    };
    const fn = (ctx: Parameters<Parameters<typeof t.app.tenant>[2]>[0]) => ordering.createDraftOrder(ctx, input);
    return { order: await (who === 'host' ? asHost(fn) : asManager(fn)), burger, fries };
  }

  it('a host builds a pickup order from the menu: priced by the server, a draft nobody has charged, due, built by staff, audited', async () => {
    const { order, burger, fries } = await draft({ lines: [{ menuItemId: (await menuOf(t, diner(), venueId())).byName('Cheeseburger').id, qty: 2, priceCents: 1 } as never, { menuItemId: (await menuOf(t, diner(), venueId())).plain().id, qty: 1 }] });
    // The client's price was dropped: the menu's price is the price.
    expect(order).toMatchObject({
      status: 'draft',
      paymentStatus: 'unpaid',
      source: 'phone',
      channel: 'pickup',
      itemCount: 3,
      subtotalCents: burger.priceCents * 2 + fries.priceCents,
      totalCents: burger.priceCents * 2 + fries.priceCents,
      axes: { kitchen: 'none', money: 'due', leaves: 'pickup', source: 'phone' },
      holdUntil: new Date(HOLD),
      promisedAt: new Date(WANTED),
      customerName: 'Fran Function',
      payLinkSentAt: null,
      paidBy: null,
    });
    expect(order.taxCents).toBeGreaterThan(0);
    const r = await row(order.id);
    expect(r).toMatchObject({ status: 'draft', source: 'phone', requested_asap: false, item_count: 3 });
    expect(r.tracking_token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.customer_id).not.toBeNull();
    expect((await items(order.id)).map((i) => [i.name_snapshot, i.qty, i.unit_price_cents])).toEqual([
      [burger.name, 2, burger.priceCents],
      [fries.name, 1, fries.priceCents],
    ]);
    expect(await audits(order.id)).toMatchObject([{ action: 'order.draft_created', actor_kind: 'staff', after: { channel: 'pickup', items: 3, customItems: 0 } }]);
    expect((await events(order.id)).map((e) => e.name)).toEqual(['order.drafted']);
    expect(await messages(order.id)).toEqual([]);
    expect((await footprint(t, order.id)).tickets).toEqual([]);
    // Listed under drafts, and under "due"; left out of the default list.
    const drafts = await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), drafts: true }));
    expect(drafts.map((o) => o.id)).toContain(order.id);
    expect((await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), money: ['due'] }))).map((o) => o.id)).toContain(order.id);
    expect((await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), limit: 200 }))).map((o) => o.id)).not.toContain(order.id);

    // The guest's name is required; so is at least one item; a table order needs a table.
    await expect(draft({ customer: { name: '' } })).rejects.toThrow();
    await expect(draft({ lines: [], customItems: [] })).rejects.toThrow();
    await expect(draft({ channel: 'dine-in-qr' })).rejects.toMatchObject({ code: 'invalid' });
    // An 86'd item is refused with its name.
    await t.db.updateTable('menu_items').set({ is_available: false }).where('id', '=', burger.id).execute();
    await expect(draft()).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining(`${burger.name} is 86'd`) });
    await t.db.updateTable('menu_items').set({ is_available: true }).where('id', '=', burger.id).execute();
    // Another organisation's venue, and another org's menu item: not found.
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.createDraftOrder(ctx, { venueId: venueId(), lines: [{ menuItemId: fries.id, qty: 1 }], customer: { name: 'X' } }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.createDraftOrder(ctx, { venueId: t.fixture.group.venues.cbd!.id, lines: [{ menuItemId: fries.id, qty: 1 }], customer: { name: 'X' } }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a custom item needs a manager; it is priced as given, flagged on the record, and sits beside menu items', async () => {
    const custom = [{ name: 'Function set menu for 20', priceCents: 180_000, qty: 1 }];
    await expect(draft({ customItems: custom })).rejects.toMatchObject({ code: 'forbidden', message: expect.stringContaining('Only a manager') });
    const { order, burger, fries } = await draft({ customItems: custom, channel: 'dine-in-qr', tableLabel: 'Private room' }, 'manager');
    expect(order).toMatchObject({ channel: 'dine-in-qr', tableLabel: 'Private room', subtotalCents: burger.priceCents * 2 + fries.priceCents + 180_000, axes: { leaves: 'table', money: 'due' } });
    const lines = await items(order.id);
    expect(lines.map((i) => [i.menu_item_id === null, i.name_snapshot, i.unit_price_cents, i.category_snapshot])).toEqual([
      [false, burger.name, burger.priceCents, expect.any(String)],
      [false, fries.name, fries.priceCents, expect.any(String)],
      [true, 'Function set menu for 20', 180_000, 'Custom'],
    ]);
    expect(await audits(order.id)).toMatchObject([{ action: 'order.draft_created', after: { customItems: 1, tableLabel: 'Private room' } }]);
    expect(order.items[2]).toMatchObject({ menuItemId: null, name: 'Function set menu for 20', unitPriceCents: 180_000 });
  });

  it('the pay link opens the real checkout: the guest pays the whole amount by the tracking link, the order is placed, ticketed, in the ledger and confirmed', async () => {
    const { order } = await draft();
    // Another organisation's manager finds no such order.
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.sendPayLink(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'not_found' });
    // The kitchen may not send it.
    await expect(t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.sendPayLink(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'forbidden' });

    const sent = await asHost((ctx) => ordering.sendPayLink(ctx, { orderId: order.id }));
    expect(sent).toMatchObject({ via: 'email', status: 'queued', until: new Date(HOLD) });
    expect(sent.order).toMatchObject({ status: 'pending_payment', axes: { kitchen: 'none', money: 'due' } });
    expect(sent.payUrl).toMatch(/\/order\/t\/[A-Za-z0-9_-]{32}$/);
    const r = await row(order.id);
    expect(r.pay_link_sent_at).toEqual(t.clock());
    expect(sent.payUrl.endsWith(`/order/t/${r.tracking_token}`)).toBe(true);
    const m = await messages(order.id);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'transactional', template_key: 'order.pay_link', channel: 'email', status: 'queued' });
    expect((m[0]!.payload as { pay_url: string; total: string }).pay_url).toBe(sent.payUrl);
    expect((await audits(order.id)).map((a) => a.action)).toEqual(['order.draft_created', 'order.pay_link_sent']);
    expect((await events(order.id)).map((e) => e.name)).toEqual(['order.drafted', 'order.pay_link_sent']);
    // The link works until the hold date: the unpaid-order expiry is booked for then, not for 15 minutes.
    const expiry = await t.db.selectFrom('jobs').select(['run_at', 'status']).where('kind', '=', 'ordering.expire_unpaid').where('idempotency_key', '=', `expire:${order.id}`).executeTakeFirstOrThrow();
    expect(expiry.run_at).toEqual(new Date(HOLD));
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const email = t.sim.email.sent.find((e) => e.to === order.customerEmail)!;
    expect(email.subject).toBe(`Pay for your order ${order.reference} at Oak Diner`);
    expect(email.body).toContain(`Pay here: ${sent.payUrl}`);
    expect(email.body).toContain('The link works until');

    // Sending again (a little later) sends again; the order stays as it is.
    t.clock.advanceMinutes(1);
    const again = await asHost((ctx) => ordering.sendPayLink(ctx, { orderId: order.id }));
    expect(again.order.status).toBe('pending_payment');
    expect(await messages(order.id)).toHaveLength(2);

    // The guest follows the link and pays: the same checkout every online order uses.
    t.clock.advanceDays(3);
    const paid = await ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon() }, { trackingToken: r.tracking_token!, sourceToken: okCard('fran') });
    expect(paid.status).toBe('paid');
    expect(paid.status === 'paid' && paid.order).toMatchObject({ status: 'placed', paymentStatus: 'paid', axes: { kitchen: 'new', money: 'paid', leaves: 'pickup', source: 'phone' }, source: 'phone', paidBy: null });
    const f = await footprint(t, order.id);
    expect(f.payments.map((p) => [p.provider, p.status, p.amount_cents])).toEqual([['sim-pay', 'completed', order.totalCents]]);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({ total_cents: order.totalCents, tender_type: 'card', status: 'completed' });
    expect(f.tickets).toHaveLength(1);
    expect(f.tickets[0]!.target_ready_at).toEqual(new Date(WANTED));
    expect(f.messages.map((x) => x.template_key).sort()).toEqual(['order.confirmed', 'order.pay_link', 'order.pay_link']);
    expect(t.sim.payment.captured().filter((c) => c.reference === order.reference)).toHaveLength(1);
    // Paying the link twice charges once.
    expect(await ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon() }, { trackingToken: r.tracking_token!, sourceToken: okCard('fran') })).toMatchObject({ status: 'paid', replayed: true });
    expect(t.sim.payment.captured().filter((c) => c.reference === order.reference)).toHaveLength(1);
    // Paid, so no longer a draft: the link cannot be sent and it is off the drafts list.
    await expect(asHost((ctx) => ordering.sendPayLink(ctx, { orderId: order.id }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await asHost((ctx) => ordering.listOrders(ctx, { venueId: venueId(), drafts: true }))).map((o) => o.id)).not.toContain(order.id);
  });

  it('a link not paid by the hold date lapses: the order is cancelled and the link no longer pays', async () => {
    const { order } = await draft();
    await asHost((ctx) => ordering.sendPayLink(ctx, { orderId: order.id }));
    t.clock.set(HOLD);
    t.clock.advanceMinutes(1);
    await drainJobs(t.app, { kinds: ['ordering.expire_unpaid'] });
    expect(await row(order.id)).toMatchObject({ status: 'cancelled', rejected_reason: 'Not paid in time.', payment_status: 'unpaid' });
    await expect(ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon() }, { trackingToken: (await row(order.id)).tracking_token!, sourceToken: okCard() })).rejects.toMatchObject({ code: 'conflict' });
    // A draft whose wanted time has passed cannot be given a link at all.
    t.clock.set(QUIET_EVENING);
    const { order: late } = await draft({ wantedAt: '2026-10-01T09:00:00.000Z', holdUntil: null });
    t.clock.set('2026-10-01T10:00:00.000Z');
    await expect(asHost((ctx) => ordering.sendPayLink(ctx, { orderId: late.id }))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('has passed') });
    // No contact, no link.
    t.clock.set(QUIET_EVENING);
    const { order: silent } = await draft({ customer: { name: 'Sam Silent' } });
    await expect(asHost((ctx) => ordering.sendPayLink(ctx, { orderId: silent.id }))).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('no email or phone') });
  });

  it('a manager marks a draft paid by cash: settled as a sale with the tender, ticketed, confirmed, audited with the reason; a host may not; a refund is refused; twice is refused', async () => {
    const { order } = await draft();
    await expect(asHost((ctx) => ordering.markDraftPaid(ctx, { orderId: order.id, method: 'cash', reason: 'Paid at the counter.' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => ordering.markDraftPaid(ctx, { orderId: order.id, method: 'cash', reason: 'Paid at the counter.' }))).rejects.toMatchObject({ code: 'not_found' });

    const paid = await asManager((ctx) => ordering.markDraftPaid(ctx, { orderId: order.id, method: 'cash', reason: 'Paid cash at the counter.' }));
    expect(paid).toMatchObject({ status: 'placed', paymentStatus: 'paid', paidBy: 'cash', axes: { kitchen: 'new', money: 'paid', source: 'phone' } });
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'placed', payment_status: 'paid', paid_by: 'cash' });
    expect(f.payments.map((p) => [p.provider, p.status, p.external_ref, p.amount_cents])).toEqual([['manual', 'completed', `manual:${order.id}`, order.totalCents]]);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({ total_cents: order.totalCents, tender_type: 'cash', status: 'completed' });
    expect(f.tickets).toHaveLength(1);
    expect(f.messages.map((m) => m.template_key)).toEqual(['order.confirmed']);
    expect(f.history.map((h) => h.to_status)).toEqual(['draft', 'pending_payment', 'placed']);
    const a = await audits(order.id);
    expect(a.map((x) => x.action)).toEqual(['order.draft_created', 'order.marked_paid']);
    expect(a[1]).toMatchObject({ actor_kind: 'staff', after: { method: 'cash', reason: 'Paid cash at the counter.', totalCents: order.totalCents } });
    expect((await events(order.id)).map((e) => e.name)).toEqual(['order.drafted', 'order.paid', 'order.marked_paid']);
    expect(t.sim.payment.charges.filter((c) => c.reference === order.reference)).toEqual([]);
    // Nothing was pushed to a till: there is no processor payment to name.
    expect(await t.db.selectFrom('jobs').select('id').where('kind', '=', 'ordering.pos_push').where(sql<boolean>`payload->>'orderId' = ${order.id}`).execute()).toEqual([]);

    await expect(asManager((ctx) => ordering.markDraftPaid(ctx, { orderId: order.id, method: 'bank', reason: 'Again.' }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await footprint(t, order.id)).payments).toHaveLength(1);
    // Money that never went through a processor cannot come back through one.
    await expect(ordering.refundOrder(t.app, { orgId: diner().orgId, principal: await diner().as('manager') }, { orderId: order.id, reason: 'Changed mind', idempotencyKey: `r-${randomUUID()}` })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('cash') });
    expect(t.sim.payment.refunds.filter((r) => r.paymentRef.includes(order.id))).toEqual([]);
    // The kitchen moves it along like any paid order.
    expect((await asManager((ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'accepted' }))).axes.kitchen).toBe('accepted');
  });

  it('a draft is cancelled with a reason and no message; one untouched for a year is cleared by the daily job', async () => {
    const { order } = await draft();
    const cancelled = await asHost((ctx) => ordering.cancelDraftOrder(ctx, { orderId: order.id, reason: 'The guest changed their mind.' }));
    expect(cancelled).toMatchObject({ status: 'cancelled', axes: { kitchen: 'stopped', money: 'voided' } });
    expect((await audits(order.id)).map((a) => a.action)).toEqual(['order.draft_created', 'order.draft_cancelled']);
    expect(await messages(order.id)).toEqual([]);
    await expect(asHost((ctx) => ordering.cancelDraftOrder(ctx, { orderId: order.id, reason: 'Again.' }))).rejects.toMatchObject({ code: 'conflict' });

    const { order: stale } = await draft({ wantedAt: null, holdUntil: null });
    const { order: fresh } = await draft({ wantedAt: null, holdUntil: null });
    t.clock.advanceDays(300);
    // Touching a draft (sending its link) keeps it.
    await asHost((ctx) => ordering.sendPayLink(ctx, { orderId: fresh.id }));
    t.clock.advanceDays(66);
    await tickSchedules(t.app, { only: ['ordering.expire_drafts'] });
    await drainJobs(t.app, { kinds: ['ordering.expire_drafts'] });
    expect(await row(stale.id)).toMatchObject({ status: 'cancelled', rejected_reason: 'Not used for a year.' });
    expect((await audits(stale.id)).map((a) => a.action)).toEqual(['order.draft_created', 'order.draft_expired']);
    expect((await events(stale.id)).map((e) => e.name)).toContain('order.draft_expired');
    // The one with a link out is pending payment, not a draft; its own 30-day hold decides it.
    expect((await row(fresh.id)).status).not.toBe('draft');
  });

  it('the assistant builds, links and marks paid, asking first each time; a replayed yes does nothing more', async () => {
    // Only an owner may let a key make changes; the owner holds every role, so the custom item is allowed.
    const writer = await issueKey(t.app, diner().orgId, await diner().as('owner'), { scopes: ['orders:read', 'orders:write'], canWrite: true });
    const m = await menuOf(t, diner(), venueId());
    const named = () => t.db.selectFrom('orders').selectAll().where('venue_id', '=', venueId()).where('customer_name', '=', 'Pat Phone').execute();
    const args = { items: [{ menu_item_id: m.plain().id, quantity: 2 }], custom_items: [{ name: 'Cake', price_cents: 4500 }], guest_name: 'Pat Phone', guest_email: `pat.${randomUUID().slice(0, 8)}@example.com`, wanted_at: WANTED, hold_until: HOLD, note: 'Candles' };
    const ask = await rawToolCall(t.app, writer.key, 'order_draft_create', args);
    expect(ask.asking!.question).toBe(`Build a pickup order at Oak Diner for 2026-10-10 19:00 under the name "Pat Phone": 2 x ${m.plain().name}, 1 x Cake (custom), coming to $${((m.plain().priceCents * 2 + 4500) / 100).toFixed(2)}? Nothing is charged yet. A pay link can then be sent to the guest.`);
    expect(await named()).toEqual([]);
    const yes = await rawToolCall(t.app, writer.key, 'order_draft_create', args, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false, structured: { status: 'draft', money: 'Due', item_count: 3 } });
    const again = await rawToolCall(t.app, writer.key, 'order_draft_create', args, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(again.answer?.isError).toBe(true);
    const made = await named();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ source: 'phone', status: 'draft', customer_note: 'Candles' });
    const id = made[0]!.id;
    expect(await audits(id)).toMatchObject([{ action: 'order.draft_created', actor_kind: 'agent' }]);

    // The drafts list names it; the pay link asks, then goes once.
    const drafts = await rawToolCall(t.app, writer.key, 'orders_list', { show: 'drafts' });
    const listed = (drafts.answer!.structured as { orders: Array<Record<string, unknown>> }).orders.find((o) => o.order_id === id)!;
    expect(listed).toMatchObject({ came_from: 'Phone', money: 'Due', kitchen: 'Not with the kitchen yet', hold_until: '2026-10-11 00:00' });
    const link = await rawToolCall(t.app, writer.key, 'order_pay_link_send', { order: made[0]!.reference });
    expect(link.asking!.question).toMatch(/^Send the guest a pay link by email for order .* They pay the full .* on the venue's order page; the link works until 2026-10-11 00:00\.$/);
    expect(await messages(id)).toEqual([]);
    const linked = await rawToolCall(t.app, writer.key, 'order_pay_link_send', { order: made[0]!.reference }, { inputResponses: YES, requestState: link.asking!.requestState });
    expect(linked.answer).toMatchObject({ isError: false, structured: { status: 'pending_payment', via: 'email' } });
    expect(await messages(id)).toHaveLength(1);
    expect((await rawToolCall(t.app, writer.key, 'order_pay_link_send', { order: made[0]!.reference }, { inputResponses: YES, requestState: link.asking!.requestState })).answer?.isError).toBe(true);
    expect(await messages(id)).toHaveLength(1);

    // Marked paid by bank transfer through the assistant: once.
    const mark = await rawToolCall(t.app, writer.key, 'order_mark_paid', { order: made[0]!.reference, method: 'bank', reason: 'Transfer received this morning.' });
    expect(mark.asking!.question).toMatch(/^Mark order .* as paid by bank transfer, with the reason "Transfer received this morning\."\? It goes into the sales record and to the kitchen as a paid order\./);
    expect((await row(id)).payment_status).toBe('unpaid');
    const marked = await rawToolCall(t.app, writer.key, 'order_mark_paid', { order: made[0]!.reference, method: 'bank', reason: 'Transfer received this morning.' }, { inputResponses: YES, requestState: mark.asking!.requestState });
    expect(marked.answer).toMatchObject({ isError: false, structured: { status: 'placed', money: 'Paid', method: 'bank' } });
    expect(await row(id)).toMatchObject({ payment_status: 'paid', paid_by: 'bank', status: 'placed' });
    expect((await rawToolCall(t.app, writer.key, 'order_mark_paid', { order: made[0]!.reference, method: 'bank', reason: 'Transfer received this morning.' }, { inputResponses: YES, requestState: mark.asking!.requestState })).answer?.isError).toBe(true);
    expect((await footprint(t, id)).payments).toHaveLength(1);
    expect((await footprint(t, id)).transactions[0]).toMatchObject({ tender_type: 'bank' });

    // An order the menu cannot price (an unknown item) is refused before anyone is asked.
    const refused = await rawToolCall(t.app, writer.key, 'order_draft_create', { ...args, guest_name: 'No Item', items: [{ menu_item_id: randomUUID(), quantity: 1 }] });
    expect(refused.asking).toBeNull();
    expect(refused.answer?.isError).toBe(true);
    expect(await t.db.selectFrom('orders').select('id').where('customer_name', '=', 'No Item').execute()).toEqual([]);
  });
});
