import { describe, expect, it } from 'vitest';
import { drainJobs } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import { useTestEnv } from '@ros/testkit';
import { approvals, campaigns, identity, offers } from '@ros/modules';
import { WORKER, newGuest, noShow, record, unique } from './helpers';

/**
 * Guest lists (docs/CONSOLE_IA.md section 9, pattern 5): the plain query language parses and
 * refuses what it should; every field and operator picks the same guests an independent
 * JavaScript oracle does; the default lists exist for both orgs and cannot be deleted; one org's
 * list is not another's; a campaign to a list reaches only its members who hold consent.
 */

type Node = identity.ListNode;

/** The oracle: every guest's facts pulled with plain selects, the rule evaluated in JavaScript. */
async function oracle(t: ReturnType<typeof useTestEnv>, org: FixtureOrg) {
  const now = t.clock().getTime();
  const DAY = 86_400_000;
  const customers = await t.db.selectFrom('customers').select(['id', 'created_at', 'suburb', 'acquisition_source', 'primary_email', 'primary_phone']).where('org_id', '=', org.orgId).where('status', '=', 'active').execute();
  const sales = await t.db.selectFrom('transactions').select(['customer_id', 'occurred_at', 'total_cents', 'refunded_cents']).where('org_id', '=', org.orgId).where('status', '<>', 'voided').where('customer_id', 'is not', null).execute();
  const byCustomer = new Map<string, { visits: number; spend: number; first: number; last: number }>();
  for (const s of sales) {
    const f = byCustomer.get(s.customer_id!) ?? { visits: 0, spend: 0, first: Infinity, last: -Infinity };
    f.visits++;
    f.spend += Number(s.total_cents) - Number(s.refunded_cents);
    f.first = Math.min(f.first, s.occurred_at.getTime());
    f.last = Math.max(f.last, s.occurred_at.getTime());
    byCustomer.set(s.customer_id!, f);
  }
  const consents = new Set((await t.db.selectFrom('consents').select(['customer_id', 'purpose']).where('org_id', '=', org.orgId).where('status', '=', 'granted').execute()).map((c) => `${c.customer_id}:${c.purpose}`));
  const members = new Set((await t.db.selectFrom('events').select('customer_id').where('org_id', '=', org.orgId).where('name', '=', 'loyalty.enrolled').execute()).map((e) => e.customer_id));
  const noShows = new Map<string, number>();
  for (const e of await t.db.selectFrom('events').select('customer_id').where('org_id', '=', org.orgId).where('name', '=', 'booking.no_show').execute()) noShows.set(e.customer_id!, (noShows.get(e.customer_id!) ?? 0) + 1);

  const cmp = (op: string, a: number, b: number) => (op === 'more_than' ? a > b : op === 'less_than' ? a < b : op === 'is' ? a === b : a !== b);
  const clause = (c: identity.ListClause, g: (typeof customers)[number]): boolean => {
    const f = byCustomer.get(g.id);
    switch (c.field) {
      case 'last_visit': {
        if (c.op === 'never') return !f;
        if (!f) return false;
        return c.op === 'within_days' ? f.last >= now - c.days * DAY : f.last < now - c.days * DAY;
      }
      case 'first_visit': {
        if (c.op === 'never') return !f;
        const first = f ? f.first : g.created_at.getTime();
        return c.op === 'within_days' ? first >= now - c.days * DAY : first < now - c.days * DAY;
      }
      case 'visits':
        return cmp(c.op, f?.visits ?? 0, c.value);
      case 'spend':
        return cmp(c.op, f?.spend ?? 0, c.value);
      case 'average_spend':
        return f && f.visits > 0 ? cmp(c.op, Math.trunc(f.spend / f.visits), c.value) : false;
      case 'no_shows':
        return cmp(c.op, noShows.get(g.id) ?? 0, c.value);
      case 'email_yes':
        return consents.has(`${g.id}:marketing_email`) === ((c.op === 'is') === c.value);
      case 'texts_yes':
        return consents.has(`${g.id}:marketing_sms`) === ((c.op === 'is') === c.value);
      case 'loyalty_member':
        return members.has(g.id) === ((c.op === 'is') === c.value);
      case 'suburb':
        return ((g.suburb ?? '').trim().toLowerCase() === c.value.trim().toLowerCase() && !!g.suburb) === (c.op === 'is');
      case 'source':
        return (g.acquisition_source === c.value.toLowerCase().replace(/\s+/g, '-')) === (c.op === 'is');
    }
  };
  const walk = (n: Node, g: (typeof customers)[number]): boolean => ('and' in n ? n.and.every((x) => walk(x, g)) : 'or' in n ? n.or.some((x) => walk(x, g)) : clause(n, g));
  return (text: string) => {
    const node = identity.parseListQuery(text);
    const hit = customers.filter((g) => walk(node, g));
    return { count: hit.length, ids: new Set(hit.map((g) => g.id)) };
  };
}

describe('guest lists: the plain query language', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;

  describe('the grammar', () => {
    it('parses the two documented examples, writes them back the same, and reads as a sentence', () => {
      const a = identity.parseListQuery('last visit more than 60 days ago and said yes to email');
      expect(a).toEqual({ and: [{ field: 'last_visit', op: 'more_than_days_ago', days: 60 }, { field: 'email_yes', op: 'is', value: true }] });
      expect(identity.listText(a)).toBe('last visit more than 60 days ago and said yes to email is yes');
      expect(identity.parseListQuery(identity.listText(a))).toEqual(a);
      expect(identity.listWords(a)).toBe('Guests who last visit was more than 60 days ago and said yes to email');

      const b = identity.parseListQuery('(spend more than $500 or visits more than 10) and suburb is Newtown');
      expect(b).toEqual({ and: [{ or: [{ field: 'spend', op: 'more_than', value: 50_000 }, { field: 'visits', op: 'more_than', value: 10 }] }, { field: 'suburb', op: 'is', value: 'Newtown' }] });
      expect(identity.listText(b)).toBe('(spend more than $500 or visits more than 10) and suburb is Newtown');
      expect(identity.parseListQuery(identity.listText(b))).toEqual(b);
    });

    it('"and" binds before "or"; brackets change that; every operator round-trips', () => {
      const plain = identity.parseListQuery('visits more than 3 and spend less than $20 or loyalty member');
      expect(plain).toEqual({ or: [{ and: [{ field: 'visits', op: 'more_than', value: 3 }, { field: 'spend', op: 'less_than', value: 2000 }] }, { field: 'loyalty_member', op: 'is', value: true }] });
      const texts = [
        'last visit within the last 30 days',
        'first visit more than 365 days ago',
        'last visit is never',
        'visits is 1',
        'visits is not 1',
        'average spend more than $60.50',
        'no-shows more than 0',
        'said yes to texts is no',
        'loyalty member is not yes',
        'suburb is not "Surry Hills"',
        'source is walk-in',
        'suburb is Bondi Beach and visits less than 5',
      ];
      for (const text of texts) {
        const node = identity.parseListQuery(text);
        expect(identity.parseListQuery(identity.listText(node))).toEqual(node);
      }
      // Case and spacing do not matter; money reads with or without the sign; a plain "no shows" is accepted.
      expect(identity.listText(identity.parseListQuery('  SPEND more than 500 AND No Shows is 2 '))).toBe('spend more than $500 and no-shows is 2');
    });

    it('refuses anything that is not the grammar, in a sentence the person can act on', () => {
      const bad: Array<[string, RegExp]> = [
        ["suburb is Newtown'; drop table customers; --", /do not understand/i],
        ['select * from customers', /do not understand/i],
        ['select name from customers', /not a field I know/i],
        ['visits > 3', /do not understand/i],
        ['visits more than three', /needs a number/i],
        ['last visit more than 60 days', /days ago/i],
        ['last visit within the last 2 months', /Count in days/i],
        ['spend more than $5 and', /ends where a condition should be/i],
        ['(spend more than $5', /not closed/i],
        ['spend more than $5)', /never opened/i],
        ['email is yes', /not a field I know/i],
        ['suburb Newtown', /write "is <value>"/i],
        ['not suburb is Newtown', /not a field I know/i],
        ['', /Write a rule/i],
        ['x'.repeat(601), /under 600 characters/i],
      ];
      for (const [text, why] of bad) {
        expect(() => identity.parseListQuery(text), text).toThrowError(why);
      }
      // The refusals are AppError('invalid'), so the console shows them in place.
      try {
        identity.parseListQuery('visits > 3');
      } catch (e) {
        expect(e).toMatchObject({ code: 'invalid' });
      }
    });

    it('allows ten conditions and refuses an eleventh, however they are grouped', () => {
      const ten = Array.from({ length: 10 }, (_, i) => `visits is ${i}`).join(' or ');
      expect(identity.countClauses(identity.parseListQuery(ten))).toBe(10);
      const eleven = `${ten} or visits is 10`;
      expect(() => identity.parseListQuery(eleven)).toThrowError(/at most 10 conditions/);
      const nested = `(${Array.from({ length: 6 }, (_, i) => `visits is ${i}`).join(' and ')}) or (${Array.from({ length: 5 }, (_, i) => `spend is $${i}`).join(' and ')})`;
      expect(() => identity.parseListQuery(nested)).toThrowError(/at most 10 conditions/);
    });

    it('a value a person typed is a bound parameter: it matches only a guest carrying that exact text', async () => {
      const tag = `x' or '1'='1 ${unique('s')}`;
      const g = await newGuest(t, diner(), { suburb: tag });
      const manager = await diner().as('manager');
      const rows = await t.app.tenant(diner().orgId, manager, (ctx) => identity.listCustomers(ctx, { query: `suburb is "${tag}"`, limit: 50 }));
      expect(rows.map((r) => r.id)).toEqual([g.customerId]);
      const injected = await t.app.tenant(diner().orgId, manager, (ctx) => identity.listCustomers(ctx, { query: `suburb is "') or true or ('"`, limit: 50 }));
      expect(injected).toEqual([]);
      expect(Number((await t.db.selectFrom('customers').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBeGreaterThan(100);
    });
  });

  describe('every field and operator, against an independent oracle, on both fixture orgs', () => {
    const rules = [
      'visits more than 3',
      'visits less than 2',
      'visits is 1',
      'visits is not 1',
      'spend more than $500',
      'spend less than $50',
      'spend is not 0',
      'average spend more than $60',
      'average spend less than $40',
      'last visit within the last 30 days',
      'last visit more than 60 days ago',
      'last visit is never',
      'first visit within the last 90 days',
      'first visit more than 365 days ago',
      'said yes to email',
      'said yes to email is no',
      'said yes to texts is yes',
      'loyalty member is yes',
      'loyalty member is no',
      'no-shows more than 0',
      'no-shows is 0',
      'suburb is Newtown',
      'suburb is not Newtown',
      'source is walk-in',
      'source is not organic',
      '(spend more than $200 or visits more than 5) and said yes to email',
      'last visit more than 60 days ago and said yes to email',
      'loyalty member and no-shows more than 1 or suburb is Newtown',
    ];

    for (const org of ['diner', 'group'] as const) {
      it(`at ${org}`, async () => {
        const o = t.fixture[org];
        // Facts the fixtures do not seed: a few suburbs and no-shows.
        const a = await newGuest(t, o, { suburb: 'Newtown', emailConsent: true });
        const b = await newGuest(t, o, { suburb: 'newtown ' });
        await newGuest(t, o, { suburb: 'Surry Hills', source: 'walk-in' });
        await record(t, o, a.customerId, { cents: 30_000 });
        await noShow(t, o, a.customerId);
        await noShow(t, o, a.customerId);
        await noShow(t, o, b.customerId);
        const count = await oracle(t, o);
        const owner = await o.as('owner');
        let nonEmpty = 0;
        for (const rule of rules) {
          const want = count(rule);
          const got = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { query: rule }));
          expect({ rule, count: got.count }).toEqual({ rule, count: want.count });
          // The members themselves, through the Customers index, when the list is small enough to read back whole.
          if (want.count > 0 && want.count <= 200) {
            const rows = await t.app.tenant(o.orgId, owner, (ctx) => identity.listCustomers(ctx, { query: rule, limit: 200 }));
            expect(new Set(rows.map((r) => r.id))).toEqual(want.ids);
          }
          if (want.count > 0) nonEmpty++;
        }
        expect(nonEmpty).toBeGreaterThan(rules.length * 0.7);
        // Suburb matching ignores case and stray spaces.
        expect(count('suburb is Newtown').ids.has(b.customerId)).toBe(true);
      });
    }
  });

  describe('default lists and ownership', () => {
    it('both fixture orgs have the five default lists, written in plain words, which cannot be changed or deleted', async () => {
      for (const o of [diner(), group()]) {
        const manager = await o.as('manager');
        const lists = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.listSegments(ctx));
        const system = lists.filter((s) => s.isSystem);
        expect(system.map((s) => s.name).sort()).toEqual(['Big spenders', 'Lapsed 60+ days', 'New this month', 'Regulars', 'Said yes to email']);
        for (const s of system) {
          expect(s.query).toBeTruthy();
          expect(s.words).toMatch(/^Guests who /);
          await expect(t.app.tenant(o.orgId, manager, (ctx) => campaigns.deleteSegment(ctx, s.id))).rejects.toMatchObject({ code: 'invalid' });
          await expect(t.app.tenant(o.orgId, manager, (ctx) => campaigns.saveSegment(ctx, { id: s.id, name: s.name, query: 'visits is 1' }))).rejects.toMatchObject({ code: 'invalid' });
        }
        const rows = await t.db.selectFrom('segments').select(['name', 'is_system']).where('org_id', '=', o.orgId).where('is_system', '=', true).execute();
        expect(rows).toHaveLength(5);
        // Lapsed 60+ days is the Customers page's lapsed view, as a list: nobody in it was in within 60 days.
        const lapsed = system.find((s) => s.name === 'Lapsed 60+ days')!;
        const members = await t.app.tenant(o.orgId, manager, (ctx) => identity.listCustomers(ctx, { query: lapsed.query!, limit: 200 }));
        const cutoff = t.clock().getTime() - 60 * 86_400_000;
        for (const m of members) expect(m.lastVisitAt!.getTime()).toBeLessThan(cutoff);
      }
    });

    it('a saved list stores the canonical wording, is audited, and the words come back on read', async () => {
      const manager = await diner().as('manager');
      const s = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: unique('Quiet Tuesday'), query: 'Visits more than 2 AND last visit within the last 90 days' }));
      expect(s.query).toBe('visits more than 2 and last visit within the last 90 days');
      expect(s.words).toBe('Guests who have more than 2 visits and last visit was in the last 90 days');
      const row = await t.db.selectFrom('segments').select(['definition', 'is_system']).where('id', '=', s.id).executeTakeFirstOrThrow();
      expect(row).toEqual({ definition: { query: 'visits more than 2 and last visit within the last 90 days' }, is_system: false });
      expect((await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', s.id).execute()).map((a) => a.action)).toContain('segment.created');
      await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: unique('bad'), query: 'visits > 2' }))).rejects.toMatchObject({ code: 'invalid' });
      // Front of house may not define lists.
      const host = await diner().as('host');
      await expect(t.app.tenant(diner().orgId, host, (ctx) => campaigns.saveSegment(ctx, { name: unique('host'), query: 'visits is 1' }))).rejects.toMatchObject({ code: 'forbidden' });
    });

    it("a venue's list from org A is not visible to org B, and cannot be used by org B's offers", async () => {
      const managerA = await diner().as('manager');
      const s = await t.app.tenant(diner().orgId, managerA, (ctx) => campaigns.saveSegment(ctx, { name: unique('Only ours'), query: 'spend more than $1' }));
      const managerB = await group().as('manager');
      await expect(t.app.tenant(group().orgId, managerB, (ctx) => campaigns.getSegment(ctx, s.id))).rejects.toMatchObject({ code: 'not_found' });
      await expect(t.app.tenant(group().orgId, managerB, (ctx) => campaigns.previewSegment(ctx, { segmentId: s.id }))).rejects.toMatchObject({ code: 'not_found' });
      expect((await t.app.tenant(group().orgId, managerB, (ctx) => campaigns.listSegments(ctx))).some((x) => x.id === s.id)).toBe(false);
      await expect(
        t.app.tenant(group().orgId, managerB, (ctx) => offers.saveOffer(ctx, { kind: 'manual', name: 'Theirs', discountKind: 'percent', percentOff: 10, audience: 'list', segmentId: s.id, method: 'automatic' })),
      ).rejects.toMatchObject({ code: 'not_found' });
      // An offer at org A may use it, and then the list is kept.
      const offer = await t.app.tenant(diner().orgId, managerA, (ctx) => offers.saveOffer(ctx, { kind: 'manual', name: unique('Ours'), discountKind: 'percent', percentOff: 10, audience: 'list', segmentId: s.id, method: 'automatic' }));
      expect(offer.segmentName).toBe(s.name);
      await expect(t.app.tenant(diner().orgId, managerA, (ctx) => campaigns.deleteSegment(ctx, s.id))).rejects.toMatchObject({ code: 'conflict' });
      expect((await t.app.tenant(diner().orgId, managerA, (ctx) => offers.offersUsingList(ctx, s.id))).map((o) => o.id)).toEqual([offer.id]);
    });
  });

  describe('a campaign to a list', () => {
    it('queues a message only for the list\'s members who hold consent; the rest get nothing', async () => {
      const o = diner();
      const suburb = unique('Listville');
      const manager = await o.as('manager');
      const yes = [await newGuest(t, o, { suburb, emailConsent: true, firstName: 'Yes1' }), await newGuest(t, o, { suburb, emailConsent: true, firstName: 'Yes2' }), await newGuest(t, o, { suburb, emailConsent: true, firstName: 'Yes3' })];
      const no = [await newGuest(t, o, { suburb, firstName: 'Silent' }), await newGuest(t, o, { suburb, phone: true, smsConsent: true, firstName: 'TextsOnly' })];
      const outsider = await newGuest(t, o, { suburb: 'Elsewhere', emailConsent: true });
      const list = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: unique('Listville'), query: `suburb is "${suburb}"` }));
      const preview = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.previewSegment(ctx, { segmentId: list.id }));
      expect(preview).toMatchObject({ count: 5, email: { reachable: 3 }, sms: { reachable: 1 } });

      const c = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.draftCampaign(ctx, { venueId: o.venueId, name: 'To the list', channel: 'email', segmentId: list.id, subject: 'Hello {{first_name}}', body: 'Hi {{first_name}}, a note for Listville.' }));
      expect(c.audienceCount).toBe(3);
      const { approval } = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.submitCampaign(ctx, { campaignId: c.id }));
      await t.app.tenant(o.orgId, manager, (ctx) => approvals.decideApproval(ctx, approval.id, { decision: 'approved' }));
      await drainJobs(t.app);

      const queued = await t.db.selectFrom('messages').select(['customer_id', 'status']).where('campaign_id', '=', c.id).execute();
      expect(new Set(queued.map((m) => m.customer_id))).toEqual(new Set(yes.map((g) => g.customerId)));
      for (const g of [...no, outsider]) expect(queued.some((m) => m.customer_id === g.customerId)).toBe(false);
      for (const g of yes) expect(t.sim.email.sent.filter((m) => m.to.toLowerCase() === g.email.toLowerCase())).toHaveLength(1);
      for (const g of no) expect(t.sim.email.sent.filter((m) => m.to.toLowerCase() === g.email.toLowerCase())).toHaveLength(0);
      // The list says where it is used.
      const usage = await t.app.tenant(o.orgId, manager, (ctx) => campaigns.segmentUsage(ctx, list.id));
      expect(usage.campaigns.map((k) => k.id)).toEqual([c.id]);
      // Membership is live: a consented member who moves suburb drops out before the next send.
      await t.app.tenant(o.orgId, manager, (ctx) => identity.updateCustomer(ctx, yes[0]!.customerId, { suburb: 'Moved' }));
      expect(await t.app.tenant(o.orgId, WORKER, (ctx) => campaigns.isSegmentMember(ctx, list.id, yes[0]!.customerId))).toBe(false);
      expect(await t.app.tenant(o.orgId, WORKER, (ctx) => campaigns.isSegmentMember(ctx, list.id, yes[1]!.customerId))).toBe(true);
    });
  });
});
