import { beforeAll, describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { loyalty, offers } from '@ros/modules';
import { checkoutAdjusters, getCheckoutAdjuster } from '@ros/modules/ordering';
import { WORKER, balanceOf, draft, earn, makeOrder, newGuest, newMember, pointsRows, resetProgram } from './helpers';

/**
 * Online redemption, driven through the ordering contract exactly as checkout drives it:
 * quote() while pricing, commit() once the order is paid, release() on a full refund.
 */
describe('checkout adjusters: loyalty rewards and offer codes online', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const loyaltyAdj = () => getCheckoutAdjuster('loyalty')!;
  const offersAdj = () => getCheckoutAdjuster('offers')!;
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], orgId = diner().orgId) => t.app.tenant(orgId, WORKER, fn);
  let rewardId: string;
  let welcomeId: string;

  beforeAll(async () => {
    await resetProgram(t, diner());
    await resetProgram(t, group());
    rewardId = (await tenant((ctx) => loyalty.saveReward(ctx, { name: '$10 off', costPoints: 100, kind: 'fixed', valueCents: 1000, minSpendCents: 3000 }))).id;
    welcomeId = (await tenant((ctx) => offers.saveOffer(ctx, { kind: 'comeback', name: 'Come back', discountKind: 'fixed', valueCents: 1000, minSpendCents: 4000, validityDays: 30, codePrefix: 'OAK-C', channels: ['pickup', 'dine-in-qr'] }))).id;
  });

  const snapshot = async (accountId?: string) => ({
    redemptions: Number((await t.db.selectFrom('redemptions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n),
    points: Number((await t.db.selectFrom('loyalty_transactions').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n),
    codes: await t.db.selectFrom('offer_codes').select(['id', 'status', 'claimed_at', 'redeemed_at', 'customer_id']).orderBy('id').execute(),
    events: Number((await t.db.selectFrom('events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n),
    balance: accountId ? await balanceOf(t, accountId) : null,
  });

  it('both adjusters are registered with ordering, and neither claims a code that is not its own', async () => {
    expect(checkoutAdjusters().map((a) => a.key)).toEqual(expect.arrayContaining(['loyalty', 'offers']));
    const d = draft(t, diner());
    expect(await tenant((ctx) => loyaltyAdj().quote(ctx, d, 'SUMMER10'))).toBeNull();
    expect(await tenant((ctx) => offersAdj().quote(ctx, d, 'SUMMER10'))).toBeNull();
    expect(await tenant((ctx) => offersAdj().quote(ctx, d, loyalty.rewardCheckoutCode(rewardId)))).toBeNull();
  });

  describe('a loyalty reward', () => {
    it('a quote prices the reward and changes nothing', async () => {
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 250);
      const before = await snapshot(m.accountId);
      const a = await tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, diner(), { customerId: m.customerId, subtotalCents: 6000 }), loyalty.rewardCheckoutCode(rewardId)));
      expect(a).toMatchObject({ adjuster: 'loyalty', amountCents: 1000, label: '$10 off (100 points)', ref: { rewardId, accountId: m.accountId } });
      // Quoting again and again is still nothing.
      await tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, diner(), { customerId: m.customerId }), loyalty.rewardCheckoutCode(rewardId)));
      expect(await snapshot(m.accountId)).toEqual(before);
    });

    it('a quote refuses, in plain words, what cannot be redeemed', async () => {
      const code = loyalty.rewardCheckoutCode(rewardId);
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 60);
      const q = (over: Parameters<typeof draft>[2]) => tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, diner(), over), code));
      await expect(q({})).rejects.toMatchObject({ code: 'invalid', message: 'Sign in to use your points.' });
      await expect(q({ customerId: m.customerId })).rejects.toMatchObject({ code: 'invalid', message: 'Not enough points: 60 available, 100 needed.' });
      await earn(t, diner(), m, 100);
      await expect(q({ customerId: m.customerId, subtotalCents: 2000 })).rejects.toMatchObject({ code: 'invalid', message: 'Spend $30.00 or more to use this reward.' });
      const stranger = await newGuest(t, diner());
      await expect(q({ customerId: stranger.customerId })).rejects.toMatchObject({ code: 'invalid' });
      // Points already promised to a counter code are not there to spend online.
      const host = await diner().as('host');
      await t.app.tenant(diner().orgId, host, (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId }));
      await expect(q({ customerId: m.customerId })).rejects.toMatchObject({ code: 'invalid', message: 'Not enough points: 60 available, 100 needed.' });
    });

    it('the points burn when the order is paid, once, however often the payment is confirmed; a refund gives them back once', async () => {
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 250);
      const d = draft(t, diner(), { customerId: m.customerId });
      const adjustment = (await tenant((ctx) => loyaltyAdj().quote(ctx, d, loyalty.rewardCheckoutCode(rewardId))))!;
      const orderId = await makeOrder(t, diner(), { customerId: m.customerId });
      const args = { orderId, venueId: diner().venueId, customerId: m.customerId, transactionId: null, adjustment };

      await tenant((ctx) => loyaltyAdj().commit(ctx, args));
      await tenant((ctx) => loyaltyAdj().commit(ctx, args));
      const rows = await t.db.selectFrom('redemptions').selectAll().where('order_id', '=', orderId).execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'redeemed', channel: 'online', points: 100, account_id: m.accountId, discount_cents: 1000, redeemed_venue_id: diner().venueId });
      expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toMatchObject([{ points: -100, redemption_id: rows[0]!.id }]);
      expect(await balanceOf(t, m.accountId)).toBe(150);

      await tenant((ctx) => loyaltyAdj().release!(ctx, { orderId, adjustment }));
      await tenant((ctx) => loyaltyAdj().release!(ctx, { orderId, adjustment }));
      expect(await balanceOf(t, m.accountId)).toBe(250);
      expect((await pointsRows(t, m.accountId)).filter((p) => p.redemption_id === rows[0]!.id)).toHaveLength(2);
      expect((await t.db.selectFrom('redemptions').select('status').where('order_id', '=', orderId).executeTakeFirstOrThrow()).status).toBe('voided');
      // A late replay of the payment confirmation after the refund does not spend them again.
      await tenant((ctx) => loyaltyAdj().commit(ctx, args));
      expect(await balanceOf(t, m.accountId)).toBe(250);
    });

    it('two orders paid at the same moment cannot overspend a balance', async () => {
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 150);
      const d = draft(t, diner(), { customerId: m.customerId });
      // Both carts were priced while the 150 points were all there.
      const a1 = (await tenant((ctx) => loyaltyAdj().quote(ctx, d, loyalty.rewardCheckoutCode(rewardId))))!;
      const a2 = (await tenant((ctx) => loyaltyAdj().quote(ctx, d, loyalty.rewardCheckoutCode(rewardId))))!;
      const o1 = await makeOrder(t, diner(), { customerId: m.customerId });
      const o2 = await makeOrder(t, diner(), { customerId: m.customerId });
      const results = await Promise.allSettled([
        tenant((ctx) => loyaltyAdj().commit(ctx, { orderId: o1, venueId: diner().venueId, customerId: m.customerId, transactionId: null, adjustment: a1 })),
        tenant((ctx) => loyaltyAdj().commit(ctx, { orderId: o2, venueId: diner().venueId, customerId: m.customerId, transactionId: null, adjustment: a2 })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
      expect(await balanceOf(t, m.accountId)).toBe(50);
      expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toHaveLength(1);
    });

    it('a commit for someone else\'s account, or from another org, spends nothing', async () => {
      const m = await newMember(t, diner());
      const thief = await newMember(t, diner());
      await earn(t, diner(), m, 200);
      const adjustment = (await tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, diner(), { customerId: m.customerId }), loyalty.rewardCheckoutCode(rewardId))))!;
      const orderId = await makeOrder(t, diner(), { customerId: thief.customerId });
      await expect(tenant((ctx) => loyaltyAdj().commit(ctx, { orderId, venueId: diner().venueId, customerId: thief.customerId, transactionId: null, adjustment }))).rejects.toMatchObject({ code: 'not_found' });
      const groupOrder = await makeOrder(t, group());
      await expect(tenant((ctx) => loyaltyAdj().commit(ctx, { orderId: groupOrder, venueId: group().venueId, customerId: null, transactionId: null, adjustment }), group().orgId)).rejects.toMatchObject({ code: 'not_found' });
      // The group has no such reward: to its checkout the code is simply not a code.
      expect(await tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, group()), loyalty.rewardCheckoutCode(rewardId)), group().orgId)).toBeNull();
      expect(await balanceOf(t, m.accountId)).toBe(200);
    });

    it('a free-item reward takes off the price of that item in the cart', async () => {
      const item = await t.db.selectFrom('menu_items').select(['id', 'price_cents']).where('org_id', '=', diner().orgId).where('name', '=', 'Fries, aioli').executeTakeFirstOrThrow();
      const free = await tenant((ctx) => loyalty.saveReward(ctx, { name: 'Free fries', costPoints: 80, kind: 'free_item', menuItemId: item.id }));
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 90);
      const code = loyalty.rewardCheckoutCode(free.id);
      await expect(tenant((ctx) => loyaltyAdj().quote(ctx, draft(t, diner(), { customerId: m.customerId }), code))).rejects.toMatchObject({ code: 'invalid', message: 'Add the free item to your order to use this reward.' });
      const withFries = draft(t, diner(), {
        customerId: m.customerId,
        subtotalCents: 3700,
        lines: [
          { menuItemId: item.id, name: 'Fries, aioli', category: 'Sides', qty: 1, unitPriceCents: item.price_cents, lineTotalCents: item.price_cents, isAlcohol: false },
          { menuItemId: item.id.replace(/^./, 'f'), name: 'Cheeseburger', category: 'Mains', qty: 1, unitPriceCents: 2600, lineTotalCents: 2600, isAlcohol: false },
        ],
      });
      expect(await tenant((ctx) => loyaltyAdj().quote(ctx, withFries, code))).toMatchObject({ amountCents: item.price_cents });
    });
  });

  describe('an offer code', () => {
    const issue = async (customerId: string | null, offerId = welcomeId) => (await tenant((ctx) => offers.issueCode(ctx, { offerId, customerId, source: 'flow:winback' }))).code;
    const codeRow = (id: string) => t.db.selectFrom('offer_codes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const commitArgs = async (code: Awaited<ReturnType<typeof issue>>, customerId: string | null, over: Partial<Parameters<typeof draft>[2]> = {}) => {
      const adjustment = (await tenant((ctx) => offersAdj().quote(ctx, draft(t, diner(), { customerId, ...over }), code.code)))!;
      const orderId = await makeOrder(t, diner(), { customerId });
      return { orderId, venueId: diner().venueId, customerId, transactionId: null, adjustment };
    };

    it('a quote prices the code and changes nothing; it is never applied by itself', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const before = await snapshot();
      const a = await tenant((ctx) => offersAdj().quote(ctx, draft(t, diner(), { customerId: g.customerId, subtotalCents: 6000 }), code.code.toLowerCase()));
      expect(a).toMatchObject({ adjuster: 'offers', code: code.code, amountCents: 1000, label: 'Come back: $10 off when you spend $40 or more', ref: { codeId: code.id, offerId: welcomeId } });
      // Before the guest has an identity at checkout the cart can still be priced.
      expect(await tenant((ctx) => offersAdj().quote(ctx, draft(t, diner()), code.code))).toMatchObject({ amountCents: 1000 });
      expect(await snapshot()).toEqual(before);
      expect(await codeRow(code.id)).toMatchObject({ status: 'issued', claimed_at: null, redeemed_at: null, redeemed_order_id: null });
    });

    it('a code is used once: the paid order takes it, a replay is the same use, a second order is refused', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const first = await commitArgs(code, g.customerId);
      const second = await commitArgs(code, g.customerId);
      await tenant((ctx) => offersAdj().commit(ctx, first));
      await tenant((ctx) => offersAdj().commit(ctx, first));
      expect(await codeRow(code.id)).toMatchObject({ status: 'redeemed', redeemed_order_id: first.orderId, redeemed_venue_id: diner().venueId, discount_applied_cents: 1000 });
      const events = await t.db.selectFrom('events').select('properties').where('name', '=', 'offer.redeemed').where('code', '=', code.code).execute();
      expect(events).toHaveLength(1);

      await expect(tenant((ctx) => offersAdj().commit(ctx, second))).rejects.toMatchObject({ code: 'conflict', message: 'That code has already been used.' });
      await expect(tenant((ctx) => offersAdj().quote(ctx, draft(t, diner(), { customerId: g.customerId }), code.code))).rejects.toMatchObject({ code: 'invalid', message: 'That code has already been used.' });
      expect((await codeRow(code.id)).redeemed_order_id).toBe(first.orderId);
    });

    it('two orders paid at the same moment with the same code: one takes it', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const a = await commitArgs(code, g.customerId);
      const b = await commitArgs(code, g.customerId);
      const results = await Promise.allSettled([tenant((ctx) => offersAdj().commit(ctx, a)), tenant((ctx) => offersAdj().commit(ctx, b))]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'conflict' });
    });

    it('a code cannot be used by another customer', async () => {
      const owner = await newGuest(t, diner());
      const other = await newGuest(t, diner());
      const code = await issue(owner.customerId);
      await expect(tenant((ctx) => offersAdj().quote(ctx, draft(t, diner(), { customerId: other.customerId }), code.code))).rejects.toMatchObject({ code: 'invalid', message: 'That code belongs to a different guest.' });
      const args = await commitArgs(code, owner.customerId);
      await expect(tenant((ctx) => offersAdj().commit(ctx, { ...args, customerId: other.customerId }))).rejects.toMatchObject({ code: 'conflict' });
      expect(await codeRow(code.id)).toMatchObject({ status: 'issued', customer_id: owner.customerId });
    });

    it('a code cannot be used at another org', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const args = await commitArgs(code, g.customerId);
      // To the group's checkout it is not a code at all, and a commit finds nothing to mark.
      expect(await tenant((ctx) => offersAdj().quote(ctx, draft(t, group()), code.code), group().orgId)).toBeNull();
      const groupOrder = await makeOrder(t, group());
      await expect(tenant((ctx) => offersAdj().commit(ctx, { ...args, orderId: groupOrder, venueId: group().venueId, customerId: null }), group().orgId)).rejects.toMatchObject({ code: 'not_found' });
      expect((await codeRow(code.id)).status).toBe('issued');
    });

    it('a code cannot be used once it has expired, except by an order that was priced in time and paid a few minutes late', async () => {
      const now = t.clock();
      try {
        const g = await newGuest(t, diner());
        const late = await issue(g.customerId);
        const priced = await commitArgs(late, g.customerId);
        const h = await newGuest(t, diner());
        const dead = await issue(h.customerId);
        const stale = await commitArgs(dead, h.customerId);

        t.clock.set(new Date(late.expiresAt.getTime() + 10 * 60_000));
        await expect(tenant((ctx) => offersAdj().quote(ctx, draft(t, diner(), { customerId: g.customerId }), late.code))).rejects.toMatchObject({ code: 'invalid', message: 'That code has expired.' });
        await tenant((ctx) => offersAdj().commit(ctx, priced));
        expect((await codeRow(late.id)).status).toBe('redeemed');

        t.clock.advanceMinutes(60);
        await expect(tenant((ctx) => offersAdj().commit(ctx, stale))).rejects.toMatchObject({ code: 'conflict', message: 'That code has expired.' });
        expect((await codeRow(dead.id)).redeemed_at).toBeNull();
      } finally {
        t.clock.set(now);
      }
    });

    it('a full refund gives the code back, once, and it can then be used again', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const args = await commitArgs(code, g.customerId);
      await tenant((ctx) => offersAdj().commit(ctx, args));
      await tenant((ctx) => offersAdj().release!(ctx, { orderId: args.orderId, adjustment: args.adjustment }));
      await tenant((ctx) => offersAdj().release!(ctx, { orderId: args.orderId, adjustment: args.adjustment }));
      expect(await codeRow(code.id)).toMatchObject({ status: 'claimed', redeemed_at: null, redeemed_order_id: null, discount_applied_cents: null });
      expect(await t.db.selectFrom('events').select('id').where('name', '=', 'offer.released').where('code', '=', code.code).execute()).toHaveLength(1);
      // Releasing for an order that did not use the code does nothing.
      const again = await commitArgs(code, g.customerId);
      await tenant((ctx) => offersAdj().commit(ctx, again));
      await tenant((ctx) => offersAdj().release!(ctx, { orderId: args.orderId, adjustment: args.adjustment }));
      expect(await codeRow(code.id)).toMatchObject({ status: 'redeemed', redeemed_order_id: again.orderId });
    });

    it('the offer\'s own rules are enforced: minimum spend, order type, venue, and a venue that does not take codes', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const q = (over: Parameters<typeof draft>[2], orgVenue = diner()) => tenant((ctx) => offersAdj().quote(ctx, draft(t, orgVenue, { customerId: g.customerId, ...over }), code.code));
      await expect(q({ subtotalCents: 3999 })).rejects.toMatchObject({ code: 'invalid', message: 'Spend $40.00 or more to use this code.' });
      await expect(q({ channel: 'delivery' })).rejects.toMatchObject({ code: 'invalid', message: 'That code cannot be used on this kind of order.' });

      const pct = await tenant((ctx) => offers.saveOffer(ctx, { kind: 'manual', name: 'Staff pick', discountKind: 'percent', percentOff: 15, validVenueIds: [group().venues.cbd!.id] }), group().orgId);
      const gg = await newGuest(t, group());
      const groupCode = (await tenant((ctx) => offers.issueCode(ctx, { offerId: pct.id, customerId: gg.customerId, source: 'staff' }), group().orgId)).code;
      const gq = (venueId: string) => tenant((ctx) => offersAdj().quote(ctx, draft(t, group(), { venueId, customerId: gg.customerId, subtotalCents: 5000 }), groupCode.code), group().orgId);
      expect(pct.validVenueIds).toEqual([group().venues.cbd!.id]);
      expect(await gq(group().venues.cbd!.id)).toMatchObject({ amountCents: 750 });
      await expect(gq(group().venues.newtown!.id)).rejects.toMatchObject({ code: 'invalid', message: 'That code cannot be used at this venue.' });

      await tenant((ctx) => setModule(ctx, offers.offersModule, { venueId: diner().venueId, config: { acceptHere: false } }));
      try {
        await expect(q({})).rejects.toMatchObject({ code: 'invalid', message: 'Codes cannot be used at this venue.' });
      } finally {
        await resetProgram(t, diner());
      }
    });
  });
});
