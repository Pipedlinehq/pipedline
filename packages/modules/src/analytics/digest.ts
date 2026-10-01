import { z } from 'zod';
import { sql } from 'kysely';
import { type Ctx, addDays, invalid, json } from '@ros/core';
import { type MetricDef, type Unit, getMetric } from './catalogue';
import { type FamilyRow, type FetchArgs, type Measures, SALE_STATUSES } from './engine';
import { fetchItems } from './families/items';
import { fetchSales } from './families/sales';
import { fetchWeb } from './families/web';
import { addMonths, dayDiff, isRealDate, monthEnd, monthStart, weekStart } from './period';
import { type VenueScope, resolveScope } from './scope';
import { type AnalyticsSettings, getAnalyticsSettings } from './settings';

/**
 * A digest says what moved in a day, a week or a month, against a like-for-like baseline: the
 * same weekdays over the weeks before. It is arithmetic and templates, nothing else. The same
 * inputs and the same clock always give the same findings and the same sentence.
 *
 * Baseline: the period is slid back in whole weeks (7 days at a time for a day or a week, 35
 * for a month, so the slices never overlap) to make up to N earlier periods with the same
 * weekdays. Their mean is "usual"; their spread is "normal variation". A change is flagged
 * only when it is both outside that spread and large enough to matter.
 */
export const DIGEST_VERSION = 1;

export const digestInput = z
  .object({
    venueId: z.string().uuid().optional(),
    period: z.enum(['day', 'week', 'month']),
    /** Any venue-local date inside the period wanted. Default: the last complete one. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();
export type DigestInput = z.input<typeof digestInput>;

export type Significance = 'normal' | 'notable' | 'strong' | 'insufficient_history';

export interface DigestFinding {
  metric: string;
  name: string;
  unit: Unit;
  value: number | null;
  /** The mean of the like-for-like baseline periods. */
  baseline: number | null;
  change_abs: number | null;
  change_pct: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
  /** Whether the move is good news for the venue, from the metric's definition. */
  reads_as: 'good' | 'bad' | 'neutral';
  significance: Significance;
  /** The band the value usually falls in (baseline ± the notable threshold). */
  usual_range: [number, number] | null;
  baseline_periods: number;
  caveats: string[];
}

export interface DigestMover {
  dimension: 'item' | 'channel' | 'daypart' | 'campaign';
  member: string;
  metric: string;
  unit: Unit;
  value: number;
  baseline: number;
  change_abs: number;
  change_pct: number | null;
  direction: 'up' | 'down';
  significance: Significance;
}

export interface Digest {
  version: number;
  period: { kind: 'day' | 'week' | 'month'; from: string; to: string; complete: boolean };
  venue: string | null;
  currency: string;
  baseline: { method: string; periods_asked: number; shift_days: number; earliest_from: string };
  headline: DigestFinding[];
  /** Metric keys that moved beyond normal variation. */
  flagged: string[];
  movers: DigestMover[];
  summary: string;
  caveats: string[];
  as_of: string;
}

const HEADLINE = ['net_sales', 'orders', 'avg_order_value', 'items_per_order', 'identified_share', 'new_customer_orders', 'returning_customer_orders', 'discounts', 'refund_rate', 'web_sessions'];

const daysOf = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;
const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
};
const roundFor = (unit: Unit, v: number): number => (unit === 'cents' || unit === 'count' ? Math.round(v) : Math.round(v * 10_000) / 10_000);

/** day → member → measures, from a family fetched at day grain. */
function index(rows: FamilyRow[], dim: string | null): Map<string, Map<string, Measures>> {
  const out = new Map<string, Map<string, Measures>>();
  for (const r of rows) {
    const day = r.bucket!;
    const member = dim ? (r.dims[dim] ?? '(none)') : '';
    const byMember = out.get(day) ?? new Map<string, Measures>();
    byMember.set(member, r.m);
    out.set(day, byMember);
  }
  return out;
}

function sumOver(series: Map<string, Map<string, Measures>>, days: string[], member: string): Measures {
  const out: Measures = {};
  for (const d of days) {
    const m = series.get(d)?.get(member);
    if (!m) continue;
    for (const [k, v] of Object.entries(m)) if (v !== null && v !== undefined) out[k] = (out[k] ?? 0) + Number(v);
  }
  return out;
}

export function classify(value: number, base: number[], s: AnalyticsSettings['digest']): { significance: Significance; mean: number | null; spread: number } {
  if (base.length < 4) return { significance: 'insufficient_history', mean: base.length ? mean(base) : null, spread: 0 };
  const m = mean(base);
  const spread = sd(base);
  const diff = value - m;
  const rel = m === 0 ? (diff === 0 ? 0 : Infinity) : Math.abs(diff / m);
  if (rel < s.minChangeRatio) return { significance: 'normal', mean: m, spread };
  if (spread === 0) return { significance: diff === 0 ? 'normal' : rel >= 0.2 ? 'notable' : 'normal', mean: m, spread };
  const z = Math.abs(diff) / spread;
  return { significance: z >= s.strongSd ? 'strong' : z >= s.notableSd ? 'notable' : 'normal', mean: m, spread };
}

export const money = (cents: number): string => {
  const neg = cents < 0;
  const dollars = Math.round(Math.abs(cents) / 100);
  return `${neg ? '-' : ''}$${String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
};
const show = (unit: Unit, v: number): string =>
  unit === 'cents' ? money(v) : unit === 'ratio' ? `${Math.round(v * 1000) / 10}%` : unit === 'count' ? String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(Math.round(v * 100) / 100);
export const pct = (v: number | null): string => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const dm = (d: string): string => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

function periodLabel(kind: 'day' | 'week' | 'month', from: string, to: string): string {
  if (kind === 'day') return `${WEEKDAY[new Date(`${from}T00:00:00Z`).getUTCDay()]} ${dm(from)} ${from.slice(0, 4)}`;
  if (kind === 'week') return `Week of ${dm(from)} to ${dm(to)} ${to.slice(0, 4)}`;
  return `${MONTHS[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
}

async function earliest(ctx: Ctx, scope: VenueScope): Promise<{ sale: string | null; session: string | null }> {
  const r = await sql<{ sale: string | null; session: string | null }>`
    select
      (select min((t.occurred_at at time zone v.timezone)::date)
       from transactions t join venues v on v.id = t.venue_id
       where t.org_id = ${ctx.orgId} and t.venue_id = any(${scope.venueIds}::uuid[]) and t.status in ${sql.raw(SALE_STATUSES)}) as sale,
      (select min((s.first_seen_at at time zone coalesce(v.timezone, ${scope.orgTimezone}))::date)
       from visitor_sessions s left join venues v on v.id = s.venue_id
       where s.org_id = ${ctx.orgId} and (s.venue_id = any(${scope.venueIds}::uuid[]) or (${scope.all}::boolean and s.venue_id is null))) as session`.execute(ctx.db);
  return r.rows[0]!;
}

/**
 * Work out the digest without storing it. Read-only staff and above; for one venue, or for the
 * whole org when the caller can see every venue.
 */
export async function computeDigest(ctx: Ctx, raw: DigestInput): Promise<Digest> {
  const parsed = digestInput.safeParse(raw);
  if (!parsed.success) throw invalid('That digest request is not valid.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  if (!input.venueId && !scope.all) throw invalid('Your role covers only some venues. Ask for one venue at a time.');
  if (input.date && !isRealDate(input.date)) throw invalid('That date does not exist.');
  const settings = await getAnalyticsSettings(ctx);
  const cfg = settings.digest;
  const today = scope.today;

  let from: string;
  let to: string;
  if (input.period === 'day') {
    from = to = input.date ?? addDays(today, -1);
  } else if (input.period === 'week') {
    from = input.date ? weekStart(input.date) : addDays(weekStart(today), -7);
    to = addDays(from, 6);
  } else {
    from = input.date ? monthStart(input.date) : addMonths(monthStart(today), -1);
    to = monthEnd(from);
  }
  if (from > today) throw invalid('That period has not started yet.');
  const complete = to < today;
  const shift = input.period === 'month' ? 35 : 7;
  const n = cfg.baselinePeriods;
  const windowFrom = addDays(from, -shift * n);
  const periodDays = daysOf(from, to);
  const first = await earliest(ctx, scope);

  const base = { ctx, scope, settings, from: windowFrom, to, grain: 'day' as const, filters: {}, source: 'auto' as const, funnel: 'order' };
  const all = (keys: string[]) => new Set(keys.flatMap((k) => getMetric(k)!.measures));
  const salesMeasures = all(HEADLINE.filter((k) => getMetric(k)!.family === 'sales'));
  const fetch = async (fn: (a: FetchArgs) => Promise<{ rows: FamilyRow[] }>, dims: string[], measures: Set<string>) => (await fn({ ...base, dims, measures })).rows;

  const salesByDay = index(await fetch(fetchSales, [], salesMeasures), null);
  const webByDay = index(await fetch(fetchWeb, [], new Set(['sessions'])), null);
  const byChannel = index(await fetch(fetchSales, ['channel'], new Set(['net'])), 'channel');
  const byDaypart = index(await fetch(fetchSales, ['daypart'], new Set(['net'])), 'daypart');
  const byItem = index(await fetch(fetchItems, ['item'], new Set(['revenue'])), 'item');
  const byCampaign = index(await fetch(fetchWeb, ['campaign'], new Set(['sessions'])), 'campaign');

  /** The earlier like-for-like periods that lie wholly inside recorded history. */
  const baselineDays = (since: string | null): string[][] => {
    const out: string[][] = [];
    for (let k = 1; k <= n; k++) {
      const days = periodDays.map((d) => addDays(d, -shift * k));
      if (since && days[0]! >= since) out.push(days);
    }
    return out;
  };
  const salesBase = baselineDays(first.sale);
  const webBase = baselineDays(first.session);

  const caveats: string[] = [];
  const headline: DigestFinding[] = [];
  for (const key of HEADLINE) {
    const def: MetricDef = getMetric(key)!;
    const isWeb = def.family === 'web';
    const series = isWeb ? webByDay : salesByDay;
    const periods = isWeb ? webBase : salesBase;
    const value = def.value(sumOver(series, periodDays, ''));
    const measured = def.aggregation === 'sum' ? (value ?? 0) : value;
    const baseValues = periods.map((days) => def.value(sumOver(series, days, ''))).map((v) => (def.aggregation === 'sum' ? (v ?? 0) : v)).filter((v): v is number => v !== null);
    const finding: DigestFinding = {
      metric: def.key,
      name: def.name,
      unit: def.unit,
      value: measured === null ? null : roundFor(def.unit, measured),
      baseline: null,
      change_abs: null,
      change_pct: null,
      direction: 'unknown',
      reads_as: 'neutral',
      significance: 'insufficient_history',
      usual_range: null,
      baseline_periods: baseValues.length,
      caveats: [],
    };
    if (measured === null) {
      // Unmeasured is not low: a ratio with nothing under it has no value, and says nothing.
      finding.caveats.push('Not measurable for this period: there was nothing to measure it on.');
    } else {
      const c = classify(measured, baseValues, cfg);
      finding.significance = c.significance;
      if (c.mean !== null) {
        finding.baseline = roundFor(def.unit, c.mean);
        const diff = measured - c.mean;
        // The change is the difference of the two figures as shown, so a reader's own subtraction agrees.
        finding.change_abs = roundFor(def.unit, finding.value! - finding.baseline);
        finding.change_pct = c.mean === 0 ? null : Math.round((diff / Math.abs(c.mean)) * 10_000) / 10_000;
        finding.direction = Math.abs(diff) < 1e-9 || (c.mean !== 0 && Math.abs(diff / c.mean) < 0.005) ? 'flat' : diff > 0 ? 'up' : 'down';
        if (finding.direction !== 'flat' && def.direction !== 'neutral') {
          finding.reads_as = (finding.direction === 'up') === (def.direction === 'up_is_good') ? 'good' : 'bad';
        }
        if (c.significance !== 'insufficient_history') {
          finding.usual_range = [roundFor(def.unit, Math.max(0, c.mean - cfg.notableSd * c.spread)), roundFor(def.unit, c.mean + cfg.notableSd * c.spread)];
        }
      }
      if (c.significance === 'insufficient_history') finding.caveats.push(`Only ${baseValues.length} earlier like-for-like ${baseValues.length === 1 ? 'period' : 'periods'} of history: too few to say what is normal.`);
    }
    headline.push(finding);
  }

  // ── Top movers ───────────────────────────────────────────────────────────
  const movers: DigestMover[] = [];
  const rank = (dimension: DigestMover['dimension'], series: Map<string, Map<string, Measures>>, measure: string, metric: string, unit: Unit, periods: string[][], skip: string[] = []) => {
    if (!periods.length) return;
    const members = new Set<string>();
    for (const days of [periodDays, ...periods]) for (const d of days) for (const m of series.get(d)?.keys() ?? []) members.add(m);
    const found: DigestMover[] = [];
    for (const member of [...members].sort()) {
      if (skip.includes(member)) continue;
      const value = Number(sumOver(series, periodDays, member)[measure] ?? 0);
      const baseValues = periods.map((days) => Number(sumOver(series, days, member)[measure] ?? 0));
      const c = classify(value, baseValues, cfg);
      const m = c.mean ?? 0;
      const diff = value - m;
      if (roundFor(unit, value) - roundFor(unit, m) === 0) continue;
      found.push({
        dimension,
        member,
        metric,
        unit,
        value: roundFor(unit, value),
        baseline: roundFor(unit, m),
        change_abs: roundFor(unit, value) - roundFor(unit, m),
        change_pct: m === 0 ? null : Math.round((diff / m) * 10_000) / 10_000,
        direction: diff > 0 ? 'up' : 'down',
        significance: c.significance,
      });
    }
    const by = (dir: 'up' | 'down') =>
      found
        .filter((f) => f.direction === dir)
        .sort((x, y) => Math.abs(y.change_abs) - Math.abs(x.change_abs) || x.member.localeCompare(y.member))
        .slice(0, cfg.topMovers);
    movers.push(...by('up'), ...by('down'));
  };
  rank('item', byItem, 'revenue', 'item_revenue', 'cents', salesBase);
  rank('channel', byChannel, 'net', 'net_sales', 'cents', salesBase);
  rank('daypart', byDaypart, 'net', 'net_sales', 'cents', salesBase);
  rank('campaign', byCampaign, 'sessions', 'web_sessions', 'count', webBase, ['(none)']);

  // ── The same findings in plain words ─────────────────────────────────────
  const label = periodLabel(input.period, from, to);
  const usual = input.period === 'day' ? 'this weekday' : 'these weekdays';
  const sentences: string[] = [];
  const net = headline.find((f) => f.metric === 'net_sales')!;
  const orders = headline.find((f) => f.metric === 'orders')!;
  if (!orders.value) {
    sentences.push(`${label}: no sales were recorded.`);
    caveats.push('No sales were recorded for this period. That can mean the venue was closed or that sales have not reached the ledger; it is not evidence of a bad period.');
  } else if (net.baseline === null || net.significance === 'insufficient_history') {
    sentences.push(`${label}: net sales ${show('cents', net.value ?? 0)} from ${show('count', orders.value)} orders. There is not enough history yet to say what is usual.`);
  } else {
    const how = net.direction === 'flat' ? 'in line with' : `${pct(net.change_pct).replace(/^[+-]/, '')} ${net.direction === 'up' ? 'above' : 'below'}`;
    const note = net.significance === 'normal' ? 'within normal variation' : net.significance === 'strong' ? 'well outside normal variation' : 'outside normal variation';
    sentences.push(`${label}: net sales ${show('cents', net.value ?? 0)} from ${show('count', orders.value)} orders, ${how} the usual ${show('cents', net.baseline)} for ${usual} (${note}).`);
  }
  const flaggedFindings = headline.filter((f) => f.significance === 'notable' || f.significance === 'strong');
  for (const f of flaggedFindings.filter((x) => x.metric !== 'net_sales')) {
    sentences.push(`${f.name} ${f.direction === 'up' ? 'higher' : 'lower'} than usual: ${show(f.unit, f.value ?? 0)} against ${show(f.unit, f.baseline ?? 0)} (${pct(f.change_pct)}).`);
  }
  if (orders.value && !flaggedFindings.length && net.significance !== 'insufficient_history') sentences.push('Nothing moved beyond normal variation.');
  const tell = (dimension: DigestMover['dimension'], word: string) => {
    const ups = movers.filter((m) => m.dimension === dimension && m.direction === 'up');
    const downs = movers.filter((m) => m.dimension === dimension && m.direction === 'down');
    const fmt = (m: DigestMover) => `${m.member} (${m.change_abs > 0 ? '+' : '-'}${show(m.unit, Math.abs(m.change_abs))})`;
    if (ups.length) sentences.push(`${word} up most: ${ups.map(fmt).join(', ')}.`);
    if (downs.length) sentences.push(`${word} down most: ${downs.map(fmt).join(', ')}.`);
  };
  if (orders.value) {
    tell('item', 'Items');
    tell('daypart', 'Dayparts');
    tell('channel', 'Channels');
  }
  tell('campaign', 'Campaign visits');

  if (!complete) caveats.push(`The period is still in progress (today is ${today}), so totals will rise.`);
  if (salesBase.length < n) caveats.push(`The baseline uses ${salesBase.length} of ${n} earlier periods: sales history starts on ${first.sale ?? 'no recorded day'}.`);
  const identified = headline.find((f) => f.metric === 'identified_share');
  if (identified?.value !== null && identified?.value !== undefined) {
    caveats.push(`${Math.round(identified.value * 100)}% of sales in the period are tied to a known customer; the new and returning counts describe only those.`);
  }
  caveats.push('A flagged change is a difference from the usual pattern, not an explanation of it.');

  return {
    version: DIGEST_VERSION,
    period: { kind: input.period, from, to, complete },
    venue: input.venueId ? scope.venues[0]!.name : null,
    currency: scope.currency,
    baseline: {
      method: `The same ${dayDiff(from, to) + 1 === 1 ? 'weekday' : 'weekdays'}, slid back ${shift} days at a time, for up to ${n} earlier periods; "usual" is their mean and "normal variation" is ${cfg.notableSd} standard deviations around it.`,
      periods_asked: n,
      shift_days: shift,
      earliest_from: windowFrom,
    },
    headline,
    flagged: flaggedFindings.map((f) => f.metric),
    movers,
    summary: sentences.join(' '),
    caveats,
    as_of: ctx.now().toISOString(),
  };
}

export interface StoredDigest extends Digest {
  id: string;
  generated_at: string;
}

/** Compute the digest and keep it. One row per org or venue, period kind and period start; a rebuild replaces it. */
export async function buildDigest(ctx: Ctx, raw: DigestInput): Promise<StoredDigest> {
  const digest = await computeDigest(ctx, raw);
  const venueId = digestInput.parse(raw).venueId ?? null;
  const row = await sql<{ id: string; generated_at: Date }>`
    insert into insight_digests (org_id, venue_id, period, period_start, period_end, payload, summary, generated_at)
    values (${ctx.orgId}, ${venueId}, ${digest.period.kind}, ${digest.period.from}::date, ${digest.period.to}::date, ${json(digest)}::jsonb, ${digest.summary}, ${ctx.now()})
    on conflict (org_id, coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid), period, period_start)
    do update set period_end = excluded.period_end, payload = excluded.payload, summary = excluded.summary, generated_at = excluded.generated_at
    returning id, generated_at`.execute(ctx.db);
  return { ...digest, id: row.rows[0]!.id, generated_at: row.rows[0]!.generated_at.toISOString() };
}

export const listDigestsInput = z
  .object({ venueId: z.string().uuid().optional(), period: z.enum(['day', 'week', 'month']).optional(), limit: z.number().int().min(1).max(100).default(12) })
  .strict();

/** Stored digests, newest first. Org-level digests are shown only to callers who can see every venue. */
export async function listDigests(ctx: Ctx, raw: z.input<typeof listDigestsInput> = {}): Promise<StoredDigest[]> {
  const input = listDigestsInput.parse(raw);
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  let q = ctx.db
    .selectFrom('insight_digests')
    .select(['id', 'venue_id', 'payload', 'generated_at'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('period_start', 'desc')
    .orderBy('generated_at', 'desc')
    .limit(input.limit);
  if (input.venueId) q = q.where('venue_id', '=', input.venueId);
  else if (scope.all) q = q.where('venue_id', 'is', null);
  else q = q.where('venue_id', 'in', scope.venueIds);
  if (input.period) q = q.where('period', '=', input.period);
  const rows = await q.execute();
  return rows.map((r) => ({ ...(r.payload as unknown as Digest), id: r.id, generated_at: r.generated_at.toISOString() }));
}
