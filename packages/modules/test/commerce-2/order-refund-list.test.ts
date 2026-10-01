import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ordering } from '@ros/modules';
import { QUIET_EVENING, paidOrder } from '../commerce/helpers';

describe('ordering.listOrderRefunds: the refunds on an order, for the console timeline', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('lists a manual part refund with who sent it, then the automatic refund that follows a cancellation', async () => {
    const order = await paidOrder(t, diner(), diner().venueId);
    const manager = { orgId: diner().orgId, principal: await diner().as('manager') };
    await t.app.tenant(manager.orgId, manager.principal, (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'accepted' }));
    const first = await ordering.refundOrder(t.app, manager, { orderId: order.id, amountCents: 200, reason: 'One item was missing.', idempotencyKey: randomUUID() });
    expect(first.status).toBe('completed');

    t.clock.advanceMinutes(1);
    await t.app.tenant(manager.orgId, manager.principal, (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'cancelled', reason: 'The kitchen closed early.' }));
    await drainJobs(t.app);

    const refunds = await t.app.tenant(manager.orgId, manager.principal, (ctx) => ordering.listOrderRefunds(ctx, order.id));
    expect(refunds).toHaveLength(2);
    expect(refunds[0]).toMatchObject({ id: first.refundId, amountCents: 200, status: 'completed', reason: 'One item was missing.', automatic: false });
    expect(refunds[0]!.byStaffName).toBeTruthy();
    expect(refunds[1]).toMatchObject({ amountCents: order.totalCents - 200, status: 'completed', reason: 'The kitchen closed early.' });
    expect(refunds[0]!.requestedAt.getTime()).toBeLessThan(refunds[1]!.requestedAt.getTime());

    // It agrees with the database, row for row.
    const rows = await t.db.selectFrom('refunds').select(['id', 'amount_cents']).where('order_id', '=', order.id).orderBy('created_at').execute();
    expect(refunds.map((r) => [r.id, r.amountCents])).toEqual(rows.map((r) => [r.id, r.amount_cents]));
  });

  it('a refund that could not be sent is listed as failed, with why', async () => {
    const order = await paidOrder(t, diner(), diner().venueId);
    const manager = { orgId: diner().orgId, principal: await diner().as('manager') };
    t.sim.payment.failNext(1, 'processor outage');
    await ordering.refundOrder(t.app, manager, { orderId: order.id, amountCents: 100, reason: 'Goodwill.', idempotencyKey: randomUUID() }).catch(() => undefined);
    const refunds = await t.app.tenant(manager.orgId, manager.principal, (ctx) => ordering.listOrderRefunds(ctx, order.id));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ status: 'failed', amountCents: 100, automatic: false });
    expect(refunds[0]!.failureReason).toBeTruthy();
  });

  it('any staff at the venue may read it; another org, a guest and a venue the caller has no role at may not', async () => {
    const order = await paidOrder(t, diner(), diner().venueId);
    const manager = { orgId: diner().orgId, principal: await diner().as('manager') };
    await ordering.refundOrder(t.app, manager, { orderId: order.id, amountCents: 100, reason: 'Goodwill.', idempotencyKey: randomUUID() });

    const kitchen = await diner().as('kitchen');
    expect(await t.app.tenant(diner().orgId, kitchen, (ctx) => ordering.listOrderRefunds(ctx, order.id))).toHaveLength(1);

    const otherOrg = await t.fixture.group.as('owner');
    await expect(t.app.tenant(t.fixture.group.orgId, otherOrg, (ctx) => ordering.listOrderRefunds(ctx, order.id))).rejects.toMatchObject({ code: 'not_found' });

    // A group order at Bondi, asked for by the manager of the other two venues: not found, not forbidden.
    const group = t.fixture.group;
    const bondi = await paidOrder(t, group, group.venues.bondi!.id);
    const twoVenueManager = await group.as('manager');
    await expect(t.app.tenant(group.orgId, twoVenueManager, (ctx) => ordering.listOrderRefunds(ctx, bondi.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner().orgId, { kind: 'anon' }, (ctx) => ordering.listOrderRefunds(ctx, order.id))).rejects.toMatchObject({ code: expect.stringMatching(/unauthenticated|forbidden|not_found/) });
    await expect(t.app.tenant(diner().orgId, manager.principal, (ctx) => ordering.listOrderRefunds(ctx, 'not-an-id'))).rejects.toBeTruthy();
  });
});
