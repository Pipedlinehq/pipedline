import { beforeAll, describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { identity, loyalty } from '@ros/modules';
import { WORKER, balanceOf, earn, eventsNamed, newGuest, newMember, pointsRows, record, resetProgram, sale } from './helpers';

describe('loyalty: earning comes from the ledger', () => {
  const t = useTestEnv();
  beforeAll(async () => {
    await resetProgram(t, t.fixture.diner);
    await resetProgram(t, t.fixture.group);
  });
  const diner = () => t.fixture.diner;
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) => t.app.tenant(diner().orgId, principal, fn);

  it('a known guest earns with nothing done at the till, once, however many times the sale is delivered', async () => {
    const m = await newMember(t, diner(), { phone: true });
    // All the till knows is the phone number on the sale.
    const txn = sale(t, { cents: 5900, identityHints: [{ kind: 'phone', value: m.phone! }] });
    const first = await record(t, diner(), txn);
    await record(t, diner(), txn);
    await record(t, diner(), { ...txn });
    // Even calling the earning function directly for the same sale changes nothing.
    await tenant((ctx) => loyalty.earnForSale(ctx, { id: first.transaction.id, venueId: diner().venueId, customerId: m.customerId, occurredAt: txn.occurredAt, channel: 'dine-in', status: 'completed', totalCents: 5900, refundedCents: 0, subtotalCents: 5900, discountCents: 0 }));

    const rows = await pointsRows(t, m.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'earn', points: 59, source_transaction_id: first.transaction.id, idempotency_key: `earn:${first.transaction.id}`, venue_id: diner().venueId });
    expect(await balanceOf(t, m.accountId)).toBe(59);
    expect(await eventsNamed(t, diner().orgId, 'loyalty.earned', { transaction_id: first.transaction.id })).toHaveLength(1);
  });

  it('a full refund takes every point back, and a replayed refund takes nothing more', async () => {
    const m = await newMember(t, diner());
    const txn = sale(t, { cents: 5900, identityHints: [{ kind: 'email', value: m.email }] });
    await record(t, diner(), txn);
    expect(await balanceOf(t, m.accountId)).toBe(59);
    const refunded = { ...txn, status: 'refunded' as const, refundedCents: 5900 };
    await record(t, diner(), refunded);
    await record(t, diner(), refunded);
    const rows = await pointsRows(t, m.accountId);
    expect(rows.map((r) => [r.kind, r.points])).toEqual([['earn', 59], ['reverse', -59]]);
    expect(await balanceOf(t, m.accountId)).toBe(0);
  });

  it('a partial refund reverses in proportion, in steps, and never more than was earned', async () => {
    const m = await newMember(t, diner());
    const txn = sale(t, { cents: 10_000, identityHints: [{ kind: 'email', value: m.email }] });
    const r = await record(t, diner(), txn);
    expect(await balanceOf(t, m.accountId)).toBe(100);
    await record(t, diner(), { ...txn, status: 'partially_refunded', refundedCents: 2500 });
    expect(await balanceOf(t, m.accountId)).toBe(75);
    await record(t, diner(), { ...txn, status: 'partially_refunded', refundedCents: 2500 });
    expect(await balanceOf(t, m.accountId)).toBe(75);
    await record(t, diner(), { ...txn, status: 'partially_refunded', refundedCents: 5000 });
    expect(await balanceOf(t, m.accountId)).toBe(50);
    await record(t, diner(), { ...txn, status: 'refunded', refundedCents: 10_000 });
    expect(await balanceOf(t, m.accountId)).toBe(0);
    const reversed = await eventsNamed(t, diner().orgId, 'loyalty.earn_reversed', { transaction_id: r.transaction.id });
    expect(reversed.map((e) => (e.properties as { points: number }).points)).toEqual([25, 25, 50]);
  });

  it('a sale first seen already partly refunded earns only the share that was kept', async () => {
    const m = await newMember(t, diner());
    await record(t, diner(), sale(t, { cents: 8000, status: 'partially_refunded', refundedCents: 2000, identityHints: [{ kind: 'email', value: m.email }] }));
    expect(await balanceOf(t, m.accountId)).toBe(60);
  });

  it('points are on what was paid for food and drink: a discount earns nothing, a pending sale waits', async () => {
    const m = await newMember(t, diner());
    await record(t, diner(), sale(t, { cents: 5000, discountCents: 1000, identityHints: [{ kind: 'email', value: m.email }] }));
    expect(await balanceOf(t, m.accountId)).toBe(40);
    const pending = sale(t, { cents: 3000, status: 'pending', identityHints: [{ kind: 'email', value: m.email }] });
    await record(t, diner(), pending);
    expect(await balanceOf(t, m.accountId)).toBe(40);
    await record(t, diner(), { ...pending, status: 'completed' });
    expect(await balanceOf(t, m.accountId)).toBe(70);
  });

  it('a sale that gains its customer later earns then', async () => {
    const m = await newMember(t, diner(), { phone: true });
    // The tap arrives with nobody attached.
    const txn = sale(t, { cents: 4200 });
    const anon = await record(t, diner(), txn);
    expect(anon.transaction.customerId).toBeNull();
    expect(await balanceOf(t, m.accountId)).toBe(0);
    // The same sale is delivered again, this time with the phone number staff attached.
    const late = await record(t, diner(), { ...txn, identityHints: [{ kind: 'phone', value: m.phone! }] });
    expect(late).toMatchObject({ created: false, changed: true });
    expect(late.transaction.customerId).toBe(m.customerId);
    expect(await balanceOf(t, m.accountId)).toBe(42);
    expect(await pointsRows(t, m.accountId)).toHaveLength(1);
  });

  it('a sale made under a duplicate record earns when the two records are merged', async () => {
    const m = await newMember(t, diner());
    t.clock.advanceMinutes(1);
    // The same person pays by phone number at the till: a second, unenrolled record.
    const phone = '+61498000111';
    const dup = await record(t, diner(), sale(t, { cents: 7700, identityHints: [{ kind: 'phone', value: phone }] }));
    expect(dup.transaction.customerId).not.toBe(m.customerId);
    expect(await balanceOf(t, m.accountId)).toBe(0);

    // They sign in with both: identity proves the two records are one person and merges them.
    const joined = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: m.email }, { kind: 'phone', value: phone }], via: 'guest_login' }));
    expect(joined.customerId).toBe(m.customerId);
    expect(joined.mergedFrom).toEqual([dup.transaction.customerId]);

    const rows = await pointsRows(t, m.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'earn', points: 77, source_transaction_id: dup.transaction.id });
  });

  it('nobody earns who should not: an anonymous sale, a guest who has not joined, a suspended member', async () => {
    const before = await t.db.selectFrom('loyalty_transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', diner().orgId).executeTakeFirstOrThrow();
    await record(t, diner(), sale(t, { cents: 5000 }));
    const stranger = await newGuest(t, diner());
    await record(t, diner(), sale(t, { cents: 5000, identityHints: [{ kind: 'email', value: stranger.email }] }));
    const m = await newMember(t, diner());
    const manager = await diner().as('manager');
    await tenant((ctx) => loyalty.setMemberStatus(ctx, { accountId: m.accountId, status: 'suspended', reason: 'Disputed chargebacks' }), manager);
    await record(t, diner(), sale(t, { cents: 5000, identityHints: [{ kind: 'email', value: m.email }] }));
    const after = await t.db.selectFrom('loyalty_transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', diner().orgId).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
  });

  it('a venue with loyalty switched off, or set not to earn, does not earn; the group\'s other venues still do', async () => {
    const group = t.fixture.group;
    const m = await newMember(t, group, { venueId: group.venues.cbd!.id });
    const bondi = group.venues.bondi!.id;
    const newtown = group.venues.newtown!.id;
    await t.app.tenant(group.orgId, WORKER, async (ctx) => {
      await setModule(ctx, loyalty.loyaltyModule, { venueId: bondi, enabled: false });
      await setModule(ctx, loyalty.loyaltyModule, { venueId: newtown, config: { earnHere: false } });
    });
    try {
      await earn(t, group, m, 30, bondi);
      await earn(t, group, m, 30, newtown);
      expect(await balanceOf(t, m.accountId)).toBe(0);
      await earn(t, group, m, 30, group.venues.cbd!.id);
      expect(await balanceOf(t, m.accountId)).toBe(30);
    } finally {
      await resetProgram(t, group);
    }
  });

  it('the rounding rule and the tier multiplier are applied, and earning moves the tier', async () => {
    const owner = await diner().as('owner');
    try {
      await tenant(async (ctx) => {
        await loyalty.saveProgram(ctx, { name: 'Test Rewards', pointsPerDollar: 1.5, pointsRounding: 'ceil', pointValueCents: 1 });
        await loyalty.saveTier(ctx, { name: 'Member', thresholdPoints: 0, multiplier: 1 });
        await loyalty.saveTier(ctx, { name: 'Gold', thresholdPoints: 100, windowMonths: 12, multiplier: 2, perks: ['A free coffee on Sundays'] });
      }, owner);
      const m = await newMember(t, diner());
      const tierOf = async () => (await t.db.selectFrom('loyalty_accounts as a').leftJoin('loyalty_tiers as lt', 'lt.id', 'a.tier_id').select('lt.name').where('a.id', '=', m.accountId).executeTakeFirstOrThrow()).name;
      expect(await tierOf()).toBe('Member');

      await record(t, diner(), sale(t, { cents: 5950, identityHints: [{ kind: 'email', value: m.email }] }));
      expect(await balanceOf(t, m.accountId)).toBe(90); // 59.5 x 1.5 = 89.25, rounded up
      expect(await tierOf()).toBe('Member');
      await record(t, diner(), sale(t, { cents: 1000, identityHints: [{ kind: 'email', value: m.email }] }));
      expect(await balanceOf(t, m.accountId)).toBe(105);
      expect(await tierOf()).toBe('Gold');
      // Now on Gold: the same $10 earns double.
      const gold = await record(t, diner(), sale(t, { cents: 1000, identityHints: [{ kind: 'email', value: m.email }] }));
      expect(await balanceOf(t, m.accountId)).toBe(135);
      const ev = await eventsNamed(t, diner().orgId, 'loyalty.earned', { transaction_id: gold.transaction.id });
      expect(ev[0]!.properties).toMatchObject({ points: 30, multiplier: 2, spend_cents: 1000 });
      expect(await eventsNamed(t, diner().orgId, 'loyalty.tier_changed', { account_id: m.accountId })).toHaveLength(2);

      // The window rolls on: a year and a bit later those points no longer hold the tier.
      const now = t.clock();
      t.clock.advanceDays(400);
      await tenant((ctx) => loyalty.refreshTiers(ctx));
      expect(await tierOf()).toBe('Member');
      t.clock.set(now);
    } finally {
      await resetProgram(t, diner());
    }
  });

  it('the back-fill earns history once: only a manager may run it, sales from before joining need saying so, and a second run adds nothing', async () => {
    const g = await newGuest(t, diner());
    const tenDaysAgo = new Date(t.clock().getTime() - 10 * 86_400_000);
    for (const cents of [2000, 3000, 4000]) await record(t, diner(), sale(t, { cents, occurredAt: tenDaysAgo, identityHints: [{ kind: 'email', value: g.email }] }));
    const e = await tenant((ctx) => loyalty.importMember(ctx, { customerId: g.customerId, venueId: diner().venueId }));
    expect(await balanceOf(t, e.accountId)).toBe(0);

    const host = await diner().as('host');
    const manager = await diner().as('manager');
    await expect(tenant((ctx) => loyalty.backfillEarning(ctx, { customerId: g.customerId }), host)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await tenant((ctx) => loyalty.backfillEarning(ctx, { customerId: g.customerId }), manager)).toMatchObject({ sales: 0 });
    expect(await tenant((ctx) => loyalty.backfillEarning(ctx, { customerId: g.customerId, includePreEnrolment: true }), manager)).toMatchObject({ sales: 3, points: 90 });
    expect(await tenant((ctx) => loyalty.backfillEarning(ctx, { customerId: g.customerId, includePreEnrolment: true }), manager)).toMatchObject({ sales: 0, points: 0 });
    expect(await balanceOf(t, e.accountId)).toBe(90);
    expect(await pointsRows(t, e.accountId)).toHaveLength(3);
    const audited = await t.db.selectFrom('audit_log').select(['actor_id', 'after']).where('org_id', '=', diner().orgId).where('action', '=', 'loyalty.backfill_run').execute();
    expect(audited).toHaveLength(3);
    expect(audited.map((a) => (a.after as { points: number }).points).sort()).toEqual([0, 0, 90]);
    expect(audited[0]!.actor_id).toBe(diner().staff.manager!.staffId);
  });

  it('a guest who pays and then joins at the counter still earns for that sale', async () => {
    const g = await newGuest(t, diner(), { phone: true });
    const paid = await record(t, diner(), sale(t, { cents: 6400, identityHints: [{ kind: 'phone', value: g.phone! }] }));
    t.clock.advanceMinutes(4);
    const host = await diner().as('host');
    const e = await tenant((ctx) => loyalty.enrolAtCounter(ctx, { venueId: diner().venueId, phone: g.phone! }), host);
    expect(e).toMatchObject({ created: true, customerId: g.customerId });
    const rows = await pointsRows(t, e.accountId);
    expect(rows.filter((r) => r.kind === 'earn')).toMatchObject([{ points: 64, source_transaction_id: paid.transaction.id }]);
  });
});
