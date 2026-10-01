import { z } from 'zod';
import { sql } from 'kysely';
import { type Ctx, invalid } from '@ros/core';
import { CATALOGUE_VERSION, DIMENSION_KEYS, FAMILIES, type FamilyKey, type MetricDef, type Unit, getMetric } from './catalogue';
import { type FetchArgs, type FetchResult, type Measures, SALE_STATUSES, rowKey } from './engine';
import { fetchCampaigns, fetchMessages } from './families/campaigns';
import { fetchCohorts, fetchCustomerBase, fetchCustomerFlows } from './families/customers';
import { fetchItems } from './families/items';
import { fetchSales } from './families/sales';
import { fetchEvents, fetchFunnel, fetchWeb } from './families/web';
import { factsState, ledgerFreshness } from './freshness';
import { COMPARISONS, GRAINS, type Grain, type ResolvedComparison, type ResolvedPeriod, bucketsOf, periodInput, resolveComparison, resolvePeriod } from './period';
import { type VenueScope, resolveScope } from './scope';
import { type AnalyticsSettings, getAnalyticsSettings } from './settings';

const filterValue = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)]);

export const metricQueryInput = z
  .object({
    /** Metric keys from the catalogue. */
    metrics: z.array(z.string().min(1).max(60)).min(1).max(12),
    /** Dimension keys to split by. Every metric asked for must support each one. */
    dimensions: z.array(z.string().min(1).max(40)).max(3).default([]),
    /** dimension key → the value or values to keep. `venue` takes venue ids. */
    filters: z.record(z.string(), filterValue).default({}),
    /** A relative name such as last_28_days, or { from, to } as venue-local dates (inclusive). */
    period: periodInput.default('last_28_days'),
    grain: z.enum(GRAINS).optional(),
    compareTo: z.enum(COMPARISONS).optional(),
    /** Which declared funnel the funnel metrics describe. */
    funnel: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).default('order'),
    sort: z.object({ by: z.string().min(1).max(60), direction: z.enum(['asc', 'desc']).default('desc') }).optional(),
    limit: z.number().int().min(1).max(5000).default(500),
    /**
     * Where to read from. 'auto' reads the derived facts when they are level with the ledger
     * and the question fits them, else the ledger. The other two force one side (for checks).
     */
    source: z.enum(['auto', 'ledger', 'facts']).default('auto'),
  })
  .strict();
export type MetricQuery = z.input<typeof metricQueryInput>;
export type ParsedMetricQuery = z.infer<typeof metricQueryInput>;

export interface MetricChange {
  /** current − comparison, in the metric's own unit. */
  abs: number | null;
  /** (current − comparison) ÷ comparison. Null when the comparison is zero or missing. */
  pct: number | null;
}

export interface MetricRow {
  /** First day of the time bucket, when a grain was asked for. */
  period_start: string | null;
  dimensions: Record<string, string | null>;
  values: Record<string, number | null>;
  compare?: Record<string, number | null>;
  change?: Record<string, MetricChange>;
}

export interface MetricResult {
  as_of: string;
  currency: string;
  period: { from: string; to: string; days: number; label: string; timezone: string; includes_today: boolean };
  compare: { kind: string; from: string; to: string; days: number; basis: string } | null;
  grain: Grain | null;
  dimensions: string[];
  metrics: Array<{ key: string; name: string; unit: Unit; definition_version: number; good_direction: MetricDef['direction']; adds_up: boolean; caveats: string[] }>;
  rows: MetricRow[];
  totals: { values: Record<string, number | null>; compare?: Record<string, number | null>; change?: Record<string, MetricChange> };
  row_count: number;
  truncated: boolean;
  /** Where each group of metrics was read from, and how many source rows stand behind it. */
  sources: Array<{ metrics: string[]; read_from: 'ledger' | 'facts'; tables: string[]; source_rows: Record<string, number> }>;
  freshness: { latest_sale_at: string | null; latest_sale_ingested_at: string | null; facts_computed_at: string | null };
  venues: { scope: 'all_venues' | 'selected_venues'; names: string[] };
  caveats: string[];
  catalogue_version: number;
}

const FETCHERS: Record<FamilyKey, (a: FetchArgs) => Promise<FetchResult>> = {
  sales: fetchSales,
  items: fetchItems,
  customers: fetchCustomerFlows,
  customer_base: fetchCustomerBase,
  cohorts: fetchCohorts,
  web: fetchWeb,
  events: fetchEvents,
  funnel: fetchFunnel,
  campaigns: fetchCampaigns,
  messages: fetchMessages,
};

/** Families that produce their own row shape and cannot share a result with another family. */
const STANDALONE: FamilyKey[] = ['cohorts', 'funnel'];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const ORDINAL_DIMS = new Set(['day_of_week', 'hour', 'periods_since', 'funnel_step']);

const list = (xs: string[]) => xs.map((x) => `"${x}"`).join(', ');

interface Plan {
  input: ParsedMetricQuery;
  defs: MetricDef[];
  families: FamilyKey[];
  dims: string[];
  grain: Grain | null;
  filters: Record<string, string[]>;
}

function plan(input: ParsedMetricQuery): Plan {
  const defs: MetricDef[] = [];
  for (const key of [...new Set(input.metrics)]) {
    const d = getMetric(key);
    if (!d) throw invalid(`"${key}" is not a metric. Ask for the metric catalogue to see what can be measured.`);
    defs.push(d);
  }
  const families = [...new Set(defs.map((d) => d.family))];
  const alone = families.find((f) => STANDALONE.includes(f));
  if (alone && families.length > 1) throw invalid(`${FAMILIES[alone].name} metrics have their own shape. Ask for them on their own.`);

  let dims = [...new Set(input.dimensions)];
  let grain: Grain | null = input.grain ?? null;
  if (alone === 'cohorts') {
    if (dims.some((d) => d !== 'cohort' && d !== 'periods_since')) throw invalid('Cohort retention is always split by cohort and periods_since, and by nothing else.');
    dims = ['cohort', 'periods_since'];
    if (grain === 'day') throw invalid('Cohorts are weekly or monthly. Use grain "week" or "month".');
    grain = grain ?? 'month';
  }
  if (alone === 'funnel' && !dims.includes('funnel_step')) dims = ['funnel_step', ...dims];

  for (const d of dims) {
    if (!DIMENSION_KEYS.includes(d)) throw invalid(`"${d}" is not a dimension. Ask for the metric catalogue to see the dimensions.`);
  }
  const filters: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(input.filters)) {
    if (k === 'venue') continue;
    if (!DIMENSION_KEYS.includes(k)) throw invalid(`"${k}" is not something results can be filtered by.`);
    filters[k] = (Array.isArray(v) ? v : [v]).map((x) => (k === 'day_of_week' ? String(WEEKDAYS.indexOf(x.toLowerCase()) + 1 || x) : x));
  }
  for (const def of defs) {
    const fam = FAMILIES[def.family];
    for (const d of [...dims, ...Object.keys(filters)]) {
      if (!fam.dimensions.includes(d)) throw invalid(`"${def.key}" cannot be split or filtered by "${d}". It supports: ${list(fam.dimensions)}.`);
    }
    if (grain && alone !== 'cohorts' && !fam.grains.includes(grain)) {
      throw invalid(`"${def.key}" describes a state as of the end of the period and cannot be split by ${grain}. Leave the grain out, or compare two periods.`);
    }
    if (def.needsOneOf && !def.needsOneOf.some((d) => dims.includes(d))) throw invalid(`"${def.key}" needs one of these dimensions: ${list(def.needsOneOf)}.`);
  }
  if (input.sort && !defs.some((d) => d.key === input.sort!.by)) throw invalid(`Sort by one of the metrics asked for: ${list(defs.map((d) => d.key))}.`);
  return { input, defs, families, dims, grain, filters };
}

function values(defs: MetricDef[], byFamily: Partial<Record<FamilyKey, Measures>>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const d of defs) {
    const m = byFamily[d.family];
    // No row from the family means nothing happened in that slice: sums are zero, everything else is unmeasured.
    out[d.key] = m ? d.value(m) : d.aggregation === 'sum' ? 0 : null;
  }
  return out;
}

function changes(defs: MetricDef[], cur: Record<string, number | null>, prev: Record<string, number | null>): Record<string, MetricChange> {
  const out: Record<string, MetricChange> = {};
  for (const d of defs) {
    const a = cur[d.key];
    const b = prev[d.key];
    if (a === null || a === undefined || b === null || b === undefined) {
      out[d.key] = { abs: null, pct: null };
      continue;
    }
    const abs = d.unit === 'ratio' || d.unit === 'number' || d.unit === 'days' ? Math.round((a - b) * 10_000) / 10_000 : a - b;
    out[d.key] = { abs, pct: b === 0 ? null : Math.round(((a - b) / Math.abs(b)) * 10_000) / 10_000 };
  }
  return out;
}

function label(dim: string, value: string | null, scope: VenueScope): string | null {
  if (dim === 'venue') return value === null ? '(whole org)' : (scope.venues.find((v) => v.id === value)?.name ?? '(other venue)');
  if (value === null) return null;
  if (dim === 'day_of_week') return WEEKDAYS[Number(value) - 1] ?? value;
  return value;
}

async function earliestDay(ctx: Ctx, scope: VenueScope): Promise<string | null> {
  const r = await sql<{ d: string | null }>`
    select min((t.occurred_at at time zone v.timezone)::date) as d
    from transactions t
    join venues v on v.id = t.venue_id
    where t.org_id = ${ctx.orgId} and t.venue_id = any(${scope.venueIds}::uuid[]) and t.status in ${sql.raw(SALE_STATUSES)}`.execute(ctx.db);
  return r.rows[0]?.d ?? null;
}

interface Collected {
  /** key → family → measures */
  rows: Map<string, { bucket: string | null; dims: Record<string, string | null>; m: Partial<Record<FamilyKey, Measures>> }>;
  totals: Partial<Record<FamilyKey, Measures>>;
  results: Partial<Record<FamilyKey, FetchResult>>;
}

async function collect(ctx: Ctx, p: Plan, scope: VenueScope, settings: AnalyticsSettings, from: string, to: string): Promise<Collected> {
  const out: Collected = { rows: new Map(), totals: {}, results: {} };
  for (const family of p.families) {
    const measures = new Set(p.defs.filter((d) => d.family === family).flatMap((d) => d.measures));
    const res = await FETCHERS[family]({ ctx, scope, settings, from, to, grain: p.grain, dims: p.dims, filters: p.filters, measures, source: p.input.source, funnel: p.input.funnel });
    out.results[family] = res;
    out.totals[family] = res.totals;
    for (const r of res.rows) {
      const key = rowKey(r.bucket, r.dims, p.dims);
      const row = out.rows.get(key) ?? { bucket: r.bucket, dims: r.dims, m: {} };
      row.m[family] = r.m;
      out.rows.set(key, row);
    }
  }
  return out;
}

/**
 * The one way to ask for numbers. Deterministic SQL over the ledger, the event stream and the
 * derived facts; no model anywhere. Read-only staff and above; with no venue filter the answer
 * covers every venue the caller can see, and never one they cannot.
 *
 * Every answer says which venue-local dates it used, what it was compared with, the unit and
 * definition version of each metric, which tables it read, how many source rows stand behind
 * it, how fresh the ledger is, and the caveats that apply to this particular answer.
 */
export async function queryMetrics(ctx: Ctx, raw: MetricQuery): Promise<MetricResult> {
  const parsed = metricQueryInput.safeParse(raw);
  if (!parsed.success) throw invalid('That metric query is not valid.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  const venueFilter = input.filters.venue;
  const scope = await resolveScope(ctx, venueFilter ? (Array.isArray(venueFilter) ? venueFilter : [venueFilter]) : undefined);
  return runMetricQuery(ctx, scope, input);
}

/** queryMetrics after the role check and venue scope are settled. For this module's own callers. */
export async function runMetricQuery(ctx: Ctx, scope: VenueScope, input: ParsedMetricQuery): Promise<MetricResult> {
  const p = plan(input);
  const settings = await getAnalyticsSettings(ctx);
  const period: ResolvedPeriod = resolvePeriod(input.period, scope.today, input.period === 'all_time' ? await earliestDay(ctx, scope) : null);
  const caveats: string[] = [];
  let comparison: ResolvedComparison | null = input.compareTo ? resolveComparison(period, input.compareTo) : null;
  if (comparison && p.families.includes('cohorts')) {
    comparison = null;
    caveats.push('Cohort retention is not compared with another period: compare cohorts with each other instead.');
  }

  const cur = await collect(ctx, p, scope, settings, period.from, period.to);
  const prev = comparison ? await collect(ctx, p, scope, settings, comparison.from, comparison.to) : null;

  // Line comparison buckets up with current ones by position: the third week with the third week.
  const curBuckets = p.grain && !p.families.includes('cohorts') ? bucketsOf(period.from, period.to, p.grain) : [];
  const timeSplit = curBuckets.length > 0;
  const prevBucketToCur = new Map<string, string>();
  if (comparison && timeSplit) bucketsOf(comparison.from, comparison.to, p.grain!).forEach((b, i) => curBuckets[i] && prevBucketToCur.set(b, curBuckets[i]!));

  type Acc = { bucket: string | null; dims: Record<string, string | null>; cur?: Partial<Record<FamilyKey, Measures>>; prev?: Partial<Record<FamilyKey, Measures>> };
  const acc = new Map<string, Acc>();
  for (const r of cur.rows.values()) acc.set(rowKey(r.bucket, r.dims, p.dims), { bucket: r.bucket, dims: r.dims, cur: r.m });
  if (timeSplit && !p.dims.length) {
    // A day with no sales is a row of zeros, not a gap the reader has to notice.
    for (const b of curBuckets) if (!acc.has(rowKey(b, {}, []))) acc.set(rowKey(b, {}, []), { bucket: b, dims: {}, cur: {} });
  }
  if (prev) {
    for (const r of prev.rows.values()) {
      const bucket = timeSplit ? (prevBucketToCur.get(r.bucket ?? '') ?? null) : r.bucket;
      if (timeSplit && !bucket) continue;
      const key = rowKey(bucket, r.dims, p.dims);
      const a = acc.get(key) ?? { bucket, dims: r.dims };
      a.prev = r.m;
      acc.set(key, a);
    }
  }

  let rows: MetricRow[] = [...acc.values()].map((a) => {
    const v = values(p.defs, a.cur ?? {});
    const row: MetricRow = {
      period_start: a.bucket,
      dimensions: Object.fromEntries(Object.entries(a.dims).map(([k, val]) => [k, label(k, val, scope)])),
      values: v,
    };
    if (prev) {
      row.compare = values(p.defs, a.prev ?? {});
      row.change = changes(p.defs, v, row.compare);
    }
    return Object.assign(row, { _raw: a.dims });
  });

  const rawOf = (r: MetricRow) => (r as MetricRow & { _raw: Record<string, string | null> })._raw;
  const ordinal = p.dims.filter((d) => ORDINAL_DIMS.has(d));
  const lead = input.sort?.by ?? p.defs[0]!.key;
  const dir = input.sort?.direction === 'asc' ? 1 : -1;
  rows.sort((x, y) => {
    if (!input.sort) {
      if ((x.period_start ?? '') !== (y.period_start ?? '')) return (x.period_start ?? '') < (y.period_start ?? '') ? -1 : 1;
      for (const d of p.dims.filter((k) => k === 'cohort')) if (rawOf(x)[d] !== rawOf(y)[d]) return (rawOf(x)[d] ?? '') < (rawOf(y)[d] ?? '') ? -1 : 1;
      for (const d of ordinal) {
        const diff = Number(rawOf(x)[d] ?? 0) - Number(rawOf(y)[d] ?? 0);
        if (diff) return diff;
      }
      if (ordinal.length === p.dims.length && p.dims.length) return 0;
    }
    const a = x.values[lead];
    const b = y.values[lead];
    if (a !== b) {
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      return (a - b) * dir;
    }
    return JSON.stringify(x.dimensions) < JSON.stringify(y.dimensions) ? -1 : 1;
  });
  const rowCount = rows.length;
  const truncated = rowCount > input.limit;
  rows = rows.slice(0, input.limit).map((r) => {
    const { _raw, ...rest } = r as MetricRow & { _raw?: unknown };
    void _raw;
    return rest;
  });

  const totals: MetricResult['totals'] = { values: values(p.defs, cur.totals) };
  if (prev) {
    totals.compare = values(p.defs, prev.totals);
    totals.change = changes(p.defs, totals.values, totals.compare);
  }

  // ── What a careful reader needs to know about this particular answer ──────
  for (const f of p.families) for (const c of cur.results[f]!.caveats) if (!caveats.includes(c)) caveats.push(c);
  if (p.families.some((f) => FAMILIES[f].customerScoped)) {
    // A state as of a day is built from all history up to it, so the share that matters is the all-time one.
    const wholeHistory = p.families.every((f) => f === 'customer_base' || f === 'cohorts');
    let sales = wholeHistory ? undefined : cur.results.sales?.totals;
    if (!sales || sales.identified_orders === null || sales.identified_orders === undefined) {
      sales = (
        await fetchSales({
          ctx,
          scope,
          settings,
          from: wholeHistory ? '1900-01-01' : period.from,
          to: period.to,
          grain: null,
          dims: [],
          filters: {},
          measures: new Set(['orders', 'identified_orders']),
          source: input.source === 'facts' ? 'auto' : input.source,
          funnel: input.funnel,
        })
      ).totals;
    }
    const orders = Number(sales.orders ?? 0);
    if (orders > 0) {
      const share = Math.round((Number(sales.identified_orders ?? 0) / orders) * 100);
      caveats.push(`Only ${share}% of sales ${wholeHistory ? `up to ${period.to}` : 'in this period'} are tied to a known customer, so customer metrics describe that share and say nothing about the rest.`);
    }
  }
  if (period.includesToday) caveats.push(`The period includes today (${scope.today}), which is still in progress.`);
  if (scope.mixedZones) caveats.push('The venues are in different time zones; each venue\'s days are its own local days.');
  if (timeSplit || p.dims.length) {
    const lumpy = p.defs.filter((d) => d.aggregation === 'distinct').map((d) => d.key);
    if (lumpy.length) caveats.push(`${list(lumpy)} ${lumpy.length === 1 ? 'counts' : 'count'} distinct people or sales, so the rows do not add up to the total.`);
  }
  if (truncated) caveats.push(`Showing ${input.limit} of ${rowCount} rows. Narrow the question or raise the limit.`);
  if (comparison && timeSplit && bucketsOf(comparison.from, comparison.to, p.grain!).length !== curBuckets.length) {
    caveats.push('The comparison period spans a different number of time buckets; rows are matched by position and the totals cover the whole of each period.');
  }

  const fresh = await ledgerFreshness(ctx, scope.venueIds);
  const readsFacts = p.families.some((f) => cur.results[f]!.path === 'facts');
  const state = readsFacts ? await factsState(ctx) : null;
  const salesFamily = p.families.find((f) => f === 'sales' || f === 'items');
  if (salesFamily && Number(Object.values(cur.results[salesFamily]!.sourceRows)[0] ?? 0) === 0) {
    caveats.push('No sales were found for this period and these venues. That can mean the venue was closed or that sales have not reached the ledger yet; it is not evidence of a bad day.');
  }

  return {
    as_of: ctx.now().toISOString(),
    currency: scope.currency,
    period: { from: period.from, to: period.to, days: period.days, label: period.label, timezone: scope.mixedZones ? 'each venue\'s own' : scope.timezone, includes_today: period.includesToday },
    compare: comparison ? { kind: comparison.kind, from: comparison.from, to: comparison.to, days: comparison.days, basis: comparison.basis } : null,
    grain: p.grain,
    dimensions: p.dims,
    metrics: p.defs.map((d) => ({
      key: d.key,
      name: d.name,
      unit: d.unit,
      definition_version: d.version,
      good_direction: d.direction,
      adds_up: d.aggregation === 'sum',
      caveats: d.caveats,
    })),
    rows,
    totals,
    row_count: rowCount,
    truncated,
    sources: p.families.map((f) => ({
      metrics: p.defs.filter((d) => d.family === f).map((d) => d.key),
      read_from: cur.results[f]!.path,
      tables: cur.results[f]!.tables,
      source_rows: cur.results[f]!.sourceRows,
    })),
    freshness: {
      latest_sale_at: fresh.latestSaleAt?.toISOString() ?? null,
      latest_sale_ingested_at: fresh.latestIngestedAt?.toISOString() ?? null,
      facts_computed_at: state?.computedAt?.toISOString() ?? null,
    },
    venues: { scope: scope.all ? 'all_venues' : 'selected_venues', names: scope.venues.map((v) => v.name) },
    caveats,
    catalogue_version: CATALOGUE_VERSION,
  };
}
