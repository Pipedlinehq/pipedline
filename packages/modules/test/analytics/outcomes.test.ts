import { beforeEach, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { analytics, identity, ledger } from '@ros/modules';
import { WORKER, sale } from './helpers';
import { groupBy, loadSales, sum } from './oracle';

/**
 * Campaign and creator outcomes are the one thing that leaves toward a creator or an advertiser
 * (docs/modules/hub.md section 7): totals only, above a minimum cohort, after a quiet period,
 * spend as a band, "aligned with" and never "drove".
 */
const OUTCOME_KEYS = ['campaign_id', 'creator_id', 'first_activity_on', 'new_customers', 'orders', 'repeat_rate', 'revenue_band', 'sessions', 'status', 'status_note', 'summary'];

describe('analytics: campaign and creator outcomes', () => {
  const t = useTestEnv();
  const org = () => t.fixture.diner;
  beforeEach(() => t.clock.set('2026-09-30T02:00:00Z'));

  const outcomes = async (input: analytics.CampaignOutcomesInput = {}, who: 'owner' | 'kitchen' = 'owner') => {
    const p = await org().as(who);
    return t.app.tenant(org().orgId, p, (ctx) => analytics.campaignOutcomes(ctx, input));
  };
  /** A guest who arrived through a campaign link `daysAgo` days ago, with `orders` sales a week apart. */
  async function guest(tag: string, campaignId: string, creatorId: string, daysAgo: number, orders: number): Promise<string> {
    const at = new Date(t.clock().getTime() - daysAgo * 86_400_000);
    return t.app.tenant(org().orgId, WORKER, async (ctx) => {
      const r = await identity.resolveCustomer(ctx, {
        hints: [{ kind: 'email', value: `${tag}@outcomes.example` }],
        via: 'online-order',
        venueId: org().venueId,
        profile: { firstName: 'Casey', lastName: `Cohort-${tag}` },
        acquisition: { source: 'criota', campaignId, creatorId, landingPath: '/offer', at },
      });
      for (let i = 0; i < orders; i++) {
        const when = new Date(Math.min(at.getTime() + i * 7 * 86_400_000, t.clock().getTime() - 60_000));
        await ledger.recordTransaction(ctx, sale(`oc-${tag}-${i}`, when), { venueId: org().venueId, customerId: r.customerId! });
      }
      return r.customerId!;
    });
  }

  it('reports each fixture campaign and creator as totals that equal the ledger, with spend as a band', async () => {
    const out = await outcomes();
    const sales = await loadSales(t.db, org().orgId);
    const byId = new Map(sales.map((s) => [s.id, s]));
    const customers = await t.db.selectFrom('customers').select(['id', 'acquisition_campaign_id', 'acquisition_creator_id']).where('org_id', '=', org().orgId).where('status', '=', 'active').execute();
    const attributions = (await t.db.selectFrom('transaction_attributions').select(['transaction_id', 'customer_id', 'campaign_id', 'creator_id']).where('org_id', '=', org().orgId).where('model', '=', 'acquisition').execute()).filter((a) => byId.has(a.transaction_id));
    const sessions = await t.db.selectFrom('visitor_sessions').select(['campaign_id', 'creator_id']).where('org_id', '=', org().orgId).execute();
    const key = (c: string | null, k: string | null) => `${c ?? ''}|${k ?? ''}`;
    const byKey = groupBy(attributions, (a) => key(a.campaign_id, a.creator_id));

    expect(out.outcomes.length).toBeGreaterThanOrEqual(7);
    expect(out).toMatchObject({ venue: null, venues_covered: 1, min_cohort: 5, quiet_days: 7, currency: 'AUD', period: { from: null, to: '2026-09-30' } });
    let measured = 0;
    for (const o of out.outcomes) {
      expect(Object.keys(o).sort()).toEqual(OUTCOME_KEYS);
      if (o.status !== 'measured') continue;
      measured++;
      const k = key(o.campaign_id, o.creator_id);
      const attr = byKey.get(k) ?? [];
      const revenue = sum(attr, (a) => byId.get(a.transaction_id)!.total - byId.get(a.transaction_id)!.refunded);
      const buyers = new Set(attr.map((a) => a.customer_id));
      const repeatBuyers = new Set(attr.filter((a) => byId.get(a.transaction_id)!.rank > 1).map((a) => a.customer_id));
      expect(o.new_customers, k).toBe(customers.filter((c) => key(c.acquisition_campaign_id, c.acquisition_creator_id) === k).length);
      expect(o.sessions, k).toBe(sessions.filter((s) => key(s.campaign_id, s.creator_id) === k).length);
      expect(o.orders, k).toBe(attr.length);
      expect(o.repeat_rate, k).toBe(Math.round((repeatBuyers.size / buyers.size) * 100) / 100);
      // A band that contains the real figure, and the real figure nowhere.
      expect(o.revenue_band!.low_cents, k).toBeLessThanOrEqual(revenue);
      if (o.revenue_band!.high_cents !== null) expect(o.revenue_band!.high_cents, k).toBeGreaterThan(revenue);
      expect(JSON.stringify(o), k).not.toContain(String(revenue));
      expect(o.summary).toMatch(/^Aligned with /);
    }
    expect(measured).toBeGreaterThanOrEqual(7);
    const text = JSON.stringify(out);
    expect(text).toMatch(/aligned with/i);
    expect(text).not.toMatch(/\b(drove|driven|drives|generated|thanks to|because of)\b/i);
    expect(out.wording).toMatch(/not proof that it caused/);
    // No guest anywhere in it.
    for (const c of customers.slice(0, 200)) expect(text.includes(c.id)).toBe(false);
  });

  it('returns no number at all below the minimum cohort', async () => {
    for (const tag of ['s1', 's2', 's3', 's4']) await guest(tag, 'camp_small', 'creator_small', 40, 2);
    const four = (await outcomes({ campaignId: 'camp_small' })).outcomes;
    expect(four).toHaveLength(1);
    expect(four[0]).toMatchObject({ campaign_id: 'camp_small', creator_id: 'creator_small', status: 'not_enough_guests', sessions: null, new_customers: null, orders: null, revenue_band: null, repeat_rate: null });
    expect(four[0]!.status_note).toMatch(/Not enough guests yet/);
    expect(four[0]!.status_note).toMatch(/unmeasured, not a low result/);
    // The only digits in the row are the floor itself and the date of first activity.
    const { first_activity_on, ...rest } = four[0]!;
    expect(first_activity_on).toBe('2026-08-21');
    expect(JSON.stringify(rest).replace(/fewer than 5/g, '')).not.toMatch(/\d/);

    // The same floor applies when the campaign is looked at through the metric query.
    const owner = await org().as('owner');
    const q = await t.app.tenant(org().orgId, owner, (ctx) =>
      analytics.queryMetrics(ctx, { metrics: ['campaign_sessions', 'campaign_new_customers', 'campaign_orders', 'campaign_revenue', 'campaign_repeat_orders', 'campaign_repeat_rate'], dimensions: ['campaign'], filters: { campaign: 'camp_small' }, period: 'last_90_days' }),
    );
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]!.values).toEqual({ campaign_sessions: 0, campaign_new_customers: null, campaign_orders: null, campaign_revenue: null, campaign_repeat_orders: null, campaign_repeat_rate: null });
    expect(q.totals.values.campaign_orders).toBeNull();
    expect(q.caveats.join(' ')).toMatch(/not enough guests yet \(fewer than 5\)/);

    // The fifth guest crosses it.
    await guest('s5', 'camp_small', 'creator_small', 40, 1);
    const five = (await outcomes({ campaignId: 'camp_small' })).outcomes[0]!;
    expect(five).toMatchObject({ status: 'measured', new_customers: 5, orders: 9, repeat_rate: 0.8, sessions: 0 });
    expect(five.revenue_band).toEqual({ label: '$500 to $1,000', low_cents: 50_000, high_cents: 100_000 });
    expect(five.summary).toBe('Aligned with campaign camp_small, creator creator_small: 5 new guests; 9 orders, spend in the range $500 to $1,000; 80% of purchasing guests came back.');
    const after = await t.app.tenant(org().orgId, owner, (ctx) =>
      analytics.queryMetrics(ctx, { metrics: ['campaign_new_customers', 'campaign_orders', 'campaign_revenue'], dimensions: ['campaign'], filters: { campaign: 'camp_small' }, period: 'last_90_days' }),
    );
    expect(after.rows[0]!.values).toEqual({ campaign_new_customers: 5, campaign_orders: 9, campaign_revenue: 9 * 5900 });
  });

  it('withholds spend when enough guests arrived but too few have purchased', async () => {
    for (const tag of ['p1', 'p2', 'p3']) await guest(tag, 'camp_signups', 'creator_x', 30, 1);
    for (const tag of ['p4', 'p5', 'p6']) await guest(tag, 'camp_signups', 'creator_x', 30, 0);
    const o = (await outcomes({ campaignId: 'camp_signups' })).outcomes[0]!;
    expect(o).toMatchObject({ status: 'measured', new_customers: 6, orders: null, revenue_band: null, repeat_rate: null });
    expect(o.status_note).toMatch(/fewer than 5 guests have purchased/);
    expect(o.summary).toBe('Aligned with campaign camp_signups, creator creator_x: 6 new guests; too few purchasing guests to report spend.');
  });

  it('shows nothing for the first seven days of a campaign', async () => {
    for (const tag of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) await guest(tag, 'camp_fresh', 'creator_fresh', 3, 1);
    const early = (await outcomes({ campaignId: 'camp_fresh' })).outcomes[0]!;
    expect(early).toMatchObject({ status: 'too_early', first_activity_on: '2026-09-27', sessions: null, new_customers: null, orders: null, revenue_band: null, repeat_rate: null });
    expect(early.status_note).toBe('Too early to say. Results appear 7 days after first activity, from 2026-10-04.');

    t.clock.set('2026-10-03T02:00:00Z');
    expect((await outcomes({ campaignId: 'camp_fresh' })).outcomes[0]!.status).toBe('too_early');
    t.clock.set('2026-10-04T02:00:00Z');
    const later = (await outcomes({ campaignId: 'camp_fresh' })).outcomes[0]!;
    expect(later).toMatchObject({ status: 'measured', new_customers: 6, orders: 6, repeat_rate: 0 });
    expect(later.revenue_band!.label).toBe('$250 to $500');
  });

  it('the minimum cohort is a setting an org can raise and cannot lower', async () => {
    for (const tag of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']) await guest(tag, 'camp_six', 'creator_six', 30, 1);
    expect((await outcomes({ campaignId: 'camp_six' })).outcomes[0]!.status).toBe('measured');
    const owner = await org().as('owner');
    await t.app.tenant(org().orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 8, campaignQuietDays: 45 }));
    const stored = await t.db.selectFrom('orgs').select('settings').where('id', '=', org().orgId).executeTakeFirstOrThrow();
    expect((stored.settings as { analytics: { minCohort: number } }).analytics.minCohort).toBe(8);
    const raised = await outcomes({ campaignId: 'camp_six' });
    expect(raised.min_cohort).toBe(8);
    expect(raised.quiet_days).toBe(45);
    // Thirty days in, with a 45-day quiet period, it is too early again; with a shorter one it is too small.
    expect(raised.outcomes[0]!.status).toBe('too_early');
    await t.app.tenant(org().orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { campaignQuietDays: 7 }));
    const small = (await outcomes({ campaignId: 'camp_six' })).outcomes[0]!;
    expect(small).toMatchObject({ status: 'not_enough_guests', new_customers: null, orders: null, revenue_band: null });
    expect(small.status_note).toMatch(/fewer than 8/);

    await expect(t.app.tenant(org().orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 2 }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.app.tenant(org().orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { campaignQuietDays: 0 }))).rejects.toMatchObject({ code: 'invalid' });
    const kitchen = await org().as('kitchen');
    await expect(t.app.tenant(org().orgId, kitchen, (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 50 }))).rejects.toMatchObject({ code: 'forbidden' });
    await t.app.tenant(org().orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { minCohort: 5 }));
    expect((await outcomes({ campaignId: 'camp_six' })).outcomes[0]!.status).toBe('measured');
  });

  it('can be narrowed by creator and by period, and is refused to anyone who is not staff', async () => {
    const all = await outcomes();
    const creator = await outcomes({ creatorId: 'creator_wagyu_wes' });
    expect(creator.outcomes.length).toBeGreaterThanOrEqual(2);
    expect(creator.outcomes.every((o) => o.creator_id === 'creator_wagyu_wes')).toBe(true);
    expect(creator.outcomes).toEqual(all.outcomes.filter((o) => o.creator_id === 'creator_wagyu_wes'));

    // A short period holds fewer guests, so more combinations fall under the floor; none leaks a small number.
    const week = await outcomes({ period: 'last_7_days' });
    expect(week.period).toEqual({ from: '2026-09-23', to: '2026-09-29' });
    for (const o of week.outcomes) {
      if (o.new_customers !== null) expect(o.new_customers).toBeGreaterThanOrEqual(5);
      if (o.status !== 'measured') expect([o.sessions, o.new_customers, o.orders, o.revenue_band, o.repeat_rate]).toEqual([null, null, null, null, null]);
    }
    expect(week.outcomes.some((o) => o.status === 'not_enough_guests')).toBe(true);

    expect((await outcomes({}, 'kitchen')).outcomes.length).toBe(all.outcomes.length);
    await expect(t.app.tenant(org().orgId, { kind: 'anon' }, (ctx) => analytics.campaignOutcomes(ctx, {}))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(t.app.tenant(org().orgId, { kind: 'guest', customerId: '00000000-0000-4000-8000-000000000000' }, (ctx) => analytics.campaignOutcomes(ctx, {}))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(outcomes({ venueId: t.fixture.group.venueId })).rejects.toMatchObject({ code: 'not_found' });
    await expect(outcomes({ guestId: 'x' } as never)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('for a group, each venue\'s outcomes are its own and smaller cohorts fall under the floor', async () => {
    const group = t.fixture.group;
    const owner = await group.as('owner');
    const whole = await t.app.tenant(group.orgId, owner, (ctx) => analytics.campaignOutcomes(ctx, {}));
    expect(whole.venues_covered).toBe(3);
    const statuses = new Set<string>();
    for (const venue of Object.values(group.venues)) {
      const one = await t.app.tenant(group.orgId, owner, (ctx) => analytics.campaignOutcomes(ctx, { venueId: venue.id }));
      expect(one.venue).toBe(venue.name);
      for (const o of one.outcomes) {
        statuses.add(o.status);
        const org = whole.outcomes.find((w) => w.campaign_id === o.campaign_id && w.creator_id === o.creator_id)!;
        if (o.new_customers !== null) {
          expect(o.new_customers).toBeGreaterThanOrEqual(5);
          expect(org.new_customers!).toBeGreaterThanOrEqual(o.new_customers);
        }
      }
    }
    expect(statuses.has('measured')).toBe(true);
    expect(statuses.has('not_enough_guests')).toBe(true);
  });
});
