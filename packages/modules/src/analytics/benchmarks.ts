import { type App, type Ctx, addDays, forbidden, isAppError, localDate } from '@ros/core';
import { type Unit, getMetric } from './catalogue';
import { metricQueryInput, runMetricQuery } from './query';
import { resolveScope } from './scope';

/**
 * Benchmarks: anonymous percentile bands across orgs that opted in (orgs.benchmark_opt_in).
 *
 *   - an org that has not opted in contributes nothing and sees nothing
 *   - a band exists only when at least BENCHMARK_MIN_ORGS opted-in orgs are in the cohort
 *   - benchmark_bands holds a metric, a cohort label and three percentiles: no org id, no
 *     venue, nothing that names a business (docs/THREAT_MODEL.md section 4, Commercial)
 *   - only scale-free metrics are benchmarked (rates and averages), so a band says nothing
 *     about any one business's size
 */
export const BENCHMARK_MIN_ORGS = 5;
/** An org with fewer sales than this in the window is too thin to contribute a meaningful value. */
export const BENCHMARK_MIN_ORDERS = 10;
export const BENCHMARK_WINDOW_DAYS = 28;
export const BENCHMARK_METRICS = ['avg_order_value', 'items_per_order', 'refund_rate', 'discount_rate', 'tip_rate', 'identified_share', 'returning_order_share', 'repeat_rate'] as const;

const WORKER = { kind: 'worker' as const, job: 'analytics.benchmarks' };
const SALES_METRICS = BENCHMARK_METRICS.filter((m) => getMetric(m)!.family === 'sales');

interface OrgValues {
  cohorts: string[];
  values: Record<string, number | null>;
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** The cohorts an org belongs to: everyone, each cuisine, its price band, each state it trades in, and the three together. */
function cohortsOf(cuisines: string[], priceBand: number | null, states: string[]): string[] {
  const out = ['all'];
  const c = [...new Set(cuisines.map(slug).filter(Boolean))].sort();
  const s = [...new Set(states.map((x) => x.trim().toUpperCase()).filter(Boolean))].sort();
  for (const x of c) out.push(`cuisine:${x}`);
  if (priceBand) out.push(`band:${priceBand}`);
  for (const x of s) out.push(`state:${x}`);
  if (priceBand) for (const x of c) for (const y of s) out.push(`cuisine:${x}|band:${priceBand}|state:${y}`);
  return out;
}

/** This org's own values for the benchmarked metrics over the window, using the catalogue's definitions. */
async function orgValues(ctx: Ctx, from: string, to: string): Promise<OrgValues | null> {
  const scope = await resolveScope(ctx);
  if (!scope.all) throw forbidden('Benchmarks describe the whole organisation.');
  const org = await ctx.db.selectFrom('orgs').select(['cuisine_tags', 'price_band']).where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const states = (await ctx.db.selectFrom('venues').select('state').where('org_id', '=', ctx.orgId).where('state', 'is not', null).execute()).map((v) => v.state!);
  const sales = await runMetricQuery(ctx, scope, metricQueryInput.parse({ metrics: ['orders', ...SALES_METRICS], period: { from, to } }));
  if (Number(sales.totals.values.orders ?? 0) < BENCHMARK_MIN_ORDERS) return null;
  const base = await runMetricQuery(ctx, scope, metricQueryInput.parse({ metrics: ['repeat_rate'], period: { from, to } }));
  const values: Record<string, number | null> = {};
  for (const m of BENCHMARK_METRICS) values[m] = (m === 'repeat_rate' ? base.totals.values[m] : sales.totals.values[m]) ?? null;
  return { cohorts: cohortsOf(org.cuisine_tags, org.price_band, states), values };
}

/** Linear-interpolated percentile, the same rule as Postgres percentile_cont. */
export function percentile(sorted: number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export interface BenchmarkRun {
  period: { from: string; to: string };
  orgsOptedIn: number;
  orgsContributing: number;
  bandsWritten: number;
}

/**
 * Recompute the bands. Platform work by nature: it is the one place numbers from more than one
 * org meet. Each org's values are computed inside that org's own tenant transaction, with
 * row-level security on, using the same metric definitions the org itself sees; only the bare
 * values leave that transaction, and only the percentiles of five or more are written.
 */
export async function computeBenchmarks(app: App, opts: { to?: string } = {}): Promise<BenchmarkRun> {
  const to = opts.to ?? addDays(localDate(app.clock(), 'UTC'), -1);
  const from = addDays(to, -(BENCHMARK_WINDOW_DAYS - 1));
  // app.db bypasses row-level security: this reads only which orgs opted in, never their data.
  const orgs = await app.db.selectFrom('orgs').select('id').where('benchmark_opt_in', '=', true).where('status', 'in', ['onboarding', 'live']).orderBy('id').execute();

  const samples = new Map<string, number[]>();
  let contributing = 0;
  for (const o of orgs) {
    // An org that cannot be measured (no venue yet, say) is left out; it must not stop the others.
    const v = await app.tenant(o.id, WORKER, (ctx) => orgValues(ctx, from, to)).catch((e: unknown) => {
      if (isAppError(e)) return null;
      throw e;
    });
    if (!v) continue;
    contributing++;
    for (const cohort of v.cohorts) {
      for (const metric of BENCHMARK_METRICS) {
        const value = v.values[metric];
        if (value === null || value === undefined) continue;
        const key = `${metric}\u0001${cohort}`;
        const list = samples.get(key) ?? [];
        list.push(value);
        samples.set(key, list);
      }
    }
  }

  const bands = [...samples.entries()]
    .filter(([, values]) => values.length >= BENCHMARK_MIN_ORGS)
    .map(([key, values]) => {
      const [metric, cohort] = key.split('\u0001') as [string, string];
      const sorted = [...values].sort((a, b) => a - b);
      return { metric, cohort, period_start: from, period_end: to, p25: percentile(sorted, 0.25), p50: percentile(sorted, 0.5), p75: percentile(sorted, 0.75), n_orgs: sorted.length, computed_at: app.clock() };
    });

  await app.platform('analytics benchmarks: anonymous percentile bands across opted-in orgs', async (pctx) => {
    // Replace the window's bands as a whole, so a cohort that fell below the minimum disappears.
    await pctx.db.deleteFrom('benchmark_bands').where('period_start', '=', from).where('period_end', '=', to).execute();
    if (bands.length) await pctx.db.insertInto('benchmark_bands').values(bands).execute();
  });
  return { period: { from, to }, orgsOptedIn: orgs.length, orgsContributing: contributing, bandsWritten: bands.length };
}

export interface BenchmarkComparison {
  metric: string;
  name: string;
  unit: Unit;
  cohort: string;
  your_value: number | null;
  p25: number;
  p50: number;
  p75: number;
  n_orgs: number;
  position: 'below_p25' | 'p25_to_p50' | 'p50_to_p75' | 'above_p75' | 'unmeasured';
}

export interface Benchmarks {
  opted_in: boolean;
  period: { from: string; to: string } | null;
  min_orgs: number;
  comparisons: BenchmarkComparison[];
  note: string;
  as_of: string;
}

/**
 * This org against the bands of the cohorts it belongs to. An org that has not opted in gets
 * no bands at all. Read-only staff and above, and only callers who can see the whole org.
 */
export async function getBenchmarks(ctx: Ctx): Promise<Benchmarks> {
  const scope = await resolveScope(ctx);
  if (!scope.all) throw forbidden('Benchmarks describe the whole organisation.');
  const org = await ctx.db.selectFrom('orgs').select(['benchmark_opt_in']).where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const asOf = ctx.now().toISOString();
  if (!org.benchmark_opt_in) {
    return { opted_in: false, period: null, min_orgs: BENCHMARK_MIN_ORGS, comparisons: [], note: 'Benchmarks are opt-in. This organisation has not joined, so it neither contributes to nor sees the bands. An owner can switch it on in settings.', as_of: asOf };
  }
  const latest = await ctx.db.selectFrom('benchmark_bands').select(['period_start', 'period_end']).orderBy('period_end', 'desc').orderBy('period_start', 'desc').limit(1).executeTakeFirst();
  if (!latest) {
    return { opted_in: true, period: null, min_orgs: BENCHMARK_MIN_ORGS, comparisons: [], note: `No bands yet: a band needs at least ${BENCHMARK_MIN_ORGS} opted-in organisations in a cohort.`, as_of: asOf };
  }
  const mine = await orgValues(ctx, latest.period_start, latest.period_end);
  const cohorts = mine?.cohorts ?? [];
  const bands = cohorts.length
    ? await ctx.db
        .selectFrom('benchmark_bands')
        .select(['metric', 'cohort', 'p25', 'p50', 'p75', 'n_orgs'])
        .where('period_start', '=', latest.period_start)
        .where('period_end', '=', latest.period_end)
        .where('cohort', 'in', cohorts)
        .where('n_orgs', '>=', BENCHMARK_MIN_ORGS)
        .orderBy('metric')
        .orderBy('cohort')
        .execute()
    : [];
  const comparisons: BenchmarkComparison[] = bands.map((b) => {
    const def = getMetric(b.metric);
    const v = mine!.values[b.metric] ?? null;
    const p25 = Number(b.p25);
    const p50 = Number(b.p50);
    const p75 = Number(b.p75);
    return {
      metric: b.metric,
      name: def?.name ?? b.metric,
      unit: def?.unit ?? 'number',
      cohort: b.cohort,
      your_value: v,
      p25,
      p50,
      p75,
      n_orgs: b.n_orgs,
      position: v === null ? 'unmeasured' : v < p25 ? 'below_p25' : v < p50 ? 'p25_to_p50' : v <= p75 ? 'p50_to_p75' : 'above_p75',
    };
  });
  return {
    opted_in: true,
    period: { from: latest.period_start, to: latest.period_end },
    min_orgs: BENCHMARK_MIN_ORGS,
    comparisons,
    note: !mine
      ? `This organisation had fewer than ${BENCHMARK_MIN_ORDERS} sales in the window, so it has no value to compare.`
      : comparisons.length
        ? 'Each band is the middle half of opted-in organisations in the cohort. A band is a description of others, not a target.'
        : `No bands yet for this organisation's cohorts: each needs at least ${BENCHMARK_MIN_ORGS} opted-in organisations.`,
    as_of: asOf,
  };
}
