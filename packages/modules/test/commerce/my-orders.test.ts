import { beforeAll, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { ordering } from '@ros/modules';
import { QUIET_EVENING, anon, pay, placeOrder } from './helpers';

/** The guest's own order history, for the account page on the venue's site. */
describe('ordering: a guest lists their own orders', () => {
  const t = useTestEnv();
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('returns only the signed-in guest\'s orders, newest first, with their tracking handle', async () => {
    const diner = t.fixture.diner;
    const email = `mine.${Date.now()}@example.com`;
    const first = await placeOrder(t, diner, diner.venueId, { customer: { name: 'Mia Mine', email } });
    await pay(t, diner, first);
    t.clock.advanceMinutes(5);
    const second = await placeOrder(t, diner, diner.venueId, { customer: { name: 'Mia Mine', email } });
    const someoneElse = await placeOrder(t, diner, diner.venueId);

    const me = { kind: 'guest' as const, customerId: first.customerId! };
    const mine = await t.app.tenant(diner.orgId, me, (ctx) => ordering.listMyOrders(ctx));
    expect(mine.map((o) => o.reference)).toEqual([second.reference, first.reference]);
    expect(mine[1]).toMatchObject({ status: 'placed', paymentStatus: 'paid', totalCents: first.totalCents, trackingToken: first.trackingToken });
    expect(mine[0]).toMatchObject({ status: 'pending_payment', items: [{ name: first.items[0]!.name, qty: 1 }] });
    expect(mine.map((o) => o.reference)).not.toContain(someoneElse.reference);

    // Row read back: the list is exactly the customer's orders in the table.
    const rows = await t.db.selectFrom('orders').select('reference').where('customer_id', '=', first.customerId!).execute();
    expect(rows.map((r) => r.reference).sort()).toEqual(mine.map((o) => o.reference).sort());
  });

  it('an anonymous visitor cannot list anything, and another org sees none of them', async () => {
    const diner = t.fixture.diner;
    await expect(t.app.tenant(diner.orgId, anon(), (ctx) => ordering.listMyOrders(ctx))).rejects.toMatchObject({ code: 'unauthenticated' });
    const order = await placeOrder(t, diner, diner.venueId);
    const guest = { kind: 'guest' as const, customerId: order.customerId! };
    // The same customer id presented at another org's site finds nothing (row-level security).
    expect(await t.app.tenant(t.fixture.group.orgId, guest, (ctx) => ordering.listMyOrders(ctx))).toEqual([]);
  });
});
