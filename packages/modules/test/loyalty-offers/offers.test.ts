import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, getTool, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { comms, identity, offers } from '@ros/modules';
import { getCheckoutAdjuster } from '@ros/modules/ordering';
import { ANON, WORKER, auditRows, draft, eventsNamed, guestOf, newGuest, record, resetProgram, sale } from './helpers';

describe('offers: unique per-customer codes', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) => t.app.tenant(diner().orgId, principal, fn);
  const as = async <T>(who: 'owner' | 'manager' | 'host' | 'kitchen', fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as(who), fn);
  const codeRow = (id: string) => t.db.selectFrom('offer_codes').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  let welcome: offers.OfferView;
  let comeback: offers.OfferView;
  let creator: offers.OfferView;

  beforeAll(async () => {
    await resetProgram(t, diner());
    await resetProgram(t, group());
    const manager = await diner().as('manager');
    welcome = await tenant((ctx) => offers.saveOffer(ctx, { kind: 'welcome', name: 'Welcome', discountKind: 'fixed', valueCents: 1000, minSpendCents: 4000, validityDays: 30, codePrefix: 'oak-w' }), manager);
    comeback = await tenant((ctx) => offers.saveOffer(ctx, { kind: 'comeback', name: 'We miss you', discountKind: 'percent', percentOff: 15, validityDays: 21, codePrefix: 'OAK-C' }), manager);
    creator = await tenant((ctx) => offers.saveOffer(ctx, { kind: 'creator', name: 'Wagyu Wes sent you', discountKind: 'fixed', valueCents: 1500, validityDays: 14, codePrefix: 'WES', creatorId: 'creator_wagyu_wes', campaignId: 'camp_spring_launch' }), manager);
  });

  const issue = async (customerId: string | null, offer = welcome, source = 'flow:welcome') => (await tenant((ctx) => offers.issueCode(ctx, { offerId: offer.id, customerId, source }))).code;
  const expireJob = async () => {
    await tickSchedules(t.app, { only: ['offers.expire_codes'] });
    await drainJobs(t.app, { kinds: ['offers.expire_codes'] });
  };

  describe('definitions and issuing', () => {
    it('a manager defines offers; front of house cannot; the definition says what it gives in plain words', async () => {
      expect(welcome).toMatchObject({ kind: 'welcome', codePrefix: 'OAK-W', requiresClaim: true, summary: '$10 off when you spend $40 or more', channels: ['pickup', 'delivery', 'dine-in-qr'] });
      expect(comeback.summary).toBe('15% off');
      expect(creator).toMatchObject({ creatorId: 'creator_wagyu_wes', campaignId: 'camp_spring_launch' });
      await expect(as('host', (ctx) => offers.saveOffer(ctx, { kind: 'manual', name: 'Mates rates', discountKind: 'percent', percentOff: 100 }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('manager', (ctx) => offers.saveOffer(ctx, { kind: 'creator', name: 'No creator', discountKind: 'fixed', valueCents: 500 }))).rejects.toMatchObject({ code: 'invalid' });
      await expect(as('manager', (ctx) => offers.saveOffer(ctx, { kind: 'manual', name: 'Elsewhere', discountKind: 'fixed', valueCents: 500, validVenueIds: [group().venueId] }))).rejects.toMatchObject({ code: 'not_found' });
      expect((await auditRows(t, diner().orgId, 'offer.created', welcome.id))[0]).toMatchObject({ actor_kind: 'staff', actor_id: diner().staff.manager!.staffId });
      expect((await as('host', (ctx) => offers.listOffers(ctx))).map((o) => o.name)).toEqual(expect.arrayContaining(['Welcome', 'We miss you']));
      // Another org's offer is not there to issue from.
      const g = await newGuest(t, group());
      await expect(t.app.tenant(group().orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: g.customerId, source: 'flow:welcome' }))).rejects.toMatchObject({ code: 'not_found' });
    });

    it('a code is unique, prefixed and unguessable, records where it came from, and a guest holds one live code per offer', async () => {
      const a = await newGuest(t, diner());
      const b = await newGuest(t, diner());
      const first = await tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: a.customerId, source: 'flow:welcome' }));
      const again = await tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: a.customerId, source: 'campaign:abc' }));
      const other = await tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: b.customerId, source: 'flow:welcome' }));

      expect(first.created).toBe(true);
      expect(first.code.code).toMatch(/^OAK-W-[A-Z2-9]{8}$/);
      expect(again).toMatchObject({ created: false, code: { id: first.code.id, code: first.code.code } });
      expect(other.code.code).not.toBe(first.code.code);
      const row = await codeRow(first.code.id);
      expect(row).toMatchObject({ status: 'issued', source: 'flow:welcome', customer_id: a.customerId, claimed_at: null });
      expect(row.expires_at.getTime() - row.issued_at.getTime()).toBe(30 * 86_400_000);
      expect(await t.db.selectFrom('offer_codes').select('id').where('offer_id', '=', welcome.id).where('customer_id', '=', a.customerId).execute()).toHaveLength(1);
      expect(await eventsNamed(t, diner().orgId, 'offer.issued', { code_id: first.code.id })).toMatchObject([{ properties: { source: 'flow:welcome', offer_kind: 'welcome' }, code: first.code.code }]);

      // The database itself refuses a second live code for the same guest and offer.
      await expect(
        t.db.insertInto('offer_codes').values({ org_id: diner().orgId, offer_id: welcome.id, customer_id: a.customerId, code: 'OAK-W-DUPLICATE', expires_at: new Date(t.clock().getTime() + 86_400_000) }).execute(),
      ).rejects.toThrow(/offer_codes_one_live/);
      // Two requests at once for the same guest are one code.
      const c = await newGuest(t, diner());
      const both = await Promise.all([issue(c.customerId, comeback), issue(c.customerId, comeback)]);
      expect(both[0].id).toBe(both[1].id);
      // Issuing is for flows (internal) and managers, not the counter.
      await expect(as('host', (ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: b.customerId, source: 'staff' }))).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('a bulk issue gives each guest in a segment one code, and running it twice gives no one a second', async () => {
      const guests = [];
      for (let i = 0; i < 5; i++) guests.push(await newGuest(t, diner()));
      await issue(guests[0]!.customerId, comeback);
      const ids = [...guests.map((g) => g.customerId), guests[1]!.customerId, '00000000-0000-4000-8000-000000000000'];
      const manager = await diner().as('manager');
      const first = await tenant((ctx) => offers.issueCodes(ctx, { offerId: comeback.id, customerIds: ids, source: 'campaign:winter' }), manager);
      expect(first).toMatchObject({ issued: 4, existing: 1, skipped: 1 });
      const second = await tenant((ctx) => offers.issueCodes(ctx, { offerId: comeback.id, customerIds: ids, source: 'campaign:winter' }), manager);
      expect(second).toMatchObject({ issued: 0, existing: 5, skipped: 1 });
      const rows = await t.db.selectFrom('offer_codes').select(['customer_id', 'code', 'source']).where('offer_id', '=', comeback.id).where('customer_id', 'in', guests.map((g) => g.customerId)).execute();
      expect(rows).toHaveLength(5);
      expect(new Set(rows.map((r) => r.code)).size).toBe(5);
      for (const r of rows) expect(r.code).toMatch(/^OAK-C-[A-Z2-9]{8}$/);
      await expect(as('host', (ctx) => offers.issueCodes(ctx, { offerId: comeback.id, customerIds: ids, source: 'staff' }))).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('"here is your code" is marketing: it goes through comms, to a guest who agreed, and is recorded as suppressed for one who did not', async () => {
      const owner = await diner().as('owner');
      const identityRow = await tenant((ctx) => comms.addSendingIdentity(ctx, { channel: 'email', domain: 'mail.oak-diner.example', fromName: 'Oak Diner' }, { key: 'sim-email' }), owner);
      await tenant((ctx) => comms.setSendingIdentityStatus(ctx, identityRow.id, 'verified'));
      const yes = await newGuest(t, diner(), { marketingEmail: true, firstName: 'Mei' });
      const no = await newGuest(t, diner());

      const sent = await tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: yes.customerId, source: 'flow:welcome', notify: 'email' }));
      const held = await tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: no.customerId, source: 'flow:welcome', notify: 'email' }));
      expect(sent.message).toEqual({ status: 'queued', reason: undefined });
      expect(held.message).toEqual({ status: 'suppressed', reason: 'no_consent' });
      // The guest who did not agree still has their code; they were just not messaged.
      expect((await codeRow(held.code.id)).status).toBe('issued');

      await drainJobs(t.app, { kinds: ['comms.send'] });
      expect(t.sim.email.lastTo(no.email)).toBeUndefined();
      const mail = t.sim.email.lastTo(yes.email)!;
      expect(mail).toMatchObject({ kind: 'marketing', subject: 'Welcome from Oak Diner' });
      expect(mail.body).toContain('Hi Mei');
      expect(mail.body).toContain(`Your code is ${sent.code.code}`);
      expect(mail.body).toContain('$10 off when you spend $40 or more');
      expect(mail.body).toContain(`http://oak-diner.tables.test/claim/${sent.code.code}`);
      expect(mail.body).toContain('Unsubscribe:');
      const rows = await t.db.selectFrom('messages').select(['customer_id', 'kind', 'status']).where('template_key', '=', 'offers.code').where('customer_id', 'in', [yes.customerId, no.customerId]).execute();
      expect(rows).toEqual(expect.arrayContaining([{ customer_id: yes.customerId, kind: 'marketing', status: 'sent' }, { customer_id: no.customerId, kind: 'marketing', status: 'suppressed' }]));
    });
  });

  describe('click to claim', () => {
    it('looking at the claim page changes nothing; pressing the button claims the code, once, and applies it to nothing', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const before = await codeRow(code.id);

      const seen = await tenant((ctx) => offers.previewCode(ctx, { code: code.code.toLowerCase() }), ANON);
      expect(seen).toMatchObject({ status: 'issued', offerName: 'Welcome', summary: '$10 off when you spend $40 or more' });
      expect(await codeRow(code.id)).toEqual(before);

      const claimed = await tenant((ctx) => offers.claimCode(ctx, { code: code.code }), ANON);
      t.clock.advanceMinutes(5);
      const again = await tenant((ctx) => offers.claimCode(ctx, { code: code.code }), guestOf(g.customerId));
      expect(claimed.status).toBe('claimed');
      expect(again.claimedAt).toEqual(claimed.claimedAt);
      const row = await codeRow(code.id);
      expect(row).toMatchObject({ status: 'claimed', redeemed_at: null, redeemed_order_id: null, redeemed_transaction_id: null, discount_applied_cents: null });
      expect(row.claimed_at).toEqual(claimed.claimedAt);
      expect(await eventsNamed(t, diner().orgId, 'offer.claimed', { code_id: code.id })).toMatchObject([{ properties: { via: 'link' }, customer_id: g.customerId }]);
      // The claim is a marketing touch on the guest's record; their acquisition stamp is untouched.
      expect(await t.db.selectFrom('customer_touchpoints').select(['channel', 'code']).where('customer_id', '=', g.customerId).execute()).toEqual([{ channel: 'offer', code: code.code }]);
      expect((await tenant((ctx) => offers.listMyCodes(ctx), guestOf(g.customerId))).map((c) => c.code)).toEqual([code.code]);
    });

    it('a signed-in guest cannot open or claim a code that belongs to someone else, and an unknown code is not found', async () => {
      const owner = await newGuest(t, diner());
      const other = await newGuest(t, diner());
      const code = await issue(owner.customerId);
      await expect(tenant((ctx) => offers.previewCode(ctx, { code: code.code }), guestOf(other.customerId))).rejects.toMatchObject({ code: 'not_found' });
      await expect(tenant((ctx) => offers.claimCode(ctx, { code: code.code }), guestOf(other.customerId))).rejects.toMatchObject({ code: 'not_found' });
      await expect(tenant((ctx) => offers.claimCode(ctx, { code: 'OAK-W-ZZZZZZZZ' }), ANON)).rejects.toMatchObject({ code: 'not_found' });
      // Nor can the code be opened from another org's site.
      await expect(t.app.tenant(group().orgId, ANON, (ctx) => offers.previewCode(ctx, { code: code.code }))).rejects.toMatchObject({ code: 'not_found' });
      expect((await codeRow(code.id)).status).toBe('issued');
      expect(await tenant((ctx) => offers.listMyCodes(ctx), guestOf(other.customerId))).toEqual([]);
    });

    it('the expiry job closes lapsed codes; an expired code cannot be claimed; a comeback can be issued afresh, a welcome cannot', async () => {
      const now = t.clock();
      try {
        const g = await newGuest(t, diner());
        const w = await issue(g.customerId, welcome);
        const c = await issue(g.customerId, comeback, 'flow:winback');
        await tenant((ctx) => offers.claimCode(ctx, { code: c.code }), ANON);

        t.clock.advanceDays(22);
        // Past the comeback's 21 days, before the sweep: it already reads as expired and cannot be claimed or used.
        expect((await tenant((ctx) => offers.previewCode(ctx, { code: c.code }), ANON)).status).toBe('expired');
        await expireJob();
        expect((await codeRow(c.id)).status).toBe('expired');
        expect((await codeRow(w.id)).status).toBe('issued');
        expect(await eventsNamed(t, diner().orgId, 'offer.expired', { code_id: c.id })).toMatchObject([{ properties: { claimed: true } }]);

        t.clock.advanceDays(10);
        await expect(tenant((ctx) => offers.claimCode(ctx, { code: w.code }), ANON)).rejects.toMatchObject({ code: 'invalid', message: 'That code has expired.' });
        await expect(tenant((ctx) => getCheckoutAdjuster('offers')!.quote(ctx, draft(t, diner(), { customerId: g.customerId }), w.code))).rejects.toMatchObject({ code: 'invalid', message: 'That code has expired.' });

        const fresh = await tenant((ctx) => offers.issueCode(ctx, { offerId: comeback.id, customerId: g.customerId, source: 'flow:winback' }));
        expect(fresh.created).toBe(true);
        expect(fresh.code.code).not.toBe(c.code);
        await expect(tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: g.customerId, source: 'flow:welcome' }))).rejects.toMatchObject({ code: 'invalid', message: 'That guest has already had this offer.' });
        expect((await tenant((ctx) => offers.previewCode(ctx, { code: w.code }), ANON)).status).toBe('expired');
      } finally {
        t.clock.set(now);
      }
    });
  });

  describe('cancelling, listing and guessing', () => {
    it('a manager cancels an unused code with a reason, on the audit log; it then cannot be claimed or used; front of house cannot cancel', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      await expect(as('host', (ctx) => offers.voidCode(ctx, { codeId: code.id, reason: 'Sent by mistake' }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as('manager', (ctx) => offers.voidCode(ctx, { codeId: code.id, reason: '' }))).rejects.toMatchObject({ code: 'invalid' });
      await as('manager', (ctx) => offers.voidCode(ctx, { codeId: code.id, reason: 'Sent by mistake' }));
      expect(await codeRow(code.id)).toMatchObject({ status: 'voided', void_reason: 'Sent by mistake' });
      expect(await auditRows(t, diner().orgId, 'offer.code_voided', code.id)).toMatchObject([{ actor_id: diner().staff.manager!.staffId, before: { status: 'issued' }, after: { status: 'voided', reason: 'Sent by mistake' } }]);
      await expect(tenant((ctx) => offers.claimCode(ctx, { code: code.code }), ANON)).rejects.toMatchObject({ code: 'invalid', message: 'That code is no longer valid.' });
      await expect(tenant((ctx) => getCheckoutAdjuster('offers')!.quote(ctx, draft(t, diner(), { customerId: g.customerId }), code.code))).rejects.toMatchObject({ code: 'invalid', message: 'That code is no longer valid.' });
      // The console list is a manager's; front of house may look up one guest's codes.
      expect((await as('manager', (ctx) => offers.listCodes(ctx, { offerId: welcome.id, status: 'voided' }))).map((c) => c.id)).toContain(code.id);
      await expect(as('host', (ctx) => offers.listCodes(ctx, { offerId: welcome.id }))).rejects.toMatchObject({ code: 'forbidden' });
      expect((await as('host', (ctx) => offers.listCodes(ctx, { customerId: g.customerId }))).map((c) => c.code)).toEqual([code.code]);
    });

    it('guessing codes from one address is cut off', async () => {
      const ip = '203.0.113.77';
      const guess = (i: number) => t.app.tenant(diner().orgId, ANON, (ctx) => offers.previewCode(ctx, { code: `OAK-W-GUESS${String(i).padStart(3, '0')}` }), { ip });
      for (let i = 0; i < 30; i++) await expect(guess(i)).rejects.toMatchObject({ code: 'not_found' });
      await expect(guess(31)).rejects.toMatchObject({ code: 'rate_limited' });
      // Staff checking a code at the counter are not guessing and are not limited.
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const host = await diner().as('host');
      expect((await t.app.tenant(diner().orgId, host, (ctx) => offers.previewCode(ctx, { code: code.code }), { ip })).code).toBe(code.code);
    });
  });

  describe('redeeming in venue', () => {
    it('a till sale that carries the code redeems it, once; a refund gives it back', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      await tenant((ctx) => offers.claimCode(ctx, { code: code.code }), ANON);
      const txn = sale(t, { cents: 6000, discountCents: 1000, discounts: [{ name: 'Welcome offer', code: code.code.toLowerCase(), amountCents: 1000 }] });
      const paid = await record(t, diner(), txn);
      await record(t, diner(), txn);

      expect(await codeRow(code.id)).toMatchObject({ status: 'redeemed', redeemed_transaction_id: paid.transaction.id, redeemed_venue_id: diner().venueId, discount_applied_cents: 1000, redeemed_order_id: null });
      expect(await eventsNamed(t, diner().orgId, 'offer.redeemed', { code_id: code.id })).toMatchObject([{ properties: { via: 'till', discount_cents: 1000 } }]);

      // Keyed into a second sale, the used code is not used again, and the venue can see it was tried.
      const second = await record(t, diner(), sale(t, { cents: 5000, discountCents: 1000, discounts: [{ name: `WELCOME ${code.code}`, amountCents: 1000 }] }));
      expect((await codeRow(code.id)).redeemed_transaction_id).toBe(paid.transaction.id);
      expect(await eventsNamed(t, diner().orgId, 'offer.redemption_refused', { code_id: code.id })).toMatchObject([{ properties: { reason: 'used', transaction_id: second.transaction.id } }]);

      await record(t, diner(), { ...txn, status: 'refunded', refundedCents: 5000 });
      expect(await codeRow(code.id)).toMatchObject({ status: 'claimed', redeemed_transaction_id: null, redeemed_at: null });
    });

    it('at the till a code is refused for another guest and after its expiry, and the refusal is recorded', async () => {
      const owner = await newGuest(t, diner());
      const other = await newGuest(t, diner());
      const mine = await issue(owner.customerId, comeback, 'flow:winback');
      const theirs = await record(t, diner(), sale(t, { cents: 6000, discountCents: 900, discounts: [{ name: mine.code, amountCents: 900 }], identityHints: [{ kind: 'email', value: other.email }] }));
      expect(await codeRow(mine.id)).toMatchObject({ status: 'issued', customer_id: owner.customerId, redeemed_transaction_id: null });
      expect(await eventsNamed(t, diner().orgId, 'offer.redemption_refused', { code_id: mine.id })).toMatchObject([{ properties: { reason: 'other_customer', transaction_id: theirs.transaction.id } }]);

      const now = t.clock();
      try {
        t.clock.advanceDays(25);
        await record(t, diner(), sale(t, { cents: 6000, discountCents: 900, discounts: [{ name: mine.code, amountCents: 900 }], identityHints: [{ kind: 'email', value: owner.email }] }));
        expect((await codeRow(mine.id)).redeemed_transaction_id).toBeNull();
        expect((await eventsNamed(t, diner().orgId, 'offer.redemption_refused', { code_id: mine.id })).map((e) => (e.properties as { reason: string }).reason).sort()).toEqual(['expired', 'other_customer']);
      } finally {
        t.clock.set(now);
      }
    });

    it('front of house can check a code and mark it used against a sale, once, on the audit log; kitchen staff cannot', async () => {
      const g = await newGuest(t, diner(), { firstName: 'Arjun' });
      const code = await issue(g.customerId);
      const paid = await record(t, diner(), sale(t, { cents: 7000, discountCents: 1000, identityHints: [{ kind: 'email', value: g.email }] }));

      await expect(as('kitchen', (ctx) => offers.checkCode(ctx, { venueId: diner().venueId, code: code.code }))).rejects.toMatchObject({ code: 'forbidden' });
      expect(await as('host', (ctx) => offers.checkCode(ctx, { venueId: diner().venueId, code: code.code }))).toMatchObject({ usable: true, reason: null, guestName: 'Arjun Tester', code: { summary: '$10 off when you spend $40 or more' } });
      expect((await codeRow(code.id)).status).toBe('issued');

      const done = await as('host', (ctx) => offers.redeemCodeAtCounter(ctx, { venueId: diner().venueId, code: code.code, transactionId: paid.transaction.id }));
      expect(done.status).toBe('redeemed');
      expect(await codeRow(code.id)).toMatchObject({ status: 'redeemed', redeemed_transaction_id: paid.transaction.id, discount_applied_cents: 1000, redeemed_venue_id: diner().venueId });
      expect(await auditRows(t, diner().orgId, 'offer.code_redeemed_by_staff', code.id)).toMatchObject([{ actor_kind: 'staff', actor_id: diner().staff.host!.staffId, after: { status: 'redeemed', transactionId: paid.transaction.id } }]);

      await expect(as('host', (ctx) => offers.redeemCodeAtCounter(ctx, { venueId: diner().venueId, code: code.code }))).rejects.toMatchObject({ code: 'conflict', message: 'That code has already been used.' });
      expect(await as('host', (ctx) => offers.checkCode(ctx, { venueId: diner().venueId, code: code.code }))).toMatchObject({ usable: false, reason: 'That code has already been used.' });
      // Against another guest's sale it is refused.
      const other = await newGuest(t, diner());
      const otherCode = await issue(other.customerId);
      await expect(as('host', (ctx) => offers.redeemCodeAtCounter(ctx, { venueId: diner().venueId, code: otherCode.code, transactionId: paid.transaction.id }))).rejects.toMatchObject({ code: 'conflict', message: 'That code belongs to a different guest.' });
      // Staff at one org cannot see or mark another org's code.
      const groupHost = await group().as('host');
      await expect(t.app.tenant(group().orgId, groupHost, (ctx) => offers.redeemCodeAtCounter(ctx, { venueId: group().venues.newtown!.id, code: otherCode.code }))).rejects.toMatchObject({ code: 'not_found' });
      expect((await codeRow(otherCode.id)).status).toBe('issued');
    });
  });

  describe('creator offers and where a guest came from', () => {
    it('a guest created by asking for a creator\'s code is stamped with the creator, the campaign and the code', async () => {
      const email = `newcomer-${Date.now()}@offers.example`;
      const code = await tenant((ctx) => offers.requestOfferCode(ctx, { offerId: creator.id, email, firstName: 'Noa', venueId: diner().venueId, landingPath: '/offer' }), ANON);
      expect(code.code).toMatch(/^WES-[A-Z2-9]{8}$/);
      expect(code.status).toBe('claimed');
      const customer = await t.db.selectFrom('customers').select(['id', 'acquisition_source', 'acquisition_creator_id', 'acquisition_campaign_id', 'acquisition_code', 'acquisition_landing_path']).where('primary_email', '=', email).executeTakeFirstOrThrow();
      expect(customer).toMatchObject({ acquisition_source: 'criota', acquisition_creator_id: 'creator_wagyu_wes', acquisition_campaign_id: 'camp_spring_launch', acquisition_code: code.code, acquisition_landing_path: '/offer' });
      expect(await codeRow(code.id)).toMatchObject({ customer_id: customer.id, status: 'claimed', source: 'signup' });
      expect(await eventsNamed(t, diner().orgId, 'offer.issued', { code_id: code.id })).toMatchObject([{ creator_id: 'creator_wagyu_wes', campaign_id: 'camp_spring_launch', code: code.code }]);

      // Asking again returns the same code; the offer is once per guest.
      const again = await tenant((ctx) => offers.requestOfferCode(ctx, { offerId: creator.id, email }), ANON);
      expect(again.id).toBe(code.id);
      // Their first sale with the code is attributed to the creator by the acquisition stamp.
      const paid = await record(t, diner(), sale(t, { cents: 6000, discountCents: 1500, discounts: [{ name: code.code, amountCents: 1500 }], identityHints: [{ kind: 'email', value: email }] }));
      expect(await codeRow(code.id)).toMatchObject({ status: 'redeemed', redeemed_transaction_id: paid.transaction.id });
      expect(await t.db.selectFrom('transaction_attributions').select(['model', 'creator_id', 'campaign_id', 'code']).where('transaction_id', '=', paid.transaction.id).execute()).toEqual(
        expect.arrayContaining([{ model: 'acquisition', creator_id: 'creator_wagyu_wes', campaign_id: 'camp_spring_launch', code: code.code }]),
      );
      await expect(tenant((ctx) => offers.requestOfferCode(ctx, { offerId: creator.id, email }), ANON)).rejects.toMatchObject({ code: 'invalid', message: 'You have already had this offer.' });
    });

    it('a guest the venue already knew keeps their original stamp and gets a touch instead, which attributes the sale as last touch', async () => {
      const g = await newGuest(t, diner());
      const stampBefore = await t.db.selectFrom('customers').select(['acquisition_source', 'acquisition_creator_id', 'acquisition_code']).where('id', '=', g.customerId).executeTakeFirstOrThrow();
      const code = await tenant((ctx) => offers.requestOfferCode(ctx, { offerId: creator.id, email: g.email }), ANON);
      expect(await t.db.selectFrom('customers').select(['acquisition_source', 'acquisition_creator_id', 'acquisition_code']).where('id', '=', g.customerId).executeTakeFirstOrThrow()).toEqual(stampBefore);
      expect(await t.db.selectFrom('customer_touchpoints').select(['channel', 'creator_id', 'campaign_id', 'code']).where('customer_id', '=', g.customerId).execute()).toEqual([
        { channel: 'criota', creator_id: 'creator_wagyu_wes', campaign_id: 'camp_spring_launch', code: code.code },
      ]);
      t.clock.advanceMinutes(30);
      const paid = await record(t, diner(), sale(t, { cents: 6000, identityHints: [{ kind: 'email', value: g.email }] }));
      expect(await t.db.selectFrom('transaction_attributions').select(['model', 'creator_id', 'code']).where('transaction_id', '=', paid.transaction.id).execute()).toEqual([{ model: 'last_touch', creator_id: 'creator_wagyu_wes', code: code.code }]);

      // A code used at the till without ever being claimed: the use is the touch, and that sale is attributed.
      const h = await newGuest(t, diner());
      const unclaimed = await issue(h.customerId, creator, 'campaign:spring');
      const sold = await record(t, diner(), sale(t, { cents: 6000, discountCents: 1500, discounts: [{ name: unclaimed.code, amountCents: 1500 }], identityHints: [{ kind: 'email', value: h.email }] }));
      expect(await codeRow(unclaimed.id)).toMatchObject({ status: 'redeemed', claimed_at: sold.transaction.occurredAt });
      expect(await t.db.selectFrom('transaction_attributions').select(['model', 'creator_id', 'code']).where('transaction_id', '=', sold.transaction.id).execute()).toEqual([{ model: 'last_touch', creator_id: 'creator_wagyu_wes', code: unclaimed.code }]);
      // Only welcome and creator offers can be asked for by the public.
      await expect(tenant((ctx) => offers.requestOfferCode(ctx, { offerId: comeback.id, email: g.email }), ANON)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  describe('merge, erase, export, numbers, and off', () => {
    it('a merge moves the codes to the surviving record, keeping one live code per offer', async () => {
      const winner = await newGuest(t, diner());
      t.clock.advanceMinutes(1);
      const loser = await newGuest(t, diner());
      const winnersWelcome = await issue(winner.customerId, welcome);
      const losersWelcome = await issue(loser.customerId, welcome);
      const losersComeback = await issue(loser.customerId, comeback, 'flow:winback');
      const manager = await diner().as('manager');
      await tenant((ctx) => identity.mergeCustomers(ctx, { winnerId: winner.customerId, loserId: loser.customerId, reason: 'Duplicate' }), manager);

      expect(await codeRow(losersComeback.id)).toMatchObject({ customer_id: winner.customerId, status: 'issued' });
      expect(await codeRow(winnersWelcome.id)).toMatchObject({ customer_id: winner.customerId, status: 'issued' });
      expect(await codeRow(losersWelcome.id)).toMatchObject({ customer_id: winner.customerId, status: 'voided' });
      expect(await t.db.selectFrom('offer_codes').select('id').where('customer_id', '=', loser.customerId).execute()).toEqual([]);
    });

    it('the guest\'s export lists their codes, and erasing them cancels the unused ones and unlinks the rest', async () => {
      const g = await newGuest(t, diner());
      const live = await issue(g.customerId, welcome);
      const used = await issue(g.customerId, comeback, 'flow:winback');
      await record(t, diner(), sale(t, { cents: 6000, discountCents: 900, discounts: [{ name: used.code, amountCents: 900 }], identityHints: [{ kind: 'email', value: g.email }] }));
      const owner = await diner().as('owner');
      const exported = (await tenant((ctx) => identity.exportCustomer(ctx, g.customerId), owner)) as { offers: Array<{ code: string; status: string }> };
      expect(exported.offers.map((o) => [o.code, o.status]).sort()).toEqual([[live.code, 'issued'], [used.code, 'redeemed']].sort());

      await tenant((ctx) => identity.eraseCustomer(ctx, g.customerId), owner);
      expect(await codeRow(live.id)).toMatchObject({ status: 'voided', customer_id: null, void_reason: 'Guest erased' });
      expect(await codeRow(used.id)).toMatchObject({ status: 'redeemed', customer_id: null });
    });

    it('the offers_summary tool reports issued, claimed, redeemed and the revenue on redeemed sales, by offer, as totals only', async () => {
      const g = group();
      const gt = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) => t.app.tenant(g.orgId, principal, fn);
      const offer = await gt((ctx) => offers.saveOffer(ctx, { kind: 'comeback', name: 'Summary test offer', discountKind: 'fixed', valueCents: 800, codePrefix: 'SUM' }));
      const guests = [];
      for (let i = 0; i < 4; i++) guests.push(await newGuest(t, g));
      const codes: offers.CodeView[] = [];
      for (const guest of guests) codes.push((await gt((ctx) => offers.issueCode(ctx, { offerId: offer.id, customerId: guest.customerId, source: 'campaign:summary' }))).code);
      await gt((ctx) => offers.claimCode(ctx, { code: codes[0]!.code }), ANON);
      await gt((ctx) => offers.claimCode(ctx, { code: codes[1]!.code }), ANON);
      await record(t, g, sale(t, { cents: 6000, discountCents: 800, discounts: [{ name: codes[1]!.code, amountCents: 800 }] }));
      await record(t, g, sale(t, { cents: 9000, discountCents: 800, discounts: [{ name: codes[2]!.code, amountCents: 800 }] }));

      const tool = getTool('offers_summary')!;
      expect(tool).toMatchObject({ module: 'offers', effect: 'read', scope: 'offers:read' });
      const accounts = await g.as('accounts');
      const out = tool.output.parse(await gt((ctx) => (tool as { run: Function }).run({ ctx, venueId: null }, {}), accounts));
      const mine = out.offers.find((o: { name: string }) => o.name === 'Summary test offer');
      expect(mine).toMatchObject({ issued: 4, claimed: 3, redeemed: 2, live: 2, discount_given_cents: 1600, revenue_on_redeemed_sales_cents: 5200 + 8200, redemption_rate: 0.5 });
      expect(out.totals.issued).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(out)).not.toContain(codes[0]!.code);
      expect(JSON.stringify(out)).not.toContain(guests[0]!.email);
      await expect(gt((ctx) => offers.getOffersSummary(ctx), guestOf(guests[0]!.customerId))).rejects.toMatchObject({ code: 'unauthenticated' });
    });

    it('with the module off its functions answer not-found, checkout does not know the code, and a till sale does not redeem it', async () => {
      const g = await newGuest(t, diner());
      const code = await issue(g.customerId);
      const manager = await diner().as('manager');
      await tenant((ctx) => setModule(ctx, offers.offersModule, { venueId: diner().venueId, enabled: false }));
      try {
        const off = { code: 'module_disabled', status: 404 };
        await expect(tenant((ctx) => offers.listOffers(ctx), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => offers.issueCode(ctx, { offerId: welcome.id, customerId: g.customerId, source: 'staff' }), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => offers.claimCode(ctx, { code: code.code }), ANON)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => offers.checkCode(ctx, { venueId: diner().venueId, code: code.code }), manager)).rejects.toMatchObject(off);
        await expect(tenant((ctx) => offers.getOffersSummary(ctx), manager)).rejects.toMatchObject(off);
        expect(await tenant((ctx) => getCheckoutAdjuster('offers')!.quote(ctx, draft(t, diner(), { customerId: g.customerId }), code.code))).toBeNull();
        await record(t, diner(), sale(t, { cents: 6000, discountCents: 1000, discounts: [{ name: code.code, amountCents: 1000 }] }));
        expect((await codeRow(code.id)).status).toBe('issued');
      } finally {
        await resetProgram(t, diner());
      }
      expect((await tenant((ctx) => offers.claimCode(ctx, { code: code.code }), ANON)).status).toBe('claimed');
    });
  });
});
