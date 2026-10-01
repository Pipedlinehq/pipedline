import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ordering } from '@ros/modules';
import { QUIET_EVENING, SLOT_1830, WORKER, anon, footprint, menuOf, okCard, paidOrder, pay, placeOrder } from './helpers';

const hhmm = (d: Date) => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

describe('pickup slots and pacing', () => {
  const t = useTestEnv();
  const group = () => t.fixture.group;
  const cbd = () => t.fixture.group.venues.cbd!.id;
  const slots = (input: Parameters<typeof ordering.getPickupSlots>[1]) => t.app.tenant(group().orgId, anon(), (ctx) => ordering.getPickupSlots(ctx, input));
  const config = (venueId: string, cfg: Partial<ordering.OrderingConfig>) => t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId, config: cfg }));
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('slots come from the trading hours, the lead time and the cutoff before close', async () => {
    const board = await slots({ venueId: cbd() });
    expect(board).toMatchObject({ date: '2026-10-01', timezone: 'Australia/Sydney', slotMinutes: 15, dates: ['2026-10-01', '2026-10-02', '2026-10-03'] });
    // 6:00 pm, 20 minutes' lead: the first bookable slot is 6:30. Close is 10:00 pm, cutoff 15 minutes: the last is 9:45.
    expect(hhmm(board.slots[0]!.start)).toBe('18:30');
    expect(hhmm(board.slots.at(-1)!.start)).toBe('21:45');
    expect(board.slots).toHaveLength(14);
    expect(board.slots.every((s) => s.remainingOrders === 8)).toBe(true);
    expect(board.asap).toMatchObject({ available: true, estimateMinutes: 20 });
    expect(hhmm(board.asap.promisedAt!)).toBe('18:20');

    // Tomorrow: lunch and dinner, each starting a lead time after opening.
    const friday = await slots({ venueId: cbd(), date: '2026-10-02' });
    expect(hhmm(friday.slots[0]!.start)).toBe('12:30');
    expect(friday.slots.map((s) => hhmm(s.start))).toContain('14:45');
    expect(friday.slots.map((s) => hhmm(s.start))).not.toContain('15:00');
    expect(friday.slots.map((s) => hhmm(s.start))).toContain('18:00');
    // A longer prep time pushes the first slot out.
    const slow = await slots({ venueId: cbd(), prepMinutes: 45 });
    expect(hhmm(slow.slots[0]!.start)).toBe('18:45');

    // Closed on Mondays, and nothing beyond the days a guest may book ahead.
    expect((await slots({ venueId: cbd(), date: '2026-10-05' })).slots).toEqual([]);
    expect((await slots({ venueId: cbd(), date: '2026-10-20' })).slots).toEqual([]);

    // A time that is not a slot, or is too soon, is refused at checkout.
    await expect(placeOrder(t, group(), cbd(), { slotStart: '2026-10-01T08:37:00.000Z' })).rejects.toMatchObject({ code: 'invalid', message: 'That pickup time is not available.' });
    await expect(placeOrder(t, group(), cbd(), { slotStart: '2026-10-01T08:15:00.000Z' })).rejects.toMatchObject({ code: 'invalid', message: 'That pickup time is too soon. Choose a later one.' });
    const booked = await placeOrder(t, group(), cbd(), { slotStart: SLOT_1830 });
    expect(booked).toMatchObject({ requestedAsap: false });
    expect([booked.pickupSlotStart!.toISOString(), booked.promisedAt!.toISOString()]).toEqual([SLOT_1830, SLOT_1830]);
  });

  it('a slot that fills disappears from the picker and cannot be booked; ASAP times extend past it', async () => {
    const venue = group().venues.newtown!.id;
    await config(venue, { max_orders_per_slot: 2 });
    const at1830 = async () => (await slots({ venueId: venue })).slots.find((s) => s.start.toISOString() === SLOT_1830);

    expect((await at1830())?.remainingOrders).toBe(2);
    await paidOrder(t, group(), venue, { slotStart: SLOT_1830 });
    expect((await at1830())?.remainingOrders).toBe(1);
    const second = await paidOrder(t, group(), venue, { slotStart: SLOT_1830 });
    expect(await at1830()).toBeUndefined();

    const before = await t.db.selectFrom('orders').select('id').where('venue_id', '=', venue).execute();
    await expect(placeOrder(t, group(), venue, { slotStart: SLOT_1830 })).rejects.toMatchObject({ code: 'invalid', message: 'That pickup time has just filled. Choose another.' });
    const cart = await t.app.tenant(group().orgId, anon(), async (ctx) => ordering.priceCart(ctx, { venueId: venue, slotStart: SLOT_1830, lines: [{ menuItemId: (await menuOf(t, group(), venue)).plain().id, qty: 1 }] }));
    expect(cart.issues).toEqual([{ code: 'timing', message: 'That pickup time has just filled. Choose another.' }]);
    expect(await t.db.selectFrom('orders').select('id').where('venue_id', '=', venue).execute()).toHaveLength(before.length);

    // ASAP: the 6:15 slot takes two, then the quote jumps past the full 6:30 slot to 6:45.
    const a = await paidOrder(t, group(), venue);
    const b = await paidOrder(t, group(), venue);
    expect([hhmm(a.promisedAt!), hhmm(b.promisedAt!)]).toEqual(['18:20', '18:20']);
    const board = await slots({ venueId: venue });
    expect(hhmm(board.asap.promisedAt!)).toBe('18:45');
    expect(board.asap.estimateMinutes).toBe(45);
    const c = await placeOrder(t, group(), venue);
    expect(hhmm(c.promisedAt!)).toBe('18:45');
    expect(hhmm(c.pickupSlotStart!)).toBe('18:45');

    // A cancelled order gives its place back.
    const manager = await group().as('manager');
    await t.app.tenant(group().orgId, manager, (ctx) => ordering.updateOrderStatus(ctx, { orderId: second.id, status: 'cancelled', reason: 'Guest rang to cancel.' }));
    expect((await at1830())?.remainingOrders).toBe(1);
    await config(venue, { max_orders_per_slot: 8 });
  });

  it('an unpaid order holds its slot only until the hold ends, then it is cancelled and the slot returns', async () => {
    const venue = group().venues.bondi!.id;
    await config(venue, { max_orders_per_slot: 1, payment_hold_minutes: 15 });
    const at1900 = '2026-10-01T09:00:00.000Z';
    const has = async () => (await slots({ venueId: venue })).slots.some((s) => s.start.toISOString() === at1900);

    const order = await placeOrder(t, group(), venue, { slotStart: at1900 });
    expect(await has()).toBe(false);
    await drainJobs(t.app);
    expect((await footprint(t, order.id)).order.status).toBe('pending_payment');

    t.clock.advanceMinutes(16);
    await drainJobs(t.app);
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'cancelled', rejected_reason: 'Not paid in time.' });
    expect(f.history.map((h) => `${h.from_status}>${h.to_status}`).sort()).toEqual(['null>pending_payment', 'pending_payment>cancelled']);
    expect(await has()).toBe(true);
    // Too late to pay for it now, and nothing is charged.
    await expect(pay(t, group(), order, okCard())).rejects.toMatchObject({ code: 'conflict' });
    expect(t.sim.payment.charges.filter((c) => c.reference === order.reference)).toHaveLength(0);

    // A paid order is not touched by the same job.
    const kept = await paidOrder(t, group(), venue, { slotStart: at1900 });
    t.clock.advanceMinutes(20);
    await drainJobs(t.app);
    expect((await footprint(t, kept.id)).order.status).toBe('placed');
    t.clock.set(QUIET_EVENING);
    await config(venue, { max_orders_per_slot: 8 });
  });

  it('the item cap counts units across a slot; a closed kitchen takes no ASAP orders', async () => {
    const venue = cbd();
    await config(venue, { max_items_per_slot: 5 });
    const at1915 = '2026-10-01T09:15:00.000Z';
    const fries = (await menuOf(t, group(), venue)).plain();
    await paidOrder(t, group(), venue, { slotStart: at1915, lines: [{ menuItemId: fries.id, qty: 4 }] });
    const listed = async (itemCount: number) => (await slots({ venueId: venue, itemCount })).slots.some((s) => s.start.toISOString() === at1915);
    expect(await listed(1)).toBe(true);
    expect(await listed(2)).toBe(false);
    await expect(placeOrder(t, group(), venue, { slotStart: at1915, lines: [{ menuItemId: fries.id, qty: 2 }] })).rejects.toMatchObject({ code: 'invalid' });
    await config(venue, { max_items_per_slot: null });

    // 4:00 pm: between lunch and dinner. No ASAP, but tonight's slots are still on offer.
    t.clock.set('2026-10-01T06:00:00.000Z');
    const afternoon = await slots({ venueId: venue });
    expect(afternoon.asap).toEqual({ available: false, promisedAt: null, estimateMinutes: null, reason: 'The kitchen is closed right now.' });
    expect(hhmm(afternoon.slots[0]!.start)).toBe('18:00');
    await expect(placeOrder(t, group(), venue)).rejects.toMatchObject({ code: 'invalid', message: 'The kitchen is closed right now.' });
    expect((await placeOrder(t, group(), venue, { slotStart: '2026-10-01T08:00:00.000Z' })).status).toBe('pending_payment');

    // 9:50 pm: inside the cutoff before close.
    t.clock.set('2026-10-01T11:50:00.000Z');
    expect((await slots({ venueId: venue })).asap.available).toBe(false);
    await expect(placeOrder(t, group(), venue)).rejects.toMatchObject({ code: 'invalid' });

    // A venue that only takes scheduled pickups.
    t.clock.set(QUIET_EVENING);
    await config(venue, { asap_enabled: false });
    expect((await slots({ venueId: venue })).asap).toMatchObject({ available: false, reason: 'Choose a pickup time.' });
    await expect(placeOrder(t, group(), venue)).rejects.toMatchObject({ code: 'invalid', message: 'Choose a pickup time.' });
    await config(venue, { asap_enabled: true });
  });
});
