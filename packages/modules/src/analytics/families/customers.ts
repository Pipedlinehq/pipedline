import { type RawBuilder, sql } from 'kysely';
import { type FetchArgs, type FetchResult, type Measures, SALE_STATUSES, bucketSql, inList, rowKey, runGrouped } from '../engine';
import { customersSignature, factsState } from '../freshness';
import { type Grain, bucketStart, bucketsOf } from '../period';
import type { AnalyticsSettings } from '../settings';

/**
 * What is known about each identified customer as of a venue-local day, from the ledger alone:
 * counted sales tied to a customer, within the venues given. The same statement fills the
 * fact_customer snapshot (whole org, as of today) and answers customer questions for any
 * venue set and any past day. A sale with no customer is not in here at all, which is why
 * every customer metric carries the identified-share caveat.
 *
 *   recency     whole days from the last order's venue-local date to the as-of date
 *   R score     5: within 30 days · 4: 60 · 3: 90 · 2: 180 · 1: longer
 *   F score     1: one order · 2: two · 3: three or four · 4: five to nine · 5: ten or more
 *   M score     spend quintile among these customers (5 = the top fifth)
 *   segment     one order: new (inside the new window) or one_timer;
 *               two or more: lapsed, at_risk, else loyal, frequent or repeater by order count
 */
export interface SnapshotArgs {
  orgId: string;
  venueIds: string[];
  asOf: string;
  settings: AnalyticsSettings;
}

export function customerCtes(a: SnapshotArgs): RawBuilder<unknown>[] {
  const s = a.settings.segments;
  return [
    sql`a_ctx as (
      select t.customer_id, t.id, t.occurred_at, t.venue_id, t.channel,
             (t.occurred_at at time zone v.timezone)::date as day,
             (t.total_cents - t.refunded_cents)::bigint as spend_cents,
             row_number() over (partition by t.customer_id order by t.occurred_at, t.id) as rn,
             min((t.occurred_at at time zone v.timezone)::date) over (partition by t.customer_id) as first_day
      from transactions t
      join venues v on v.id = t.venue_id
      where t.org_id = ${a.orgId} and t.venue_id = any(${a.venueIds}::uuid[])
        and t.customer_id is not null and t.status in ${sql.raw(SALE_STATUSES)}
        and (t.occurred_at at time zone v.timezone)::date <= ${a.asOf}::date
    )`,
    sql`a_snap as (
      select x.customer_id,
             count(*)::int as orders,
             sum(x.spend_cents)::bigint as spend_cents,
             min(x.occurred_at) as first_order_at,
             min(x.occurred_at) filter (where x.rn = 2) as second_order_at,
             max(x.occurred_at) as last_order_at,
             min(x.day) as first_order_day,
             min(x.day) filter (where x.rn = 2) as second_order_day,
             max(x.day) as last_order_day,
             mode() within group (order by x.channel) as favourite_channel,
             mode() within group (order by x.venue_id) as favourite_venue_id
      from a_ctx x
      group by x.customer_id
    )`,
    sql`a_scored as (
      select n.*,
             round(n.spend_cents::numeric / n.orders)::int as avg_order_cents,
             (n.second_order_day - n.first_order_day)::int as days_to_second_order,
             (${a.asOf}::date - n.last_order_day)::int as recency_days,
             (case when ${a.asOf}::date - n.last_order_day <= 30 then 5
                   when ${a.asOf}::date - n.last_order_day <= 60 then 4
                   when ${a.asOf}::date - n.last_order_day <= 90 then 3
                   when ${a.asOf}::date - n.last_order_day <= 180 then 2 else 1 end)::smallint as r_score,
             (case when n.orders >= 10 then 5 when n.orders >= 5 then 4 when n.orders >= 3 then 3
                   when n.orders = 2 then 2 else 1 end)::smallint as f_score,
             ntile(5) over (order by n.spend_cents, n.customer_id)::smallint as m_score,
             (case
                when n.orders = 1 and ${a.asOf}::date - n.last_order_day <= ${s.newWindowDays}::int then 'new'
                when n.orders = 1 then 'one_timer'
                when ${a.asOf}::date - n.last_order_day > ${s.lapsedDays}::int then 'lapsed'
                when ${a.asOf}::date - n.last_order_day > ${s.atRiskDays}::int then 'at_risk'
                when n.orders >= ${s.loyalOrders}::int then 'loyal'
                when n.orders >= ${s.frequentOrders}::int then 'frequent'
                else 'repeater' end) as segment
      from a_snap n
    )`,
  ];
}

export const SEGMENTS = ['new', 'one_timer', 'repeater', 'frequent', 'loyal', 'at_risk', 'lapsed'] as const;

const BASE_DIMS: Record<string, string> = { segment: 'r.segment', acquisition_source: 'r.acquisition_source' };

/** The customer base as of the end of the period: counts, repeat, lifetime spend, segments. */
export async function fetchCustomerBase(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const asOf = a.to > scope.today ? scope.today : a.to;
  const caveats: string[] = [];
  let path: 'ledger' | 'facts' = 'ledger';
  if (a.source !== 'ledger' && scope.all && asOf === scope.today) {
    const state = await factsState(ctx);
    if (state.customersSignature === customersSignature(asOf, a.settings) && (a.source === 'facts' || state.customersFresh)) {
      path = 'facts';
      if (!state.customersFresh) caveats.push('Served from a customer snapshot that is behind the ledger.');
    }
  }
  if (a.source === 'facts' && path !== 'facts') caveats.push('The customer snapshot describes the whole org as of today; this question needed the ledger.');
  if (!scope.all) caveats.push('Customer figures are counted within the selected venues only: a guest\'s visits to other venues are not included.');

  const ctes: RawBuilder<unknown>[] =
    path === 'facts'
      ? [sql`a_scored as (
          select f.customer_id, f.orders, f.spend_cents, f.days_to_second_order, f.recency_days, f.segment
          from fact_customer f
          where f.org_id = ${ctx.orgId}
        )`]
      : customerCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, asOf, settings: a.settings });
  ctes.push(sql`a_base as (
    select s.customer_id, s.orders, s.spend_cents, s.days_to_second_order, s.recency_days, s.segment, c.acquisition_source
    from a_scored s
    join customers c on c.id = s.customer_id
  )`);

  const aggs = {
    customers: 'count(*)',
    repeaters: 'count(*) filter (where orders >= 2)',
    one_timers: 'count(*) filter (where orders = 1)',
    spend: 'sum(spend_cents)',
    cust_orders: 'sum(orders)',
    median_days_to_second: 'percentile_cont(0.5) within group (order by days_to_second_order)',
    second_timers: 'count(days_to_second_order)',
    avg_recency: 'avg(recency_days)',
  };
  const where = Object.entries(a.filters).map(([k, v]) => inList(`(${BASE_DIMS[k]})::text`, v));
  const g = await runGrouped(ctx, { ctes, relation: 'a_base', bucket: null, dims: a.dims.map((d) => ({ key: d, expr: BASE_DIMS[d]! })), where, aggs });

  if (a.measures.has('total_customers') || a.measures.has('total_spend')) {
    // Shares are of the whole base in scope, whatever was filtered or split.
    const t = await runGrouped(ctx, { ctes, relation: 'a_base', bucket: null, dims: [], where: [], aggs });
    const whole = (m: Measures) => {
      m.total_customers = t.totals.customers ?? null;
      m.total_spend = t.totals.spend ?? null;
    };
    g.rows.forEach((r) => whole(r.m));
    whole(g.totals);
  }

  return {
    rows: g.rows,
    totals: g.totals,
    path,
    tables: path === 'facts' ? ['fact_customer', 'customers'] : ['transactions', 'customers', 'venues'],
    sourceRows: { customers: g.sourceRows },
    caveats,
  };
}

/** Customers active in the period, split into new (first ever order in it) and returning. */
export async function fetchCustomerFlows(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const bucketOfDay = bucketSql('x.day', a.grain);
  const bucketOfFirst = bucketSql('first_day', a.grain);
  const ctes = [
    customerCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, asOf: a.to, settings: a.settings })[0]!,
    sql`a_active as (
      select distinct x.customer_id, ${sql.raw(bucketOfDay ?? 'null::date')} as act_bucket, x.first_day, c.acquisition_source
      from a_ctx x
      join customers c on c.id = x.customer_id
      where x.day between ${a.from}::date and ${a.to}::date
    )`,
  ];
  const dimSql: Record<string, string> = { acquisition_source: 'r.acquisition_source' };
  // a.from is a validated YYYY-MM-DD; aggregates cannot take bound values, so it is written in.
  const fromLit = `'${a.from.replace(/[^0-9-]/g, '')}'::date`;
  const newTest = bucketOfFirst ? `first_day >= ${fromLit} and ${bucketOfFirst} = act_bucket` : `first_day >= ${fromLit}`;
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_active',
    bucket: 'r.act_bucket',
    dims: a.dims.map((d) => ({ key: d, expr: dimSql[d]! })),
    where: Object.entries(a.filters).map(([k, v]) => inList(`(${dimSql[k]})::text`, v)),
    aggs: {
      active: 'count(distinct customer_id)',
      new: `count(distinct customer_id) filter (where ${newTest})`,
    },
  });
  const caveats = scope.all ? [] : ['Customer figures are counted within the selected venues only: a guest\'s visits to other venues are not included.'];
  return { rows: g.rows, totals: g.totals, path: 'ledger', tables: ['transactions', 'customers', 'venues'], sourceRows: { customers: Number(g.totals.active ?? 0) }, caveats };
}

/** Retention: of the customers whose first order fell in a cohort period, how many ordered again N periods later. */
export async function fetchCohorts(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const grain: Grain = a.grain === 'week' ? 'week' : 'month';
  const cohortOf = bucketSql('x.first_day', grain)!;
  const activeIn = bucketSql('x.day', grain)!;
  const idx =
    grain === 'week'
      ? `((${activeIn} - ${cohortOf}) / 7)::int`
      : `((extract(year from ${activeIn}) - extract(year from ${cohortOf})) * 12 + extract(month from ${activeIn}) - extract(month from ${cohortOf}))::int`;
  const ctes = [
    customerCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, asOf: scope.today, settings: a.settings })[0]!,
    sql`a_coh as (
      select distinct x.customer_id, ${sql.raw(cohortOf)} as cohort, ${sql.raw(idx)} as idx
      from a_ctx x
      where x.first_day between ${a.from}::date and ${a.to}::date
    )`,
  ];
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_coh',
    bucket: null,
    dims: [
      { key: 'cohort', expr: 'r.cohort' },
      { key: 'periods_since', expr: 'r.idx' },
    ],
    where: [],
    aggs: { cohort_active: 'count(distinct customer_id)' },
  });

  // Every cohort gets a cell for each period that has begun, so "nobody came back" reads as 0,
  // and a period that has not happened yet is simply absent.
  const current = bucketStart(scope.today, grain);
  const size = new Map<string, number>();
  const cell = new Map<string, number>();
  for (const r of g.rows) {
    const key = rowKey(null, r.dims, ['cohort', 'periods_since']);
    cell.set(key, Number(r.m.cohort_active ?? 0));
    if (r.dims.periods_since === '0') size.set(r.dims.cohort!, Number(r.m.cohort_active ?? 0));
  }
  const rows = [];
  for (const cohort of [...size.keys()].sort()) {
    const periods = bucketsOf(cohort, current, grain).length;
    for (let i = 0; i < periods; i++) {
      const dims = { cohort, periods_since: String(i) };
      rows.push({ bucket: null, dims, m: { cohort_size: size.get(cohort)!, cohort_active: cell.get(rowKey(null, dims, ['cohort', 'periods_since'])) ?? 0 } });
    }
  }
  const caveats = [`Cohorts are ${grain === 'week' ? 'weeks' : 'calendar months'} of first order; the newest cohorts have had little time to come back.`];
  if (!scope.all) caveats.push('Customer figures are counted within the selected venues only: a guest\'s visits to other venues are not included.');
  return {
    rows,
    totals: { cohort_size: Number(g.totals.cohort_active ?? 0), cohort_active: null },
    path: 'ledger',
    tables: ['transactions', 'venues'],
    sourceRows: { customers: Number(g.totals.cohort_active ?? 0) },
    caveats,
  };
}
