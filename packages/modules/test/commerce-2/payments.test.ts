import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { AppError, type ConnectionRow, drainJobs, setModule, tickSchedules } from '@ros/core';
import { SIM_PAY_TOKENS } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { ledger, offers, ordering, qr } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, pairScreen, pay, placeOrder } from './helpers';

/** Stands in for loyalty and offers: RACED is a code another order used between pricing and payment. */
const raced: { committed: string[]; released: string[] } = { committed: [], released: [] };
ordering.registerCheckoutAdjuster({
  key: 'race-promo',
  async quote(_ctx, _draft, code) {
    const c = code.toUpperCase();
    if (c === 'RACED' || c === 'FINE5') return { adjuster: 'race-promo', code: c, label: `${c}: $${c === 'RACED' ? 10 : 5} off`, amountCents: c === 'RACED' ? 1000 : 500, ref: { c } };
    return null;
  },
  async commit(ctx, args) {
    // Half a write, then the refusal: the savepoint must take the half back.
    await ctx.db.insertInto('audit_log').values({ org_id: ctx.orgId, actor_kind: 'test', action: `race-promo.half:${args.orderId}`, entity_type: 'order', occurred_at: ctx.now() }).execute();
    if (args.adjustment.code === 'RACED') throw new AppError('conflict', 'That code has already been used.');
    raced.committed.push(`${args.orderId}:${args.adjustment.code}`);
  },
  async release(_ctx, args) {
    raced.released.push(`${args.orderId}:${args.adjustment.code}`);
  },
});

describe('payments and ordering, hardened', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const charges = (reference: string) => t.sim.payment.charges.filter((c) => c.reference === reference);
  const captured = (reference: string) => t.sim.payment.captured().filter((c) => c.reference === reference);
  const reconcile = async () => {
    await tickSchedules(t.app, { only: ['ordering.reconcile_payments'] });
    await drainJobs(t.app);
  };
  beforeAll(() => t.clock.set(QUIET_EVENING));
  beforeEach(() => t.clock.set(QUIET_EVENING));

  it('a charge that timed out is found at the processor by reconciliation: one charge, the order paid, the kitchen and the guest told once', async () => {
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Tim Timeout', email: 'tim.timeout@example.com' } });
    await expect(pay(t, diner(), order, `${SIM_PAY_TOKENS.timeout}:tim`)).rejects.toMatchObject({ code: 'provider_error' });
    expect((await footprint(t, order.id)).payments.map((p) => p.status)).toEqual(['pending']);
    // A second card is never taken while the first might have charged.
    await expect(pay(t, diner(), order, okCard('other'))).rejects.toMatchObject({ code: 'conflict' });

    // Too soon to ask: an attempt still in flight must not be mistaken for a lost one.
    await reconcile();
    expect(t.sim.payment.lookups.filter((l) => l.reference === order.reference)).toHaveLength(0);
    t.clock.advanceMinutes(3);
    await reconcile();

    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'placed', payment_status: 'paid' });
    expect(f.payments.map((p) => p.status)).toEqual(['completed']);
    expect(f.transactions).toHaveLength(1);
    expect(f.tickets).toHaveLength(1);
    expect(captured(order.reference)).toHaveLength(1);
    const ev = await t.db.selectFrom('events').select('properties').where('name', '=', 'payment.reconciled').where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
    expect(ev.map((e) => e.properties)).toEqual([{ order_id: order.id, outcome: 'charged' }]);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((m) => m.to === 'tim.timeout@example.com' && m.subject?.includes('confirmed'))).toHaveLength(1);

    // The guest's phone comes back and pays again, with either card: already paid, nothing charged.
    expect(await pay(t, diner(), order, okCard('other'))).toMatchObject({ status: 'paid', replayed: true });
    expect(await pay(t, diner(), order, `${SIM_PAY_TOKENS.timeout}:tim`)).toMatchObject({ status: 'paid', replayed: true });
    expect(captured(order.reference)).toHaveLength(1);
    await reconcile();
    expect((await footprint(t, order.id)).transactions).toHaveLength(1);
  });

  it('a charge that timed out and really failed: a second card is accepted only once the processor has said so', async () => {
    const order = await placeOrder(t, diner(), venueId());
    await expect(pay(t, diner(), order, `${SIM_PAY_TOKENS.lost}:lou`)).rejects.toMatchObject({ code: 'provider_error' });
    await expect(pay(t, diner(), order, okCard('second'))).rejects.toMatchObject({ code: 'conflict' });
    // Refusing the second card queued a look at this order, for when the first attempt has had time to land.
    const queued = await t.db.selectFrom('jobs').select(['run_at', 'payload']).where('kind', '=', 'ordering.reconcile_payments').where(sql<boolean>`payload->>'orderId' = ${order.id}`).executeTakeFirstOrThrow();
    expect(queued.run_at.toISOString()).toBe('2026-10-01T08:02:00.000Z');
    await drainJobs(t.app);
    await expect(pay(t, diner(), order, okCard('second'))).rejects.toMatchObject({ code: 'conflict' });
    expect(charges(order.reference)).toHaveLength(0);

    t.clock.advanceMinutes(3);
    await drainJobs(t.app);
    let f = await footprint(t, order.id);
    expect(f.payments.map((p) => [p.status, p.failure_reason])).toEqual([['failed', 'not_charged']]);
    expect(f.order).toMatchObject({ status: 'pending_payment', payment_status: 'failed' });
    expect(t.sim.payment.lookups.filter((l) => l.reference === order.reference)).toHaveLength(1);

    expect((await pay(t, diner(), order, okCard('second'))).status).toBe('paid');
    f = await footprint(t, order.id);
    expect(f.order.payment_status).toBe('paid');
    expect(captured(order.reference)).toHaveLength(1);
    expect(f.transactions).toHaveLength(1);
  });

  it('a refund the processor answered as pending is completed by reconciliation: the ledger and the guest follow', async () => {
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Penny Pending', email: 'penny@example.com' } });
    await pay(t, diner(), order);
    t.sim.payment.setRefundMode('pending');
    const manager = { orgId: diner().orgId, principal: await diner().as('manager') };
    const r = await ordering.refundOrder(t.app, manager, { orderId: order.id, reason: 'Guest changed their mind.', idempotencyKey: `pending-${randomUUID()}` });
    expect(r).toMatchObject({ status: 'pending', full: false });
    expect((await footprint(t, order.id)).order.payment_status).toBe('paid');
    t.sim.payment.setRefundMode('completed');

    t.clock.advanceMinutes(2);
    await reconcile();
    expect((await footprint(t, order.id)).order.payment_status).toBe('paid'); // still pending at the processor
    t.sim.payment.settleRefunds();
    t.clock.advanceMinutes(5);
    await reconcile();
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'refunded', payment_status: 'refunded' });
    expect(f.transactions[0]).toMatchObject({ status: 'refunded', refunded_cents: 1100 });
    expect(await t.db.selectFrom('refunds').select('status').where('order_id', '=', order.id).execute()).toEqual([{ status: 'completed' }]);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((m) => m.to === 'penny@example.com' && m.subject?.includes('A refund'))).toHaveLength(1);
  });

  it('a code used by another order after the card was charged: the order stays paid at the price shown, the venue absorbs it, staff are flagged, it is audited', async () => {
    const m = await menuOf(t, diner(), venueId());
    const order = await placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: m.byName('Cheeseburger').id, qty: 1 }], codes: ['RACED', 'FINE5'] });
    expect(order).toMatchObject({ subtotalCents: 2600, discountCents: 1500, totalCents: 1100 });
    const paid = await pay(t, diner(), order);
    expect(paid.status).toBe('paid');
    if (paid.status !== 'paid') return;
    expect(paid.order).toMatchObject({ absorbedDiscountCents: 1000, attentionReason: expect.stringContaining('RACED') });

    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'placed', payment_status: 'paid', total_cents: 1100, absorbed_discount_cents: 1000, absorbed_codes: ['RACED'] });
    expect(f.order.attention_at).not.toBeNull();
    expect(f.tickets).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({ total_cents: 1100, discount_cents: 1500 });
    expect(captured(order.reference).map((c) => c.amountCents)).toEqual([1100]);
    // The code that was fine was used; the refused one left nothing half-written.
    expect(raced.committed).toEqual([`${order.id}:FINE5`]);
    const halves = await t.db.selectFrom('audit_log').select('action').where('action', '=', `race-promo.half:${order.id}`).execute();
    expect(halves).toHaveLength(1);
    const audit = await t.db.selectFrom('audit_log').select(['after', 'actor_kind']).where('action', '=', 'order.discount_absorbed').where('entity_id', '=', order.id).executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ absorbedCents: 1000, codes: [{ code: 'RACED', amountCents: 1000, reason: 'That code has already been used.' }] });
    const flagged = await t.db.selectFrom('events').select('properties').where('name', '=', 'order.flagged').where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
    expect(flagged).toHaveLength(1);
    const manager = await diner().as('manager');
    const list = await t.app.tenant(diner().orgId, manager, (ctx) => ordering.listOrders(ctx, { venueId: venueId(), needsAttention: true }));
    expect(list.map((o) => o.id)).toContain(order.id);
    await t.app.tenant(diner().orgId, manager, (ctx) => ordering.clearOrderAttention(ctx, order.id));
    expect((await footprint(t, order.id)).order.attention_at).toBeNull();

    // Refunded in full: only the code this order really used is given back.
    await ordering.refundOrder(t.app, { orgId: diner().orgId, principal: manager }, { orderId: order.id, reason: 'Wrong order.', idempotencyKey: `race-${randomUUID()}` });
    expect(raced.released).toEqual([`${order.id}:FINE5`]);
  });

  it('the same race with a real offer code: the second order to pay keeps its discount and is flagged', async () => {
    const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, WORKER, fn);
    await tenant((ctx) => setModule(ctx, offers.offersModule, { venueId: venueId(), enabled: true }));
    const offer = await tenant((ctx) => offers.saveOffer(ctx, { kind: 'comeback', name: 'Race test', discountKind: 'fixed', valueCents: 500, codePrefix: 'OAK-R' }));
    const email = `racer.${randomUUID().slice(0, 8)}@example.com`;
    const first = await placeOrder(t, diner(), venueId(), { customer: { name: 'Rae Racer', email } });
    const code = (await tenant((ctx) => offers.issueCode(ctx, { offerId: offer.id, customerId: first.customerId!, source: 'test' }))).code.code;
    const m = await menuOf(t, diner(), venueId());
    const lines = [{ menuItemId: m.byName('Cheeseburger').id, qty: 1 }];
    const a = await placeOrder(t, diner(), venueId(), { lines, codes: [code], customer: { name: 'Rae Racer', email } });
    const b = await placeOrder(t, diner(), venueId(), { lines, codes: [code], customer: { name: 'Rae Racer', email } });
    expect([a.discountCents, b.discountCents]).toEqual([500, 500]);
    expect((await pay(t, diner(), a)).status).toBe('paid');
    const second = await pay(t, diner(), b);
    expect(second.status).toBe('paid');
    const fb = await footprint(t, b.id);
    expect(fb.order).toMatchObject({ payment_status: 'paid', total_cents: 2100, absorbed_discount_cents: 500 });
    expect(fb.order.attention_reason).toContain(code);
    expect(fb.transactions).toHaveLength(1);
    const row = await t.db.selectFrom('offer_codes').select(['status', 'redeemed_order_id']).where('code', '=', code).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'redeemed', redeemed_order_id: a.id });
  });

  it('push to the POS after payment (with the payment ref): the till lists the sale as the platform\'s and ledger ingest counts it once', async () => {
    const conn = await t.db.selectFrom('connections').selectAll().where('venue_id', '=', venueId()).where('plug_key', '=', 'sim-pos').executeTakeFirstOrThrow();
    const order = await placeOrder(t, diner(), venueId());
    await pay(t, diner(), order);
    expect(t.sim.pos.pushedOrders.filter((p) => p.order.reference === order.reference)).toHaveLength(0);
    await drainJobs(t.app);
    const pushed = t.sim.pos.pushedOrders.filter((p) => p.order.reference === order.reference);
    expect(pushed).toHaveLength(1);
    const f = await footprint(t, order.id);
    expect(pushed[0]).toMatchObject({ state: 'paid', order: { paymentRef: f.payments[0]!.external_ref } });
    expect(f.order.pos_order_ref).toBe(pushed[0]!.posOrderRef);
    const sale = t.sim.pos.get(pushed[0]!.paymentId!)!;
    expect(sale).toMatchObject({ application: 'platform', total_money: { amount: 1100 } });

    const r = await ledger.ingestConnection(t.app, { orgId: diner().orgId, connectionId: conn.id });
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(await t.db.selectFrom('transactions').select('id').where('external_ref', '=', sale.id).execute()).toHaveLength(0);
    expect((await footprint(t, order.id)).transactions).toHaveLength(1);
  });

  it('push to the POS before payment (as Square needs): the payment names the order, the till shows it paid, the ledger counts it once, and a POS outage never stops the guest paying', async () => {
    const conn = (await t.db.selectFrom('connections').selectAll().where('venue_id', '=', venueId()).where('plug_key', '=', 'sim-pos').executeTakeFirstOrThrow()) as unknown as ConnectionRow;
    t.sim.pos.setOrderPush('before_payment');
    try {
      expect(ordering.orderPushMode(t.app, conn)).toBe('before_payment');
      const order = await placeOrder(t, diner(), venueId());
      await pay(t, diner(), order);
      const f = await footprint(t, order.id);
      const pushed = t.sim.pos.pushedOrders.filter((p) => p.order.reference === order.reference);
      expect(pushed).toHaveLength(1);
      expect(pushed[0]!.order.paymentRef ?? null).toBeNull();
      expect(f.order.pos_order_ref).toBe(pushed[0]!.posOrderRef);
      expect(charges(order.reference)[0]!.posOrderRef).toBe(pushed[0]!.posOrderRef);
      expect(pushed[0]!.state).toBe('paid');
      // Nothing is queued to push it again after payment.
      expect(await t.db.selectFrom('jobs').select('id').where('kind', '=', 'ordering.pos_push').where('idempotency_key', '=', `pos-push:${order.id}`).execute()).toHaveLength(0);
      const events = await t.db.selectFrom('events').select('name').where('name', '=', 'order.pushed_to_pos').where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
      expect(events).toHaveLength(1);

      const saleId = pushed[0]!.paymentId!;
      expect(t.sim.pos.get(saleId)).toMatchObject({ application: 'platform' });
      await ledger.ingestConnection(t.app, { orgId: diner().orgId, connectionId: conn.id });
      expect(await t.db.selectFrom('transactions').select('id').where('external_ref', '=', saleId).execute()).toHaveLength(0);
      expect((await footprint(t, order.id)).transactions).toHaveLength(1);

      // The POS is down at checkout: the guest still pays; staff are told to check the order.
      const down = await placeOrder(t, diner(), venueId());
      t.sim.pos.failNext(1);
      expect((await pay(t, diner(), down)).status).toBe('paid');
      const fd = await footprint(t, down.id);
      expect(fd.order).toMatchObject({ payment_status: 'paid', pos_order_ref: null });
      expect(fd.order.attention_reason).toContain('POS');
      expect(charges(down.reference)[0]!.posOrderRef).toBeNull();
    } finally {
      t.sim.pos.setOrderPush('after_payment');
    }
  });

  it('a venue can make turning orders down staff-only: the paired screen is refused, staff are not', async () => {
    const config = (screen_can_reject: boolean) => t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venueId(), config: { screen_can_reject } }));
    const screen = await pairScreen(t, diner(), venueId());
    const a = await placeOrder(t, diner(), venueId());
    await pay(t, diner(), a);
    await config(false);
    try {
      await expect(t.app.tenant(diner().orgId, screen, (ctx) => ordering.updateOrderStatus(ctx, { orderId: a.id, status: 'rejected', reason: 'Out of buns.' }))).rejects.toMatchObject({ code: 'forbidden' });
      expect((await footprint(t, a.id)).order.status).toBe('placed');
      // The screen can still accept it; staff can still reject.
      const b = await placeOrder(t, diner(), venueId());
      await pay(t, diner(), b);
      expect((await t.app.tenant(diner().orgId, screen, (ctx) => ordering.updateOrderStatus(ctx, { orderId: b.id, status: 'accepted' }))).status).toBe('accepted');
      const host = await diner().as('host');
      expect((await t.app.tenant(diner().orgId, host, (ctx) => ordering.updateOrderStatus(ctx, { orderId: a.id, status: 'rejected', reason: 'Out of buns.' }))).status).toBe('rejected');
    } finally {
      await config(true);
    }
    const c = await placeOrder(t, diner(), venueId());
    await pay(t, diner(), c);
    expect((await t.app.tenant(diner().orgId, screen, (ctx) => ordering.updateOrderStatus(ctx, { orderId: c.id, status: 'rejected', reason: 'Out of buns.' }))).status).toBe('rejected');
  });

  it('rate limits: paying, following an order and scanning a code, per address', async () => {
    const payAt = (ip: string) => ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon(), ip }, { trackingToken: 'x'.repeat(40), sourceToken: okCard() });
    for (let i = 0; i < 30; i++) await expect(payAt('198.51.100.1')).rejects.toMatchObject({ code: 'not_found' });
    await expect(payAt('198.51.100.1')).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    await expect(payAt('198.51.100.2')).rejects.toMatchObject({ code: 'not_found' });

    const trackAt = (ip: string) => t.app.tenant(diner().orgId, anon(), (ctx) => ordering.trackOrder(ctx, 'y'.repeat(40)), { ip });
    for (let i = 0; i < 120; i++) await expect(trackAt('198.51.100.3')).rejects.toMatchObject({ code: 'not_found' });
    await expect(trackAt('198.51.100.3')).rejects.toMatchObject({ code: 'rate_limited' });

    const scanAt = (ip: string) => t.app.tenant(diner().orgId, anon(), (ctx) => qr.resolveQrCode(ctx, { code: 'nosuchcode1' }), { ip });
    for (let i = 0; i < 60; i++) await expect(scanAt('198.51.100.4')).rejects.toMatchObject({ code: 'not_found' });
    await expect(scanAt('198.51.100.4')).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(scanAt('198.51.100.5')).rejects.toMatchObject({ code: 'not_found' });
  });
});
