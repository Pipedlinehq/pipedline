import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { loyalty, offers, ordering } from '@ros/modules';
import { QUIET_EVENING, menuOf, pay, placeOrder } from '../commerce/helpers';
import { WORKER, balanceOf, earn, eventsNamed, guestOf, newGuest, newMember, pointsRows, resetProgram } from './helpers';

/**
 * The same adjusters, this time through the real ordering module: an order is created, paid
 * with the simulated card processor and refunded, and loyalty and offers are read back. The
 * contract-level tests in online.test.ts cover the rules; this covers the wiring.
 */
describe('loyalty and offers through a real checkout', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, WORKER, fn);
  let rewardId: string;
  let offerId: string;

  beforeAll(async () => {
    t.clock.set(QUIET_EVENING);
    await resetProgram(t, diner());
    rewardId = (await tenant((ctx) => loyalty.saveReward(ctx, { name: '$10 off', costPoints: 100, kind: 'fixed', valueCents: 1000 }))).id;
    offerId = (await tenant((ctx) => offers.saveOffer(ctx, { kind: 'comeback', name: 'Come back', discountKind: 'fixed', valueCents: 1000, codePrefix: 'OAK-C' }))).id;
  });

  const cart = async () => {
    const m = await menuOf(t, diner(), venueId());
    return [{ menuItemId: m.byName('Cheeseburger').id, qty: 2 }];
  };
  const refund = async (orderId: string) =>
    ordering.refundOrder(t.app, { orgId: diner().orgId, principal: await diner().as('manager') }, { orderId, reason: 'Guest cancelled', idempotencyKey: `refund-${randomUUID()}` });

  it('an offer code entered at checkout comes off the order, is used when the order is paid, and comes back on a full refund', async () => {
    const g = await newGuest(t, diner());
    const code = (await tenant((ctx) => offers.issueCode(ctx, { offerId, customerId: g.customerId, source: 'flow:winback' }))).code;
    const order = await placeOrder(t, diner(), venueId(), { lines: await cart(), codes: [code.code], customer: { name: 'Tess Tester', email: g.email } });
    expect(order).toMatchObject({ subtotalCents: 5200, discountCents: 1000, totalCents: 4200, customerId: g.customerId });
    // Placed is not paid: the code is still unused.
    expect((await t.db.selectFrom('offer_codes').select('status').where('id', '=', code.id).executeTakeFirstOrThrow()).status).toBe('issued');

    const paid = await pay(t, diner(), order);
    expect(paid.status).toBe('paid');
    const row = await t.db.selectFrom('offer_codes').selectAll().where('id', '=', code.id).executeTakeFirstOrThrow();
    const sale = await t.db.selectFrom('transactions').select(['id', 'total_cents']).where('order_id', '=', order.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'redeemed', redeemed_order_id: order.id, redeemed_transaction_id: sale.id, discount_applied_cents: 1000 });
    expect(await eventsNamed(t, diner().orgId, 'offer.redeemed', { code_id: code.id })).toMatchObject([{ properties: { via: 'online' } }]);
    const summary = await tenant((ctx) => offers.getOffersSummary(ctx));
    expect(summary.offers.find((o) => o.offerId === offerId)).toMatchObject({ redeemed: 1, revenueCents: 4200, discountCents: 1000 });

    // A second order cannot be placed with the used code.
    await expect(placeOrder(t, diner(), venueId(), { lines: await cart(), codes: [code.code], customer: { name: 'Tess Tester', email: g.email } })).rejects.toMatchObject({ code: 'invalid', message: 'That code has already been used.' });

    expect(await refund(order.id)).toMatchObject({ status: 'completed', full: true });
    expect(await t.db.selectFrom('offer_codes').select(['status', 'redeemed_order_id']).where('id', '=', code.id).executeTakeFirstOrThrow()).toEqual({ status: 'claimed', redeemed_order_id: null });
  });

  it('a member spends a reward at checkout: points burn when the order is paid, the order earns on what was paid, and a refund undoes both', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 150);
    const order = await placeOrder(t, diner(), venueId(), { lines: await cart(), codes: [loyalty.rewardCheckoutCode(rewardId)], customer: {} }, guestOf(m.customerId));
    expect(order).toMatchObject({ subtotalCents: 5200, discountCents: 1000, totalCents: 4200 });
    expect(await balanceOf(t, m.accountId)).toBe(150);

    expect((await pay(t, diner(), order)).status).toBe('paid');
    const sale = await t.db.selectFrom('transactions').select('id').where('order_id', '=', order.id).executeTakeFirstOrThrow();
    const redemption = await t.db.selectFrom('redemptions').selectAll().where('order_id', '=', order.id).executeTakeFirstOrThrow();
    expect(redemption).toMatchObject({ status: 'redeemed', channel: 'online', points: 100, transaction_id: sale.id, account_id: m.accountId });
    const rows = await pointsRows(t, m.accountId);
    expect(rows.find((p) => p.kind === 'burn')).toMatchObject({ points: -100, redemption_id: redemption.id });
    expect(rows.filter((p) => p.source_transaction_id === sale.id && p.kind === 'earn')).toMatchObject([{ points: 42 }]);
    expect(await balanceOf(t, m.accountId)).toBe(150 - 100 + 42);

    expect(await refund(order.id)).toMatchObject({ status: 'completed', full: true });
    expect((await t.db.selectFrom('redemptions').select('status').where('id', '=', redemption.id).executeTakeFirstOrThrow()).status).toBe('voided');
    expect(await balanceOf(t, m.accountId)).toBe(150);
    expect((await pointsRows(t, m.accountId)).filter((p) => p.redemption_id === redemption.id)).toHaveLength(2);
  });

  it('ticking the join box at checkout makes the guest a member once the order is paid, and that order earns', async () => {
    const email = `joiner.${randomUUID().slice(0, 8)}@loyalty.example`;
    const order = await placeOrder(t, diner(), venueId(), { lines: await cart(), customer: { name: 'Jo Joiner', email }, flags: [loyalty.LOYALTY_JOIN_FLAG] });
    expect(await t.db.selectFrom('loyalty_accounts').select('id').where('customer_id', '=', order.customerId!).execute()).toEqual([]);
    expect((await pay(t, diner(), order)).status).toBe('paid');
    const account = await t.db.selectFrom('loyalty_accounts').select(['id', 'enrolled_venue_id']).where('customer_id', '=', order.customerId!).executeTakeFirstOrThrow();
    expect(account.enrolled_venue_id).toBe(venueId());
    expect(await eventsNamed(t, diner().orgId, 'loyalty.enrolled', { account_id: account.id })).toMatchObject([{ properties: { via: 'checkout' } }]);
    expect(await pointsRows(t, account.id)).toMatchObject([{ kind: 'earn', points: 52 }]);
  });
});
