import { describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import { useTestEnv } from '@ros/testkit';
import { analytics, campaigns, comms } from '@ros/modules';
import { WORKER, newGuest } from './helpers';

type Rule = campaigns.SegmentRule;

/**
 * An independent oracle: every guest's facts pulled with plain selects and the rule evaluated in
 * JavaScript. Shares nothing with the compiler but the documented meaning of each field.
 */
async function oracle(t: ReturnType<typeof useTestEnv>, org: FixtureOrg, today: string) {
  const customers = await t.db
    .selectFrom('customers')
    .select(['id', 'primary_email', 'primary_phone', 'birthday', 'acquisition_source', 'acquisition_creator_id', 'acquisition_campaign_id', 'first_seen_venue_id'])
    .where('org_id', '=', org.orgId)
    .where('status', '=', 'active')
    .execute();
  const facts = new Map((await t.db.selectFrom('fact_customer').selectAll().where('org_id', '=', org.orgId).execute()).map((f) => [f.customer_id, f]));
  const consents = await t.db.selectFrom('consents').select(['customer_id', 'purpose']).where('org_id', '=', org.orgId).where('status', '=', 'granted').execute();
  const has = new Set(consents.map((c) => `${c.customer_id}:${c.purpose}`));
  const supp = new Set((await t.db.selectFrom('suppressions').select(['channel', 'value']).where('org_id', '=', org.orgId).execute()).map((s) => `${s.channel}:${String(s.value).toLowerCase()}`));
  const members = new Set((await t.db.selectFrom('events').select('customer_id').where('org_id', '=', org.orgId).where('name', '=', 'loyalty.enrolled').execute()).map((e) => e.customer_id));
  const primary = (await t.db.selectFrom('venues').select('id').where('org_id', '=', org.orgId).orderBy('created_at').orderBy('id').executeTakeFirstOrThrow()).id;
  const days = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
  const asDay = (d: unknown) => (d == null ? null : typeof d === 'string' ? d : (d as Date).toISOString().slice(0, 10));

  const evalLeaf = (r: campaigns.SegmentLeaf, c: (typeof customers)[number]): boolean | null => {
    const f = facts.get(c.id);
    const inRange = (v: number | null | undefined, x: { min?: number; max?: number }) => (v == null ? null : (x.min === undefined || v >= x.min) && (x.max === undefined || v <= x.max));
    switch (r.field) {
      case 'rfm_segment':
        return f?.segment == null ? null : (r.in as string[]).includes(f.segment);
      case 'r_score':
        return f?.r_score == null ? null : r.in.includes(f.r_score);
      case 'f_score':
        return f?.f_score == null ? null : r.in.includes(f.f_score);
      case 'm_score':
        return f?.m_score == null ? null : r.in.includes(f.m_score);
      case 'recency_days':
        return inRange(f?.last_order_day ? days(today, asDay(f.last_order_day)!) : null, r);
      case 'days_since_first_order':
        return inRange(f?.first_order_day ? days(today, asDay(f.first_order_day)!) : null, r);
      case 'orders':
        return inRange(f?.orders ?? 0, r);
      case 'spend_cents':
        return inRange(Number(f?.spend_cents ?? 0), r);
      case 'first_order_date':
      case 'last_order_date': {
        const d = asDay(r.field === 'first_order_date' ? f?.first_order_day : f?.last_order_day);
        if (!d) return null;
        return (!r.after || d > r.after) && (!r.before || d < r.before);
      }
      case 'acquisition_source':
        return r.in.includes(c.acquisition_source);
      case 'acquisition_creator':
        return c.acquisition_creator_id == null ? null : r.in.includes(c.acquisition_creator_id);
      case 'acquisition_campaign':
        return c.acquisition_campaign_id == null ? null : r.in.includes(c.acquisition_campaign_id);
      case 'favourite_channel':
        return f?.favourite_channel == null ? null : (r.in as string[]).includes(f.favourite_channel);
      case 'favourite_venue':
        return f?.favourite_venue_id == null ? null : r.in.includes(f.favourite_venue_id);
      case 'home_venue':
        return r.in.includes(f?.favourite_venue_id ?? c.first_seen_venue_id ?? primary);
      case 'consent':
        return has.has(`${c.id}:${r.purpose}`) === r.granted;
      case 'loyalty_member':
        return members.has(c.id) === r.is;
      case 'birthday_month':
        return c.birthday == null ? null : r.in.includes(Number(asDay(c.birthday)!.slice(5, 7)));
    }
  };
  const evalRule = (r: Rule, c: (typeof customers)[number]): boolean => {
    if ('all' in r) return r.all.every((x) => evalRule(x, c));
    if ('any' in r) return r.any.some((x) => evalRule(x, c));
    if ('not' in r) return !evalRule(r.not, c);
    return evalLeaf(r, c) ?? false;
  };
  const reach = (c: (typeof customers)[number], ch: 'email' | 'sms') => {
    const addr = ch === 'email' ? c.primary_email : c.primary_phone;
    return !!addr && has.has(`${c.id}:marketing_${ch}`) && !supp.has(`${ch}:${String(addr).toLowerCase()}`);
  };
  return (rule: Rule, venueId?: string) => {
    const hit = customers.filter((c) => evalRule(rule, c) && (!venueId || (facts.get(c.id)?.favourite_venue_id ?? c.first_seen_venue_id ?? primary) === venueId));
    return { count: hit.length, email: hit.filter((c) => reach(c, 'email')).length, sms: hit.filter((c) => reach(c, 'sms')).length };
  };
}

describe('campaigns: segments', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;

  describe('the rule tree is validated, and nothing a person typed reaches SQL as SQL', () => {
    const bad: Array<[string, unknown]> = [
      ['raw SQL as the definition', "select * from customers where 1=1"],
      ['an unknown field', { field: 'primary_email', in: ['a@b.c'] }],
      ['an extra key on a known field', { field: 'orders', min: 1, sql: 'drop table customers' }],
      ['a column name smuggled as the field', { field: 'orders; drop table customers', min: 1 }],
      ['a quote in a constrained value', { field: 'acquisition_source', in: ["x'); drop table customers;--"] }],
      ['a range with no bounds', { field: 'orders' }],
      ['a malformed date', { field: 'last_order_date', after: "2026-01-01' or 1=1" }],
      ['an empty group', { all: [] }],
      ['too deep', { not: { not: { not: { not: { not: { not: { field: 'orders', min: 1 } } } } } } }],
    ];
    for (const [what, definition] of bad) {
      it(`rejects ${what}`, async () => {
        const manager = await diner().as('manager');
        await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.previewSegment(ctx, { definition }))).rejects.toMatchObject({ code: 'invalid' });
        await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: `bad ${what}`, definition }))).rejects.toMatchObject({ code: 'invalid' });
      });
    }

    it('a free-text value is bound as a parameter: it matches only a guest carrying that exact text', async () => {
      const tag = "x' or '1'='1";
      await newGuest(t, diner(), { tag, emailConsent: true });
      const manager = await diner().as('manager');
      const p = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.previewSegment(ctx, { definition: { field: 'acquisition_campaign', in: [tag] } }));
      expect(p.count).toBe(1);
      expect(p.email.reachable).toBe(1);
      const injected = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.previewSegment(ctx, { definition: { field: 'acquisition_campaign', in: ["') or true or ('"] } }));
      expect(injected.count).toBe(0);
      expect(Number((await t.db.selectFrom('customers').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n)).toBeGreaterThan(100);
    });

    it('a saved segment stores the tree, never SQL; the built-in ones cannot be changed or deleted', async () => {
      const manager = await diner().as('manager');
      const s = await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.saveSegment(ctx, { name: 'Big spenders', definition: { field: 'spend_cents', min: 50_000 } }));
      const row = await t.db.selectFrom('segments').select(['definition', 'is_system']).where('id', '=', s.id).executeTakeFirstOrThrow();
      expect(row).toEqual({ definition: { field: 'spend_cents', min: 50_000 }, is_system: false });
      const audit = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', s.id).execute();
      expect(audit.map((a) => a.action)).toContain('segment.created');
      const vip = (await t.app.tenant(diner().orgId, manager, (ctx) => campaigns.listSegments(ctx))).find((x) => x.name === 'VIP')!;
      await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.saveSegment(ctx, { id: vip.id, name: 'VIP', definition: { field: 'orders', min: 1 } }))).rejects.toMatchObject({ code: 'invalid' });
      await expect(t.app.tenant(diner().orgId, manager, (ctx) => campaigns.deleteSegment(ctx, vip.id))).rejects.toMatchObject({ code: 'invalid' });
    });
  });

  describe('counts match an independent oracle', () => {
    const rules: Array<[string, Rule]> = [
      ['repeat guests who agreed to email', { all: [{ field: 'orders', min: 2 }, { field: 'consent', purpose: 'marketing_email', granted: true }] }],
      ['lapsed or at risk, or not seen in 30 days', { any: [{ field: 'rfm_segment', in: ['lapsed', 'at_risk'] }, { not: { field: 'recency_days', max: 30 } }] }],
      ['creator and paid-social guests who spent $50+', { all: [{ field: 'acquisition_source', in: ['criota', 'meta'] }, { field: 'spend_cents', min: 5000 }] }],
      ['members with a first-half birthday', { all: [{ field: 'loyalty_member', is: true }, { field: 'birthday_month', in: [1, 2, 3, 4, 5, 6] }] }],
      ['dine-in high spenders seen since June', { all: [{ field: 'favourite_channel', in: ['dine-in'] }, { field: 'm_score', in: [4, 5] }, { field: 'last_order_date', after: '2026-06-01' }] }],
      ['first ordered over 90 days ago, F score 1 or 2', { all: [{ field: 'days_since_first_order', min: 90 }, { field: 'f_score', in: [1, 2] }] }],
    ];

    for (const org of ['diner', 'group'] as const) {
      it(`every rule and every system segment, at ${org}`, async () => {
        const o = t.fixture[org];
        await t.app.tenant(o.orgId, WORKER, (ctx) => analytics.snapshotCustomers(ctx));
        const count = await oracle(t, o, '2026-09-30');
        const owner = await o.as('owner');
        const system = (await t.app.tenant(o.orgId, owner, (ctx) => campaigns.listSegments(ctx))).filter((s) => s.isSystem);
        expect(system.map((s) => s.name).sort()).toEqual(['At risk', 'Lapsed 60+', 'New', 'One-timers', 'Regulars', 'VIP']);
        const all: Array<[string, Rule]> = [...rules, ...system.map((s) => [s.name, s.definition] as [string, Rule])];
        let nonEmpty = 0;
        for (const [name, rule] of all) {
          const got = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { definition: rule }));
          const want = count(rule);
          expect({ name, count: got.count, email: got.email.reachable, sms: got.sms.reachable }).toEqual({ name, ...want });
          if (want.count > 0) nonEmpty++;
        }
        expect(nonEmpty).toBeGreaterThan(all.length / 2);
      });
    }

    it('per venue at the group, the venues partition the org, and a suppressed address stops counting as reachable', async () => {
      const o = group();
      const owner = await o.as('owner');
      const count = await oracle(t, o, '2026-09-30');
      const rule: Rule = { field: 'consent', purpose: 'marketing_email', granted: true };
      const whole = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { definition: rule }));
      let sum = 0;
      for (const v of Object.values(o.venues)) {
        const p = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { definition: rule, venueId: v.id }));
        expect(p.count).toBe(count(rule, v.id).count);
        sum += p.count;
      }
      expect(sum).toBe(whole.count);
      expect(whole.email.reachable).toBe(whole.count);

      const g = await newGuest(t, o, { emailConsent: true, venueId: o.venues.bondi!.id });
      const before = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { definition: rule, venueId: o.venues.bondi!.id }));
      await t.app.tenant(o.orgId, owner, (ctx) => comms.addManualSuppression(ctx, 'email', g.email!));
      const after = await t.app.tenant(o.orgId, owner, (ctx) => campaigns.previewSegment(ctx, { definition: rule, venueId: o.venues.bondi!.id }));
      expect(after.count).toBe(before.count);
      expect(after.email.reachable).toBe(before.email.reachable - 1);
    });
  });

  describe('who may see segments', () => {
    it('front of house cannot preview; another org\'s segment is not found; a venue the manager has no role at is not found', async () => {
      const host = await diner().as('host');
      await expect(t.app.tenant(diner().orgId, host, (ctx) => campaigns.previewSegment(ctx, { definition: { field: 'orders', min: 1 } }))).rejects.toMatchObject({ code: 'forbidden' });
      const dinerSeg = (await t.db.selectFrom('segments').select('id').where('org_id', '=', diner().orgId).executeTakeFirstOrThrow()).id;
      const gm = await group().as('manager');
      await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.getSegment(ctx, dinerSeg))).rejects.toMatchObject({ code: 'not_found' });
      await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.previewSegment(ctx, { segmentId: dinerSeg }))).rejects.toMatchObject({ code: 'not_found' });
      await expect(t.app.tenant(group().orgId, gm, (ctx) => campaigns.previewSegment(ctx, { definition: { field: 'orders', min: 1 }, venueId: group().venues.bondi!.id }))).rejects.toMatchObject({ code: 'not_found' });
    });

    it('with the module off everywhere, segments are not found; back on, they are there', async () => {
      const o = diner();
      await t.app.tenant(o.orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: o.venueId, enabled: false }));
      const manager = await o.as('manager');
      await expect(t.app.tenant(o.orgId, manager, (ctx) => campaigns.listSegments(ctx))).rejects.toMatchObject({ code: 'module_disabled', status: 404 });
      await expect(t.app.tenant(o.orgId, manager, (ctx) => campaigns.previewSegment(ctx, { definition: { field: 'orders', min: 1 } }))).rejects.toMatchObject({ status: 404 });
      await t.app.tenant(o.orgId, WORKER, (ctx) => setModule(ctx, campaigns.campaignsModule, { venueId: o.venueId, enabled: true }));
      expect((await t.app.tenant(o.orgId, manager, (ctx) => campaigns.listSegments(ctx))).length).toBeGreaterThanOrEqual(6);
    });
  });
});
