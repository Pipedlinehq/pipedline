import { type RawBuilder, sql } from 'kysely';
import { type FetchArgs, type FetchResult, SALE_STATUSES, bucketSql, daypartSql, inList, runGrouped, utcBounds } from '../engine';
import { factsState } from '../freshness';

/**
 * One row per counted sale, shaped like the daily fact: the single definition of every sales
 * measure. The ledger path of queryMetrics groups it; the roll-up inserts it into the fact
 * tables. There is no second copy of these formulas.
 *
 *   gross      what the guest paid: total_cents, including GST and tips, after discounts
 *   net        gross less GST and tips, scaled by the share of the sale that was not refunded
 *   new / returning   the customer's first counted sale, or a later one, within `venueIds`
 */
export interface SaleRowsArgs {
  orgId: string;
  venueIds: string[];
  /** Venue-local dates, inclusive … */
  from?: string;
  to?: string;
  /** … or an explicit list of venue-local days (the roll-up). */
  days?: string[];
  withRank: boolean;
  withItems: boolean;
}

export function saleCtes(a: SaleRowsArgs): RawBuilder<unknown>[] {
  const days = a.days ? [...a.days].sort() : null;
  const from = days ? days[0]! : a.from!;
  const to = days ? days[days.length - 1]! : a.to!;
  const { lo, hi } = utcBounds(from, to);
  const dayTest = days
    ? sql`(t.occurred_at at time zone v.timezone)::date = any(${days}::date[])`
    : sql`(t.occurred_at at time zone v.timezone)::date between ${from}::date and ${to}::date`;
  // The sales to count. When "new" and "returning" are wanted, every counted sale in these venues
  // is ranked per customer in one pass (so "first" means first ever), and the period is applied
  // afterwards; otherwise the period is applied straight away so the time index does the work.
  const cols = sql`t.id, t.org_id, t.venue_id, t.channel, t.source, t.customer_id, t.occurred_at,
                   t.total_cents, t.tax_cents, t.tip_cents, t.discount_cents, t.refunded_cents`;
  const src = a.withRank
    ? sql`a_src as (
        select ${cols}, row_number() over (partition by t.customer_id order by t.occurred_at, t.id) as rn
        from transactions t
        where t.org_id = ${a.orgId} and t.venue_id = any(${a.venueIds}::uuid[]) and t.status in ${sql.raw(SALE_STATUSES)}
      )`
    : sql`a_src as (
        select ${cols}, null::bigint as rn
        from transactions t
        where t.org_id = ${a.orgId} and t.venue_id = any(${a.venueIds}::uuid[]) and t.status in ${sql.raw(SALE_STATUSES)}
          and t.occurred_at >= ${lo} and t.occurred_at < ${hi}
      )`;
  const items = a.withItems
    ? sql`coalesce((select sum(l.qty) from transaction_lines l where l.org_id = t.org_id and l.transaction_id = t.id), 0)::numeric(14, 3)`
    : sql`null::numeric(14, 3)`;
  const isNew = a.withRank ? sql`(t.customer_id is not null and t.rn = 1)::int` : sql`null::int`;
  const isReturning = a.withRank ? sql`(t.customer_id is not null and t.rn > 1)::int` : sql`null::int`;
  return [
    src,
    sql`a_sale as (
      select t.id, t.venue_id, t.channel, t.source, t.customer_id,
             (t.occurred_at at time zone v.timezone)::date as day,
             extract(hour from (t.occurred_at at time zone v.timezone))::int as hour,
             (t.occurred_at at time zone v.timezone)::time as local_time,
             1 as orders,
             t.total_cents::bigint as gross_cents,
             coalesce(round((t.total_cents - t.tax_cents - t.tip_cents)::numeric
               * greatest(t.total_cents - t.refunded_cents, 0) / nullif(t.total_cents, 0)), 0)::bigint as net_cents,
             t.discount_cents::bigint as discount_cents,
             t.tax_cents::bigint as tax_cents,
             t.tip_cents::bigint as tip_cents,
             t.refunded_cents::bigint as refunded_cents,
             ${items} as items,
             (t.customer_id is not null)::int as identified_orders,
             (case when t.customer_id is not null then t.total_cents else 0 end)::bigint as identified_gross_cents,
             ${isNew} as new_customer_orders,
             ${isReturning} as returning_customer_orders,
             (t.refunded_cents > 0)::int as refunded_orders,
             (t.discount_cents > 0)::int as discounted_orders
      from a_src t
      join venues v on v.id = t.venue_id
      where t.occurred_at >= ${lo} and t.occurred_at < ${hi} and ${dayTest}
    )`,
  ];
}

/** Measure → the fact-shaped column it sums. */
export const SALES_COLUMNS: Record<string, string> = {
  orders: 'orders',
  gross: 'gross_cents',
  net: 'net_cents',
  discount: 'discount_cents',
  tax: 'tax_cents',
  tip: 'tip_cents',
  refunded: 'refunded_cents',
  items: 'items',
  identified_orders: 'identified_orders',
  identified_gross: 'identified_gross_cents',
  new_customer_orders: 'new_customer_orders',
  returning_customer_orders: 'returning_customer_orders',
  refunded_orders: 'refunded_orders',
  discounted_orders: 'discounted_orders',
};

const DAILY_DIMS = new Set(['venue', 'channel', 'source', 'day_of_week']);
const HOURLY_DIMS = new Set(['venue', 'hour', 'daypart', 'day_of_week']);

export async function fetchSales(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope, settings } = a;
  const used = [...new Set([...a.dims, ...Object.keys(a.filters)])];
  const needsRank = a.measures.has('new_customer_orders') || a.measures.has('returning_customer_orders');
  const caveats: string[] = [];

  let path: 'ledger' | 'facts' = 'ledger';
  let table: 'fact_sales_daily' | 'fact_sales_hourly' = 'fact_sales_daily';
  const fitsDaily = used.every((d) => DAILY_DIMS.has(d));
  const fitsHourly = used.every((d) => HOURLY_DIMS.has(d));
  // New and returning are stored org-wide; with a narrower scope "first" must be recomputed.
  const servable = (fitsDaily || fitsHourly) && (!needsRank || scope.all);
  if (a.source !== 'ledger' && servable) {
    const state = await factsState(ctx);
    if (a.source === 'facts' || state.salesFresh) {
      path = 'facts';
      table = fitsDaily ? 'fact_sales_daily' : 'fact_sales_hourly';
      if (!state.salesFresh) caveats.push('Served from daily facts that are behind the ledger: sales recorded or changed since the last roll-up are missing.');
    }
  } else if (a.source === 'facts') {
    caveats.push('These dimensions cannot be served from the daily facts; the ledger was read instead.');
  }

  const hourExpr = 'r.hour';
  const dimSql: Record<string, string> = {
    venue: 'r.venue_id',
    channel: 'r.channel',
    source: 'r.source',
    hour: hourExpr,
    day_of_week: 'extract(isodow from r.day)::int',
    daypart: daypartSql(hourExpr, settings),
  };

  let ctes: RawBuilder<unknown>[];
  let relation: string;
  if (path === 'facts') {
    const cols = Object.values(SALES_COLUMNS).map((c) => `f.${c}`).join(', ');
    ctes =
      table === 'fact_sales_daily'
        ? [sql`a_fact as (
            select f.day, f.venue_id, f.channel::text as channel, f.source::text as source, null::int as hour, ${sql.raw(cols)}
            from fact_sales_daily f
            where f.org_id = ${ctx.orgId} and f.venue_id = any(${scope.venueIds}::uuid[]) and f.day between ${a.from}::date and ${a.to}::date
          )`]
        : [sql`a_fact as (
            select f.day, f.venue_id, null::text as channel, null::text as source, f.hour::int as hour, ${sql.raw(cols)}
            from fact_sales_hourly f
            where f.org_id = ${ctx.orgId} and f.venue_id = any(${scope.venueIds}::uuid[]) and f.day between ${a.from}::date and ${a.to}::date
          )`];
    relation = 'a_fact';
  } else {
    ctes = saleCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, from: a.from, to: a.to, withRank: needsRank, withItems: a.measures.has('items') });
    relation = 'a_sale';
  }

  const where = Object.entries(a.filters).map(([k, v]) => inList(`(${dimSql[k]})::text`, v));
  const aggs: Record<string, string> = {};
  for (const [m, col] of Object.entries(SALES_COLUMNS)) aggs[m] = `sum(${col})`;
  // On the fact path a source row is a fact row, so count sales from the measure instead.
  const g = await runGrouped(ctx, {
    ctes,
    relation,
    bucket: bucketSql('r.day', a.grain),
    dims: a.dims.map((d) => ({ key: d, expr: dimSql[d]! })),
    where,
    aggs,
  });
  return {
    rows: g.rows,
    totals: g.totals,
    path,
    tables: path === 'facts' ? [table] : a.measures.has('items') ? ['transactions', 'transaction_lines', 'venues'] : ['transactions', 'venues'],
    sourceRows: path === 'facts' ? { [table]: g.sourceRows, transactions: Number(g.totals.orders ?? 0) } : { transactions: g.sourceRows },
    caveats,
  };
}
