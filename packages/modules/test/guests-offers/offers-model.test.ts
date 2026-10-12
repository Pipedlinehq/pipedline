import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { campaigns, offers } from '@ros/modules';
import { getCheckoutAdjuster } from '@ros/modules/ordering';
import { DINNER_WED, LUNCH_SUN, WORKER, draft, newGuest, record, unique } from './helpers';

/**
 * The offer model (docs/CONSOLE_IA.md section 9, pattern 6): who may use an offer and when, by
 * list, dates, days, services and limits; automatic against code; what combines with what; the
 * uses a venue sees; and the plain-words summary the server writes.
 */
describe('offers: the model', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const manager = async () => diner().as('manager');
  const save = async (input: offers.OfferInput) => t.app.tenant(diner().orgId, await manager(), (ctx) => offers.saveOffer(ctx, input));
  const adjuster = () => getCheckoutAdjuster('offers')!;
  const quote = (d: ReturnType<typeof draft>, code: string) => t.app.tenant(diner().orgId, WORKER, (ctx) => adjuster().quote(ctx, d, code));
  const auto = (d: ReturnType<typeof draft>, applied: Parameters<typeof offers.automaticAdjustments>[2] = []) => t.app.tenant(diner().orgId, WORKER, (ctx) => offers.automaticAdjustments(ctx, d, applied));
  const issue = async (offerId: string, customerId: string) => (await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId, customerId, source: 'staff' }))).code.code;
  const base = (over: Partial<offers.OfferInput> = {}): offers.OfferInput => ({ kind: 'manual', name: unique('Offer'), discountKind: 'fixed', valueCents: 1000, requiresClaim: false, ...over });
  /** Tests share one database: switch off every automatic offer an earlier test left on. */
  const quiet = async () => {
    const m = await manager();
    for (const o of await t.app.tenant(diner().orgId, m, (ctx) => offers.listOffers(ctx, { method: 'automatic' }))) await t.app.tenant(diner().orgId, m, (ctx) => offers.switchOffer(ctx, o.id, false));
  };

  describe('the summary the server writes', () => {
    it('reads as before for the offers of before, and spells out the newer settings in order', () => {
      const plain = { discount_kind: 'fixed' as const, value_cents: 1000, percent_off: null, min_spend_cents: 4000 };
      expect(offers.offerSummary(plain)).toBe('$10 off when you spend $40 or more');
      expect(offers.offerSummary({ ...plain, discount_kind: 'percent', percent_off: 15, min_spend_cents: 0 })).toBe('15% off');
      const full = offers.offerSummary(
        {
          discount_kind: 'fixed',
          value_cents: 1000,
          percent_off: null,
          min_spend_cents: 0,
          method: 'code',
          applies_to: 'category',
          category: 'Mains',
          audience: 'list',
          days: [2, 3, 4],
          services: ['dinner'],
          ends_at: new Date('2026-11-30T12:59:00.000Z'),
          per_guest_limit: 1,
        },
        'AUD',
        { segmentName: 'Lapsed 60+ days', timezone: 'Australia/Sydney' },
      );
      expect(full).toBe('$10 off any main for Lapsed 60+ days, Tuesday to Thursday dinner, until 30 Nov, one per guest');
      expect(offers.offerSummary({ discount_kind: 'percent', value_cents: null, percent_off: 100, min_spend_cents: 0, applies_to: 'delivery', audience: 'loyalty_members', method: 'automatic' })).toBe('Free delivery for loyalty members, applied automatically, not with other offers');
      expect(offers.offerSummary({ discount_kind: 'percent', value_cents: null, percent_off: 20, min_spend_cents: 0, method: 'automatic', applies_to: 'bill', audience: 'new_guests', days: [5, 6, 0], time_from: '16:00:00', time_to: '18:00:00', total_limit: 100, combine_item: true })).toBe(
        '20% off for new guests, Friday to Sunday 4pm to 6pm, first 100 uses, applied automatically',
      );
      expect(offers.daysWords([1, 3])).toBe('Monday and Wednesday');
      expect(offers.daysWords([0, 1, 2, 3, 4, 5, 6])).toBeNull();
      expect(offers.categoryWords('Desserts')).toBe('any dessert');
      expect(offers.clockWords('12:00:00')).toBe('12 noon');
    });
  });

  describe('eligibility', () => {
    it('by guest list: a member\'s code works, a non-member\'s does not, and leaving the list ends it', async () => {
      const suburb = unique('Eligible');
      const member = await newGuest(t, diner(), { suburb });
      const other = await newGuest(t, diner());
      const list = await t.app.tenant(diner().orgId, await manager(), (ctx) => campaigns.saveSegment(ctx, { name: unique('Members'), query: `suburb is "${suburb}"` }));
      const o = await save(base({ audience: 'list', segmentId: list.id, codePrefix: 'LST' }));
      expect(o.summary).toBe(`$10 off for ${list.name}`);
      const memberCode = await issue(o.id, member.customerId);
      const otherCode = await issue(o.id, other.customerId);
      const d = draft(diner(), t.clock());
      expect(await quote({ ...d, customerId: member.customerId }, memberCode)).toMatchObject({ amountCents: 1000, ref: { offerId: o.id } });
      await expect(quote({ ...d, customerId: other.customerId }, otherCode)).rejects.toMatchObject({ code: 'invalid', message: 'That offer is for a particular group of guests.' });
      // With nobody signed in, the code's own holder is who it is for: the member's code still works, the other's still does not.
      expect(await quote(d, memberCode)).toMatchObject({ amountCents: 1000 });
      await expect(quote(d, otherCode)).rejects.toMatchObject({ code: 'invalid' });
      // Everyone, new guests, loyalty members.
      const everyone = await save(base({ codePrefix: 'ALL' }));
      expect(await quote(d, await issue(everyone.id, other.customerId))).toMatchObject({ amountCents: 1000 });
      const newcomers = await save(base({ audience: 'new_guests', codePrefix: 'NEW' }));
      const regular = await newGuest(t, diner());
      await record(t, diner(), regular.customerId, { at: new Date(t.clock().getTime() - 86_400_000) });
      expect(await quote({ ...d, customerId: other.customerId }, await issue(newcomers.id, other.customerId))).toMatchObject({ amountCents: 1000 });
      await expect(quote({ ...d, customerId: regular.customerId }, await issue(newcomers.id, regular.customerId))).rejects.toMatchObject({ message: 'That offer is for first-time guests.' });
      const members = await save(base({ audience: 'loyalty_members', codePrefix: 'MEM' }));
      await expect(quote({ ...d, customerId: other.customerId }, await issue(members.id, other.customerId))).rejects.toMatchObject({ message: 'That offer is for loyalty members.' });
    });

    it('by dates: scheduled, active and expired are worked out from the clock, and the views agree', async () => {
      const now = t.clock();
      const soon = await save(base({ startsAt: new Date(now.getTime() + 3 * 86_400_000), codePrefix: 'SOON' }));
      const gone = await save(base({ endsAt: new Date(now.getTime() - 86_400_000), codePrefix: 'GONE' }));
      const live = await save(base({ startsAt: new Date(now.getTime() - 86_400_000), endsAt: new Date(now.getTime() + 86_400_000), codePrefix: 'LIVE' }));
      const off = await save(base({ isActive: false, codePrefix: 'OFFX' }));
      expect([soon.status, gone.status, live.status, off.status]).toEqual(['scheduled', 'expired', 'active', 'off']);
      const m = await manager();
      const byStatus = async (status: offers.OfferStatus) => (await t.app.tenant(diner().orgId, m, (ctx) => offers.listOffers(ctx, { status }))).map((o) => o.id);
      expect(await byStatus('scheduled')).toContain(soon.id);
      expect(await byStatus('expired')).toContain(gone.id);
      expect(await byStatus('active')).toContain(live.id);
      expect(await byStatus('off')).toContain(off.id);
      expect(await byStatus('active')).not.toContain(soon.id);
      expect(await byStatus('active')).not.toContain(gone.id);

      const g = await newGuest(t, diner());
      const d = { ...draft(diner(), now), customerId: g.customerId };
      await expect(quote(d, await issue(soon.id, g.customerId))).rejects.toMatchObject({ message: /^That offer starts on \d+ \w+\.$/ });
      await expect(t.app.tenant(diner().orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId: gone.id, customerId: g.customerId, source: 'staff' }))).rejects.toMatchObject({ message: 'That offer has ended.' });
      expect(await quote(d, await issue(live.id, g.customerId))).toMatchObject({ amountCents: 1000 });
      // Three days on, the scheduled offer is live and the live one has ended. The adjuster reads the clock.
      const later = new Date(now.getTime() + 3 * 86_400_000 + 60_000);
      const soonCode = await issue(soon.id, g.customerId);
      const liveCode = await issue(live.id, g.customerId);
      t.clock.set(later);
      expect(await quote({ ...d, at: later }, soonCode)).toMatchObject({ amountCents: 1000 });
      await expect(quote({ ...d, at: later }, liveCode)).rejects.toMatchObject({ message: 'That offer has ended.' });
      t.clock.set(now);
    });

    it('by days and services, in the venue\'s own time: Tuesday to Thursday dinner', async () => {
      const g = await newGuest(t, diner());
      const o = await save(base({ days: [2, 3, 4], services: ['dinner'], codePrefix: 'TTD' }));
      expect(o.summary).toBe('$10 off, Tuesday to Thursday dinner');
      const code = await issue(o.id, g.customerId);
      const d = { ...draft(diner(), DINNER_WED), customerId: g.customerId };
      // Wednesday 19:00: dinner.
      t.clock.set(DINNER_WED);
      expect(await quote(d, code)).toMatchObject({ amountCents: 1000 });
      // Wednesday 12:00: lunch.
      const lunch = new Date('2026-09-30T02:00:00.000Z');
      t.clock.set(lunch);
      await expect(quote({ ...d, at: lunch }, code)).rejects.toMatchObject({ message: 'That offer is for dinner only.' });
      // Sunday: not one of the days.
      t.clock.set(LUNCH_SUN);
      await expect(quote({ ...d, at: LUNCH_SUN }, code)).rejects.toMatchObject({ message: 'That offer is not on Sundays.' });
      t.clock.set(new Date('2026-09-30T02:00:00.000Z'));
      // A daily window.
      const happy = await save(base({ timeFrom: '16:00', timeTo: '18:00', codePrefix: 'HAPP' }));
      const happyCode = await issue(happy.id, g.customerId);
      await expect(quote(d, happyCode)).rejects.toMatchObject({ message: 'That offer runs 4pm to 6pm.' });
      const five = new Date('2026-09-30T07:00:00.000Z');
      t.clock.set(five);
      expect(await quote({ ...d, at: five }, happyCode)).toMatchObject({ amountCents: 1000 });
      t.clock.set(new Date('2026-09-30T02:00:00.000Z'));
    });

    it('by limits: per guest and in total, counted over codes used and automatic uses', async () => {
      await quiet();
      const a = await newGuest(t, diner());
      const b = await newGuest(t, diner());
      const o = await save(base({ method: 'automatic', discountKind: 'percent', percentOff: 10, perGuestLimit: 1, totalLimit: 2 }));
      expect(o.summary).toBe('10% off, one per guest, first 2 uses, applied automatically, not with other offers');
      const dA = { ...draft(diner(), t.clock()), customerId: a.customerId };
      expect(await auto(dA)).toMatchObject([{ amountCents: 960, ref: { offerId: o.id, auto: '1' } }]);
      // A till sale carrying the offer's name is a use.
      const sale1 = await record(t, diner(), a.customerId, { discountCents: 500, discounts: [{ name: o.name, code: null, amountCents: 500 }] });
      expect(await t.db.selectFrom('offer_uses').select(['customer_id', 'transaction_id', 'discount_cents']).where('offer_id', '=', o.id).execute()).toEqual([{ customer_id: a.customerId, transaction_id: sale1.transaction.id, discount_cents: 500 }]);
      expect(await auto(dA)).toEqual([]);
      const dB = { ...draft(diner(), t.clock()), customerId: b.customerId };
      expect(await auto(dB)).toHaveLength(1);
      await record(t, diner(), b.customerId, { discountCents: 500, discounts: [{ name: o.name, code: null, amountCents: 500 }] });
      // Two uses in total: nobody else gets it.
      const c = await newGuest(t, diner());
      expect(await auto({ ...draft(diner(), t.clock()), customerId: c.customerId })).toEqual([]);
      expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.offerUseCount(ctx, o.id))).toBe(2);
    });
  });

  describe('automatic against code', () => {
    it('an automatic offer is priced with no code and has none; a code offer is never applied by itself', async () => {
      await quiet();
      const g = await newGuest(t, diner());
      const automatic = await save(base({ method: 'automatic', discountKind: 'percent', percentOff: 10 }));
      const byCode = await save(base({ method: 'code', codePrefix: 'BYC' }));
      const d = { ...draft(diner(), t.clock()), customerId: g.customerId };
      const got = await auto(d);
      expect(got.map((a) => a.ref.offerId)).toEqual([automatic.id]);
      expect(got[0]).toMatchObject({ adjuster: 'offers', code: `auto:${automatic.id}`, amountCents: 960, label: `${automatic.name}: 10% off, applied automatically, not with other offers` });
      await expect(t.app.tenant(diner().orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId: automatic.id, customerId: g.customerId, source: 'staff' }))).rejects.toMatchObject({ code: 'invalid', message: /has no codes/ });
      expect(await quote(d, `auto:${automatic.id}`)).toBeNull();
      expect(await quote(d, await issue(byCode.id, g.customerId))).toMatchObject({ amountCents: 1000 });
      // The public sign-up page does not offer an automatic offer.
      const pub = await save(base({ kind: 'welcome', method: 'automatic', discountKind: 'percent', percentOff: 5 }));
      await expect(t.app.tenant(diner().orgId, { kind: 'anon' }, (ctx) => offers.getPublicOffer(ctx, pub.id))).resolves.toMatchObject({ signupOpen: false });
      // What it applies to: a category, one dish, the bill.
      const mains = await save(base({ method: 'automatic', appliesTo: 'category', category: 'Mains', valueCents: 500 }));
      const only = (await auto(d)).filter((a) => a.ref.offerId === mains.id);
      expect(only).toHaveLength(0); // it cannot sit with the 10% bill offer: neither allows the other
      await t.app.tenant(diner().orgId, await manager(), (ctx) => offers.switchOffer(ctx, automatic.id, false));
      await t.app.tenant(diner().orgId, await manager(), (ctx) => offers.switchOffer(ctx, pub.id, false));
      expect(await auto(d)).toMatchObject([{ ref: { offerId: mains.id }, amountCents: 500 }]);
      // One dish, by its real menu item: half price on that line, and it outranks the $5 category offer it cannot sit with.
      const item = await t.db.selectFrom('menu_items').select(['id', 'name']).where('org_id', '=', diner().orgId).orderBy('name').executeTakeFirstOrThrow();
      const dish = await save(base({ method: 'automatic', appliesTo: 'item', menuItemId: item.id, discountKind: 'percent', percentOff: 50, combineItem: true }));
      expect(dish.summary).toBe(`50% off ${item.name}, applied automatically`);
      await expect(save(base({ method: 'automatic', appliesTo: 'item', menuItemId: randomUUID() }))).rejects.toMatchObject({ code: 'not_found' });
      const withDish = { ...d, lines: [{ ...d.lines[0]!, menuItemId: item.id }, ...d.lines.slice(1)] };
      expect(await auto(withDish)).toMatchObject([{ ref: { offerId: dish.id }, amountCents: 2400 }]);
      expect(await auto({ ...d, lines: d.lines.filter((l) => l.category !== 'Mains'), subtotalCents: 1200 })).toEqual([]);
    });
  });

  describe('combining', () => {
    it('two offers sit on one bill only when each allows the other\'s class; largest first otherwise', async () => {
      await quiet();
      const g = await newGuest(t, diner());
      const bill = await save(base({ method: 'automatic', discountKind: 'percent', percentOff: 10, name: unique('Bill10') }));
      const mains = await save(base({ method: 'automatic', appliesTo: 'category', category: 'Mains', valueCents: 500, name: unique('Mains5') }));
      const d = { ...draft(diner(), t.clock()), customerId: g.customerId };
      // Neither combines: the bigger one (10% of $96 = $9.60) wins.
      expect((await auto(d)).map((a) => a.ref.offerId)).toEqual([bill.id]);
      expect(offers.canCombine({ applies_to: 'bill', combine_item: false, combine_bill: false, combine_delivery: false }, { applies_to: 'category', combine_item: false, combine_bill: true, combine_delivery: false })).toBe(false);
      // Both allow each other: both apply, and the second comes off what is left.
      await save({ ...base({ method: 'automatic', discountKind: 'percent', percentOff: 10, name: bill.name, combineItem: true }), id: bill.id });
      await save({ ...base({ method: 'automatic', appliesTo: 'category', category: 'Mains', valueCents: 500, name: mains.name, combineBill: true }), id: mains.id });
      const both = await auto(d);
      expect(both.map((a) => [a.ref.offerId, a.amountCents])).toEqual([
        [bill.id, 960],
        [mains.id, 500],
      ]);
      // A code already on the bill counts too: a code offer that combines with nothing keeps the automatic ones off.
      const code = await save(base({ method: 'code', codePrefix: 'SOLO', name: unique('Solo') }));
      const codeAdj = (await quote(d, await issue(code.id, g.customerId)))!;
      expect(await auto(d, [codeAdj])).toEqual([]);
      expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.codeCombinesWith(ctx, codeAdj.code, both))).toMatch(/cannot be used together with/);
      // A whole-bill code that combines with anything: the category offer joins it (it allows bill offers), the 10% bill offer does not (it allows dish offers only).
      const friendly = await save(base({ method: 'code', codePrefix: 'FRND', name: unique('Friendly'), combineBill: true, combineItem: true }));
      const friendlyAdj = (await quote(d, await issue(friendly.id, g.customerId)))!;
      expect((await auto(d, [friendlyAdj])).map((a) => a.ref.offerId)).toEqual([mains.id]);
      expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.codeCombinesWith(ctx, friendlyAdj.code, both))).toMatch(/cannot be used together with/);
      expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.codeCombinesWith(ctx, friendlyAdj.code, [both[1]!]))).toBeNull();
      await t.app.tenant(diner().orgId, await manager(), (ctx) => offers.switchOffer(ctx, bill.id, false));
      await t.app.tenant(diner().orgId, await manager(), (ctx) => offers.switchOffer(ctx, mains.id, false));
    });
  });

  describe('usage counts and sales attributed', () => {
    it('a till sale naming an automatic offer counts once however often it arrives; a refund releases it; the summary adds codes and uses', async () => {
      await quiet();
      const g = await newGuest(t, diner());
      const o = await save(base({ method: 'automatic', discountKind: 'fixed', valueCents: 700, name: unique('Tuesday pasta night') }));
      const first = await record(t, diner(), g.customerId, { cents: 6000, discountCents: 700, discounts: [{ name: o.name.toUpperCase(), code: null, amountCents: 700 }] });
      // The same sale again (a webhook replay) is the same use.
      const ref = first.transaction.externalRef;
      const again = await record(t, diner(), g.customerId, { externalRef: ref, cents: 6000, discountCents: 700, discounts: [{ name: o.name, code: null, amountCents: 700 }] });
      expect(again.transaction.id).toBe(first.transaction.id);
      const uses = await t.db.selectFrom('offer_uses').select(['transaction_id', 'discount_cents', 'released_at']).where('offer_id', '=', o.id).execute();
      expect(uses).toEqual([{ transaction_id: first.transaction.id, discount_cents: 700, released_at: null }]);
      const m = await manager();
      let s = (await t.app.tenant(diner().orgId, m, (ctx) => offers.getOffersSummary(ctx))).offers.find((x) => x.offerId === o.id)!;
      expect(s).toMatchObject({ uses: 1, discountCents: 700, revenueCents: 5300, method: 'automatic', status: 'active', issued: 0 });
      expect(await t.db.selectFrom('events').select('name').where('name', '=', 'offer.applied').where('customer_id', '=', g.customerId).execute()).toHaveLength(1);
      // Refunded in full: the use no longer counts.
      await record(t, diner(), g.customerId, { externalRef: ref, cents: 6000, discountCents: 700, status: 'refunded', refundedCents: 5300 });
      expect((await t.db.selectFrom('offer_uses').select('released_at').where('offer_id', '=', o.id).executeTakeFirstOrThrow()).released_at).not.toBeNull();
      s = (await t.app.tenant(diner().orgId, m, (ctx) => offers.getOffersSummary(ctx))).offers.find((x) => x.offerId === o.id)!;
      expect(s.uses).toBe(0);
      // A code offer's redeemed codes are uses too, beside the automatic ones, in one number.
      const byCode = await save(base({ method: 'code', codePrefix: 'CNT', valueCents: 300, name: unique('Counted') }));
      const code = await issue(byCode.id, g.customerId);
      await record(t, diner(), g.customerId, { cents: 4000, discountCents: 300, discounts: [{ name: 'Promo', code, amountCents: 300 }] });
      const summary = await t.app.tenant(diner().orgId, m, (ctx) => offers.getOffersSummary(ctx));
      expect(summary.offers.find((x) => x.offerId === byCode.id)).toMatchObject({ uses: 1, redeemed: 1, issued: 1, revenueCents: 3700 });
      expect(summary.totals.uses).toBeGreaterThanOrEqual(1);
      // The tool carries the same, with status and summary, as an allowlisted shape.
      const tool = offers.offersSummaryTool as unknown as { run: (c: { ctx: unknown; venueId: null }, i: { status?: string }) => Promise<{ offers: Array<{ offer_id: string; uses: number; status: string; summary: string; method: string }> }> };
      const out = await t.app.tenant(diner().orgId, m, (ctx) => tool.run({ ctx, venueId: null }, { status: 'active' }));
      const row = out.offers.find((x) => x.offer_id === byCode.id)!;
      expect(row).toMatchObject({ uses: 1, status: 'active', method: 'code', summary: '$3 off' });
    });
  });

  describe('the offers of before', () => {
    it('a welcome and a come-back offer are instances of the model: code, whole bill, everyone, and read as they did', async () => {
      const welcome = await save({ kind: 'welcome', name: unique('Welcome'), discountKind: 'fixed', valueCents: 1000, minSpendCents: 4000, validityDays: 30, codePrefix: 'oak-w' });
      const comeback = await save({ kind: 'comeback', name: unique('We miss you'), discountKind: 'percent', percentOff: 15, validityDays: 21, codePrefix: 'OAK-C' });
      expect(welcome).toMatchObject({ method: 'code', appliesTo: 'bill', audience: 'everyone', status: 'active', summary: '$10 off when you spend $40 or more', days: null, services: null, perGuestLimit: null });
      expect(comeback.summary).toBe('15% off');
      const g = await newGuest(t, diner());
      const d = { ...draft(diner(), t.clock()), customerId: g.customerId };
      expect(await quote(d, await issue(welcome.id, g.customerId))).toMatchObject({ amountCents: 1000, label: `${welcome.name}: $10 off when you spend $40 or more` });
      // Switching off, and back on, is its own audited change.
      const m = await manager();
      const off = await t.app.tenant(diner().orgId, m, (ctx) => offers.switchOffer(ctx, comeback.id, false));
      expect(off.status).toBe('off');
      expect((await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', comeback.id).execute()).map((a) => a.action)).toContain('offer.switched');
      // Front of house cannot switch an offer.
      await expect(t.app.tenant(diner().orgId, await diner().as('host'), (ctx) => offers.switchOffer(ctx, comeback.id, true))).rejects.toMatchObject({ code: 'forbidden' });
    });
  });
});
