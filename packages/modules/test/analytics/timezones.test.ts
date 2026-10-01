import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { analytics, ledger, tenancy } from '@ros/modules';
import { SALE_NET, WORKER, sale } from './helpers';
import { loadSales } from './oracle';

/**
 * Business days are the venue's own calendar days. Sydney moves to daylight saving at 2am on
 * Sunday 4 October 2026 (UTC+10 → UTC+11) and back at 3am on Sunday 5 April 2026.
 */
describe('analytics: venue-local days', () => {
  const t = useTestEnv();

  it('a 23:30 Sydney sale belongs to that day, before, across and after the daylight-saving change', async () => {
    const org = t.fixture.diner;
    const owner = await org.as('owner');
    t.clock.set('2026-10-06T02:00:00Z');
    const byDay = async (from: string, to: string, source: 'ledger' | 'facts' | 'auto' = 'ledger') => {
      const r = await t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders', 'net_sales'], grain: 'day', period: { from, to }, source }));
      return Object.fromEntries(r.rows.map((x) => [x.period_start!, x.values.orders!]));
    };
    const spring = await byDay('2026-10-02', '2026-10-06');
    const autumn = await byDay('2026-04-03', '2026-04-06');
    const winter = await byDay('2026-07-09', '2026-07-11');

    const put = (ref: string, at: string) => t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, sale(ref, at), { venueId: org.venueId }));
    // Saturday 3 Oct, 23:30 AEST (UTC+10).
    await put('tz-1', '2026-10-03T13:30:00Z');
    // Sunday 4 Oct, 00:30 AEST: half an hour after midnight, before the clocks change at 2am.
    await put('tz-2', '2026-10-03T14:30:00Z');
    // Sunday 4 Oct, 23:30 AEDT (UTC+11), after the change.
    await put('tz-3', '2026-10-04T12:30:00Z');
    // Monday 5 Oct, 00:15 AEDT. At the old offset this would be Sunday 23:15: the change moves it to Monday.
    await put('tz-4', '2026-10-04T13:15:00Z');
    // Clocks go back: Saturday 4 Apr 23:30 AEDT, and Sunday 5 Apr 23:30 AEST.
    await put('tz-5', '2026-04-04T12:30:00Z');
    await put('tz-6', '2026-04-05T13:30:00Z');
    // Mid-winter, nothing special: Friday 10 Jul 23:30 AEST, and ten minutes after midnight.
    await put('tz-7', '2026-07-10T13:30:00Z');
    await put('tz-8', '2026-07-10T14:10:00Z');

    const plus = (before: Record<string, number>, add: Record<string, number>) => Object.fromEntries(Object.entries(before).map(([d, n]) => [d, n + (add[d] ?? 0)]));
    expect(await byDay('2026-10-02', '2026-10-06')).toEqual(plus(spring, { '2026-10-03': 1, '2026-10-04': 2, '2026-10-05': 1 }));
    expect(await byDay('2026-04-03', '2026-04-06')).toEqual(plus(autumn, { '2026-04-04': 1, '2026-04-05': 1 }));
    expect(await byDay('2026-07-09', '2026-07-11')).toEqual(plus(winter, { '2026-07-10': 1, '2026-07-11': 1 }));

    // The derived facts use the same days: roll up, then read the fact rows back.
    const rolled = await analytics.rollup(t.app, org.orgId);
    expect(rolled.daysChanged).toEqual(expect.arrayContaining(['2026-04-04', '2026-04-05', '2026-07-10', '2026-07-11', '2026-10-03', '2026-10-04', '2026-10-05']));
    expect(await byDay('2026-10-02', '2026-10-06', 'facts')).toEqual(await byDay('2026-10-02', '2026-10-06', 'ledger'));
    expect(await byDay('2026-04-03', '2026-04-06', 'facts')).toEqual(await byDay('2026-04-03', '2026-04-06', 'ledger'));
    const hours = await t.db.selectFrom('fact_sales_hourly').select(['day', 'hour', 'orders']).where('org_id', '=', org.orgId).where('day', 'in', ['2026-10-03', '2026-10-04', '2026-10-05']).where('hour', 'in', [0, 23]).orderBy('day').orderBy('hour').execute();
    expect(hours).toEqual([
      { day: '2026-10-03', hour: 23, orders: 1 },
      { day: '2026-10-04', hour: 0, orders: 1 },
      { day: '2026-10-04', hour: 23, orders: 1 },
      { day: '2026-10-05', hour: 0, orders: 1 },
    ]);

    // The same sales by hour and by week: Sunday night is the old week, Monday 00:15 the new one.
    const byHour = await t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders', 'net_sales'], dimensions: ['hour', 'daypart'], period: { from: '2026-10-04', to: '2026-10-04' } }));
    expect(byHour.rows.map((r) => [r.dimensions.hour, r.dimensions.daypart, r.values.orders, r.values.net_sales])).toEqual(
      expect.arrayContaining([
        ['0', 'late', 1, SALE_NET],
        ['23', 'late', 1, SALE_NET],
      ]),
    );
    const byWeek = await t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], grain: 'week', period: { from: '2026-10-03', to: '2026-10-05' }, filters: { hour: ['0', '23'] } }));
    expect(byWeek.rows.map((r) => [r.period_start, r.values.orders])).toEqual([
      ['2026-09-28', 3],
      ['2026-10-05', 1],
    ]);
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('each venue keeps its own days: the same instant is Tuesday night in Perth and Wednesday morning in Sydney', async () => {
    const org = t.fixture.group;
    const owner = await org.as('owner');
    const { perth, nyc } = await t.app.tenant(org.orgId, owner, async (ctx) => ({
      perth: await tenancy.createVenue(ctx, { slug: 'perth', name: 'Oak Group Perth', timezone: 'Australia/Perth', state: 'WA' }),
      nyc: await tenancy.createVenue(ctx, { slug: 'nyc', name: 'Oak Group New York', timezone: 'America/New_York' }),
    }));
    const principal = await org.as('owner');
    const at = '2026-09-29T15:30:00Z'; // 23:30 Tue in Perth · 01:30 Wed in Sydney · 11:30 Tue in New York
    const put = (ref: string, venueId: string, when: string) => t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, sale(ref, when), { venueId }));
    await put('zone-perth', perth.id, at);
    await put('zone-cbd', org.venues.cbd!.id, at);
    await put('zone-nyc', nyc.id, at);
    // 23:30 Monday in New York is already Tuesday 03:30 UTC.
    await put('zone-nyc-late', nyc.id, '2026-09-29T03:30:00Z');

    const run = (source: 'ledger' | 'facts') =>
      t.app.tenant(org.orgId, principal, (ctx) =>
        analytics.queryMetrics(ctx, { metrics: ['orders'], dimensions: ['venue'], grain: 'day', period: { from: '2026-09-28', to: '2026-09-30' }, filters: { venue: [perth.id, nyc.id] }, source }),
      );
    const ledgerRows = await run('ledger');
    expect(ledgerRows.rows.map((r) => [r.period_start, r.dimensions.venue, r.values.orders])).toEqual([
      ['2026-09-28', 'Oak Group New York', 1],
      ['2026-09-29', 'Oak Group New York', 1],
      ['2026-09-29', 'Oak Group Perth', 1],
    ]);
    expect(ledgerRows.period.timezone).toBe('each venue\'s own');
    expect(ledgerRows.caveats.join(' ')).toMatch(/different time zones/);

    // The Sydney venue's sale at the very same instant lands on the 30th.
    const cbd = await t.app.tenant(org.orgId, principal, (ctx) =>
      analytics.queryMetrics(ctx, { metrics: ['orders'], grain: 'day', period: { from: '2026-09-29', to: '2026-09-30' }, filters: { venue: org.venues.cbd!.id }, source: 'ledger' }),
    );
    const cbdSales = await loadSales(t.db, org.orgId, [org.venues.cbd!.id]);
    const theSale = await t.db.selectFrom('transactions').select('id').where('external_ref', '=', 'zone-cbd').executeTakeFirstOrThrow();
    expect(cbdSales.find((s) => s.id === theSale.id)!.day).toBe('2026-09-30');
    expect(cbd.rows.map((r) => [r.period_start, r.values.orders])).toEqual([
      ['2026-09-29', cbdSales.filter((s) => s.day === '2026-09-29').length],
      ['2026-09-30', cbdSales.filter((s) => s.day === '2026-09-30').length],
    ]);

    await analytics.rollup(t.app, org.orgId);
    expect((await run('facts')).rows).toEqual(ledgerRows.rows);
    const facts = await t.db.selectFrom('fact_sales_daily').select(['venue_id', 'day', 'orders']).where('org_id', '=', org.orgId).where('venue_id', 'in', [perth.id, nyc.id]).orderBy('day').orderBy('venue_id').execute();
    expect(facts.map((f) => [f.day, f.orders]).sort()).toEqual([['2026-09-28', 1], ['2026-09-29', 1], ['2026-09-29', 1]]);
  });
});
