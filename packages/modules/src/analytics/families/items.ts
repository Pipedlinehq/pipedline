import { type RawBuilder, sql } from 'kysely';
import { type FetchArgs, type FetchResult, type Measures, SALE_STATUSES, bucketSql, inList, rowKey, runGrouped, utcBounds } from '../engine';
import { factsState } from '../freshness';

/**
 * One row per line of a counted sale. Item names are the snapshot taken at the sale, never the
 * live menu, so a renamed or deleted dish still reports under the name it was sold as.
 * Line revenue is before refunds: the ledger records a refund against the sale, not a line.
 *
 * item_key is the menu item id (when the POS line matched one) together with the name and
 * category snapshots, so that one key always means one name and one category. The daily item
 * fact is keyed by it, which is what lets the fact and the ledger agree to the cent when an
 * item is renamed or moved between sections part-way through a day.
 */
export interface LineRowsArgs {
  orgId: string;
  venueIds: string[];
  from?: string;
  to?: string;
  days?: string[];
}

export function lineCtes(a: LineRowsArgs): RawBuilder<unknown>[] {
  const days = a.days ? [...a.days].sort() : null;
  const from = days ? days[0]! : a.from!;
  const to = days ? days[days.length - 1]! : a.to!;
  const { lo, hi } = utcBounds(from, to);
  const dayTest = days
    ? sql`(t.occurred_at at time zone v.timezone)::date = any(${days}::date[])`
    : sql`(t.occurred_at at time zone v.timezone)::date between ${from}::date and ${to}::date`;
  return [
    sql`a_line as (
      select t.id as transaction_id, t.venue_id, t.channel::text as channel,
             (t.occurred_at at time zone v.timezone)::date as day,
             concat_ws('|', coalesce(l.menu_item_id::text, '-'), l.name_snapshot, coalesce(l.category_snapshot, '')) as item_key,
             l.menu_item_id,
             l.name_snapshot as item_name,
             coalesce(l.category_snapshot, '(uncategorised)') as category,
             l.qty::numeric(14, 3) as qty,
             l.total_cents::bigint as revenue_cents
      from transaction_lines l
      join transactions t on t.id = l.transaction_id
      join venues v on v.id = t.venue_id
      where l.org_id = ${a.orgId} and t.org_id = ${a.orgId} and t.venue_id = any(${a.venueIds}::uuid[])
        and t.status in ${sql.raw(SALE_STATUSES)}
        and t.occurred_at >= ${lo} and t.occurred_at < ${hi}
        and ${dayTest}
    )`,
  ];
}

const ITEM_DIMS = ['item', 'category'];
const FACT_DIMS = new Set(['item', 'category', 'venue']);
const FACT_MEASURES = new Set(['qty', 'revenue', 'total_qty', 'total_revenue']);

export async function fetchItems(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const used = [...new Set([...a.dims, ...Object.keys(a.filters)])];
  const caveats: string[] = [];
  const wantsShare = ['total_qty', 'total_revenue', 'total_orders'].some((m) => a.measures.has(m));

  // Order counts are distinct counts and are always taken from the ledger; the fact serves sums.
  const servable = used.every((d) => FACT_DIMS.has(d)) && [...a.measures].every((m) => FACT_MEASURES.has(m));
  let path: 'ledger' | 'facts' = 'ledger';
  if (a.source !== 'ledger' && servable) {
    const state = await factsState(ctx);
    if (a.source === 'facts' || state.salesFresh) {
      path = 'facts';
      if (!state.salesFresh) caveats.push('Served from daily facts that are behind the ledger: sales recorded or changed since the last roll-up are missing.');
    }
  } else if (a.source === 'facts') {
    caveats.push('This question cannot be served from the daily item facts; the ledger was read instead.');
  }

  const dimSql: Record<string, string> = { item: 'r.item_name', category: 'r.category', venue: 'r.venue_id', channel: 'r.channel' };
  const ctes: RawBuilder<unknown>[] =
    path === 'facts'
      ? [sql`a_line as (
          select null::uuid as transaction_id, f.venue_id, null::text as channel, f.day, f.item_key, f.menu_item_id,
                 f.item_name, coalesce(f.category, '(uncategorised)') as category, f.qty, f.revenue_cents
          from fact_item_daily f
          where f.org_id = ${ctx.orgId} and f.venue_id = any(${scope.venueIds}::uuid[]) and f.day between ${a.from}::date and ${a.to}::date
        )`]
      : lineCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, from: a.from, to: a.to });
  const where = Object.entries(a.filters).map(([k, v]) => inList(`(${dimSql[k]})::text`, v));
  const aggs = { qty: 'sum(qty)', revenue: 'sum(revenue_cents)', item_orders: 'count(distinct transaction_id)' };
  const bucket = bucketSql('r.day', a.grain);

  const g = await runGrouped(ctx, { ctes, relation: 'a_line', bucket, dims: a.dims.map((d) => ({ key: d, expr: dimSql[d]! })), where, aggs });

  // Mix and attach are shares of everything sold in the same slice, so the denominators come
  // from the same relation grouped without the item and category dimensions. A filter on item
  // or category narrows the rows shown, not the whole they are a share of.
  if (wantsShare) {
    const outerDims = a.dims.filter((d) => !ITEM_DIMS.includes(d));
    const outerWhere = Object.entries(a.filters)
      .filter(([k]) => !ITEM_DIMS.includes(k))
      .map(([k, v]) => inList(`(${dimSql[k]})::text`, v));
    const t = await runGrouped(ctx, { ctes, relation: 'a_line', bucket, dims: outerDims.map((d) => ({ key: d, expr: dimSql[d]! })), where: outerWhere, aggs });
    const byKey = new Map<string, Measures>(t.rows.map((r) => [rowKey(r.bucket, r.dims, outerDims), r.m]));
    const attach = (m: Measures, whole: Measures | undefined) => {
      m.total_qty = whole?.qty ?? null;
      m.total_revenue = whole?.revenue ?? null;
      m.total_orders = whole?.item_orders ?? null;
    };
    for (const r of g.rows) attach(r.m, byKey.get(rowKey(r.bucket, r.dims, outerDims)));
    attach(g.totals, t.totals);
  }

  return {
    rows: g.rows,
    totals: g.totals,
    path,
    tables: path === 'facts' ? ['fact_item_daily'] : ['transaction_lines', 'transactions', 'venues'],
    sourceRows: { [path === 'facts' ? 'fact_item_daily' : 'transaction_lines']: g.sourceRows },
    caveats,
  };
}
