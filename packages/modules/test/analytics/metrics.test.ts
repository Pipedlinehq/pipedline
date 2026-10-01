import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, track } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, comms } from '@ros/modules';
import { DAYPART, WEEKDAY_NAME, type Sale, between, customers, dayDiff, groupBy, loadSales, median, ratio, sum, totals } from './oracle';

/**
 * Every headline metric, checked against an oracle that reads the raw ledger and does the
 * arithmetic in JavaScript (./oracle.ts). "Today" is Wednesday 30 September 2026 in Sydney.
 */
const FROM = '2026-09-02';
const TO = '2026-09-29';
const SALES_KEYS = ['orders', 'gross_sales', 'net_sales', 'avg_order_value', 'items_sold', 'items_per_order', 'refunds', 'refunded_orders', 'refund_rate', 'discounts', 'discounted_orders', 'tips'] as const;

describe('analytics: metrics against the ledger', () => {
  const t = useTestEnv();
  let sales: Sale[];
  const org = () => t.fixture.diner;
  const ask = async (query: analytics.MetricQuery, who: 'owner' | 'manager' | 'kitchen' = 'owner') => {
    const p = await org().as(who);
    return t.app.tenant(org().orgId, p, (ctx) => analytics.queryMetrics(ctx, query));
  };

  beforeAll(async () => {
    // Other modules' seeders may have added sales after the analytics seeder ran.
    await analytics.rollup(t.app, org().orgId);
    sales = await loadSales(t.db, org().orgId);
  });

  it('the catalogue declares every metric a venue needs, each with a unit, a definition, dimensions and caveats', () => {
    const cat = analytics.metricCatalogue();
    const keys = cat.metrics.map((m) => m.key);
    for (const k of [
      'gross_sales', 'net_sales', 'orders', 'avg_order_value', 'items_per_order', 'refunds', 'refund_rate', 'discounts', 'tips',
      'identified_share', 'new_customers', 'returning_customers', 'repeat_rate', 'one_timer_share', 'median_days_to_second_order',
      'customer_lifetime_value', 'customers_total', 'cohort_retention_rate', 'item_quantity', 'item_revenue', 'item_revenue_share', 'item_attach_rate',
      'web_sessions', 'funnel_conversion_rate', 'campaign_sessions', 'campaign_new_customers', 'campaign_orders', 'campaign_revenue', 'campaign_repeat_rate',
      'messages_sent', 'messages_delivered', 'messages_opened', 'messages_clicked', 'messages_unsubscribed',
    ]) {
      expect(keys, k).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
    const dims = new Set(cat.dimensions.map((d) => d.key));
    for (const m of cat.metrics) {
      expect(m.name.length, m.key).toBeGreaterThan(2);
      expect(m.description.length, m.key).toBeGreaterThan(15);
      expect(m.how_it_is_computed.length, m.key).toBeGreaterThan(10);
      expect(['cents', 'count', 'ratio', 'days', 'number'], m.key).toContain(m.unit);
      expect(m.definition_version, m.key).toBeGreaterThanOrEqual(1);
      for (const d of m.dimensions) expect(dims.has(d), `${m.key} → ${d}`).toBe(true);
    }
    const salesDims = cat.metrics.find((m) => m.key === 'net_sales')!.dimensions;
    expect(salesDims).toEqual(expect.arrayContaining(['venue', 'channel', 'source', 'daypart', 'day_of_week', 'hour']));
    expect(cat.metrics.find((m) => m.key === 'customers_total')!.dimensions).toContain('segment');
  });

  it('sales totals equal the ledger: gross, net, orders, average order value, items, refunds, discounts, tips', async () => {
    const want = totals(between(sales, FROM, TO));
    expect(want.orders).toBeGreaterThan(150);
    expect(want.refunded_orders + want.discounted_orders).toBeGreaterThan(0);
    for (const source of ['ledger', 'auto'] as const) {
      const r = await ask({ metrics: [...SALES_KEYS], period: { from: FROM, to: TO }, source });
      for (const k of SALES_KEYS) expect(r.totals.values[k], `${k} (${source})`).toBe(want[k]);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.values).toEqual(r.totals.values);
    }
    const auto = await ask({ metrics: ['net_sales'], period: { from: FROM, to: TO } });
    expect(auto.sources[0]!.read_from).toBe('facts');
  });

  it('relative periods resolve to venue-local dates and say so', async () => {
    const r = await ask({ metrics: ['orders'], period: 'last_28_days' });
    expect(r.period).toMatchObject({ from: FROM, to: TO, days: 28, label: 'last_28_days', timezone: 'Australia/Sydney', includes_today: false });
    expect(r.totals.values.orders).toBe(between(sales, FROM, TO).length);

    const today = await ask({ metrics: ['orders'], period: 'today' });
    expect(today.period).toMatchObject({ from: '2026-09-30', to: '2026-09-30', includes_today: true });
    expect(today.caveats.join(' ')).toMatch(/still in progress/);
    expect(today.totals.values.orders).toBe(between(sales, '2026-09-30', '2026-09-30').length);

    const week = await ask({ metrics: ['orders'], period: 'last_week' });
    expect(week.period).toMatchObject({ from: '2026-09-21', to: '2026-09-27' });
    const month = await ask({ metrics: ['orders'], period: 'last_month' });
    expect(month.period).toMatchObject({ from: '2026-08-01', to: '2026-08-31' });
    expect(month.totals.values.orders).toBe(between(sales, '2026-08-01', '2026-08-31').length);

    // 23:30 in Sydney is still the 30th there, although it is already past midnight in UTC terms of the next local day's start.
    t.clock.set('2026-09-30T13:30:00Z');
    expect((await ask({ metrics: ['orders'], period: 'today' })).period.from).toBe('2026-09-30');
    t.clock.set('2026-09-30T14:30:00Z');
    expect((await ask({ metrics: ['orders'], period: 'today' })).period.from).toBe('2026-10-01');
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('splits by channel, source, daypart, day of week and hour each equal the ledger and add up to the total', async () => {
    const inPeriod = between(sales, FROM, TO);
    const whole = totals(inPeriod);
    const cases: Array<[string, (s: Sale) => string]> = [
      ['channel', (s) => s.channel],
      ['source', (s) => s.source],
      ['daypart', (s) => DAYPART(s.hour)],
      ['day_of_week', (s) => WEEKDAY_NAME[s.weekday]!],
      ['hour', (s) => String(s.hour)],
    ];
    for (const [dim, key] of cases) {
      for (const source of ['ledger', 'auto'] as const) {
        const r = await ask({ metrics: ['orders', 'gross_sales', 'net_sales', 'avg_order_value', 'refunds', 'tips'], dimensions: [dim], period: { from: FROM, to: TO }, source });
        const want = groupBy(inPeriod, key);
        expect(r.rows.length, dim).toBe(want.size);
        for (const row of r.rows) {
          const w = totals(want.get(row.dimensions[dim]!)!);
          expect(row.values, `${dim}=${row.dimensions[dim]} (${source})`).toEqual({ orders: w.orders, gross_sales: w.gross_sales, net_sales: w.net_sales, avg_order_value: w.avg_order_value, refunds: w.refunds, tips: w.tips });
        }
        expect(sum(r.rows, (x) => x.values.net_sales ?? 0)).toBe(whole.net_sales);
        expect(sum(r.rows, (x) => x.values.orders ?? 0)).toBe(whole.orders);
        expect(r.totals.values.net_sales).toBe(whole.net_sales);
      }
    }
    // Two dimensions at once, and a filter.
    const two = await ask({ metrics: ['orders', 'net_sales'], dimensions: ['channel', 'daypart'], period: { from: FROM, to: TO } });
    for (const row of two.rows) {
      const w = totals(inPeriod.filter((s) => s.channel === row.dimensions.channel && DAYPART(s.hour) === row.dimensions.daypart));
      expect(row.values).toEqual({ orders: w.orders, net_sales: w.net_sales });
    }
    const weekend = await ask({ metrics: ['orders', 'net_sales'], filters: { day_of_week: ['friday', 'saturday'], channel: 'dine-in' }, period: { from: FROM, to: TO } });
    const w = totals(inPeriod.filter((s) => [5, 6].includes(s.weekday) && s.channel === 'dine-in'));
    expect(weekend.totals.values).toEqual({ orders: w.orders, net_sales: w.net_sales });
  });

  it('identified share, and new versus returning orders, equal the ledger', async () => {
    const inPeriod = between(sales, FROM, TO);
    const want = totals(inPeriod);
    for (const source of ['ledger', 'auto'] as const) {
      const r = await ask({ metrics: ['identified_orders', 'identified_share', 'identified_sales_share', 'new_customer_orders', 'returning_customer_orders', 'returning_order_share'], period: { from: FROM, to: TO }, source });
      expect(r.totals.values.identified_orders).toBe(want.identified_orders);
      expect(r.totals.values.identified_share).toBe(want.identified_share);
      expect(r.totals.values.identified_sales_share).toBe(ratio(sum(inPeriod.filter((s) => s.customerId), (s) => s.total), want.gross_sales));
      expect(r.totals.values.new_customer_orders).toBe(want.new_customer_orders);
      expect(r.totals.values.returning_customer_orders).toBe(want.returning_customer_orders);
      expect(r.totals.values.returning_order_share).toBe(ratio(want.returning_customer_orders, want.identified_orders));
    }
    expect(want.identified_orders).toBe(want.new_customer_orders + want.returning_customer_orders);
    expect(want.identified_orders).toBeLessThan(want.orders);
  });

  it('time grains: every day is a row (closed days are zeros), weeks start on Monday, and rows add up to the total', async () => {
    const inPeriod = between(sales, FROM, TO);
    const byDay = await ask({ metrics: ['orders', 'net_sales', 'avg_order_value'], grain: 'day', period: { from: FROM, to: TO } });
    expect(byDay.rows).toHaveLength(28);
    expect(byDay.rows.map((r) => r.period_start)).toEqual(Array.from({ length: 28 }, (_, i) => addDays(FROM, i)));
    for (const row of byDay.rows) {
      const w = totals(inPeriod.filter((s) => s.day === row.period_start));
      expect(row.values, row.period_start!).toEqual({ orders: w.orders, net_sales: w.net_sales, avg_order_value: w.avg_order_value });
    }
    // The fixture venue is closed on Mondays: a zero, and an unmeasurable average rather than a zero one.
    const monday = byDay.rows.find((r) => r.period_start === '2026-09-07')!;
    expect(monday.values).toEqual({ orders: 0, net_sales: 0, avg_order_value: null });

    const byWeek = await ask({ metrics: ['orders', 'net_sales'], grain: 'week', period: { from: FROM, to: TO } });
    expect(byWeek.rows.map((r) => r.period_start)).toEqual(['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28']);
    expect(sum(byWeek.rows, (r) => r.values.net_sales ?? 0)).toBe(totals(inPeriod).net_sales);
    const wk = totals(inPeriod.filter((s) => s.day >= '2026-09-14' && s.day <= '2026-09-20'));
    expect(byWeek.rows[2]!.values).toEqual({ orders: wk.orders, net_sales: wk.net_sales });

    const byMonth = await ask({ metrics: ['orders', 'net_sales'], grain: 'month', period: { from: '2026-06-01', to: '2026-08-31' } });
    expect(byMonth.rows.map((r) => r.period_start)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    const july = totals(between(sales, '2026-07-01', '2026-07-31'));
    expect(byMonth.rows[1]!.values).toEqual({ orders: july.orders, net_sales: july.net_sales });
  });

  it('comparisons state the dates they used and the change is plain arithmetic', async () => {
    const cur = totals(between(sales, FROM, TO));
    const prevRange = { from: '2026-08-05', to: '2026-09-01' };
    const prev = totals(between(sales, prevRange.from, prevRange.to));
    const r = await ask({ metrics: ['net_sales', 'orders', 'avg_order_value', 'refund_rate'], period: 'last_28_days', compareTo: 'previous_period' });
    expect(r.compare).toMatchObject({ kind: 'previous_period', ...prevRange, days: 28 });
    expect(r.compare!.basis).toMatch(/same weekdays/);
    expect(r.totals.compare).toEqual({ net_sales: prev.net_sales, orders: prev.orders, avg_order_value: prev.avg_order_value, refund_rate: prev.refund_rate });
    expect(r.totals.change!.net_sales).toEqual({ abs: cur.net_sales - prev.net_sales, pct: ratio(cur.net_sales - prev.net_sales, prev.net_sales) });
    expect(r.totals.change!.orders!.abs).toBe(cur.orders - prev.orders);

    // Year on year moves back 52 weeks so that weekdays line up.
    const yoy = await ask({ metrics: ['net_sales'], period: { from: FROM, to: TO }, compareTo: 'same_period_last_year', grain: 'week' });
    expect(yoy.compare).toMatchObject({ from: '2025-09-03', to: '2025-09-30' });
    expect(yoy.totals.compare!.net_sales).toBe(totals(between(sales, '2025-09-03', '2025-09-30')).net_sales);
    expect(yoy.rows).toHaveLength(5);
    expect(yoy.rows[1]!.compare!.net_sales).toBe(totals(between(sales, '2025-09-08', '2025-09-14')).net_sales);

    // A whole calendar month compares with the whole month before, whatever its length.
    const month = await ask({ metrics: ['orders'], period: 'last_month', compareTo: 'previous_period' });
    expect(month.compare).toMatchObject({ from: '2026-07-01', to: '2026-07-31' });
    expect(month.totals.compare!.orders).toBe(between(sales, '2026-07-01', '2026-07-31').length);

    // A comparison with nothing in it gives no percentage rather than an infinite one.
    const early = await ask({ metrics: ['orders'], period: { from: '2025-04-10', to: '2025-04-16' }, compareTo: 'same_period_last_year' });
    expect(early.totals.compare!.orders).toBe(0);
    expect(early.totals.change!.orders!.pct).toBeNull();
  });

  it('the customer base: repeat rate, one-timer share, median days to second visit, lifetime value, segments', async () => {
    const asOf = '2026-09-30';
    const base = customers(sales, asOf);
    expect(base.length).toBeGreaterThan(300);
    const repeaters = base.filter((c) => c.orders >= 2);
    const want = {
      customers_total: base.length,
      repeat_rate: ratio(repeaters.length, base.length),
      one_timer_share: ratio(base.length - repeaters.length, base.length),
      median_days_to_second_order: median(repeaters.map((c) => dayDiff(c.firstDay, c.secondDay!))),
      customer_lifetime_value: Math.round(sum(base, (c) => c.spend) / base.length),
      avg_orders_per_customer: Math.round((sum(base, (c) => c.orders) / base.length) * 100) / 100,
      customer_spend: sum(base, (c) => c.spend),
    };
    for (const source of ['ledger', 'auto'] as const) {
      const r = await ask({ metrics: Object.keys(want), period: 'today', source });
      expect(r.totals.values, source).toEqual(want);
      if (source === 'auto') expect(r.sources[0]!.read_from).toBe('facts');
    }
    expect(want.repeat_rate + want.one_timer_share).toBeCloseTo(1, 3);

    for (const source of ['ledger', 'auto'] as const) {
      const seg = await ask({ metrics: ['customers_total', 'customer_share', 'customer_spend', 'customer_spend_share'], dimensions: ['segment'], period: 'today', source });
      const bySeg = groupBy(base, (c) => c.segment);
      expect(seg.rows.length).toBe(bySeg.size);
      expect(bySeg.size).toBeGreaterThanOrEqual(5);
      for (const row of seg.rows) {
        const list = bySeg.get(row.dimensions.segment!)!;
        expect(row.values, `${row.dimensions.segment} (${source})`).toEqual({
          customers_total: list.length,
          customer_share: ratio(list.length, base.length),
          customer_spend: sum(list, (c) => c.spend),
          customer_spend_share: ratio(sum(list, (c) => c.spend), want.customer_spend),
        });
      }
      expect(sum(seg.rows, (r) => r.values.customers_total ?? 0)).toBe(base.length);
    }

    // As of an earlier day, from the ledger: the base and the segments are what they were then.
    const then = customers(sales, '2026-06-30');
    const past = await ask({ metrics: ['customers_total', 'repeat_rate'], period: { from: '2026-06-01', to: '2026-06-30' } });
    expect(past.totals.values).toEqual({ customers_total: then.length, repeat_rate: ratio(then.filter((c) => c.orders >= 2).length, then.length) });
    expect(past.sources[0]!.read_from).toBe('ledger');

    // A state cannot be split by time.
    await expect(ask({ metrics: ['repeat_rate'], grain: 'week', period: 'last_28_days' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('customer metrics say what share of sales they describe', async () => {
    const inPeriod = between(sales, FROM, TO);
    const share = Math.round((inPeriod.filter((s) => s.customerId).length / inPeriod.length) * 100);
    const r = await ask({ metrics: ['active_customers'], period: { from: FROM, to: TO } });
    expect(r.caveats).toContain(`Only ${share}% of sales in this period are tied to a known customer, so customer metrics describe that share and say nothing about the rest.`);
    const all = sales.filter((s) => s.day <= '2026-09-30');
    const allShare = Math.round((all.filter((s) => s.customerId).length / all.length) * 100);
    const base = await ask({ metrics: ['repeat_rate'], period: 'today' });
    expect(base.caveats.join(' ')).toContain(`Only ${allShare}% of sales up to 2026-09-30 are tied to a known customer`);
    // Sales metrics alone carry no such caveat.
    expect((await ask({ metrics: ['net_sales'], period: { from: FROM, to: TO } })).caveats.join(' ')).not.toMatch(/known customer/);
  });

  it('active, new and returning customers in a period equal the ledger', async () => {
    const inPeriod = between(sales, FROM, TO).filter((s) => s.customerId);
    const active = new Set(inPeriod.map((s) => s.customerId!));
    const isNew = new Set(inPeriod.filter((s) => s.rank === 1).map((s) => s.customerId!));
    const r = await ask({ metrics: ['active_customers', 'new_customers', 'returning_customers', 'returning_customer_share'], period: { from: FROM, to: TO } });
    expect(r.totals.values).toEqual({ active_customers: active.size, new_customers: isNew.size, returning_customers: active.size - isNew.size, returning_customer_share: ratio(active.size - isNew.size, active.size) });

    const weekly = await ask({ metrics: ['active_customers', 'new_customers'], grain: 'week', period: { from: FROM, to: TO } });
    const wk = inPeriod.filter((s) => s.day >= '2026-09-14' && s.day <= '2026-09-20');
    expect(weekly.rows.find((x) => x.period_start === '2026-09-14')!.values).toEqual({
      active_customers: new Set(wk.map((s) => s.customerId)).size,
      new_customers: new Set(wk.filter((s) => s.rank === 1).map((s) => s.customerId)).size,
    });
    expect(weekly.caveats.join(' ')).toMatch(/do not add up/);

    const bySource = await ask({ metrics: ['new_customers'], dimensions: ['acquisition_source'], period: { from: FROM, to: TO } });
    expect(sum(bySource.rows, (x) => x.values.new_customers ?? 0)).toBe(isNew.size);
  });

  it('cohort retention: each cohort is its first-order month, period 0 is everyone, later periods are who came back', async () => {
    const r = await ask({ metrics: ['cohort_size', 'cohort_active_customers', 'cohort_retention_rate'], period: { from: '2026-06-01', to: '2026-08-31' } });
    expect(r.dimensions).toEqual(['cohort', 'periods_since']);
    const identified = sales.filter((s) => s.customerId);
    const firstDay = new Map<string, string>();
    for (const s of identified) if (!firstDay.has(s.customerId!)) firstDay.set(s.customerId!, s.day);
    const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
    const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7));
    for (const cohort of ['2026-06-01', '2026-07-01', '2026-08-01']) {
      const members = new Set([...firstDay.entries()].filter(([, d]) => monthOf(d) === cohort).map(([c]) => c));
      const rows = r.rows.filter((x) => x.dimensions.cohort === cohort);
      // June has periods 0..3 (June, July, August, September); August has 0..1.
      expect(rows.map((x) => x.dimensions.periods_since)).toEqual(Array.from({ length: monthsBetween(cohort, '2026-09-01') + 1 }, (_, i) => String(i)));
      for (const row of rows) {
        const idx = Number(row.dimensions.periods_since);
        const active = new Set(identified.filter((s) => members.has(s.customerId!) && monthsBetween(cohort, monthOf(s.day)) === idx).map((s) => s.customerId));
        expect(row.values, `${cohort}+${idx}`).toEqual({ cohort_size: members.size, cohort_active_customers: active.size, cohort_retention_rate: ratio(active.size, members.size) });
      }
      expect(rows[0]!.values.cohort_retention_rate).toBe(1);
    }
  });

  it('item performance: quantity, revenue, mix and attach rate equal the ledger', async () => {
    const inPeriod = between(sales, FROM, TO);
    const lines = inPeriod.flatMap((s) => s.lines.map((l) => ({ ...l, saleId: s.id })));
    const totalRevenue = sum(lines, (l) => l.total);
    const totalQty = sum(lines, (l) => l.qty);
    const ordersWithLines = new Set(lines.map((l) => l.saleId)).size;
    for (const [dim, key] of [['item', (l: (typeof lines)[number]) => l.name], ['category', (l: (typeof lines)[number]) => l.category]] as const) {
      const r = await ask({ metrics: ['item_quantity', 'item_revenue', 'item_orders', 'item_revenue_share', 'item_quantity_share', 'item_attach_rate'], dimensions: [dim], period: { from: FROM, to: TO } });
      const want = groupBy(lines, key);
      expect(r.rows.length).toBe(want.size);
      for (const row of r.rows) {
        const list = want.get(row.dimensions[dim]!)!;
        const orders = new Set(list.map((l) => l.saleId)).size;
        expect(row.values, `${dim}=${row.dimensions[dim]}`).toEqual({
          item_quantity: sum(list, (l) => l.qty),
          item_revenue: sum(list, (l) => l.total),
          item_orders: orders,
          item_revenue_share: ratio(sum(list, (l) => l.total), totalRevenue),
          item_quantity_share: ratio(sum(list, (l) => l.qty), totalQty),
          item_attach_rate: ratio(orders, ordersWithLines),
        });
      }
      expect(r.totals.values.item_revenue).toBe(totalRevenue);
      expect(r.totals.values.item_quantity).toBe(totalQty);
    }
    // The biggest seller comes first, and the limit is honoured and reported.
    const top = await ask({ metrics: ['item_revenue'], dimensions: ['item'], period: { from: FROM, to: TO }, limit: 3 });
    expect(top.rows).toHaveLength(3);
    expect(top.truncated).toBe(true);
    expect(top.rows[0]!.values.item_revenue!).toBeGreaterThanOrEqual(top.rows[1]!.values.item_revenue!);
    // Mix needs something to be a share of.
    await expect(ask({ metrics: ['item_revenue_share'], period: { from: FROM, to: TO } })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('web sessions and the funnel equal the session and event rows', async () => {
    const sessions = await t.db.selectFrom('visitor_sessions').select(['id', 'first_seen_at', 'utm_source', 'campaign_id', 'device_class']).where('org_id', '=', org().orgId).execute();
    const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
    const inPeriod = sessions.filter((s) => local(s.first_seen_at) >= FROM && local(s.first_seen_at) <= TO);
    expect(inPeriod.length).toBeGreaterThan(100);
    const r = await ask({ metrics: ['web_sessions'], dimensions: ['utm_source'], period: { from: FROM, to: TO } });
    expect(r.totals.values.web_sessions).toBe(inPeriod.length);
    const bySource = groupBy(inPeriod, (s) => s.utm_source ?? 'direct');
    for (const row of r.rows) expect(row.values.web_sessions, row.dimensions.utm_source!).toBe(bySource.get(row.dimensions.utm_source!)!.length);
    const facts = await ask({ metrics: ['web_sessions'], dimensions: ['utm_source'], period: { from: FROM, to: TO }, source: 'facts' });
    expect(facts.sources[0]!.read_from).toBe('facts');
    expect(facts.rows.map((x) => [x.dimensions.utm_source, x.values.web_sessions])).toEqual(r.rows.map((x) => [x.dimensions.utm_source, x.values.web_sessions]));

    const steps = analytics.funnelSteps('order');
    expect(steps[0]!.event).toBe('session.started');
    const events = await t.db.selectFrom('events').select(['session_id', 'name']).where('org_id', '=', org().orgId).where('session_id', 'in', inPeriod.map((s) => s.id)).execute();
    const bySession = groupBy(events, (e) => e.session_id!);
    const reached = steps.map((_, i) => inPeriod.filter((s) => steps.slice(0, i + 1).every((st) => (bySession.get(s.id) ?? []).some((e) => e.name === st.event))).length);
    const f = await ask({ metrics: ['funnel_sessions', 'funnel_conversion_rate', 'funnel_step_rate'], period: { from: FROM, to: TO } });
    expect(f.rows.map((x) => x.dimensions.funnel_event)).toEqual(steps.map((s) => s.event));
    f.rows.forEach((row, i) => {
      expect(row.values.funnel_sessions, row.dimensions.funnel_event!).toBe(reached[i]);
      expect(row.values.funnel_conversion_rate).toBe(reached[0] ? ratio(reached[i]!, reached[0]!) : null);
      expect(row.values.funnel_step_rate).toBe(i === 0 || !reached[i - 1] ? null : ratio(reached[i]!, reached[i - 1]!));
    });
    expect(reached[0]).toBe(inPeriod.length);
    expect(reached[1]!).toBeGreaterThan(0);
    expect(reached[1]!).toBeLessThan(reached[0]!);
    // Counts never rise from one step to the next.
    for (let i = 1; i < reached.length; i++) expect(reached[i]!).toBeLessThanOrEqual(reached[i - 1]!);
  });

  it('message performance is counted from the event stream, and an empty period is unmeasured, not poor', async () => {
    const quiet = await ask({ metrics: ['messages_sent', 'message_open_rate'], period: { from: '2025-05-01', to: '2025-05-07' } });
    expect(quiet.totals.values).toEqual({ messages_sent: 0, message_open_rate: null });
    expect(quiet.caveats.join(' ')).toMatch(/nothing to measure/);

    const at = new Date('2026-09-20T01:00:00Z');
    await t.app.tenant(org().orgId, { kind: 'worker', job: 'test' }, async (ctx) => {
      const send = async (id: string, names: Array<typeof comms.messageSent>) => {
        for (const def of names) {
          await track(ctx, def, { message_id: id, channel: 'email', kind: 'marketing', template_key: 'test_promo', campaign_id: 'mc_test' }, { occurredAt: at, source: 'comms', venueId: org().venueId });
        }
      };
      await send('00000000-0000-4000-8000-000000000001', [comms.messageSent, comms.messageDelivered, comms.messageOpened, comms.messageOpened, comms.messageClicked]);
      await send('00000000-0000-4000-8000-000000000002', [comms.messageSent, comms.messageDelivered, comms.messageOpened]);
      await send('00000000-0000-4000-8000-000000000003', [comms.messageSent, comms.messageDelivered]);
      await send('00000000-0000-4000-8000-000000000004', [comms.messageSent, comms.messageBounced]);
      await track(ctx, comms.messageUnsubscribed, { message_id: '00000000-0000-4000-8000-000000000002', channel: 'email', kind: 'marketing', template_key: 'test_promo', campaign_id: 'mc_test', via: 'link' }, { occurredAt: at, source: 'comms', venueId: org().venueId });
    });
    const r = await ask({
      metrics: ['messages_sent', 'messages_delivered', 'messages_opened', 'messages_clicked', 'messages_bounced', 'messages_unsubscribed', 'message_delivery_rate', 'message_open_rate', 'message_click_rate', 'message_unsubscribe_rate'],
      filters: { message_campaign: 'mc_test' },
      period: { from: '2026-09-20', to: '2026-09-20' },
    });
    expect(r.totals.values).toEqual({
      messages_sent: 4,
      messages_delivered: 3,
      messages_opened: 2,
      messages_clicked: 1,
      messages_bounced: 1,
      messages_unsubscribed: 1,
      message_delivery_rate: 0.75,
      message_open_rate: 0.6667,
      message_click_rate: 0.3333,
      message_unsubscribe_rate: 0.3333,
    });
  });

  it('every answer explains itself: dates, units, definition versions, tables, row counts, freshness', async () => {
    const r = await ask({ metrics: ['net_sales', 'avg_order_value'], dimensions: ['channel'], period: 'last_28_days', compareTo: 'previous_period', source: 'ledger' });
    expect(r.as_of).toBe('2026-09-30T02:00:00.000Z');
    expect(r.currency).toBe('AUD');
    expect(r.metrics).toEqual([
      expect.objectContaining({ key: 'net_sales', unit: 'cents', definition_version: 1, adds_up: true, good_direction: 'up_is_good' }),
      expect.objectContaining({ key: 'avg_order_value', unit: 'cents', definition_version: 1, adds_up: false }),
    ]);
    expect(r.sources).toEqual([{ metrics: ['net_sales', 'avg_order_value'], read_from: 'ledger', tables: ['transactions', 'venues'], source_rows: { transactions: between(sales, FROM, TO).length } }]);
    const latest = sales.reduce((m, s) => (s.at > m ? s.at : m), sales[0]!.at);
    expect(r.freshness.latest_sale_at).toBe(latest.toISOString());
    expect(r.freshness.latest_sale_ingested_at).not.toBeNull();
    expect(r.venues).toEqual({ scope: 'all_venues', names: ['Oak Diner'] });
    expect(r.catalogue_version).toBe(analytics.CATALOGUE_VERSION);

    const empty = await ask({ metrics: ['net_sales', 'avg_order_value'], period: { from: '2024-01-01', to: '2024-01-07' } });
    expect(empty.totals.values).toEqual({ net_sales: 0, avg_order_value: null });
    expect(empty.caveats.join(' ')).toMatch(/not evidence of a bad day/);
  });

  it('is role-checked and refuses what it cannot answer honestly', async () => {
    const q: analytics.MetricQuery = { metrics: ['net_sales'], period: 'last_7_days' };
    // Read-only and kitchen staff may read totals.
    expect((await ask(q, 'kitchen')).totals.values.net_sales).toBeGreaterThan(0);
    for (const principal of [{ kind: 'anon' as const }, { kind: 'guest' as const, customerId: '00000000-0000-4000-8000-000000000000' }, { kind: 'device' as const, deviceId: 'd', venueId: org().venueId, purpose: 'kitchen' as const }]) {
      await expect(t.app.tenant(org().orgId, principal, (ctx) => analytics.queryMetrics(ctx, q))).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    await expect(ask({ metrics: ['profit'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], dimensions: ['segment'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], dimensions: ['customer_id'] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], filters: { email: 'x@example.com' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], period: { from: '2026-09-31', to: '2026-10-01' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], period: { from: '2026-09-10', to: '2026-09-01' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(ask({ metrics: ['net_sales'], period: 'last_28_days', nonsense: true } as never)).rejects.toMatchObject({ code: 'invalid' });
    // A venue id from another org is not found, not forbidden.
    await expect(ask({ metrics: ['net_sales'], filters: { venue: t.fixture.group.venueId } })).rejects.toMatchObject({ code: 'not_found' });
    // A value that tries to break out of the query is just a value that matches nothing.
    const inj = await ask({ metrics: ['orders'], filters: { channel: "pickup' or '1'='1" }, period: 'last_28_days' });
    expect(inj.totals.values.orders).toBe(0);
  });
});
