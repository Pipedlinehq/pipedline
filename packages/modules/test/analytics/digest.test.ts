import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, drainJobs, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, ledger } from '@ros/modules';
import { WORKER, sale } from './helpers';
import { type Sale, between, loadSales, totals } from './oracle';

/**
 * Digests compare a period with the same weekdays over the weeks before. "Today" is Wednesday
 * 30 September 2026, so the last complete week is Monday 21 to Sunday 27 September.
 */
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]) => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1));

describe('analytics: digests', () => {
  const t = useTestEnv();
  let sales: Sale[];
  const org = () => t.fixture.diner;
  const as = async <T>(who: 'owner' | 'manager' | 'kitchen', fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org().orgId, await org().as(who), fn);

  beforeAll(async () => {
    sales = await loadSales(t.db, org().orgId);
  });
  beforeEach(() => t.clock.set('2026-09-30T02:00:00Z'));

  it('is deterministic: the same inputs and the same clock give the same findings and the same words', async () => {
    const a = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    const b = await as('manager', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a.period).toEqual({ kind: 'week', from: '2026-09-21', to: '2026-09-27', complete: true });
    expect(a.as_of).toBe('2026-09-30T02:00:00.000Z');
    // Whether it reads the facts or the ledger makes no difference either.
    await analytics.rollup(t.app, org().orgId);
    const c = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    expect(c).toEqual(a);
    for (const period of ['day', 'month'] as const) {
      const x = await as('owner', (ctx) => analytics.computeDigest(ctx, { period }));
      expect(await as('owner', (ctx) => analytics.computeDigest(ctx, { period }))).toEqual(x);
    }
  });

  it('the headline findings equal the ledger, and the baseline is the mean of the same weekdays over eight earlier weeks', async () => {
    const d = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    const week = totals(between(sales, '2026-09-21', '2026-09-27'));
    const earlier = Array.from({ length: 8 }, (_, i) => totals(between(sales, addDays('2026-09-21', -7 * (i + 1)), addDays('2026-09-27', -7 * (i + 1)))));
    const find = (k: string) => d.headline.find((h) => h.metric === k)!;
    expect(d.baseline).toMatchObject({ periods_asked: 8, shift_days: 7, earliest_from: '2026-07-27' });

    const net = find('net_sales');
    const base = earlier.map((w) => w.net_sales);
    expect(net.value).toBe(week.net_sales);
    expect(net.baseline).toBe(Math.round(mean(base)));
    expect(net.change_abs).toBe(week.net_sales - Math.round(mean(base)));
    expect(net.change_pct).toBe(Math.round(((week.net_sales - mean(base)) / mean(base)) * 10_000) / 10_000);
    expect(net.baseline_periods).toBe(8);
    expect(net.usual_range).toEqual([Math.round(Math.max(0, mean(base) - 2 * sd(base))), Math.round(mean(base) + 2 * sd(base))]);
    const z = Math.abs(week.net_sales - mean(base)) / sd(base);
    const rel = Math.abs(week.net_sales - mean(base)) / mean(base);
    expect(net.significance).toBe(rel < 0.05 ? 'normal' : z >= 3 ? 'strong' : z >= 2 ? 'notable' : 'normal');
    expect(net.direction).toBe(rel < 0.005 ? 'flat' : week.net_sales > mean(base) ? 'up' : 'down');

    expect(find('orders').value).toBe(week.orders);
    expect(find('orders').baseline).toBe(Math.round(mean(earlier.map((w) => w.orders))));
    expect(find('avg_order_value').value).toBe(week.avg_order_value);
    expect(find('identified_share').value).toBe(week.identified_share);
    expect(find('new_customer_orders').value).toBe(week.new_customer_orders);
    expect(find('refund_rate').value).toBe(week.refund_rate);
    expect(d.headline.map((h) => h.metric)).toEqual(['net_sales', 'orders', 'avg_order_value', 'items_per_order', 'identified_share', 'new_customer_orders', 'returning_customer_orders', 'discounts', 'refund_rate', 'web_sessions']);
    expect(d.flagged).toEqual(d.headline.filter((h) => h.significance === 'notable' || h.significance === 'strong').map((h) => h.metric));

    // The sentence is built from the same numbers.
    expect(d.summary.startsWith(`Week of 21 Sep to 27 Sep 2026: net sales $${Math.round(week.net_sales / 100).toLocaleString('en-AU')} from ${week.orders} orders`)).toBe(true);
    expect(d.caveats.join(' ')).toMatch(/not an explanation/);
    expect(d.caveats.join(' ')).toContain(`${Math.round(week.identified_share! * 100)}% of sales in the period are tied to a known customer`);

    // Movers: each is a real member, with its value, and at most three up and three down per dimension.
    for (const dim of ['item', 'channel', 'daypart', 'campaign'] as const) {
      const ms = d.movers.filter((m) => m.dimension === dim);
      expect(ms.filter((m) => m.direction === 'up').length).toBeLessThanOrEqual(3);
      expect(ms.filter((m) => m.direction === 'down').length).toBeLessThanOrEqual(3);
      for (const m of ms) expect(m.change_abs).toBe(m.value - m.baseline);
    }
    const wagyu = d.movers.find((m) => m.dimension === 'item');
    expect(wagyu).toBeDefined();
    const itemValue = between(sales, '2026-09-21', '2026-09-27').flatMap((s) => s.lines).filter((l) => l.name === wagyu!.member).reduce((s, l) => s + l.total, 0);
    expect(wagyu!.value).toBe(itemValue);
    const pickup = d.movers.find((m) => m.dimension === 'channel' && m.member === 'pickup');
    if (pickup) expect(pickup.value).toBe(totals(between(sales, '2026-09-21', '2026-09-27').filter((s) => s.channel === 'pickup')).net_sales);
  });

  it('flags what moved beyond normal variation, says which way, and ranks what moved most', async () => {
    const before = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    // A private function on the Saturday of last week: forty extra pickup orders of one dish at lunch.
    await t.app.tenant(org().orgId, WORKER, async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ledger.recordTransaction(
          ctx,
          sale(`spike-${i}`, `2026-09-26T03:${String(i).padStart(2, '0')}:00Z`, {
            channel: 'pickup',
            source: 'online-order',
            lines: [{ lineNo: 1, name: 'Function platter', category: 'Functions', qty: 1, unitPriceCents: 5900, modifiers: [], discountCents: 0, taxCents: 536, totalCents: 5900 }],
          }),
          { venueId: org().venueId },
        );
      }
    });
    const d = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week' }));
    const orders = d.headline.find((h) => h.metric === 'orders')!;
    expect(orders.value).toBe(before.headline.find((h) => h.metric === 'orders')!.value! + 40);
    expect(orders).toMatchObject({ direction: 'up', reads_as: 'good' });
    expect(['notable', 'strong']).toContain(orders.significance);
    expect(orders.value!).toBeGreaterThan(orders.usual_range![1]);
    expect(d.flagged).toContain('orders');
    expect(d.flagged).toContain('net_sales');
    expect(d.summary).toMatch(/above the usual \$[\d,]+ for these weekdays \((well )?outside normal variation\)/);
    expect(d.summary).toContain('Orders higher than usual:');
    // Identified share fell, because the forty were anonymous: flagged, and read as bad news.
    const identified = d.headline.find((h) => h.metric === 'identified_share')!;
    expect(identified.direction).toBe('down');
    expect(identified.reads_as).toBe('bad');

    const top = d.movers.filter((m) => m.dimension === 'item' && m.direction === 'up')[0]!;
    expect(top).toMatchObject({ member: 'Function platter', metric: 'item_revenue', value: 40 * 5900, baseline: 0, change_abs: 40 * 5900, change_pct: null });
    expect(['notable', 'strong']).toContain(top.significance);
    expect(d.movers.find((m) => m.dimension === 'channel' && m.direction === 'up')!.member).toBe('pickup');
    expect(d.movers.find((m) => m.dimension === 'daypart' && m.direction === 'up')!.member).toBe('lunch');
    expect(d.summary).toContain('Items up most: Function platter (+$2,360)');
  });

  it('says so when there is nothing to measure or too little history, instead of calling it a bad period', async () => {
    // The fixture venue is closed on Mondays.
    const monday = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'day', date: '2026-09-21' }));
    expect(monday.period).toEqual({ kind: 'day', from: '2026-09-21', to: '2026-09-21', complete: true });
    expect(monday.summary).toMatch(/^Monday 21 Sep 2026: no sales were recorded\./);
    expect(monday.caveats.join(' ')).toMatch(/not evidence of a bad period/);
    const aov = monday.headline.find((h) => h.metric === 'avg_order_value')!;
    expect(aov.value).toBeNull();
    expect(aov.caveats.join(' ')).toMatch(/nothing to measure/);
    expect(monday.headline.find((h) => h.metric === 'net_sales')).toMatchObject({ value: 0, baseline: 0, significance: 'normal', direction: 'flat' });
    expect(monday.flagged).not.toContain('net_sales');

    // Two weeks into the venue's recorded history there is nothing to compare with.
    const first = sales[0]!.day;
    const early = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week', date: addDays(first, 14) }));
    const net = early.headline.find((h) => h.metric === 'net_sales')!;
    expect(net.significance).toBe('insufficient_history');
    expect(net.baseline_periods).toBeLessThan(4);
    expect(early.flagged).toEqual([]);
    expect(early.summary).toMatch(/not enough history yet to say what is usual/);
    expect(early.caveats.join(' ')).toMatch(/The baseline uses \d of 8 earlier periods/);

    // A period still in progress is labelled as such; one that has not begun is refused.
    const now = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'week', date: '2026-09-30' }));
    expect(now.period.complete).toBe(false);
    expect(now.caveats.join(' ')).toMatch(/still in progress/);
    await expect(as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'day', date: '2026-10-09' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'year' } as never))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a month is compared with like-for-like slices 35 days apart, and a day with the same weekday', async () => {
    const month = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'month' }));
    expect(month.period).toEqual({ kind: 'month', from: '2026-08-01', to: '2026-08-31', complete: true });
    expect(month.baseline).toMatchObject({ shift_days: 35, earliest_from: addDays('2026-08-01', -280) });
    const aug = totals(between(sales, '2026-08-01', '2026-08-31'));
    const base = Array.from({ length: 8 }, (_, i) => totals(between(sales, addDays('2026-08-01', -35 * (i + 1)), addDays('2026-08-31', -35 * (i + 1)))).net_sales);
    const net = month.headline.find((h) => h.metric === 'net_sales')!;
    expect(net.value).toBe(aug.net_sales);
    expect(net.baseline).toBe(Math.round(mean(base)));
    expect(month.summary.startsWith('Aug 2026: net sales')).toBe(true);

    const day = await as('owner', (ctx) => analytics.computeDigest(ctx, { period: 'day' }));
    expect(day.period).toEqual({ kind: 'day', from: '2026-09-29', to: '2026-09-29', complete: true });
    const tuesdays = Array.from({ length: 8 }, (_, i) => totals(between(sales, addDays('2026-09-29', -7 * (i + 1)), addDays('2026-09-29', -7 * (i + 1)))).net_sales);
    expect(day.headline.find((h) => h.metric === 'net_sales')!.baseline).toBe(Math.round(mean(tuesdays)));
    expect(day.summary).toMatch(/^Tuesday 29 Sep 2026: /);
    expect(day.summary).toMatch(/for this weekday/);
  });

  it('a built digest is stored once per period and read back; rebuilding replaces it', async () => {
    const first = await as('owner', (ctx) => analytics.buildDigest(ctx, { period: 'week', date: '2026-09-09' }));
    expect(first.period).toMatchObject({ from: '2026-09-07', to: '2026-09-13' });
    const row = await t.db.selectFrom('insight_digests').selectAll().where('id', '=', first.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: org().orgId, venue_id: null, period: 'week', period_start: '2026-09-07', period_end: '2026-09-13', summary: first.summary });
    expect((row.payload as { headline: unknown[] }).headline).toEqual(JSON.parse(JSON.stringify(first.headline)));
    expect(row.generated_at.toISOString()).toBe('2026-09-30T02:00:00.000Z');

    t.clock.advanceMinutes(90);
    const again = await as('kitchen', (ctx) => analytics.buildDigest(ctx, { period: 'week', date: '2026-09-13' }));
    expect(again.id).toBe(first.id);
    expect(again.summary).toBe(first.summary);
    const rows = await t.db.selectFrom('insight_digests').select(['id', 'generated_at']).where('org_id', '=', org().orgId).where('period', '=', 'week').where('period_start', '=', '2026-09-07').where('venue_id', 'is', null).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generated_at.toISOString()).toBe('2026-09-30T03:30:00.000Z');

    const listed = await as('owner', (ctx) => analytics.listDigests(ctx, { period: 'week', limit: 3 }));
    expect(listed).toHaveLength(3);
    expect(listed.map((d) => d.period.from)).toEqual([...listed.map((d) => d.period.from)].sort().reverse());
    // The fixture seeder left a month, a day and four weeks behind.
    const kinds = await t.db.selectFrom('insight_digests').select(['period']).where('org_id', '=', org().orgId).execute();
    expect(new Set(kinds.map((k) => k.period))).toEqual(new Set(['day', 'week', 'month']));
    await expect(t.app.tenant(org().orgId, { kind: 'anon' }, (ctx) => analytics.buildDigest(ctx, { period: 'week' }))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('the weekly schedule builds each org\'s digest once, in the first hour after its week ends', async () => {
    // Sunday 4 October, 23:30 in Sydney: the week is not over.
    t.clock.set('2026-10-04T12:30:00Z');
    await tickSchedules(t.app, { only: ['analytics.weekly_digest'] });
    expect(await drainJobs(t.app, { kinds: ['analytics.weekly_digest'] })).toMatchObject({ ran: 2, succeeded: 2 });
    const count = async (from: string) => (await t.db.selectFrom('insight_digests').select(['org_id', 'venue_id']).where('period', '=', 'week').where('period_start', '=', from).execute()).length;
    expect(await count('2026-09-28')).toBe(0);

    // Monday 00:30: the week of 28 September is complete.
    t.clock.set('2026-10-04T13:30:00Z');
    await tickSchedules(t.app, { only: ['analytics.weekly_digest'] });
    await tickSchedules(t.app, { only: ['analytics.weekly_digest'] });
    expect(await drainJobs(t.app, { kinds: ['analytics.weekly_digest'] })).toMatchObject({ ran: 2, succeeded: 2 });
    const built = await t.db.selectFrom('insight_digests').select(['org_id', 'venue_id', 'summary']).where('period', '=', 'week').where('period_start', '=', '2026-09-28').execute();
    // One for the single-venue org; for the group, one for the org and one per venue.
    expect(built.filter((b) => b.org_id === t.fixture.diner.orgId)).toHaveLength(1);
    const group = built.filter((b) => b.org_id === t.fixture.group.orgId);
    expect(group).toHaveLength(4);
    expect(new Set(group.map((b) => b.venue_id))).toEqual(new Set([null, ...Object.values(t.fixture.group.venues).map((v) => v.id)]));
    expect(built.every((b) => b.summary.startsWith('Week of 28 Sep to 4 Oct 2026'))).toBe(true);

    // An hour later the job runs again and leaves them alone.
    const stamps = await t.db.selectFrom('insight_digests').select(['id', 'generated_at']).where('period', '=', 'week').where('period_start', '=', '2026-09-28').orderBy('id').execute();
    t.clock.advanceMinutes(60);
    await tickSchedules(t.app, { only: ['analytics.weekly_digest'] });
    expect(await drainJobs(t.app, { kinds: ['analytics.weekly_digest'] })).toMatchObject({ ran: 2, succeeded: 2 });
    expect(await t.db.selectFrom('insight_digests').select(['id', 'generated_at']).where('period', '=', 'week').where('period_start', '=', '2026-09-28').orderBy('id').execute()).toEqual(stamps);
  });
});
