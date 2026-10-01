import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type CanonicalTransaction, drainJobs, listScheduleDefs, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, identity, ledger, tenancy } from '@ros/modules';
import { WORKER, sale } from './helpers';
import { customers, dayDiff, groupBy, loadSales, sum } from './oracle';

const FACT_TABLES = ['fact_sales_daily', 'fact_sales_hourly', 'fact_item_daily', 'fact_customer', 'fact_events_daily', 'fact_campaign_daily', 'rollup_state'] as const;
const SYD = 'Australia/Sydney';
const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: SYD }).format(d);

describe('analytics: derived facts', () => {
  const t = useTestEnv();
  const record = (orgId: string, venueId: string, txn: CanonicalTransaction, customerId?: string) =>
    t.app.tenant(orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId, customerId }));

  /** Every row of every fact table for an org, in a stable order, including when it was computed. */
  async function snapshot(orgId: string): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of FACT_TABLES) {
      const r = await sql<{ j: unknown }>`select to_jsonb(x) as j from ${sql.table(table)} x where x.org_id = ${orgId} order by to_jsonb(x)::text`.execute(t.db);
      out[table] = r.rows.map((x) => x.j);
    }
    return out;
  }

  beforeAll(async () => {
    for (const org of [t.fixture.diner, t.fixture.group]) await analytics.rollup(t.app, org.orgId);
  });
  beforeEach(() => t.clock.set('2026-09-30T02:00:00Z'));

  it('the sales facts equal the ledger, row for row, for both orgs', async () => {
    for (const org of [t.fixture.diner, t.fixture.group]) {
      const sales = await loadSales(t.db, org.orgId);
      const daily = await t.db.selectFrom('fact_sales_daily').selectAll().where('org_id', '=', org.orgId).execute();
      const want = groupBy(sales, (s) => `${s.venueId}|${s.day}|${s.channel}|${s.source}`);
      expect(daily.length).toBe(want.size);
      expect(daily.length).toBeGreaterThan(400);
      for (const f of daily) {
        const list = want.get(`${f.venue_id}|${f.day}|${f.channel}|${f.source}`)!;
        expect(list, `${f.day} ${f.channel}`).toBeDefined();
        expect({
          orders: f.orders,
          gross: f.gross_cents,
          net: f.net_cents,
          discount: f.discount_cents,
          tax: f.tax_cents,
          tip: f.tip_cents,
          refunded: f.refunded_cents,
          items: Number(f.items),
          identified: f.identified_orders,
          identifiedGross: f.identified_gross_cents,
          fresh: f.new_customer_orders,
          returning: f.returning_customer_orders,
          refundedOrders: f.refunded_orders,
          discountedOrders: f.discounted_orders,
        }).toEqual({
          orders: list.length,
          gross: sum(list, (s) => s.total),
          net: sum(list, (s) => s.net),
          discount: sum(list, (s) => s.discount),
          tax: sum(list, (s) => s.tax),
          tip: sum(list, (s) => s.tip),
          refunded: sum(list, (s) => s.refunded),
          items: sum(list, (s) => s.items),
          identified: list.filter((s) => s.customerId).length,
          identifiedGross: sum(list.filter((s) => s.customerId), (s) => s.total),
          fresh: list.filter((s) => s.rank === 1).length,
          returning: list.filter((s) => s.rank > 1).length,
          refundedOrders: list.filter((s) => s.refunded > 0).length,
          discountedOrders: list.filter((s) => s.discount > 0).length,
        });
      }

      const hourly = await t.db.selectFrom('fact_sales_hourly').selectAll().where('org_id', '=', org.orgId).execute();
      const byHour = groupBy(sales, (s) => `${s.venueId}|${s.day}|${s.hour}`);
      expect(hourly.length).toBe(byHour.size);
      for (const f of hourly) {
        const list = byHour.get(`${f.venue_id}|${f.day}|${f.hour}`)!;
        expect([f.orders, f.gross_cents, f.net_cents, f.refunded_cents, Number(f.items)]).toEqual([list.length, sum(list, (s) => s.total), sum(list, (s) => s.net), sum(list, (s) => s.refunded), sum(list, (s) => s.items)]);
      }
    }
  });

  it('the item facts equal the ledger lines', async () => {
    const org = t.fixture.group;
    const sales = await loadSales(t.db, org.orgId);
    const lines = sales.flatMap((s) => s.lines.map((l) => ({ ...l, venueId: s.venueId, day: s.day, saleId: s.id })));
    const facts = await t.db.selectFrom('fact_item_daily').selectAll().where('org_id', '=', org.orgId).execute();
    const want = groupBy(lines, (l) => `${l.venueId}|${l.day}|${l.name}|${l.category}`);
    const got = groupBy(facts, (f) => `${f.venue_id}|${f.day}|${f.item_name}|${f.category}`);
    expect(got.size).toBe(want.size);
    for (const [key, rows] of got) {
      const list = want.get(key)!;
      expect([sum(rows, (f) => Number(f.qty)), sum(rows, (f) => f.revenue_cents), sum(rows, (f) => f.orders)], key).toEqual([sum(list, (l) => l.qty), sum(list, (l) => l.total), new Set(list.map((l) => l.saleId)).size]);
    }
  });

  it('the customer snapshot equals the ledger: orders, spend, dates, recency, segment, and RFM scores in range', async () => {
    for (const org of [t.fixture.diner, t.fixture.group]) {
      const want = new Map(customers(await loadSales(t.db, org.orgId), '2026-09-30').map((c) => [c.customerId, c]));
      const facts = await t.db.selectFrom('fact_customer').selectAll().where('org_id', '=', org.orgId).execute();
      expect(facts.length).toBe(want.size);
      for (const f of facts) {
        const c = want.get(f.customer_id)!;
        expect({
          orders: f.orders,
          spend: f.spend_cents,
          first: f.first_order_day,
          last: f.last_order_day,
          toSecond: f.days_to_second_order,
          recency: f.recency_days,
          segment: f.segment,
          avg: f.avg_order_cents,
        }).toEqual({
          orders: c.orders,
          spend: c.spend,
          first: c.firstDay,
          last: c.lastDay,
          toSecond: c.secondDay ? dayDiff(c.firstDay, c.secondDay) : null,
          recency: dayDiff(c.lastDay, '2026-09-30'),
          segment: c.segment,
          avg: Math.round(c.spend / c.orders),
        });
        for (const score of [f.r_score, f.f_score, f.m_score]) expect(score! >= 1 && score! <= 5).toBe(true);
      }
      const segments = new Set(facts.map((f) => f.segment));
      for (const s of ['new', 'one_timer', 'repeater', 'at_risk', 'lapsed']) expect(segments.has(s), s).toBe(true);
      // The best customers score highest on frequency and spend.
      const loyal = facts.filter((f) => f.orders >= 10);
      expect(loyal.length).toBeGreaterThan(0);
      for (const f of loyal) expect([f.f_score, f.m_score]).toEqual([5, 5]);
    }
  });

  it('the event and campaign facts equal the event stream, the sessions, the customers and the attributions', async () => {
    const org = t.fixture.diner;
    const events = await t.db.selectFrom('events').select(['name', 'occurred_at', 'venue_id', 'utm_source', 'creator_id', 'campaign_id']).where('org_id', '=', org.orgId).execute();
    const wantEvents = groupBy(events, (e) => `${e.venue_id ?? '00000000-0000-0000-0000-000000000000'}|${localDay(e.occurred_at)}|${e.name}|${e.utm_source ?? ''}|${e.creator_id ?? ''}|${e.campaign_id ?? ''}`);
    const eventFacts = await t.db.selectFrom('fact_events_daily').selectAll().where('org_id', '=', org.orgId).execute();
    expect(eventFacts.length).toBe(wantEvents.size);
    for (const f of eventFacts) expect(f.events).toBe(wantEvents.get(`${f.venue_key}|${f.day}|${f.name}|${f.utm_source}|${f.creator_id}|${f.campaign_id}`)!.length);
    expect(sum(eventFacts, (f) => f.events)).toBe(events.length);

    const facts = await t.db.selectFrom('fact_campaign_daily').selectAll().where('org_id', '=', org.orgId).execute();
    const sessions = await t.db.selectFrom('visitor_sessions').select(['id']).where('org_id', '=', org.orgId).execute();
    const newCustomers = await t.db.selectFrom('customers').select(['id', 'acquisition_campaign_id', 'acquisition_creator_id']).where('org_id', '=', org.orgId).where('status', '=', 'active').execute();
    expect(sum(facts, (f) => f.sessions)).toBe(sessions.length);
    expect(sum(facts, (f) => f.new_customers)).toBe(newCustomers.length);
    const sales = await loadSales(t.db, org.orgId);
    const byId = new Map(sales.map((s) => [s.id, s]));
    const attributions = (await t.db.selectFrom('transaction_attributions').select(['transaction_id', 'campaign_id', 'creator_id']).where('org_id', '=', org.orgId).where('model', '=', 'acquisition').execute()).filter((a) => byId.has(a.transaction_id));
    expect(attributions.length).toBeGreaterThan(100);
    expect(sum(facts, (f) => f.orders)).toBe(attributions.length);
    expect(sum(facts, (f) => f.revenue_cents)).toBe(sum(attributions, (a) => byId.get(a.transaction_id)!.total - byId.get(a.transaction_id)!.refunded));
    expect(sum(facts, (f) => f.repeat_orders)).toBe(attributions.filter((a) => byId.get(a.transaction_id)!.rank > 1).length);
    // One campaign and creator, end to end.
    const pick = (f: { campaign_id: string; creator_id: string }) => f.campaign_id === 'camp_winter_steak' && f.creator_id === 'creator_wagyu_wes';
    const mine = facts.filter(pick);
    const mineAttr = attributions.filter((a) => a.campaign_id === 'camp_winter_steak' && a.creator_id === 'creator_wagyu_wes');
    expect(sum(mine, (f) => f.new_customers)).toBe(newCustomers.filter((c) => c.acquisition_campaign_id === 'camp_winter_steak' && c.acquisition_creator_id === 'creator_wagyu_wes').length);
    expect(sum(mine, (f) => f.orders)).toBe(mineAttr.length);
    expect(sum(mine, (f) => f.orders)).toBeGreaterThan(0);
  });

  it('a query answered from the facts equals the same query answered from the ledger', async () => {
    const queries: analytics.MetricQuery[] = [
      { metrics: ['gross_sales', 'net_sales', 'orders', 'avg_order_value', 'items_sold', 'items_per_order', 'refunds', 'refund_rate', 'discounts', 'discount_rate', 'tips', 'tax'], period: 'last_90_days', compareTo: 'previous_period' },
      { metrics: ['net_sales', 'orders', 'identified_share', 'new_customer_orders', 'returning_customer_orders'], dimensions: ['venue', 'channel'], grain: 'week', period: 'last_90_days' },
      { metrics: ['net_sales', 'orders', 'tips'], dimensions: ['source', 'day_of_week'], period: 'last_365_days' },
      { metrics: ['net_sales', 'orders', 'avg_order_value', 'items_per_order'], dimensions: ['daypart', 'hour'], period: 'last_28_days', compareTo: 'same_period_last_year' },
      { metrics: ['net_sales', 'refunds'], dimensions: ['hour'], filters: { day_of_week: 'saturday' }, grain: 'month', period: 'last_365_days' },
      { metrics: ['item_revenue', 'item_quantity', 'item_revenue_share', 'item_quantity_share'], dimensions: ['item', 'venue'], period: 'last_90_days' },
      { metrics: ['item_revenue', 'item_quantity'], dimensions: ['category'], grain: 'month', period: 'last_365_days' },
      { metrics: ['customers_total', 'repeat_rate', 'one_timer_share', 'median_days_to_second_order', 'customer_lifetime_value', 'avg_orders_per_customer', 'avg_recency_days'], dimensions: ['segment'], period: 'today' },
      { metrics: ['customers_total', 'customer_share', 'customer_spend_share'], dimensions: ['acquisition_source'], period: 'today' },
      { metrics: ['web_sessions'], dimensions: ['utm_source', 'campaign'], grain: 'week', period: 'last_90_days' },
      { metrics: ['event_count'], dimensions: ['event_name'], period: 'last_28_days' },
    ];
    for (const org of [t.fixture.diner, t.fixture.group]) {
      const owner = await org.as('owner');
      for (const query of queries) {
        const [fromLedger, fromFacts] = await t.app.tenant(org.orgId, owner, async (ctx) => [
          await analytics.queryMetrics(ctx, { ...query, source: 'ledger' }),
          await analytics.queryMetrics(ctx, { ...query, source: 'facts' }),
        ]);
        const label = JSON.stringify(query);
        expect(fromLedger!.sources.every((s) => s.read_from === 'ledger'), label).toBe(true);
        expect(fromFacts!.sources.every((s) => s.read_from === 'facts'), label).toBe(true);
        expect(fromFacts!.rows, label).toEqual(fromLedger!.rows);
        expect(fromFacts!.totals, label).toEqual(fromLedger!.totals);
        expect(fromFacts!.rows.length, label).toBeGreaterThan(0);
      }
    }
  });

  it('re-running the roll-ups changes nothing: not a value, not a timestamp', async () => {
    const org = t.fixture.diner;
    const before = await snapshot(org.orgId);
    expect(before.fact_sales_daily!.length).toBeGreaterThan(400);
    t.clock.advanceMinutes(7);
    const again = await analytics.rollup(t.app, org.orgId);
    expect(again.daysChanged).toEqual([]);
    expect(again.customersSnapshot).toBe(false);
    expect(await snapshot(org.orgId)).toEqual(before);
    const reconcile = await analytics.rollup(t.app, org.orgId, { mode: 'reconcile' });
    expect(reconcile.daysChanged).toEqual([]);
    const full = await analytics.backfill(t.app, org.orgId);
    expect(full.daysExamined).toBeGreaterThan(400);
    expect(full.daysChanged).toEqual([]);
    expect(full.customersChanged).toBe(0);
    expect(await snapshot(org.orgId)).toEqual(before);
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('a refund that arrives later re-rolls the day of the sale, and only that day', async () => {
    const org = t.fixture.diner;
    const owner = await org.as('owner');
    const day = '2026-08-13';
    const ask = (source: 'auto' | 'facts' = 'auto') =>
      t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders', 'gross_sales', 'net_sales', 'refunds', 'refunded_orders'], period: { from: day, to: day }, source }));

    // A sale back-dated to a past Thursday evening arrives late.
    const start = await ask();
    await record(org.orgId, org.venueId, sale('late-1', '2026-08-13T09:30:00Z'));
    expect((await t.app.tenant(org.orgId, owner, (ctx) => analytics.factsState(ctx))).salesFresh).toBe(false);
    // Before any roll-up the answer is already right, because it is read from the ledger …
    const live = await ask();
    expect(live.sources[0]!.read_from).toBe('ledger');
    expect(live.totals.values.orders).toBe(start.totals.values.orders! + 1);
    // … and the facts, asked for by name, admit they are behind.
    const stale = await ask('facts');
    expect(stale.totals.values.orders).toBe(start.totals.values.orders);
    expect(stale.caveats.join(' ')).toMatch(/behind the ledger/);

    t.clock.advanceMinutes(20);
    const rolled = await analytics.rollup(t.app, org.orgId);
    expect(rolled.daysChanged).toEqual([day]);
    const afterSale = await ask();
    expect(afterSale.sources[0]!.read_from).toBe('facts');
    expect(afterSale.totals.values).toEqual({ ...live.totals.values });
    expect(afterSale.totals.values.net_sales).toBe(start.totals.values.net_sales! + (5900 - 536));
    const beforeRefund = await snapshot(org.orgId);

    // Two weeks later the guest is refunded in full.
    t.clock.advanceDays(14);
    const refunded = await record(org.orgId, org.venueId, sale('late-1', '2026-08-13T09:30:00Z', { status: 'refunded', refundedCents: 5900 }));
    expect(refunded).toMatchObject({ created: false, changed: true });
    const rerolled = await analytics.rollup(t.app, org.orgId);
    // The day of the sale, and the day of the refund itself, which gained a "transaction.refunded" event.
    expect(rerolled.daysChanged).toEqual([day, '2026-10-14']);
    const afterRefund = await ask();
    expect(afterRefund.sources[0]!.read_from).toBe('facts');
    expect(afterRefund.totals.values).toEqual({
      orders: afterSale.totals.values.orders,
      gross_sales: afterSale.totals.values.gross_sales,
      net_sales: start.totals.values.net_sales,
      refunds: afterSale.totals.values.refunds! + 5900,
      refunded_orders: afterSale.totals.values.refunded_orders! + 1,
    });

    // Read back: only that day's rows were rewritten, and its roll-up marker moved.
    const after = await snapshot(org.orgId);
    type Row = { day: string; computed_at: string; rollup?: string };
    const touched = (table: string) => {
      const was = new Set((beforeRefund[table] as Row[]).map((b) => JSON.stringify(b)));
      return (after[table] as Row[]).filter((r) => !was.has(JSON.stringify(r)));
    };
    expect(new Set(touched('fact_sales_daily').map((r) => r.day))).toEqual(new Set([day]));
    expect(new Set(touched('fact_sales_hourly').map((r) => r.day))).toEqual(new Set([day]));
    expect(touched('fact_item_daily')).toEqual([]);
    expect((touched('fact_events_daily') as Array<Row & { name: string; events: number }>).map((r) => [r.day, r.name, r.events])).toEqual([['2026-10-14', 'transaction.refunded', 1]]);
    const marker = await t.db.selectFrom('rollup_state').select(['computed_at']).where('org_id', '=', org.orgId).where('rollup', '=', 'daily').where('day', '=', day).executeTakeFirstOrThrow();
    expect(marker.computed_at.toISOString()).toBe(t.clock().toISOString());
    const other = await t.db.selectFrom('rollup_state').select(['computed_at']).where('org_id', '=', org.orgId).where('rollup', '=', 'daily').where('day', '=', '2026-08-14').executeTakeFirstOrThrow();
    expect(other.computed_at.getTime()).toBeLessThan(marker.computed_at.getTime());

    // A voided sale stops counting altogether.
    await record(org.orgId, org.venueId, sale('late-1', '2026-08-13T09:30:00Z', { status: 'voided', refundedCents: 5900 }));
    expect((await analytics.rollup(t.app, org.orgId)).daysChanged).toEqual([day]);
    expect((await ask()).totals.values).toEqual(start.totals.values);
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('a customer linked to an older sale later moves "new" and "returning" on their other days too', async () => {
    const org = t.fixture.diner;
    const guest = await t.app.tenant(org.orgId, WORKER, (ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'late.link@example.com' }], via: 'pos', venueId: org.venueId }));
    await record(org.orgId, org.venueId, sale('link-anon', '2026-07-02T02:30:00Z'));
    await record(org.orgId, org.venueId, sale('link-known', '2026-07-09T02:30:00Z'), guest.customerId!);
    await analytics.rollup(t.app, org.orgId);
    const read = async (day: string) => {
      const rows = await t.db.selectFrom('fact_sales_daily').select(['new_customer_orders', 'returning_customer_orders', 'identified_orders']).where('org_id', '=', org.orgId).where('day', '=', day).execute();
      return { fresh: sum(rows, (r) => r.new_customer_orders), returning: sum(rows, (r) => r.returning_customer_orders), identified: sum(rows, (r) => r.identified_orders) };
    };
    const first = { a: await read('2026-07-02'), b: await read('2026-07-09') };
    // The earlier sale turns out to be the same guest.
    await record(org.orgId, org.venueId, sale('link-anon', '2026-07-02T02:30:00Z'), guest.customerId!);
    const rolled = await analytics.rollup(t.app, org.orgId);
    expect(rolled.daysChanged).toEqual(['2026-07-02', '2026-07-09']);
    expect(await read('2026-07-02')).toEqual({ fresh: first.a.fresh + 1, returning: first.a.returning, identified: first.a.identified + 1 });
    expect(await read('2026-07-09')).toEqual({ fresh: first.b.fresh - 1, returning: first.b.returning + 1, identified: first.b.identified });
    const snap = await t.db.selectFrom('fact_customer').select(['orders', 'first_order_day', 'segment']).where('customer_id', '=', guest.customerId!).executeTakeFirstOrThrow();
    expect(snap).toEqual({ orders: 2, first_order_day: '2026-07-02', segment: 'at_risk' });
  });

  it('a back-fill rebuilds everything from nothing, and a partial one does not claim to be complete', async () => {
    const org = t.fixture.group;
    await analytics.rollup(t.app, org.orgId);
    const before = await snapshot(org.orgId);
    const strip = (rows: unknown[]) => rows.map((r) => ({ ...(r as object), computed_at: null }));
    for (const table of FACT_TABLES) await sql`delete from ${sql.table(table)} where org_id = ${org.orgId}`.execute(t.db);
    const owner = await org.as('owner');
    expect((await t.app.tenant(org.orgId, owner, (ctx) => analytics.factsState(ctx))).cursor).toBeNull();
    // With no facts at all, a question is still answered, from the ledger.
    const cold = await t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales'], period: 'last_28_days' }));
    expect(cold.sources[0]!.read_from).toBe('ledger');
    expect(cold.totals.values.net_sales).toBeGreaterThan(0);

    const part = await analytics.backfill(t.app, org.orgId, { from: '2026-09-01', to: '2026-09-30', chunkDays: 7 });
    expect(part.daysExamined).toBeGreaterThan(20);
    expect((await t.app.tenant(org.orgId, owner, (ctx) => analytics.factsState(ctx))).salesFresh).toBe(false);

    const full = await analytics.backfill(t.app, org.orgId, { chunkDays: 50 });
    expect(full.daysExamined).toBeGreaterThan(400);
    const after = await snapshot(org.orgId);
    for (const table of FACT_TABLES.filter((x) => x !== 'rollup_state')) expect(strip(after[table]!), table).toEqual(strip(before[table]!));
    expect((await t.app.tenant(org.orgId, owner, (ctx) => analytics.factsState(ctx)))).toMatchObject({ salesFresh: true, customersFresh: true, customersAsOf: '2026-09-30' });
    const warm = await t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales'], period: 'last_28_days' }));
    expect(warm.sources[0]!.read_from).toBe('facts');
    expect(warm.totals.values).toEqual(cold.totals.values);
  });

  it('the snapshot is retaken when the day changes, because recency moves', async () => {
    const org = t.fixture.diner;
    await analytics.rollup(t.app, org.orgId);
    t.clock.set('2026-10-01T02:00:00Z');
    const next = await analytics.rollup(t.app, org.orgId);
    expect(next.customersSnapshot).toBe(true);
    expect(next.customersChanged).toBeGreaterThan(300);
    const state = await t.app.tenant(org.orgId, WORKER, (ctx) => analytics.factsState(ctx));
    expect(state).toMatchObject({ customersAsOf: '2026-10-01', customersFresh: true });
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('the customer snapshot follows the person: erased at once, folded on a merge, and part of their own export', async () => {
    const org = t.fixture.diner;
    const owner = await org.as('owner');
    const mk = (tag: string) =>
      t.app.tenant(org.orgId, WORKER, async (ctx) => {
        const r = await identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: `${tag}@snapshot.example` }], via: 'pos', venueId: org.venueId });
        await ledger.recordTransaction(ctx, sale(`snap-${tag}-1`, '2026-09-10T03:00:00Z'), { venueId: org.venueId, customerId: r.customerId! });
        await ledger.recordTransaction(ctx, sale(`snap-${tag}-2`, '2026-09-17T03:00:00Z'), { venueId: org.venueId, customerId: r.customerId! });
        return r.customerId!;
      });
    const [a, b, c] = [await mk('a'), await mk('b'), await mk('c')];
    await analytics.rollup(t.app, org.orgId);
    const rows = () => t.db.selectFrom('fact_customer').select(['customer_id', 'orders', 'segment']).where('customer_id', 'in', [a, b, c]).orderBy('orders').execute();
    expect(await rows()).toHaveLength(3);

    // What a guest is given when they ask for their data includes the summary held about them.
    const exported = await t.app.tenant(org.orgId, owner, (ctx) => identity.exportCustomer(ctx, a));
    expect(exported.analytics).toMatchObject({ orders: 2, spendCents: 11800, firstOrderOn: '2026-09-10', lastOrderOn: '2026-09-17', daysToSecondOrder: 7, segment: 'repeater' });

    // Erasing a guest removes their snapshot row in the same transaction, not at the next roll-up.
    await t.app.tenant(org.orgId, owner, (ctx) => identity.eraseCustomer(ctx, a));
    expect((await rows()).map((r) => r.customer_id).sort()).toEqual([b, c].sort());
    // Their sales stay in the ledger, now anonymous, and the facts follow at the next roll-up.
    const day = async () => (await t.db.selectFrom('fact_sales_daily').select((eb) => eb.fn.sum<number>('identified_orders').as('n')).where('org_id', '=', org.orgId).where('day', '=', '2026-09-10').executeTakeFirstOrThrow()).n;
    const before = Number(await day());
    expect((await analytics.rollup(t.app, org.orgId)).daysChanged).toEqual(expect.arrayContaining(['2026-09-10', '2026-09-17']));
    expect(Number(await day())).toBe(before - 1);

    // Merging two records leaves one snapshot row, holding the combined history.
    await t.app.tenant(org.orgId, owner, (ctx) => identity.mergeCustomers(ctx, { winnerId: b, loserId: c, reason: 'same person' }));
    expect((await rows()).map((r) => r.customer_id)).toEqual([b]);
    await analytics.rollup(t.app, org.orgId);
    expect(await rows()).toEqual([{ customer_id: b, orders: 4, segment: 'repeater' }]);
  });

  it('a change to the segment rules or to a venue\'s time zone makes the facts stale until they are rebuilt', async () => {
    const org = t.fixture.diner;
    const owner = await org.as('owner');
    await analytics.rollup(t.app, org.orgId);
    const segments = (source: 'auto' | 'ledger') =>
      t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['customers_total'], dimensions: ['segment'], period: 'today', source }));
    const first = await segments('auto');
    expect(first.sources[0]!.read_from).toBe('facts');

    // Tighten "loyal" from ten orders to four: the stored snapshot no longer matches the rules.
    await t.app.tenant(org.orgId, owner, (ctx) => analytics.setAnalyticsSettings(ctx, { segments: { newWindowDays: 30, atRiskDays: 60, lapsedDays: 120, frequentOrders: 3, loyalOrders: 4 } }));
    const changed = await segments('auto');
    expect(changed.sources[0]!.read_from).toBe('ledger');
    const loyal = (r: typeof first) => r.rows.find((x) => x.dimensions.segment === 'loyal')!.values.customers_total!;
    expect(loyal(changed)).toBeGreaterThan(loyal(first));
    const rolled = await analytics.rollup(t.app, org.orgId);
    expect(rolled.customersSnapshot).toBe(true);
    const after = await segments('auto');
    expect(after.sources[0]!.read_from).toBe('facts');
    expect(after.rows).toEqual(changed.rows);

    // Move the venue to Perth: every local day boundary shifts by two or three hours.
    const sales = () => t.app.tenant(org.orgId, owner, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders', 'net_sales'], grain: 'day', period: { from: '2026-09-01', to: '2026-09-29' } }));
    const sydney = await sales();
    expect(sydney.sources[0]!.read_from).toBe('facts');
    await t.app.tenant(org.orgId, owner, (ctx) => tenancy.updateVenue(ctx, org.venueId, { timezone: 'Australia/Perth' }));
    expect(await t.app.tenant(org.orgId, owner, (ctx) => analytics.factsState(ctx))).toMatchObject({ frameOk: false, salesFresh: false });
    const perth = await sales();
    expect(perth.sources[0]!.read_from).toBe('ledger');
    expect(perth.period.timezone).toBe('Australia/Perth');
    const rebuilt = await analytics.rollup(t.app, org.orgId);
    expect(rebuilt.mode).toBe('backfill');
    const again = await sales();
    expect(again.sources[0]!.read_from).toBe('facts');
    expect(again.rows).toEqual(perth.rows);
    expect(again.totals.values.orders).toBe(perth.totals.values.orders);
  });

  it('only a background job may rebuild facts; an owner asks for one', async () => {
    const org = t.fixture.diner;
    const owner = await org.as('owner');
    const manager = await org.as('manager');
    await expect(t.app.tenant(org.orgId, owner, (ctx) => analytics.rollupDays(ctx, ['2026-09-01']))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(org.orgId, owner, (ctx) => analytics.snapshotCustomers(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(org.orgId, manager, (ctx) => analytics.requestBackfill(ctx))).rejects.toMatchObject({ code: 'forbidden' });
    await t.app.tenant(org.orgId, owner, (ctx) => analytics.requestBackfill(ctx, { from: '2026-09-01' }));
    const queued = await t.db.selectFrom('jobs').select(['kind', 'payload', 'status']).where('org_id', '=', org.orgId).where('kind', '=', 'analytics.backfill').execute();
    expect(queued).toEqual([{ kind: 'analytics.backfill', payload: { from: '2026-09-01' }, status: 'queued' }]);
    expect(await drainJobs(t.app, { kinds: ['analytics.backfill'] })).toMatchObject({ ran: 1, succeeded: 1 });
  });

  it('the schedules enqueue one roll-up per org per window, and the jobs run clean', async () => {
    const keys = listScheduleDefs().map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(['analytics.rollup', 'analytics.reconcile', 'analytics.weekly_digest', 'analytics.benchmarks']));
    await tickSchedules(t.app, { only: ['analytics.rollup', 'analytics.reconcile'] });
    await tickSchedules(t.app, { only: ['analytics.rollup', 'analytics.reconcile'] });
    const jobs = await t.db.selectFrom('jobs').select(['org_id', 'payload']).where('kind', '=', 'analytics.rollup').where('status', '=', 'queued').execute();
    expect(jobs).toHaveLength(4);
    expect(new Set(jobs.map((j) => j.org_id))).toEqual(new Set([t.fixture.diner.orgId, t.fixture.group.orgId]));
    expect(jobs.map((j) => (j.payload as { mode: string }).mode).sort()).toEqual(['incremental', 'incremental', 'reconcile', 'reconcile']);
    expect(await drainJobs(t.app, { kinds: ['analytics.rollup'] })).toMatchObject({ ran: 4, succeeded: 4, failed: 0, dead: 0 });
  });
});
