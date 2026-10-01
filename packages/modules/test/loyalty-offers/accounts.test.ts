import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, getTool, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { identity, loyalty } from '@ros/modules';
import { orderStatusHandlers, type OrderSnapshot } from '@ros/modules/ordering';
import { ANON, WORKER, auditRows, balanceOf, earn, eventsNamed, guestOf, makeOrder, newGuest, newMember, pointsRows, record, resetProgram, sale } from './helpers';

describe('loyalty: members, accounts and the programme', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  let rewardId: string;

  beforeAll(async () => {
    await resetProgram(t, diner());
    await resetProgram(t, group());
    rewardId = (await t.app.tenant(diner().orgId, WORKER, (ctx) => loyalty.saveReward(ctx, { name: '$10 off', costPoints: 100, kind: 'fixed', valueCents: 1000 }))).id;
  });

  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) => t.app.tenant(diner().orgId, principal, fn);
  const as = async <T>(who: 'owner' | 'manager' | 'host' | 'kitchen', fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as(who), fn);
  const account = (id: string) => t.db.selectFrom('loyalty_accounts').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

  describe('joining', () => {
    it('a guest joins themself: one account, a member code that works as an identity, the joining bonus once, and a welcome that confirms it', async () => {
      await resetProgram(t, diner(), { enrolmentBonus: 50 });
      try {
        const g = await newGuest(t, diner());
        const me = guestOf(g.customerId);
        const first = await tenant((ctx) => loyalty.joinLoyalty(ctx, { venueId: diner().venueId }), me);
        const again = await tenant((ctx) => loyalty.joinLoyalty(ctx), me);
        expect(first).toMatchObject({ created: true, bonusPoints: 50 });
        expect(first.memberCode).toMatch(/^M-[A-Z2-9]{10}$/);
        expect(again).toMatchObject({ created: false, accountId: first.accountId, memberCode: first.memberCode });

        expect(await t.db.selectFrom('loyalty_accounts').select('id').where('customer_id', '=', g.customerId).execute()).toHaveLength(1);
        expect(await pointsRows(t, first.accountId)).toMatchObject([{ kind: 'bonus', points: 50, idempotency_key: `enrol:${first.accountId}` }]);
        // The code the membership QR encodes resolves to this guest, e.g. scanned at the till.
        const qr = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('customer_id', '=', g.customerId).where('kind', '=', 'loyalty_qr').execute();
        expect(qr).toEqual([{ kind: 'loyalty_qr', value: first.memberCode }]);
        const scanned = await record(t, diner(), sale(t, { cents: 2000, identityHints: [{ kind: 'loyalty_qr', value: first.memberCode }] }));
        expect(scanned.transaction.customerId).toBe(g.customerId);
        expect(await balanceOf(t, first.accountId)).toBe(70);

        expect(await eventsNamed(t, diner().orgId, 'loyalty.enrolled', { account_id: first.accountId })).toMatchObject([{ properties: { via: 'guest', bonus_points: 50 } }]);
        await drainJobs(t.app, { kinds: ['comms.send'] });
        const mail = t.sim.email.sent.filter((m) => m.to === g.email);
        expect(mail).toHaveLength(1);
        expect(mail[0]).toMatchObject({ kind: 'transactional', subject: 'You have joined Test Rewards' });
        expect(mail[0]!.body).toContain(first.memberCode);
        expect(mail[0]!.body).toContain('We have added 50 points to get you started.');
        expect(mail[0]!.body).toContain('http://oak-diner.tables.test/loyalty');
      } finally {
        await resetProgram(t, diner());
      }
    });

    it('front of house enrol a guest at the counter from a phone number; kitchen staff cannot; no consent is recorded for them', async () => {
      const phone = '0412 555 808';
      await expect(as('kitchen', (ctx) => loyalty.enrolAtCounter(ctx, { venueId: diner().venueId, phone }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('host', (ctx) => loyalty.enrolAtCounter(ctx, { venueId: diner().venueId, firstName: 'Nobody' }))).rejects.toMatchObject({ code: 'invalid' });

      const e = await as('host', (ctx) => loyalty.enrolAtCounter(ctx, { venueId: diner().venueId, phone, firstName: 'Priya', birthday: '1991-04-02' }));
      expect(e.created).toBe(true);
      const customer = await t.db.selectFrom('customers').select(['primary_phone', 'first_name', 'birthday']).where('id', '=', e.customerId).executeTakeFirstOrThrow();
      expect(customer).toEqual({ primary_phone: '+61412555808', first_name: 'Priya', birthday: '1991-04-02' });
      expect(await account(e.accountId)).toMatchObject({ customer_id: e.customerId, enrolled_venue_id: diner().venueId, status: 'active' });
      expect(await t.db.selectFrom('consents').select('id').where('customer_id', '=', e.customerId).execute()).toEqual([]);
      expect(await auditRows(t, diner().orgId, 'loyalty.enrolled_at_counter', e.accountId)).toMatchObject([{ actor_kind: 'staff', actor_id: diner().staff.host!.staffId }]);

      // The same number again is the same member.
      const again = await as('host', (ctx) => loyalty.enrolAtCounter(ctx, { venueId: diner().venueId, phone: '+61 412 555 808' }));
      expect(again).toMatchObject({ created: false, accountId: e.accountId });
      await drainJobs(t.app, { kinds: ['comms.send'] });
      expect(t.sim.sms.sent.filter((m) => m.to === '+61412555808')).toHaveLength(1);
      expect(t.sim.sms.lastTo('+61412555808')!.body).toContain(e.memberCode);
    });

    it('the join box at checkout enrols the guest when the order is paid, not before, and only once', async () => {
      expect(orderStatusHandlers()).toContain(loyalty.enrolFromCheckout);
      const g = await newGuest(t, diner());
      const orderId = await makeOrder(t, diner(), { customerId: g.customerId });
      const order: OrderSnapshot = { id: orderId, venueId: diner().venueId, customerId: g.customerId, reference: 'T1', channel: 'pickup', status: 'pending_payment', totalCents: 4500, subtotalCents: 4500, promisedAt: null, transactionId: null, sessionId: null, flags: [loyalty.LOYALTY_JOIN_FLAG] };
      const accounts = () => t.db.selectFrom('loyalty_accounts').select('id').where('customer_id', '=', g.customerId).execute();

      await tenant((ctx) => loyalty.enrolFromCheckout(ctx, order, { from: null, to: 'pending_payment' }));
      expect(await accounts()).toHaveLength(0);
      await tenant((ctx) => loyalty.enrolFromCheckout(ctx, { ...order, status: 'placed' }, { from: 'pending_payment', to: 'placed' }));
      await tenant((ctx) => loyalty.enrolFromCheckout(ctx, { ...order, status: 'accepted' }, { from: 'placed', to: 'accepted' }));
      const made = await accounts();
      expect(made).toHaveLength(1);
      expect(await eventsNamed(t, diner().orgId, 'loyalty.enrolled', { account_id: made[0]!.id })).toMatchObject([{ properties: { via: 'checkout' } }]);

      // The order's own sale then reaches the ledger and earns, with nothing further from anyone.
      await record(t, diner(), sale(t, { cents: 4500, source: 'online-order', channel: 'pickup', orderId }), { customerId: g.customerId });
      expect(await balanceOf(t, made[0]!.id)).toBe(45);

      // No box ticked, no membership.
      const h = await newGuest(t, diner());
      await tenant((ctx) => loyalty.enrolFromCheckout(ctx, { ...order, customerId: h.customerId, flags: [], status: 'placed' }, { from: 'pending_payment', to: 'placed' }));
      expect(await t.db.selectFrom('loyalty_accounts').select('id').where('customer_id', '=', h.customerId).execute()).toHaveLength(0);
    });
  });

  describe('who may do what', () => {
    it('front of house cannot adjust points; a manager can, with a reason, and it is audited; a large one needs an owner', async () => {
      const m = await newMember(t, diner());
      const args = { venueId: diner().venueId, accountId: m.accountId, points: 50, reason: 'Missed points from a catering invoice' };

      await expect(as('host', (ctx) => loyalty.adjustPoints(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('kitchen', (ctx) => loyalty.adjustPoints(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, reason: '' }))).rejects.toMatchObject({ code: 'invalid', message: 'Give a reason for the adjustment.' });
      expect(await pointsRows(t, m.accountId)).toEqual([]);

      const done = await as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, requestKey: 'form-nonce-0001' }));
      const replay = await as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, requestKey: 'form-nonce-0001' }));
      expect(done).toEqual({ balance: 50, applied: true });
      expect(replay).toEqual({ balance: 50, applied: false });
      const manager = diner().staff.manager!;
      expect(await pointsRows(t, m.accountId)).toMatchObject([{ kind: 'adjust', points: 50, staff_id: manager.staffId, note: args.reason, venue_id: diner().venueId }]);
      const audit = await auditRows(t, diner().orgId, 'loyalty.points_adjusted', m.accountId);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_kind: 'staff', actor_id: manager.staffId, before: { balance: 0 }, after: { balance: 50, points: 50, reason: args.reason } });

      // Above the venue's threshold (500 by default) it is the owner's call.
      await expect(as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, points: 501 }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, points: -501 }))).rejects.toMatchObject({ code: 'forbidden' });
      expect(await as('owner', (ctx) => loyalty.adjustPoints(ctx, { ...args, points: 501 }))).toMatchObject({ balance: 551, applied: true });
      // Points cannot be taken below zero, or out from under a live counter code.
      await as('host', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId }));
      await expect(as('manager', (ctx) => loyalty.adjustPoints(ctx, { ...args, points: -500 }))).rejects.toMatchObject({ code: 'invalid', message: 'Only 451 points can be removed.' });
      // Another org's account is not there to adjust.
      const groupManager = await group().as('manager');
      await expect(t.app.tenant(group().orgId, groupManager, (ctx) => loyalty.adjustPoints(ctx, { ...args, venueId: group().venueId }))).rejects.toMatchObject({ code: 'not_found' });
    });

    it('the programme, its tiers and its rewards are a manager\'s to change, and changes are audited', async () => {
      const input = { name: 'Test Rewards', pointsPerDollar: 1, pointsRounding: 'floor' as const, pointValueCents: 1 };
      await expect(as('host', (ctx) => loyalty.saveProgram(ctx, input))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('host', (ctx) => loyalty.saveTier(ctx, { name: 'Free Gold', thresholdPoints: 0, multiplier: 9 }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('manager', (ctx) => loyalty.saveProgram(ctx, { ...input, expiryPolicy: 'fixed' }))).rejects.toMatchObject({ code: 'invalid' });
      const saved = await as('manager', (ctx) => loyalty.saveProgram(ctx, { ...input, termsUrl: 'https://oak-diner.example/terms' }));
      expect(saved.termsUrl).toBe('https://oak-diner.example/terms');
      // One programme per org: saving again changes that one.
      expect(await t.db.selectFrom('loyalty_programs').select('id').where('org_id', '=', diner().orgId).execute()).toHaveLength(1);
      expect((await auditRows(t, diner().orgId, 'loyalty.program_updated', saved.id)).length).toBeGreaterThan(0);
      // The database itself refuses a second active programme.
      await expect(t.db.insertInto('loyalty_programs').values({ org_id: diner().orgId, name: 'Second' }).execute()).rejects.toThrow(/loyalty_programs_one_active/);
      // What the public sees.
      expect(await tenant((ctx) => loyalty.getProgram(ctx), ANON)).toMatchObject({ name: 'Test Rewards', pointsPerDollar: 1, isActive: true });
    });

    it('a guest reads only their own account', async () => {
      const a = await newMember(t, diner());
      const b = await newMember(t, diner());
      await earn(t, diner(), a, 120);
      await earn(t, diner(), b, 300);

      const mine = await tenant((ctx) => loyalty.getMyLoyalty(ctx, { venueId: diner().venueId }), guestOf(a.customerId));
      expect(mine.member).toMatchObject({ accountId: a.accountId, memberCode: a.memberCode, balance: 120, available: 120, valueCents: 120 });
      expect(mine.history).toMatchObject([{ kind: 'earn', points: 120, description: 'Points earned' }]);
      const ten = mine.rewards.find((r) => r.id === rewardId)!;
      expect(ten).toMatchObject({ canAfford: true, pointsShort: 0, blockedReason: null, checkoutCode: loyalty.rewardCheckoutCode(rewardId) });
      expect(await tenant((ctx) => loyalty.getMyLoyaltyHistory(ctx), guestOf(a.customerId))).toHaveLength(1);

      await expect(tenant((ctx) => loyalty.getAccount(ctx, { accountId: a.accountId }), guestOf(a.customerId))).resolves.toMatchObject({ member: { balance: 120 } });
      await expect(tenant((ctx) => loyalty.getAccount(ctx, { accountId: b.accountId }), guestOf(a.customerId))).rejects.toMatchObject({ code: 'not_found' });
      await expect(tenant((ctx) => loyalty.getAccount(ctx, { accountId: b.accountId }), ANON)).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(tenant((ctx) => loyalty.getMyLoyalty(ctx), ANON)).rejects.toMatchObject({ code: 'unauthenticated' });
      // A guest is not staff: the counter's functions are closed to them.
      await expect(tenant((ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, memberCode: b.memberCode }), guestOf(a.customerId))).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(tenant((ctx) => loyalty.listMembers(ctx), guestOf(a.customerId))).rejects.toMatchObject({ code: 'unauthenticated' });
      // A guest of one org is nobody at another, and staff of one org cannot open another's account.
      const elsewhere = await t.app.tenant(group().orgId, guestOf(a.customerId), (ctx) => loyalty.getMyLoyalty(ctx));
      expect(elsewhere.member).toBeNull();
      const groupOwner = await group().as('owner');
      await expect(t.app.tenant(group().orgId, groupOwner, (ctx) => loyalty.getAccount(ctx, { accountId: a.accountId }))).rejects.toMatchObject({ code: 'not_found' });
      // Someone who has not joined sees the programme and no account.
      const stranger = await newGuest(t, diner());
      expect(await tenant((ctx) => loyalty.getMyLoyalty(ctx), guestOf(stranger.customerId))).toMatchObject({ member: null, program: { name: 'Test Rewards' } });
    });

    it('staff find a member by QR, phone, email or name, by the ways the venue allows', async () => {
      const m = await newMember(t, diner(), { phone: true, firstName: 'Zephyrine' });
      await earn(t, diner(), m, 140);
      const find = (input: Omit<Parameters<typeof loyalty.lookupMember>[1], 'venueId'>) => as('host', (ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, ...input }));
      for (const by of [{ memberCode: m.memberCode.toLowerCase() }, { phone: m.phone!.replace('+61', '0') }, { email: m.email.toUpperCase() }]) {
        expect((await find(by)).member).toMatchObject({ accountId: m.accountId, name: 'Zephyrine Tester', balance: 140 });
      }
      expect(await as('host', (ctx) => loyalty.searchMembers(ctx, { venueId: diner().venueId, q: 'zephyr' }))).toMatchObject([{ accountId: m.accountId, balance: 140 }]);
      // Known to the venue but not a member: the screen can offer to enrol them.
      const stranger = await newGuest(t, diner());
      expect(await find({ email: stranger.email })).toEqual({ member: null, customerId: stranger.customerId });
      expect(await find({ memberCode: 'M-NOTAREALONE' })).toEqual({ member: null, customerId: null });
      await expect(as('kitchen', (ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, memberCode: m.memberCode }))).rejects.toMatchObject({ code: 'forbidden' });

      await tenant((ctx) => setModule(ctx, loyalty.loyaltyModule, { venueId: diner().venueId, config: { identifyBy: ['qr'] } }));
      try {
        await expect(find({ phone: m.phone! })).rejects.toMatchObject({ code: 'invalid' });
        expect((await find({ memberCode: m.memberCode })).member?.accountId).toBe(m.accountId);
      } finally {
        await resetProgram(t, diner());
      }
    });

    it('with the module off its functions answer not-found, nothing earns, and the data is still there when it comes back', async () => {
      const m = await newMember(t, diner());
      await earn(t, diner(), m, 80);
      const manager = await diner().as('manager');
      await tenant((ctx) => setModule(ctx, loyalty.loyaltyModule, { venueId: diner().venueId, enabled: false }));
      try {
        const off = { code: 'module_disabled', status: 404 };
        await expect(tenant((ctx) => loyalty.getMyLoyalty(ctx), guestOf(m.customerId))).rejects.toMatchObject(off);
        await expect(tenant((ctx) => loyalty.joinLoyalty(ctx, { venueId: diner().venueId }), guestOf(m.customerId))).rejects.toMatchObject(off);
        await expect(tenant((ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, memberCode: m.memberCode }), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId }), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => loyalty.adjustPoints(ctx, { venueId: diner().venueId, accountId: m.accountId, points: 5, reason: 'While off' }), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => loyalty.getProgramSettings(ctx), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => getTool('loyalty_summary')!.effect === 'read' && (getTool('loyalty_summary') as { run: Function }).run({ ctx, venueId: null }, { days: 30 }), manager)).rejects.toMatchObject(off);
        await earn(t, diner(), m, 40);
        expect(await balanceOf(t, m.accountId)).toBe(80);
      } finally {
        await resetProgram(t, diner());
      }
      expect((await tenant((ctx) => loyalty.getMyLoyalty(ctx), guestOf(m.customerId))).member).toMatchObject({ balance: 80 });
    });
  });

  describe('merge, erase and export', () => {
    it('a merge moves the account and its ledger when only the losing record was a member', async () => {
      const winner = await newGuest(t, diner());
      t.clock.advanceMinutes(1);
      const loser = await newMember(t, diner());
      await earn(t, diner(), loser, 80);
      const before = await pointsRows(t, loser.accountId);
      const manager = await diner().as('manager');
      await tenant((ctx) => identity.mergeCustomers(ctx, { winnerId: winner.customerId, loserId: loser.customerId, reason: 'Same person, two emails' }), manager);

      expect(await account(loser.accountId)).toMatchObject({ customer_id: winner.customerId, status: 'active', member_code: loser.memberCode });
      expect(await pointsRows(t, loser.accountId)).toEqual(before);
      const mine = await tenant((ctx) => loyalty.getMyLoyalty(ctx), guestOf(winner.customerId));
      expect(mine.member).toMatchObject({ accountId: loser.accountId, balance: 80 });
      // Their next sale, under either email, earns into it.
      await record(t, diner(), sale(t, { cents: 2000, identityHints: [{ kind: 'email', value: loser.email }] }));
      expect(await balanceOf(t, loser.accountId)).toBe(100);
    });

    it('when both records were members the winner\'s account survives and takes the balance, the held code and the old card', async () => {
      const winner = await newMember(t, diner());
      t.clock.advanceMinutes(1);
      const loser = await newMember(t, diner());
      await earn(t, diner(), winner, 30);
      const losersSale = sale(t, { cents: 18_000, identityHints: [{ kind: 'email', value: loser.email }] });
      await record(t, diner(), losersSale);
      const held = await as('host', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: loser.accountId, rewardId }));
      const manager = await diner().as('manager');
      await tenant((ctx) => identity.mergeCustomers(ctx, { winnerId: winner.customerId, loserId: loser.customerId, reason: 'Duplicate' }), manager);
      // A replayed merge handler would find nothing left to move: the ledger rows are keyed.

      expect(await balanceOf(t, winner.accountId)).toBe(210);
      expect(await balanceOf(t, loser.accountId)).toBe(0);
      expect(await account(loser.accountId)).toMatchObject({ status: 'closed' });
      expect((await pointsRows(t, winner.accountId)).filter((p) => p.kind === 'transfer')).toMatchObject([{ points: 180, idempotency_key: `merge:${loser.accountId}:in` }]);
      expect((await pointsRows(t, loser.accountId)).filter((p) => p.kind === 'transfer')).toMatchObject([{ points: -180 }]);
      expect((await t.db.selectFrom('redemptions').select('account_id').where('id', '=', held.id).executeTakeFirstOrThrow()).account_id).toBe(winner.accountId);
      const card = await as('host', (ctx) => loyalty.getMemberCard(ctx, { venueId: diner().venueId, accountId: winner.accountId }));
      expect(card).toMatchObject({ balance: 210, held: 100, available: 110 });
      // The card they were carrying from the other membership still finds them.
      const byOldCard = await as('host', (ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, memberCode: loser.memberCode }));
      expect(byOldCard.member?.accountId).toBe(winner.accountId);
      // The held code still pays out, from the surviving account.
      await record(t, diner(), sale(t, { cents: 5000, discountCents: 1000, discounts: [{ name: held.code, amountCents: 1000 }], identityHints: [{ kind: 'email', value: winner.email }] }));
      expect(await balanceOf(t, winner.accountId)).toBe(210 - 100 + 40);
      // A refund of a sale that earned under the old membership is taken from the surviving one.
      await record(t, diner(), { ...losersSale, status: 'refunded', refundedCents: 18_000 });
      expect((await pointsRows(t, winner.accountId)).filter((p) => p.kind === 'reverse')).toMatchObject([{ points: -180 }]);
      expect(await balanceOf(t, loser.accountId)).toBe(0);
    });

    it('the guest\'s export includes their membership, and erasing them removes the member', async () => {
      const m = await newMember(t, diner(), { phone: true });
      await earn(t, diner(), m, 130);
      const live = await as('host', (ctx) => loyalty.issueRedemption(ctx, { venueId: diner().venueId, accountId: m.accountId, rewardId }));
      const owner = await diner().as('owner');

      const exported = (await tenant((ctx) => identity.exportCustomer(ctx, m.customerId), owner)) as { loyalty: Array<Record<string, unknown>> };
      expect(exported.loyalty).toHaveLength(1);
      expect(exported.loyalty[0]).toMatchObject({ program: 'Test Rewards', memberCode: m.memberCode, balance: 130, status: 'active' });
      expect(exported.loyalty[0]!.points).toMatchObject([{ kind: 'earn', points: 130 }]);

      const membersBefore = (await tenant((ctx) => loyalty.getLoyaltySummary(ctx), owner)).members.total;
      await tenant((ctx) => identity.eraseCustomer(ctx, m.customerId), owner);

      const gone = await account(m.accountId);
      expect(gone.status).toBe('closed');
      expect(gone.member_code).toBe(`erased-${m.accountId}`);
      expect(gone.tier_id).toBeNull();
      expect(await balanceOf(t, m.accountId)).toBe(0);
      expect((await t.db.selectFrom('redemptions').select(['status', 'void_reason']).where('id', '=', live.id).executeTakeFirstOrThrow())).toEqual({ status: 'voided', void_reason: 'Member erased' });
      expect(await t.db.selectFrom('customer_identities').select('id').where('customer_id', '=', m.customerId).execute()).toEqual([]);
      // Nothing finds them any more: not the card, not the phone, not the member list.
      expect(await as('host', (ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, memberCode: m.memberCode }))).toEqual({ member: null, customerId: null });
      expect(await as('host', (ctx) => loyalty.lookupMember(ctx, { venueId: diner().venueId, phone: m.phone! }))).toEqual({ member: null, customerId: null });
      expect((await tenant((ctx) => loyalty.listMembers(ctx, { limit: 200 }), owner)).find((x) => x.accountId === m.accountId)).toBeUndefined();
      expect((await tenant((ctx) => loyalty.getLoyaltySummary(ctx), owner)).members.total).toBe(membersBefore - 1);
      // A sale with their old card afterwards is an anonymous sale.
      const after = await record(t, diner(), sale(t, { cents: 3000, identityHints: [{ kind: 'loyalty_qr', value: m.memberCode }] }));
      expect(await balanceOf(t, m.accountId)).toBe(0);
      expect(after.transaction.customerId).not.toBe(m.customerId);
    });
  });

  describe('jobs and the programme in numbers', () => {
    const runDaily = async (key: string) => {
      await tickSchedules(t.app, { only: [key] });
      await drainJobs(t.app, { kinds: [key] });
    };

    it('the expiry job lapses points past their date, oldest first, once a day at most', async () => {
      const now = t.clock();
      const monthsAgo = (n: number) => new Date(now.getTime() - n * 30.5 * 86_400_000);
      await resetProgram(t, diner(), { expiryPolicy: 'fixed', expiryMonths: 12 });
      try {
        const old = await newMember(t, diner(), { enrolledAt: monthsAgo(15) });
        await record(t, diner(), sale(t, { cents: 10_000, occurredAt: monthsAgo(14), identityHints: [{ kind: 'email', value: old.email }] }));
        await record(t, diner(), sale(t, { cents: 4000, occurredAt: monthsAgo(2), identityHints: [{ kind: 'email', value: old.email }] }));
        // Spent 60 of the old hundred already: spending uses the oldest points first.
        const spender = await newMember(t, diner(), { enrolledAt: monthsAgo(15) });
        await record(t, diner(), sale(t, { cents: 10_000, occurredAt: monthsAgo(14), identityHints: [{ kind: 'email', value: spender.email }] }));
        await as('manager', (ctx) => loyalty.adjustPoints(ctx, { venueId: diner().venueId, accountId: spender.accountId, points: -60, reason: 'Redeemed on the old system' }));
        const fresh = await newMember(t, diner());
        await earn(t, diner(), fresh, 70);

        await runDaily('loyalty.expire_points');
        await runDaily('loyalty.expire_points');
        await tenant((ctx) => loyalty.expirePoints(ctx));

        expect((await pointsRows(t, old.accountId)).filter((p) => p.kind === 'expire')).toMatchObject([{ points: -100 }]);
        expect(await balanceOf(t, old.accountId)).toBe(40);
        expect((await pointsRows(t, spender.accountId)).filter((p) => p.kind === 'expire')).toMatchObject([{ points: -40 }]);
        expect(await balanceOf(t, spender.accountId)).toBe(0);
        expect(await balanceOf(t, fresh.accountId)).toBe(70);
        expect(await eventsNamed(t, diner().orgId, 'loyalty.expired', { account_id: old.accountId })).toMatchObject([{ properties: { points: 100, policy: 'fixed' } }]);
      } finally {
        await resetProgram(t, diner());
      }
    });

    it('under a rolling rule the whole balance lapses after the quiet period, and an active member keeps theirs', async () => {
      const now = t.clock();
      const monthsAgo = (n: number) => new Date(now.getTime() - n * 30.5 * 86_400_000);
      await resetProgram(t, group(), { expiryPolicy: 'rolling', expiryMonths: 6 });
      try {
        const quiet = await newMember(t, group(), { enrolledAt: monthsAgo(12) });
        await record(t, group(), sale(t, { cents: 9000, occurredAt: monthsAgo(9), identityHints: [{ kind: 'email', value: quiet.email }] }));
        const active = await newMember(t, group(), { enrolledAt: monthsAgo(12) });
        await record(t, group(), sale(t, { cents: 9000, occurredAt: monthsAgo(9), identityHints: [{ kind: 'email', value: active.email }] }));
        await record(t, group(), sale(t, { cents: 1000, occurredAt: monthsAgo(1), identityHints: [{ kind: 'email', value: active.email }] }));
        // The day's scheduled run has been and gone (a schedule fires once per day per org), so run the job's work directly.
        expect((await t.app.tenant(group().orgId, WORKER, (ctx) => loyalty.expirePoints(ctx))).accounts).toBeGreaterThanOrEqual(1);
        expect(await balanceOf(t, quiet.accountId)).toBe(0);
        expect(await balanceOf(t, active.accountId)).toBe(100);
      } finally {
        await resetProgram(t, group());
      }
    });

    it('birthday points arrive once a year on the day; the message about them goes only to a guest who agreed to marketing', async () => {
      await resetProgram(t, diner(), { birthdayBonus: 250 });
      try {
        // The fixture clock is 30 September in Sydney.
        const agreed = await newMember(t, diner(), { marketingEmail: true });
        const silent = await newMember(t, diner());
        const notToday = await newMember(t, diner());
        await tenant(async (ctx) => {
          await identity.updateCustomer(ctx, agreed.customerId, { birthday: '1990-09-30' });
          await identity.updateCustomer(ctx, silent.customerId, { birthday: '1985-09-30' });
          await identity.updateCustomer(ctx, notToday.customerId, { birthday: '1990-10-01' });
        });
        await runDaily('loyalty.birthday_bonus');
        await tenant((ctx) => loyalty.awardBirthdayBonuses(ctx));

        expect(await pointsRows(t, agreed.accountId)).toMatchObject([{ kind: 'bonus', points: 250, idempotency_key: `birthday:${agreed.accountId}:2026` }]);
        expect(await balanceOf(t, silent.accountId)).toBe(250);
        expect(await balanceOf(t, notToday.accountId)).toBe(0);
        const messages = await t.db.selectFrom('messages').select(['customer_id', 'kind', 'status', 'error']).where('template_key', '=', 'loyalty.birthday').where('customer_id', 'in', [agreed.customerId, silent.customerId, notToday.customerId]).execute();
        expect(messages).toHaveLength(2);
        expect(messages.find((m) => m.customer_id === agreed.customerId)).toMatchObject({ kind: 'marketing', status: 'queued' });
        expect(messages.find((m) => m.customer_id === silent.customerId)).toMatchObject({ kind: 'marketing', status: 'suppressed', error: 'no_consent' });
      } finally {
        await resetProgram(t, diner());
      }
    });

    it('the loyalty_summary tool reports members, points, liability and earn coverage, as totals only', async () => {
      const g = group();
      // A member who earns, a member who has never earned, and a known guest who has not joined.
      const earner = await newMember(t, g);
      const idle = await newMember(t, g);
      const stranger = await newGuest(t, g);
      await earn(t, g, earner, 200);
      await record(t, g, sale(t, { cents: 5000, identityHints: [{ kind: 'email', value: stranger.email }] }));

      const tool = getTool('loyalty_summary')!;
      expect(tool).toMatchObject({ module: 'loyalty', effect: 'read', scope: 'loyalty:read' });
      const owner = await g.as('owner');
      const raw = await t.app.tenant(g.orgId, owner, (ctx) => (tool as { run: Function }).run({ ctx, venueId: null }, { days: 30 }));
      const out = tool.output.parse(raw);

      const db = (
        await sql<{ outstanding: number; members: number; never: number }>`
          select (select coalesce(sum(points), 0)::int from loyalty_transactions where org_id = ${g.orgId}) as outstanding,
                 (select count(*)::int from loyalty_accounts where org_id = ${g.orgId} and status <> 'closed') as members,
                 (select count(*)::int from loyalty_accounts a where a.org_id = ${g.orgId} and a.status <> 'closed'
                    and not exists (select 1 from loyalty_transactions lt where lt.account_id = a.id and lt.kind = 'earn')) as never`.execute(t.db)
      ).rows[0]!;
      expect(out.members).toMatchObject({ total: db.members, never_earned: db.never });
      expect(db.never).toBeGreaterThanOrEqual(1);
      expect(out.points.outstanding).toBe(db.outstanding);
      expect(out.points.issued - out.points.redeemed - out.points.expired).toBeLessThanOrEqual(out.points.issued);
      expect(out.outstanding_liability_cents).toBe(db.outstanding); // one cent a point in the test programme
      expect(out.program).toEqual({ name: 'Test Rewards', active: true });

      const cov = out.earn_coverage;
      expect(cov.identified_sales).toBeGreaterThanOrEqual(cov.member_sales);
      expect(cov.member_sales).toBeGreaterThanOrEqual(cov.earned_sales);
      expect(cov.earned_sales).toBeGreaterThanOrEqual(1);
      expect(cov.share_of_identified_sales).toBeCloseTo(cov.earned_sales / cov.identified_sales, 3);
      // Totals only: nothing that names a guest leaves.
      expect(JSON.stringify(out)).not.toContain(earner.email);
      expect(JSON.stringify(out)).not.toContain(idle.memberCode);

      // Read-only staff may see the numbers; a guest may not.
      const accounts = await g.as('accounts');
      await expect(t.app.tenant(g.orgId, accounts, (ctx) => loyalty.getLoyaltySummary(ctx))).resolves.toMatchObject({ program: { name: 'Test Rewards' } });
      await expect(t.app.tenant(g.orgId, guestOf(earner.customerId), (ctx) => loyalty.getLoyaltySummary(ctx))).rejects.toMatchObject({ code: 'unauthenticated' });
    });
  });
});
