import { type RawBuilder, sql } from 'kysely';
import type { Ctx } from '@ros/core';
import type { Grain } from './period';
import type { VenueScope } from './scope';
import type { AnalyticsSettings } from './settings';

/**
 * The small query engine under queryMetrics. A family turns a request into one relation of
 * source rows with named dimension columns; this file groups it. Everything is SQL run inside
 * the caller's tenant transaction, so row-level security applies to every read, and every
 * value a caller supplies is bound, never spliced.
 */

/** Sales that count: paid, including ones later refunded. Pending and voided sales never count. */
export const SALE_STATUSES = `('completed', 'refunded', 'partially_refunded')`;

export type Measures = Record<string, number | null>;

export interface FamilyRow {
  /** Start of the time bucket (YYYY-MM-DD), or null when the answer is not split by time. */
  bucket: string | null;
  dims: Record<string, string | null>;
  m: Measures;
}

export interface FetchArgs {
  ctx: Ctx;
  scope: VenueScope;
  settings: AnalyticsSettings;
  from: string;
  to: string;
  grain: Grain | null;
  dims: string[];
  filters: Record<string, string[]>;
  /** The measures the requested metrics need; a family may skip work for the rest. */
  measures: Set<string>;
  source: 'auto' | 'ledger' | 'facts';
  funnel: string;
}

export interface FetchResult {
  rows: FamilyRow[];
  totals: Measures;
  path: 'ledger' | 'facts';
  tables: string[];
  /** How many source rows stand behind the totals, by table. */
  sourceRows: Record<string, number>;
  caveats: string[];
  /** Set when a family dropped or hid rows (the campaign cohort floor). */
  hiddenRows?: number;
}

export interface GroupedSpec {
  /** CTE definitions, each "name as (…)". */
  ctes: RawBuilder<unknown>[];
  /** The relation to group: one row per source row. */
  relation: string;
  /** SQL over the relation giving the time bucket (a date), or null for no time split. */
  bucket: string | null;
  /** Requested dimensions: a key and the SQL (over the relation) producing its text value. */
  dims: Array<{ key: string; expr: string }>;
  /** Conditions over the relation. Values are bound. */
  where: RawBuilder<unknown>[];
  /** Measure name → aggregate SQL over the grouped relation (its columns, plus g_bucket). */
  aggs: Record<string, string>;
}

export function bucketSql(dayExpr: string, grain: Grain | null): string | null {
  if (!grain) return null;
  if (grain === 'day') return `(${dayExpr})::date`;
  // date_trunc('week') starts weeks on Monday, matching weekStart() in period.ts.
  return `date_trunc('${grain}', (${dayExpr})::timestamp)::date`;
}

/** A venue-local hour, as SQL, mapped to the org's configured dayparts. Constants only, so it is groupable. */
export function daypartSql(hourExpr: string, settings: AnalyticsSettings): string {
  const arms = settings.dayparts.map((d) => {
    const from = Math.trunc(d.fromHour);
    const to = Math.trunc(d.toHour);
    const cond = to <= from ? `(${hourExpr} >= ${from} or ${hourExpr} < ${to})` : `(${hourExpr} >= ${from} and ${hourExpr} < ${to})`;
    // Keys are validated as [a-z0-9_] by the settings schema.
    return `when ${cond} then '${d.key.replace(/[^a-z0-9_]/g, '')}'`;
  });
  return `(case ${arms.join(' ')} else 'other' end)`;
}

/** Coarse UTC bounds around venue-local dates, so the time index is used before the exact local-date test. */
export function utcBounds(from: string, to: string): { lo: Date; hi: Date } {
  const lo = new Date(`${from}T00:00:00Z`);
  lo.setUTCDate(lo.getUTCDate() - 1);
  const hi = new Date(`${to}T00:00:00Z`);
  hi.setUTCDate(hi.getUTCDate() + 2);
  return { lo, hi };
}

export const inList = (expr: string, values: string[]): RawBuilder<unknown> => sql`${sql.raw(expr)} = any(${values}::text[])`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Group a relation by the time bucket and the requested dimensions, and in the same statement
 * produce the grand total (GROUPING SETS), so distinct counts are right at both levels.
 */
export async function runGrouped(ctx: Ctx, spec: GroupedSpec): Promise<{ rows: FamilyRow[]; totals: Measures; sourceRows: number }> {
  const measureKeys = Object.keys(spec.aggs);
  const dimCols = spec.dims.map((d, i) => ({ key: d.key, col: `g_d${i}`, expr: d.expr }));
  const cutCols = [`${spec.bucket ?? 'null::date'} as g_bucket`, ...dimCols.map((d) => `(${d.expr})::text as ${d.col}`)];
  const where = spec.where.length ? sql`where ${sql.join(spec.where, sql` and `)}` : sql``;
  const groupCols = ['g_bucket', ...dimCols.map((d) => d.col)];
  const aggSql = [...measureKeys.map((k, i) => `${spec.aggs[k]} as m${i}`), 'count(*) as g_n'].join(', ');

  const q = sql<Record<string, unknown>>`
    with ${sql.join(spec.ctes, sql`, `)},
    a_cut as (
      select ${sql.raw(cutCols.join(', '))}, r.*
      from ${sql.raw(spec.relation)} r
      ${where}
    )
    select ${sql.raw(groupCols.join(', '))}, grouping(g_bucket)::int as g_total, ${sql.raw(aggSql)}
    from a_cut
    group by grouping sets ((${sql.raw(groupCols.join(', '))}), ())
    order by g_total, g_bucket${sql.raw(dimCols.map((d) => `, ${d.col}`).join(''))}`;
  const res = await q.execute(ctx.db);

  const rows: FamilyRow[] = [];
  let totals: Measures = Object.fromEntries(measureKeys.map((k) => [k, 0]));
  let sourceRows = 0;
  for (const r of res.rows) {
    const m: Measures = {};
    measureKeys.forEach((k, i) => (m[k] = num(r[`m${i}`])));
    if (Number(r.g_total) === 1) {
      totals = m;
      sourceRows = Number(r.g_n ?? 0);
      continue;
    }
    const dims: Record<string, string | null> = {};
    for (const d of dimCols) dims[d.key] = (r[d.col] as string | null) ?? null;
    rows.push({ bucket: (r.g_bucket as string | null) ?? null, dims, m });
  }
  // An empty relation still yields the total row; its sums are null and mean "nothing there".
  for (const k of measureKeys) if (totals[k] === null && /^(sum|count)\(/.test(spec.aggs[k]!.trim())) totals[k] = 0;
  return { rows, totals, sourceRows };
}

export const rowKey = (bucket: string | null, dims: Record<string, string | null>, dimKeys: string[]): string =>
  [bucket ?? '', ...dimKeys.map((k) => dims[k] ?? '\u0000')].join('\u0001');
