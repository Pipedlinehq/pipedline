import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { loyalty } from '@ros/modules';
import { WORKER, auditRows, balanceOf, earn, eventsNamed, guestOf, newMember, pointsRows, record, resetProgram, sale } from './helpers';

describe('loyalty: redeeming at the counter', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const rewards: Record<string, string> = {};

  beforeAll(async () => {
    await resetProgram(t, diner());
    await resetProgram(t, group());
    const make = (orgId: string, input: Parameters<typeof loyalty.saveReward>[1]) => t.app.tenant(orgId, WORKER, (ctx) => loyalty.saveReward(ctx, input));
    rewards.ten = (await make(diner().orgId, { name: '$10 off', costPoints: 100, kind: 'fixed', valueCents: 1000 })).id;
    rewards.five = (await make(diner().orgId, { name: '$5 off', costPoints: 100, kind: 'fixed', valueCents: 500 })).id;
    rewards.pct = (await make(diner().orgId, { name: '20% off', costPoints: 150, kind: 'percent', percentOff: 20 })).id;
    rewards.groupTen = (await make(group().orgId, { name: '$10 off', costPoints: 100, kind: 'fixed', valueCents: 1000 })).id;
  });

  const as = async <T>(who: 'owner' | 'manager' | 'host' | 'kitchen', fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as(who), fn);
  const issue = (accountId: string, rewardId = rewards.ten!) => as('host', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId, rewardId }));
  const redemption = (id: string) => t.db.selectFrom('redemptions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const sweep = async () => {
    await tickSchedules(t.app, { only: ['loyalty.sweep_redemptions'] });
    await drainJobs(t.app, { kinds: ['loyalty.sweep_redemptions'] });
  };

  it('points burn on the confirmed payment, never on issuing the code', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 200);

    const r = await issue(m.accountId);
    expect(r).toMatchObject({ status: 'issued', points: 100, rewardSummary: '$10 off', channel: 'counter' });
    expect(r.code).toMatch(/^R-[A-Z2-9]{6}$/);
    expect(r.expiresAt.getTime() - t.clock().getTime()).toBe(15 * 60_000);

    // Issued: nothing has been spent. The points are held, so they cannot be promised twice.
    expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toHaveLength(0);
    expect(await balanceOf(t, m.accountId)).toBe(200);
    const card = await as('host', (ctx) => loyalty.getMemberCard(ctx, { venueId: diner().venueId, accountId: m.accountId }));
    expect(card).toMatchObject({ balance: 200, held: 100, available: 100 });
    expect(card.liveRedemptions.map((x) => x.code)).toEqual([r.code]);
    // The counter screen's queue shows it waiting, with whose it is.
    const queue = await as('host', (ctx) => loyalty.listCounterRedemptions(ctx, { venueId: diner().venueId }));
    expect(queue.find((q) => q.id === r.id)).toMatchObject({ status: 'issued', memberName: 'Tess Tester', rewardName: '$10 off' });
    await expect(as('kitchen', (ctx) => loyalty.listCounterRedemptions(ctx, { venueId: diner().venueId }))).rejects.toMatchObject({ code: 'forbidden' });

    // The sale arrives from the till, anonymous, with the code keyed in as the discount's name.
    t.clock.advanceMinutes(3);
    const txn = sale(t, { cents: 5900, discountCents: 1000, discounts: [{ name: `Loyalty ${r.code.toLowerCase()}`, amountCents: 1000 }] });
    const paid = await record(t, diner(), txn);
    await record(t, diner(), txn);

    const row = await redemption(r.id);
    expect(row).toMatchObject({ status: 'redeemed', transaction_id: paid.transaction.id, redeemed_venue_id: diner().venueId, discount_cents: 1000, forced: false });
    const burns = (await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn');
    expect(burns).toHaveLength(1);
    expect(burns[0]).toMatchObject({ points: -100, redemption_id: r.id, source_transaction_id: paid.transaction.id, idempotency_key: `burn:${r.id}` });
    // The sale paid for this member's code, so we know whose it is: it earns too ($49 paid).
    expect(await balanceOf(t, m.accountId)).toBe(200 - 100 + 49);
    const ev = await eventsNamed(t, diner().orgId, 'loyalty.redeemed', { redemption_id: r.id });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.properties).toMatchObject({ matched_by: 'code', channel: 'counter', points: 100 });
  });

  it('with no code on the sale it is matched by venue, time and discount amount; a sale that fits two waiting codes matches neither', async () => {
    const a = await newMember(t, diner());
    await earn(t, diner(), a, 120);
    const ra = await issue(a.accountId, rewards.five);
    // A discount of the wrong size is not this redemption.
    await record(t, diner(), sale(t, { cents: 4000, discountCents: 700 }));
    expect((await redemption(ra.id)).status).toBe('issued');
    // Nor is a discount of the right size that names some other code: that is an offer being used, not this reward.
    await record(t, diner(), sale(t, { cents: 4000, discountCents: 500, discounts: [{ name: 'Welcome OAK-W-7KQ2M9XA', amountCents: 500 }] }));
    expect((await redemption(ra.id)).status).toBe('issued');
    expect(await balanceOf(t, a.accountId)).toBe(120);
    const paid = await record(t, diner(), sale(t, { cents: 4000, discountCents: 500 }));
    expect(await redemption(ra.id)).toMatchObject({ status: 'redeemed', transaction_id: paid.transaction.id });
    expect((await eventsNamed(t, diner().orgId, 'loyalty.redeemed', { redemption_id: ra.id }))[0]!.properties).toMatchObject({ matched_by: 'amount' });

    const b = await newMember(t, diner());
    const c = await newMember(t, diner());
    await earn(t, diner(), b, 120);
    await earn(t, diner(), c, 120);
    const rb = await issue(b.accountId, rewards.five);
    const rc = await issue(c.accountId, rewards.five);
    await record(t, diner(), sale(t, { cents: 4000, discountCents: 500 }));
    expect((await redemption(rb.id)).status).toBe('issued');
    expect((await redemption(rc.id)).status).toBe('issued');
    expect(await balanceOf(t, b.accountId)).toBe(120);
    expect(await balanceOf(t, c.accountId)).toBe(120);
    // A sale that names the guest settles it.
    await record(t, diner(), sale(t, { cents: 4000, discountCents: 500, identityHints: [{ kind: 'email', value: c.email }] }));
    expect((await redemption(rc.id)).status).toBe('redeemed');
    expect((await redemption(rb.id)).status).toBe('issued');
    await as('host', (ctx) => loyalty.voidRedemption(ctx, { redemptionId: rb.id }));
  });

  it('a percentage reward is matched by the percentage of that sale', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 200);
    const r = await issue(m.accountId, rewards.pct);
    await record(t, diner(), sale(t, { cents: 8000, discountCents: 1600 }));
    expect(await redemption(r.id)).toMatchObject({ status: 'redeemed', discount_cents: 1600 });
    expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toMatchObject([{ points: -150 }]);
  });

  it('an expired redemption leaves the points untouched', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 150);
    const before = await pointsRows(t, m.accountId);
    const r = await issue(m.accountId);

    // Past the code's 15 minutes and the venue's 10 minutes of grace for a late-reported sale.
    t.clock.advanceMinutes(26);
    await sweep();
    expect(await redemption(r.id)).toMatchObject({ status: 'expired', transaction_id: null, redeemed_at: null });
    expect(await pointsRows(t, m.accountId)).toEqual(before);
    expect(await balanceOf(t, m.accountId)).toBe(150);
    const card = await as('host', (ctx) => loyalty.getMemberCard(ctx, { venueId: diner().venueId, accountId: m.accountId }));
    expect(card).toMatchObject({ balance: 150, held: 0, available: 150 });
    expect(await eventsNamed(t, diner().orgId, 'loyalty.redemption_expired', { redemption_id: r.id })).toHaveLength(1);

    // Someone keys the dead code into the till afterwards: the discount is the till's doing, the points stay.
    await record(t, diner(), sale(t, { cents: 5000, discountCents: 1000, discounts: [{ name: r.code, amountCents: 1000 }] }));
    expect((await redemption(r.id)).status).toBe('expired');
    expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toHaveLength(0);
  });

  it('a sale made in time but reported late still finds its code', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 150);
    const r = await issue(m.accountId);
    const paidAt = new Date(t.clock().getTime() + 5 * 60_000);
    // The till's report arrives 20 minutes after issue: past the code's expiry, inside the grace.
    t.clock.advanceMinutes(20);
    await sweep();
    expect((await redemption(r.id)).status).toBe('issued');
    // To the guest and to staff it already reads as expired: it cannot be used any more.
    expect((await t.app.tenant(diner().orgId, guestOf(m.customerId), (ctx) => loyalty.getMyLoyalty(ctx))).liveRedemptions).toEqual([]);
    await record(t, diner(), sale(t, { cents: 5000, discountCents: 1000, occurredAt: paidAt, discounts: [{ name: 'Reward', code: r.code, amountCents: 1000 }] }));
    expect(await redemption(r.id)).toMatchObject({ status: 'redeemed', redeemed_at: paidAt });
  });

  it('two redemptions at the same moment cannot overspend a balance', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 150);
    const host = await diner().as('host');
    const owner = await diner().as('owner');
    // Two screens, two different rewards of 100 points each, 150 points to spend.
    const results = await Promise.allSettled([
      t.app.tenant(diner().orgId, host, (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId: rewards.ten! })),
      t.app.tenant(diner().orgId, owner, (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId: rewards.five! })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: 'invalid', message: 'Not enough points: 50 available, 100 needed.' });
    const held = await t.db.selectFrom('redemptions').select(['points']).where('account_id', '=', m.accountId).where('status', '=', 'issued').execute();
    expect(held).toEqual([{ points: 100 }]);

    // The same reward tapped twice at once is one code, not two.
    const n = await newMember(t, diner());
    await earn(t, diner(), n, 300);
    const twice = await Promise.all([issue(n.accountId), issue(n.accountId)]);
    expect(twice[0].code).toBe(twice[1].code);
    expect(await t.db.selectFrom('redemptions').select('id').where('account_id', '=', n.accountId).execute()).toHaveLength(1);
  });

  it('a manager may force-confirm with a reason and it is audited; front of house may not', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 150);
    const r = await issue(m.accountId);
    const args = { venueId: diner().venueId, redemptionId: r.id, reason: 'Till was offline, guest had the code on their phone' };

    await expect(as('host', (ctx) => loyalty.forceConfirmRedemption(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(as('manager', (ctx) => loyalty.forceConfirmRedemption(ctx, { ...args, reason: ' ' }))).rejects.toMatchObject({ code: 'invalid' });
    expect((await redemption(r.id)).status).toBe('issued');
    expect(await balanceOf(t, m.accountId)).toBe(150);

    const done = await as('manager', (ctx) => loyalty.forceConfirmRedemption(ctx, args));
    expect(done).toMatchObject({ status: 'redeemed', forced: true });
    const manager = diner().staff.manager!;
    expect(await redemption(r.id)).toMatchObject({ status: 'redeemed', forced: true, force_reason: args.reason, redeemed_staff_id: manager.staffId });
    expect(await balanceOf(t, m.accountId)).toBe(50);
    const audit = await auditRows(t, diner().orgId, 'loyalty.redemption_forced', r.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_kind: 'staff', actor_id: manager.staffId, after: { status: 'redeemed', reason: args.reason } });
    // Confirming again is the same confirmation.
    await as('manager', (ctx) => loyalty.forceConfirmRedemption(ctx, args));
    expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toHaveLength(1);
  });

  it('where the venue keeps force-confirm for owners, a manager is refused; a lapsed code cannot be confirmed once the points are gone', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 100);
    const r = await issue(m.accountId);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, loyalty.loyaltyModule, { venueId: diner().venueId, config: { allowStaffForceConfirm: false } }));
    try {
      const args = { venueId: diner().venueId, redemptionId: r.id, reason: 'Guest showed the receipt' };
      await expect(as('manager', (ctx) => loyalty.forceConfirmRedemption(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });

      t.clock.advanceMinutes(30);
      await sweep();
      // The hold lapsed and the guest spent the points on something else.
      const other = await issue(m.accountId, rewards.five);
      await record(t, diner(), sale(t, { cents: 3000, discountCents: 500, discounts: [{ name: other.code, amountCents: 500 }] }));
      await expect(as('owner', (ctx) => loyalty.forceConfirmRedemption(ctx, args))).rejects.toMatchObject({ code: 'conflict' });
      expect((await redemption(r.id)).status).toBe('expired');
      expect(await balanceOf(t, m.accountId)).toBeGreaterThanOrEqual(0);
    } finally {
      await resetProgram(t, diner());
    }
  });

  it('a guest earns at one venue of a group and burns at another', async () => {
    const g = group();
    const cbd = g.venues.cbd!.id;
    const newtown = g.venues.newtown!.id;
    const m = await newMember(t, g, { phone: true, venueId: cbd });
    await earn(t, g, m, 180, cbd);

    // Front of house at Newtown finds them by phone and sees the points earned in the CBD.
    const host = await g.as('host');
    const found = await t.app.tenant(g.orgId, host, (ctx) => loyalty.lookupMember(ctx, { venueId: newtown, phone: m.phone! }));
    expect(found.member).toMatchObject({ accountId: m.accountId, balance: 180, available: 180 });
    const r = await t.app.tenant(g.orgId, host, (ctx) => loyalty.issueRedemption(ctx, { venueId: newtown, accountId: m.accountId, rewardId: rewards.groupTen! }));
    const paid = await record(t, g, sale(t, { cents: 6000, discountCents: 1000, discounts: [{ name: r.code, amountCents: 1000 }] }), { venueId: newtown });

    const rows = await pointsRows(t, m.accountId);
    expect(rows.find((p) => p.kind === 'earn' && p.points === 180)).toMatchObject({ venue_id: cbd });
    expect(rows.find((p) => p.kind === 'burn')).toMatchObject({ points: -100, venue_id: newtown, source_transaction_id: paid.transaction.id });
    expect(await redemption(r.id)).toMatchObject({ status: 'redeemed', issued_venue_id: newtown, redeemed_venue_id: newtown });

    // That member of staff has no role in the CBD or at Bondi: those venues are not there for them.
    await expect(t.app.tenant(g.orgId, host, (ctx) => loyalty.issueRedemption(ctx, { venueId: cbd, accountId: m.accountId, rewardId: rewards.groupTen! }))).rejects.toMatchObject({ code: 'not_found' });
    // And the single venue's staff cannot reach a group member's account at all.
    await expect(as('host', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId: rewards.ten! }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as('manager', (ctx) => loyalty.forceConfirmRedemption(ctx, { venueId: diner().venueId, redemptionId: r.id, reason: 'Trying another org' }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('when the sale a reward was used on is refunded in full, the points come back', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 100);
    const r = await issue(m.accountId);
    const txn = sale(t, { cents: 5000, discountCents: 1000, discounts: [{ name: r.code, amountCents: 1000 }], identityHints: [{ kind: 'email', value: m.email }] });
    await record(t, diner(), txn);
    expect(await balanceOf(t, m.accountId)).toBe(100 - 100 + 40);
    const refund = { ...txn, status: 'refunded' as const, refundedCents: 4000 };
    await record(t, diner(), refund);
    await record(t, diner(), refund);
    expect(await redemption(r.id)).toMatchObject({ status: 'voided', void_reason: 'Sale refunded' });
    const rows = await pointsRows(t, m.accountId);
    expect(rows.filter((p) => p.redemption_id === r.id).map((p) => [p.kind, p.points]).sort()).toEqual([['burn', -100], ['reverse', 100]]);
    // Reward returned, and the 40 points that sale earned taken back.
    expect(await balanceOf(t, m.accountId)).toBe(100);
  });

  it('a guest can issue and cancel their own code, and cannot touch anyone else\'s', async () => {
    const m = await newMember(t, diner());
    const other = await newMember(t, diner());
    await earn(t, diner(), m, 100);
    await earn(t, diner(), other, 100);
    const mine = await t.app.tenant(diner().orgId, guestOf(m.customerId), (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, rewardId: rewards.ten! }));
    expect(mine.accountId).toBe(m.accountId);
    // Naming someone else's account gets a guest nowhere.
    await expect(t.app.tenant(diner().orgId, guestOf(m.customerId), (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: other.accountId, rewardId: rewards.ten! }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner().orgId, guestOf(other.customerId), (ctx) => loyalty.voidRedemption(ctx, { redemptionId: mine.id }))).rejects.toMatchObject({ code: 'not_found' });
    const voided = await t.app.tenant(diner().orgId, guestOf(m.customerId), (ctx) => loyalty.voidRedemption(ctx, { redemptionId: mine.id }));
    expect(voided.status).toBe('voided');
    expect((await pointsRows(t, m.accountId)).filter((p) => p.kind === 'burn')).toHaveLength(0);
    // Kitchen staff do not handle guests' points.
    await expect(as('kitchen', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId: rewards.ten! }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a reward\'s own rules are enforced at issue: the wrong day, the wrong venue, switched off, used up', async () => {
    const m = await newMember(t, diner());
    await earn(t, diner(), m, 500);
    const make = (input: Parameters<typeof loyalty.saveReward>[1]) => t.app.tenant(diner().orgId, WORKER, (ctx) => loyalty.saveReward(ctx, input));
    // The fixture clock is a Wednesday (3) in Sydney.
    const mondays = await make({ name: 'Monday treat', costPoints: 50, kind: 'fixed', valueCents: 300, validDays: [1] });
    const once = await make({ name: 'Once only', costPoints: 50, kind: 'fixed', valueCents: 200, maxRedemptionsPerCustomer: 1 });
    const off = await make({ name: 'Retired', costPoints: 50, kind: 'fixed', valueCents: 100, isActive: false });
    expect(mondays.validDays).toEqual([1]);
    const here = await make({ name: 'Here only', costPoints: 50, kind: 'fixed', valueCents: 150, validVenueIds: [diner().venueId] });
    expect(here.validVenueIds).toEqual([diner().venueId]);
    await expect(issue(m.accountId, mondays.id)).rejects.toMatchObject({ code: 'invalid', message: 'That reward cannot be used today.' });
    await expect(issue(m.accountId, off.id)).rejects.toMatchObject({ code: 'invalid' });
    // A venue from another org is not a venue this org can name.
    await expect(make({ name: 'Elsewhere', costPoints: 50, kind: 'fixed', valueCents: 100, validVenueIds: [group().venueId] })).rejects.toMatchObject({ code: 'not_found' });

    const first = await issue(m.accountId, once.id);
    await record(t, diner(), sale(t, { cents: 3000, discountCents: 200, discounts: [{ name: first.code, amountCents: 200 }] }));
    await expect(issue(m.accountId, once.id)).rejects.toMatchObject({ code: 'invalid', message: 'That reward has already been used as many times as it allows.' });
    // Rewards are a manager's to define.
    await expect(as('host', (ctx) => loyalty.saveReward(ctx, { name: 'Free everything', costPoints: 1, kind: 'percent', percentOff: 100 }))).rejects.toMatchObject({ code: 'forbidden' });
  });
});
