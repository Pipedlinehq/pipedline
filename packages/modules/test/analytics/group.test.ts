import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentPrincipal } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics } from '@ros/modules';
import { type Sale, between, customers, groupBy, loadSales, ratio, totals } from './oracle';

/**
 * The group fixture: three venues. The regional manager holds two of them (CBD and Newtown),
 * the host one (Newtown), accounts all three read-only, and the owner everything.
 */
const FROM = '2026-07-01';
const TO = '2026-09-29';
const KEYS = ['orders', 'gross_sales', 'net_sales', 'refunds', 'tips', 'discounts', 'identified_orders'] as const;
const pick = (w: ReturnType<typeof totals>) => Object.fromEntries(KEYS.map((k) => [k, w[k]]));

describe('analytics: a group of venues', () => {
  const t = useTestEnv();
  let sales: Sale[];
  const org = () => t.fixture.group;
  const ids = () => ({ cbd: org().venues.cbd!.id, newtown: org().venues.newtown!.id, bondi: org().venues.bondi!.id });
  const ask = async (who: 'owner' | 'manager' | 'host' | 'accounts', query: analytics.MetricQuery) => {
    const p = await org().as(who);
    return t.app.tenant(org().orgId, p, (ctx) => analytics.queryMetrics(ctx, query));
  };

  beforeAll(async () => {
    await analytics.rollup(t.app, org().orgId);
    sales = await loadSales(t.db, org().orgId);
  });

  it('the org total equals the sum of its venues, from the ledger and from the facts', async () => {
    const inPeriod = between(sales, FROM, TO);
    const want = totals(inPeriod);
    for (const source of ['ledger', 'facts'] as const) {
      const all = await ask('owner', { metrics: [...KEYS], period: { from: FROM, to: TO }, source });
      expect(all.totals.values, source).toEqual(pick(want));
      expect(all.venues).toEqual({ scope: 'all_venues', names: ['Oak Group Bondi', 'Oak Group CBD', 'Oak Group Newtown'] });

      const byVenue = await ask('owner', { metrics: [...KEYS], dimensions: ['venue'], period: { from: FROM, to: TO }, source });
      expect(byVenue.rows).toHaveLength(3);
      for (const k of KEYS) expect(byVenue.rows.reduce((s, r) => s + (r.values[k] ?? 0), 0), `${k} (${source})`).toBe(want[k]);

      let summed = 0;
      for (const [slug, id] of Object.entries(ids())) {
        const one = await ask('owner', { metrics: [...KEYS], period: { from: FROM, to: TO }, filters: { venue: id }, source });
        const w = totals(inPeriod.filter((s) => s.venueId === id));
        expect(one.totals.values, `${slug} (${source})`).toEqual(pick(w));
        expect(one.venues.scope).toBe('selected_venues');
        expect(byVenue.rows.find((r) => r.dimensions.venue === org().venues[slug]!.name)!.values).toEqual(one.totals.values);
        summed += one.totals.values.net_sales!;
      }
      expect(summed).toBe(want.net_sales);
    }
    // The split by channel for one venue equals the ledger for that venue.
    const bondi = await ask('owner', { metrics: ['orders'], dimensions: ['channel'], period: { from: FROM, to: TO }, filters: { venue: ids().bondi } });
    const wantBondi = groupBy(inPeriod.filter((s) => s.venueId === ids().bondi), (s) => s.channel);
    expect(Object.fromEntries(bondi.rows.map((r) => [r.dimensions.channel, r.values.orders]))).toEqual(Object.fromEntries([...wantBondi].map(([k, v]) => [k, v.length])));
    expect(bondi.rows[0]!.dimensions.channel).toBe('pickup');
  });

  it('a manager of two venues never sees the third venue\'s numbers', async () => {
    const { cbd, newtown, bondi } = ids();
    const mine = sales.filter((s) => s.venueId === cbd || s.venueId === newtown);
    const inPeriod = between(mine, FROM, TO);
    const bondiOnly = between(sales.filter((s) => s.venueId === bondi), FROM, TO);
    expect(bondiOnly.length).toBeGreaterThan(20);

    for (const source of ['auto', 'ledger'] as const) {
      const r = await ask('manager', { metrics: [...KEYS], period: { from: FROM, to: TO }, source });
      expect(r.totals.values, source).toEqual(pick(totals(inPeriod)));
      expect(r.venues).toEqual({ scope: 'selected_venues', names: ['Oak Group CBD', 'Oak Group Newtown'] });
      expect(r.totals.values.orders).toBe(totals(between(sales, FROM, TO)).orders - bondiOnly.length);
    }
    const byVenue = await ask('manager', { metrics: ['orders', 'net_sales'], dimensions: ['venue'], grain: 'month', period: { from: FROM, to: TO } });
    expect(new Set(byVenue.rows.map((r) => r.dimensions.venue))).toEqual(new Set(['Oak Group CBD', 'Oak Group Newtown']));
    expect(JSON.stringify(byVenue)).not.toContain('Bondi');

    // Asking for the third venue by id is "not found", exactly as for a venue that does not exist.
    await expect(ask('manager', { metrics: ['orders'], filters: { venue: bondi } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(ask('manager', { metrics: ['orders'], filters: { venue: [cbd, bondi] } })).rejects.toMatchObject({ code: 'not_found' });
    await expect(ask('manager', { metrics: ['orders'], filters: { venue: '00000000-0000-4000-8000-000000000000' } })).rejects.toMatchObject({ code: 'not_found' });

    // Items, sessions and the freshness stamp are scoped the same way.
    const items = await ask('manager', { metrics: ['item_revenue', 'item_quantity'], period: { from: FROM, to: TO } });
    expect(items.totals.values.item_revenue).toBe(inPeriod.flatMap((s) => s.lines).reduce((s, l) => s + l.total, 0));
    const sessions = await t.db.selectFrom('visitor_sessions').select(['venue_id']).where('org_id', '=', org().orgId).execute();
    const web = await ask('manager', { metrics: ['web_sessions'], period: 'all_time' });
    expect(web.totals.values.web_sessions).toBe(sessions.filter((s) => s.venue_id === cbd || s.venue_id === newtown).length);
    expect(sessions.filter((s) => s.venue_id === bondi).length).toBeGreaterThan(0);
    const latestMine = mine.reduce((m, s) => (s.at > m ? s.at : m), mine[0]!.at);
    expect((await ask('manager', { metrics: ['orders'], period: 'today' })).freshness.latest_sale_at).toBe(latestMine.toISOString());
  });

  it('customer figures for part of a group are counted within those venues only, and say so', async () => {
    const { cbd, newtown } = ids();
    // Rank and history recomputed over the two venues alone: nothing depends on the third.
    const mine = await loadSales(t.db, org().orgId, [cbd, newtown]);
    const base = customers(mine, '2026-09-30');
    const r = await ask('manager', { metrics: ['customers_total', 'repeat_rate'], period: 'today' });
    expect(r.totals.values).toEqual({ customers_total: base.length, repeat_rate: ratio(base.filter((c) => c.orders >= 2).length, base.length) });
    expect(r.sources[0]!.read_from).toBe('ledger');
    expect(r.caveats.join(' ')).toMatch(/within the selected venues only/);

    const whole = customers(sales, '2026-09-30');
    const owner = await ask('owner', { metrics: ['customers_total', 'repeat_rate'], period: 'today' });
    expect(owner.totals.values).toEqual({ customers_total: whole.length, repeat_rate: ratio(whole.filter((c) => c.orders >= 2).length, whole.length) });
    // Guests move between venues, so the group knows more repeat customers than any part of it does.
    expect(whole.length).toBeGreaterThan(base.length);

    const inPeriod = between(mine, FROM, TO);
    const flow = await ask('manager', { metrics: ['new_customer_orders', 'returning_customer_orders', 'new_customers'], period: { from: FROM, to: TO } });
    expect(flow.totals.values).toEqual({
      new_customer_orders: inPeriod.filter((s) => s.rank === 1).length,
      returning_customer_orders: inPeriod.filter((s) => s.rank > 1).length,
      new_customers: new Set(inPeriod.filter((s) => s.rank === 1).map((s) => s.customerId)).size,
    });
  });

  it('each role sees the venues it holds: one venue for the host, all three for accounts', async () => {
    const { newtown } = ids();
    const inPeriod = between(sales, FROM, TO);
    const host = await ask('host', { metrics: ['orders', 'net_sales'], period: { from: FROM, to: TO } });
    const w = totals(inPeriod.filter((s) => s.venueId === newtown));
    expect(host.totals.values).toEqual({ orders: w.orders, net_sales: w.net_sales });
    expect(host.venues.names).toEqual(['Oak Group Newtown']);
    await expect(ask('host', { metrics: ['orders'], filters: { venue: ids().cbd } })).rejects.toMatchObject({ code: 'not_found' });

    const accounts = await ask('accounts', { metrics: ['orders', 'net_sales'], period: { from: FROM, to: TO } });
    expect(accounts.totals.values).toEqual({ orders: totals(inPeriod).orders, net_sales: totals(inPeriod).net_sales });
    expect(accounts.venues.scope).toBe('all_venues');
  });

  it('an assistant key limited to one venue sees that venue, even when its owner sees all', async () => {
    const owner = await org().as('owner');
    const agent: AgentPrincipal = { kind: 'agent', keyId: '00000000-0000-4000-8000-0000000000aa', staff: owner, scopes: ['metrics:read'], venueIds: [ids().cbd], canWrite: false };
    const r = await t.app.tenant(org().orgId, agent, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], period: { from: FROM, to: TO } }));
    expect(r.totals.values.orders).toBe(between(sales, FROM, TO).filter((s) => s.venueId === ids().cbd).length);
    expect(r.venues.names).toEqual(['Oak Group CBD']);
    await expect(t.app.tenant(org().orgId, agent, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], filters: { venue: ids().bondi } }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('digests, outcomes and benchmarks follow the same venue rules', async () => {
    const manager = await org().as('manager');
    const { cbd, bondi } = ids();
    const asManager = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org().orgId, manager, fn);
    // An org-wide digest needs the whole org; a venue digest needs that venue.
    await expect(asManager((ctx) => analytics.computeDigest(ctx, { period: 'week' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(asManager((ctx) => analytics.computeDigest(ctx, { period: 'week', venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });
    const digest = await asManager((ctx) => analytics.computeDigest(ctx, { period: 'week', venueId: cbd }));
    const lastWeek = totals(between(sales, '2026-09-21', '2026-09-27').filter((s) => s.venueId === cbd));
    expect(digest.venue).toBe('Oak Group CBD');
    expect(digest.headline.find((h) => h.metric === 'net_sales')!.value).toBe(lastWeek.net_sales);
    expect(digest.headline.find((h) => h.metric === 'orders')!.value).toBe(lastWeek.orders);
    // Stored digests: the manager is shown the ones for their venues, never the org-wide one or Bondi's.
    const stored = await asManager((ctx) => analytics.listDigests(ctx, { period: 'week', limit: 100 }));
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored.map((d) => d.venue))).toEqual(new Set(['Oak Group CBD', 'Oak Group Newtown']));
    await expect(asManager((ctx) => analytics.listDigests(ctx, { venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });

    await expect(asManager((ctx) => analytics.campaignOutcomes(ctx, { venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });
    const outcomes = await asManager((ctx) => analytics.campaignOutcomes(ctx, {}));
    expect(outcomes.venues_covered).toBe(2);
    await expect(asManager((ctx) => analytics.getBenchmarks(ctx))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('one org can never read another\'s numbers', async () => {
    const diner = t.fixture.diner;
    const dinerOwner = await diner.as('owner');
    const dinerSales = await loadSales(t.db, diner.orgId);
    const want = totals(between(dinerSales, FROM, TO));
    for (const source of ['ledger', 'facts'] as const) {
      const r = await t.app.tenant(diner.orgId, dinerOwner, (ctx) => analytics.queryMetrics(ctx, { metrics: [...KEYS], period: { from: FROM, to: TO }, source }));
      expect(r.totals.values, source).toEqual(pick(want));
      expect(r.venues.names).toEqual(['Oak Diner']);
    }
    // The other org's venue ids do not exist here.
    for (const id of Object.values(ids())) {
      await expect(t.app.tenant(diner.orgId, dinerOwner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], filters: { venue: id } }))).rejects.toMatchObject({ code: 'not_found' });
      await expect(t.app.tenant(diner.orgId, dinerOwner, (ctx) => analytics.computeDigest(ctx, { period: 'week', venueId: id }))).rejects.toMatchObject({ code: 'not_found' });
      await expect(t.app.tenant(diner.orgId, dinerOwner, (ctx) => analytics.campaignOutcomes(ctx, { venueId: id }))).rejects.toMatchObject({ code: 'not_found' });
    }
    // A group staff principal acting inside the diner's tenant has no role there.
    const groupOwner = await org().as('owner');
    await expect(t.app.tenant(diner.orgId, groupOwner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'] }))).rejects.toMatchObject({ code: 'forbidden' });
    // Row-level security holds for every analytics table: inside the diner's tenant there is no group row at all.
    await t.app.tenant(diner.orgId, { kind: 'worker', job: 'leak-test' }, async (ctx) => {
      for (const table of ['fact_sales_daily', 'fact_sales_hourly', 'fact_item_daily', 'fact_customer', 'fact_events_daily', 'fact_campaign_daily', 'rollup_state', 'insight_digests', 'saved_views'] as const) {
        const rows = await ctx.db.selectFrom(table).select('org_id').execute();
        expect(rows.length, table).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.org_id)), table).toEqual(new Set([diner.orgId]));
      }
    });
    // Saved views with the same name exist in both orgs and are separate rows.
    const views = await t.db.selectFrom('saved_views').select(['org_id', 'name']).where('name', '=', 'Weekly sales by channel').execute();
    expect(new Set(views.map((v) => v.org_id))).toEqual(new Set([diner.orgId, org().orgId]));
    const mine = await t.app.tenant(diner.orgId, dinerOwner, (ctx) => analytics.listViews(ctx));
    expect(mine.map((v) => v.name)).toEqual(['Weekly sales by channel', 'Top items this month']);
    // Distinct per-org values prove the two answers really are different data.
    const groupNet = totals(between(sales, FROM, TO)).net_sales;
    expect(groupNet).not.toBe(want.net_sales);
    expect(groupBy(sales, (s) => s.venueId).size).toBe(3);
  });
});
