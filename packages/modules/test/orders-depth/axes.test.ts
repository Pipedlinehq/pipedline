import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { ordering } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, menuOf, okCard, pay, placeOrder } from '../commerce/helpers';
import { paidDelivery } from '../commerce-2/helpers';

/**
 * The three status axes of an order (docs/COMMERCE_ADMIN_PATTERNS.md pattern 2): kitchen, money
 * and how it leaves, each derived from the order's own columns, plus where it came from. The
 * pure derivation is checked for every status, then the list filters on each axis are read back
 * against real orders.
 */
describe('order status axes', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  beforeAll(() => t.clock.set(QUIET_EVENING));
  beforeEach(() => t.clock.set(QUIET_EVENING));

  it('derives the kitchen axis from status and channel for every status', () => {
    const k = (status: ordering.OrderStatus, channel: ordering.OrderChannel = 'pickup') => ordering.kitchenOf({ status, channel });
    expect(k('draft')).toBe('none');
    expect(k('pending_payment')).toBe('none');
    expect(k('placed')).toBe('new');
    expect(k('accepted')).toBe('accepted');
    expect(k('preparing')).toBe('cooking');
    expect(k('ready')).toBe('ready');
    expect(k('completed', 'pickup')).toBe('collected');
    expect(k('completed', 'delivery')).toBe('delivered');
    expect(k('completed', 'dine-in-qr')).toBe('served');
    expect(k('rejected')).toBe('stopped');
    expect(k('cancelled')).toBe('stopped');
    expect(k('refunded')).toBe('stopped');
    // Every kitchen axis maps back to statuses, and the handed-over ones to a channel.
    for (const axis of ordering.KITCHEN_AXES) expect(ordering.kitchenStatuses(axis).length).toBeGreaterThan(0);
    expect(ordering.kitchenChannel('collected')).toBe('pickup');
    expect(ordering.kitchenChannel('delivered')).toBe('delivery');
    expect(ordering.kitchenChannel('served')).toBe('dine-in-qr');
    expect(ordering.kitchenChannel('ready')).toBeNull();
  });

  it('derives the money axis from payment status, status and source for every combination', () => {
    const m = (payment_status: ordering.OrderPaymentStatus, status: ordering.OrderStatus, source: ordering.OrderSource = 'website') => ordering.moneyOf({ payment_status, status, source });
    for (const status of ['draft', 'pending_payment', 'placed', 'accepted', 'preparing', 'ready', 'completed', 'rejected', 'cancelled', 'refunded'] as ordering.OrderStatus[]) {
      expect(m('paid', status)).toBe('paid');
      expect(m('partially_refunded', status)).toBe('partly_refunded');
      expect(m('refunded', status)).toBe('refunded');
      for (const unpaid of ['unpaid', 'failed'] as ordering.OrderPaymentStatus[]) {
        const stopped = status === 'cancelled' || status === 'rejected' || status === 'refunded';
        expect(m(unpaid, status, 'website')).toBe(stopped ? 'voided' : 'unpaid');
        expect(m(unpaid, status, 'qr')).toBe(stopped ? 'voided' : 'unpaid');
        expect(m(unpaid, status, 'assistant')).toBe(stopped ? 'voided' : 'unpaid');
        // A phone or function order nobody has paid is due, not merely unpaid.
        expect(m(unpaid, status, 'phone')).toBe(stopped ? 'voided' : 'due');
      }
    }
    expect(ordering.leavesOf('pickup')).toBe('pickup');
    expect(ordering.leavesOf('dine-in-qr')).toBe('table');
    expect(ordering.leavesOf('delivery')).toBe('delivery');
    expect(ordering.channelOf('table')).toBe('dine-in-qr');
    expect(ordering.axesOf({ status: 'placed', payment_status: 'paid', channel: 'dine-in-qr', source: 'qr' })).toEqual({ kitchen: 'new', money: 'paid', leaves: 'table', source: 'qr' });
  });

  it('an order carries its axes and source through its life: website pickup, table order, delivery, and a guest\'s assistant', async () => {
    const manager = await diner().as('manager');
    const staff = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, manager, fn);

    // Website pickup: unpaid and not with the kitchen, then new and paid, through to collected.
    const web = await placeOrder(t, diner(), venueId());
    expect(web).toMatchObject({ source: 'website', axes: { kitchen: 'none', money: 'unpaid', leaves: 'pickup', source: 'website' } });
    expect((await t.db.selectFrom('orders').select('source').where('id', '=', web.id).executeTakeFirstOrThrow()).source).toBe('website');
    const paid = await pay(t, diner(), web);
    expect(paid.status).toBe('paid');
    expect(paid.status === 'paid' && paid.order.axes).toEqual({ kitchen: 'new', money: 'paid', leaves: 'pickup', source: 'website' });
    const steps: Array<['accepted' | 'preparing' | 'ready' | 'completed', ordering.KitchenAxis]> = [
      ['accepted', 'accepted'],
      ['preparing', 'cooking'],
      ['ready', 'ready'],
      ['completed', 'collected'],
    ];
    for (const [status, axis] of steps) {
      const moved = await staff((ctx) => ordering.updateOrderStatus(ctx, { orderId: web.id, status }));
      expect(moved.axes).toMatchObject({ kitchen: axis, money: 'paid' });
    }

    // A table order comes from a QR code, leaves at the table, and is served.
    const codes = await t.db.selectFrom('qr_codes').select('code').where('venue_id', '=', venueId()).where('kind', '=', 'table').execute();
    const table = await placeOrder(t, diner(), venueId(), { channel: 'dine-in-qr', qrCode: codes[0]!.code, customer: {} });
    expect(table).toMatchObject({ source: 'qr', axes: { kitchen: 'none', money: 'unpaid', leaves: 'table', source: 'qr' } });
    await pay(t, diner(), table);
    for (const status of ['accepted', 'preparing', 'ready', 'completed'] as const) await staff((ctx) => ordering.updateOrderStatus(ctx, { orderId: table.id, status }));
    expect((await staff((ctx) => ordering.getOrder(ctx, table.id))).axes.kitchen).toBe('served');

    // A delivery is delivered.
    const { order: drop } = await paidDelivery(t, diner(), venueId());
    expect(drop.axes).toEqual({ kitchen: 'new', money: 'paid', leaves: 'delivery', source: 'website' });
    await t.app.tenant(diner().orgId, WORKER, (ctx) => ordering.completeOrderByCourier(ctx, drop.id));
    expect((await staff((ctx) => ordering.getOrder(ctx, drop.id))).axes.kitchen).toBe('delivered');

    // A cart a guest's assistant handed to the order page says so, and only website or assistant are accepted from the page.
    const m = await menuOf(t, diner(), venueId());
    const viaAssistant = await t.app.tenant(diner().orgId, anon(), (ctx) =>
      ordering.createOrder(ctx, { venueId: venueId(), channel: 'pickup', lines: [{ menuItemId: m.plain().id, qty: 1 }], idempotencyKey: `test-${randomUUID()}`, customer: { name: 'Ava Assistant', email: 'ava@example.com' }, source: 'assistant' }),
    );
    expect(viaAssistant.source).toBe('assistant');
    await expect(
      t.app.tenant(diner().orgId, anon(), (ctx) =>
        ordering.createOrder(ctx, { venueId: venueId(), channel: 'pickup', lines: [{ menuItemId: m.plain().id, qty: 1 }], idempotencyKey: `test-${randomUUID()}`, customer: { name: 'P', email: 'p@example.com' }, source: 'phone' as never }),
      ),
    ).rejects.toThrow();

    // Cancelled before paying: taken off, voided.
    const dropped = await placeOrder(t, diner(), venueId());
    await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.cancelUnpaidOrder(ctx, dropped.trackingToken!));
    expect((await staff((ctx) => ordering.getOrder(ctx, dropped.id))).axes).toMatchObject({ kitchen: 'stopped', money: 'voided' });

    // Each axis is a filter. The default list leaves unpaid checkouts out; asking for them brings them in.
    const list = (input: Partial<Parameters<typeof ordering.listOrders>[1]>) => staff((ctx) => ordering.listOrders(ctx, { venueId: venueId(), limit: 200, ...input }));
    const ids = (rows: ordering.OrderView[]) => rows.map((o) => o.id);
    expect(ids(await list({ source: ['assistant'] }))).toEqual([]);
    expect(ids(await list({ source: ['assistant'], money: ['unpaid'] }))).toEqual([viaAssistant.id]);
    expect(ids(await list({ kitchen: ['served'] }))).toContain(table.id);
    expect(ids(await list({ kitchen: ['served'] }))).not.toContain(web.id);
    expect(ids(await list({ kitchen: ['collected'] }))).toContain(web.id);
    expect(ids(await list({ kitchen: ['delivered'] }))).toEqual([drop.id]);
    expect(ids(await list({ leaves: ['table'] }))).toContain(table.id);
    expect(ids(await list({ leaves: ['table'] }))).not.toContain(web.id);
    expect(ids(await list({ money: ['voided'] }))).toContain(dropped.id);
    expect(ids(await list({}))).not.toContain(viaAssistant.id);
    expect(ids(await list({ kitchen: ['none'] }))).toContain(viaAssistant.id);
    expect(ids(await list({ money: ['paid'], leaves: ['pickup'], source: ['website'] }))).toContain(web.id);
    // The table order's payment was by card too; "due" is for phone orders only, so nothing is due yet.
    expect(await list({ money: ['due'] })).toEqual([]);
    expect(okCard()).toMatch(/^tok_sim_ok:/);
  });
});
