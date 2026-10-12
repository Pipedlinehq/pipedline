import { z } from 'zod';
import { type Ctx, addDays, audit, conflict, invalid, isUniqueViolation, json, notFound, requireStaff } from '@ros/core';
import { getMetric } from './catalogue';
import { type MetricExport, exportMetrics } from './export';
import { COMPARISONS, GRAINS, type Grain, dayDiff, isRealDate, monthEnd, periodInput, resolvePeriod } from './period';
import { type MetricQuery, type MetricResult, metricQueryInput, queryMetrics } from './query';
import { resolveScope } from './scope';
import { parseInput } from './util';

/**
 * Reports (docs/CONSOLE_IA.md section 9, pattern 9): a catalogue of questions, by category, each
 * a metric query from the catalogue with a chart to draw it. The default reports are code and
 * say "Created by Pipedline"; a venue saves its own on top, per organisation. Running a report is
 * queryMetrics with the report's question and the period, comparison and venue the reader chose,
 * so a report can never show a figure the catalogue would not, nor a venue the reader cannot see.
 *
 * Nothing here computes a number. Targets are compared with the catalogue's own value for the
 * month; annotations are labels on dates.
 */
export const REPORT_CATEGORIES = ['sales', 'guests', 'bookings', 'menu', 'delivery', 'marketing', 'team'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export const REPORT_CHARTS = ['line', 'bars', 'rank', 'cohort', 'tiles'] as const;
export type ReportChart = (typeof REPORT_CHARTS)[number];

export const REPORT_CATEGORY_WORDS: Record<ReportCategory, { title: string; blurb: string }> = {
  sales: { title: 'Sales', blurb: 'What came through the till, when, and how it left.' },
  guests: { title: 'Guests', blurb: 'Who comes back, how often, and where they came from.' },
  bookings: { title: 'Bookings', blurb: 'Covers, no-shows and lead time.' },
  menu: { title: 'Menu', blurb: 'What sells, what sells with what, and what is fading.' },
  delivery: { title: 'Delivery', blurb: 'Orders that leave by courier.' },
  marketing: { title: 'Marketing', blurb: 'Visits, campaigns and the messages you send.' },
  team: { title: 'Team', blurb: 'Tips and service.' },
};

/** The question a report asks, without its period: the reader supplies that when running it. */
export const reportQueryInput = metricQueryInput
  .omit({ period: true, compareTo: true, grain: true })
  .extend({
    /** 'auto' picks day, week or month from the length of the period asked for. */
    grain: z.enum(['auto', ...GRAINS]).optional(),
  });
export type ReportQuery = z.input<typeof reportQueryInput>;

export interface ReportDef {
  /** A default report's key (`sales.over_time`), or `saved:<id>` for the venue's own. */
  key: string;
  id: string | null;
  name: string;
  description: string;
  category: ReportCategory;
  chart: ReportChart;
  query: ReportQuery;
  /** "Pipedline" for a default; the staff member's name for a saved one. */
  createdBy: string;
  createdAt: Date | null;
}

const report = (key: string, category: ReportCategory, name: string, description: string, chart: ReportChart, query: ReportQuery): ReportDef => ({ key, id: null, name, description, category, chart, query, createdBy: 'Pipedline', createdAt: null });

/** The default reports. Every number is one the catalogue defines; the page never recomputes one. */
export const DEFAULT_REPORTS: ReportDef[] = [
  report('sales.over_time', 'sales', 'Sales over time', 'Net sales and orders by day, week or month.', 'line', { metrics: ['net_sales', 'orders'], grain: 'auto' }),
  report('sales.avg_order_value', 'sales', 'Average spend per order', 'What a guest paid per order, over time.', 'line', { metrics: ['avg_order_value', 'items_per_order'], grain: 'auto' }),
  report('sales.by_channel', 'sales', 'Sales by how it left', 'Dine-in, pickup and delivery side by side.', 'bars', { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['channel'] }),
  report('sales.by_daypart', 'sales', 'Sales by daypart', 'Breakfast, lunch, dinner and late.', 'bars', { metrics: ['net_sales', 'orders'], dimensions: ['daypart'] }),
  report('sales.by_day_of_week', 'sales', 'Sales by weekday', 'Which days carry the week.', 'bars', { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['day_of_week'] }),
  report('sales.by_hour', 'sales', 'Orders by hour', 'When the orders come in, venue time.', 'bars', { metrics: ['orders', 'net_sales'], dimensions: ['hour'] }),
  report('sales.refunds_and_discounts', 'sales', 'Refunds and discounts', 'Money given back and money given away.', 'tiles', { metrics: ['refunds', 'refund_rate', 'discounts', 'discount_rate'] }),
  report('sales.by_venue', 'sales', 'Sales by venue', 'Each venue side by side.', 'bars', { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['venue'] }),
  report('guests.new_and_returning', 'guests', 'New and returning guests', 'Known guests buying for the first time against those coming back.', 'line', { metrics: ['new_customers', 'returning_customers'], grain: 'auto' }),
  report('guests.repeat', 'guests', 'Repeat rate', 'How many known guests have been back, and how soon.', 'tiles', { metrics: ['customers_total', 'repeat_rate', 'one_timer_share', 'median_days_to_second_order'] }),
  report('guests.segments', 'guests', 'Guest groups', 'Known guests by how often they come: new, one-timers, regulars, at risk, lapsed.', 'rank', { metrics: ['customers_total', 'customer_share', 'customer_spend'], dimensions: ['segment'] }),
  report('guests.cohorts', 'guests', 'Repeat-visit cohorts', 'Of the guests who first came in a month, the share who came back in each month after.', 'cohort', { metrics: ['cohort_size', 'cohort_retention_rate'], grain: 'month' }),
  report('guests.by_source', 'guests', 'Guests by where they came from', 'Known guests by the source stamped when their record was made.', 'rank', { metrics: ['customers_total', 'repeat_rate', 'customer_lifetime_value'], dimensions: ['acquisition_source'] }),
  report('menu.top_items', 'menu', 'Top items', 'What sells, by revenue, with how many orders include it.', 'rank', { metrics: ['item_revenue', 'item_quantity', 'item_attach_rate'], dimensions: ['item'], sort: { by: 'item_revenue', direction: 'desc' }, limit: 25 }),
  report('menu.sections', 'menu', 'Revenue by menu section', 'Each section\'s share of item revenue.', 'rank', { metrics: ['item_revenue', 'item_revenue_share', 'item_quantity'], dimensions: ['category'] }),
  report('menu.items_per_order', 'menu', 'Items per order', 'How many items a guest orders, over time.', 'line', { metrics: ['items_per_order', 'items_sold'], grain: 'auto' }),
  report('delivery.over_time', 'delivery', 'Delivery sales over time', 'Net sales and orders that left by courier.', 'line', { metrics: ['net_sales', 'orders'], filters: { channel: 'delivery' }, grain: 'auto' }),
  report('delivery.by_hour', 'delivery', 'Delivery orders by hour', 'When delivery orders come in.', 'bars', { metrics: ['orders', 'net_sales'], dimensions: ['hour'], filters: { channel: 'delivery' } }),
  report('marketing.visits', 'marketing', 'Visits to your site', 'Visits to the website and QR menu, over time.', 'line', { metrics: ['web_sessions'], grain: 'auto' }),
  report('marketing.traffic_sources', 'marketing', 'Where visits come from', 'Visits by traffic source.', 'rank', { metrics: ['web_sessions'], dimensions: ['utm_source'] }),
  report('marketing.campaigns', 'marketing', 'Campaign outcomes', 'Visits, new guests, orders and spend aligned with each campaign.', 'rank', { metrics: ['campaign_sessions', 'campaign_new_customers', 'campaign_orders', 'campaign_revenue'], dimensions: ['campaign'] }),
  report('marketing.messages', 'marketing', 'Messages sent and opened', 'Emails and texts: sent, delivered, opened, clicked, opted out.', 'tiles', { metrics: ['messages_sent', 'messages_delivered', 'message_open_rate', 'message_click_rate', 'messages_unsubscribed'] }),
  report('marketing.funnel', 'marketing', 'Order funnel', 'Visits reaching each step on the way to an order.', 'bars', { metrics: ['funnel_sessions', 'funnel_conversion_rate'], dimensions: ['funnel_step'] }),
  report('team.tips', 'team', 'Tips', 'Tips paid and the tip rate, over time.', 'line', { metrics: ['tips', 'tip_rate'], grain: 'auto' }),
];

const defaultByKey = new Map(DEFAULT_REPORTS.map((r) => [r.key, r]));
if (defaultByKey.size !== DEFAULT_REPORTS.length) throw new Error('Duplicate report key');

/** Default reports whose metrics all exist in the catalogue: a typo here would be caught at load. */
for (const r of DEFAULT_REPORTS) for (const m of r.query.metrics) if (!getMetric(m)) throw new Error(`Report ${r.key} names an unknown metric ${m}`);

// ── Saved reports ─────────────────────────────────────────────────────────────

const COLS = ['id', 'name', 'description', 'category', 'chart', 'query', 'created_by_id', 'created_at'] as const;
type Row = { id: string; name: string; description: string | null; category: string; chart: string; query: unknown; created_by_id: string | null; created_at: Date };

async function staffNames(ctx: Ctx, ids: Array<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  const rows = await ctx.db.selectFrom('staff').select(['id', 'first_name', 'last_name']).where('id', 'in', wanted).execute();
  return new Map(rows.map((r) => [r.id, [r.first_name, r.last_name].filter(Boolean).join(' ')]));
}

const savedDef = (r: Row, names: Map<string, string>): ReportDef => ({
  key: `saved:${r.id}`,
  id: r.id,
  name: r.name,
  description: r.description ?? '',
  category: r.category as ReportCategory,
  chart: r.chart as ReportChart,
  query: r.query as ReportQuery,
  createdBy: (r.created_by_id && names.get(r.created_by_id)) || 'A team member',
  createdAt: r.created_at,
});

export const listReportsInput = z.object({ category: z.enum(REPORT_CATEGORIES).optional() }).strict();

/** The catalogue: the defaults, then the organisation's own, by category. Read-only staff and above. */
export async function listReports(ctx: Ctx, raw: z.input<typeof listReportsInput> = {}): Promise<ReportDef[]> {
  const input = parseInput(listReportsInput, raw, 'That report list');
  await resolveScope(ctx);
  let q = ctx.db.selectFrom('report_definitions').select(COLS).where('org_id', '=', ctx.orgId).orderBy('category').orderBy('name');
  if (input.category) q = q.where('category', '=', input.category);
  const rows = await q.execute();
  const names = await staffNames(ctx, rows.map((r) => r.created_by_id));
  return [...DEFAULT_REPORTS.filter((r) => !input.category || r.category === input.category), ...rows.map((r) => savedDef(r, names))];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One report by its key (`sales.over_time`, `saved:<id>`, a saved id, or a name). Another org's is not found. */
export async function getReport(ctx: Ctx, ref: string): Promise<ReportDef> {
  await resolveScope(ctx);
  const key = ref.trim();
  const def = defaultByKey.get(key);
  if (def) return def;
  const id = key.startsWith('saved:') ? key.slice(6) : key;
  let q = ctx.db.selectFrom('report_definitions').select(COLS).where('org_id', '=', ctx.orgId);
  q = UUID.test(id) ? q.where('id', '=', id) : q.where((eb) => eb(eb.fn('lower', ['name']), '=', key.toLowerCase()));
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Report not found');
  return savedDef(row, await staffNames(ctx, [row.created_by_id]));
}

export const saveReportInput = z
  .object({
    name: z.string().trim().min(1, 'Give the report a name.').max(80),
    description: z.string().trim().max(400).nullish(),
    category: z.enum(REPORT_CATEGORIES),
    chart: z.enum(REPORT_CHARTS).default('line'),
    query: reportQueryInput,
    /** Update this saved report instead of making a new one. */
    id: z.string().uuid().optional(),
  })
  .strict();

/**
 * Save a report for the organisation ("Save as"). Manager and above. The question is proved by
 * running it once with a short period, so a saved report is always one that can be run. A default
 * report's name may be reused: the venue's own is listed beside it with who made it.
 */
export async function saveReport(ctx: Ctx, raw: z.input<typeof saveReportInput>): Promise<ReportDef> {
  const input = parseInput(saveReportInput, raw, 'That report');
  const staff = requireStaff(ctx, { minRole: 'manager' });
  const stored = (raw as { query: ReportQuery }).query;
  await queryMetrics(ctx, toMetricQuery(stored, { period: 'last_7_days' }, null, 'day', 1));
  let row: Row;
  if (input.id) {
    const before = await ctx.db.selectFrom('report_definitions').select(COLS).where('org_id', '=', ctx.orgId).where('id', '=', input.id).executeTakeFirst();
    if (!before) throw notFound('Report not found');
    try {
      row = await ctx.db
        .updateTable('report_definitions')
        .set({ name: input.name, description: input.description ?? null, category: input.category, chart: input.chart, query: json(stored), updated_at: ctx.now() })
        .where('id', '=', before.id)
        .returning(COLS)
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A report with that name already exists.');
      throw e;
    }
    await audit(ctx, { action: 'analytics.report_updated', entityType: 'report', entityId: row.id, before: { name: before.name, query: before.query }, after: { name: row.name, category: row.category, chart: row.chart, query: row.query } });
  } else {
    try {
      row = await ctx.db
        .insertInto('report_definitions')
        .values({ org_id: ctx.orgId, name: input.name, description: input.description ?? null, category: input.category, chart: input.chart, query: json(stored), created_by_id: staff?.staffId ?? null, created_at: ctx.now(), updated_at: ctx.now() })
        .returning(COLS)
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A report with that name already exists.');
      throw e;
    }
    await audit(ctx, { action: 'analytics.report_saved', entityType: 'report', entityId: row.id, after: { name: row.name, category: row.category, chart: row.chart, query: row.query } });
  }
  return savedDef(row, await staffNames(ctx, [row.created_by_id]));
}

/** Remove a saved report. Manager and above. A default report cannot be removed. */
export async function deleteReport(ctx: Ctx, id: string): Promise<void> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Report not found');
  requireStaff(ctx, { minRole: 'manager' });
  const row = await ctx.db.selectFrom('report_definitions').select(COLS).where('org_id', '=', ctx.orgId).where('id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('Report not found');
  await ctx.db.deleteFrom('report_definitions').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'analytics.report_deleted', entityType: 'report', entityId: row.id, before: { name: row.name, query: row.query } });
}

// ── Running a report ──────────────────────────────────────────────────────────

export const runReportInput = z
  .object({
    report: z.string().trim().min(1).max(120),
    period: periodInput.default('last_28_days'),
    compareTo: z.enum(COMPARISONS).optional(),
    venueId: z.string().uuid().optional(),
    grain: z.enum(GRAINS).optional(),
    limit: z.number().int().min(1).max(5000).optional(),
  })
  .strict();
export type RunReportInput = z.input<typeof runReportInput>;

export interface Annotation {
  id: string;
  venueId: string | null;
  date: string;
  label: string;
  createdBy: string;
  createdAt: Date;
}

export interface ReportRun {
  report: ReportDef;
  result: MetricResult;
  /** Annotations whose date falls in the period, for the chart. */
  annotations: Annotation[];
}

/** A readable number of points for a period of this many days. */
export function grainForDays(days: number): Grain {
  return days <= 62 ? 'day' : days <= 190 ? 'week' : 'month';
}

/** The report's question with the reader's period, comparison, venue and grain put in. */
export function toMetricQuery(query: ReportQuery, run: { period: z.input<typeof periodInput>; compareTo?: (typeof COMPARISONS)[number] }, venueId: string | null, autoGrain: Grain, limit?: number): MetricQuery {
  const { grain: wanted, filters, ...rest } = query;
  const out: MetricQuery = { ...rest, filters: { ...(filters ?? {}) }, period: run.period };
  if (venueId) out.filters!.venue = venueId;
  if (run.compareTo) out.compareTo = run.compareTo;
  const grain = wanted === 'auto' ? autoGrain : wanted;
  if (grain) out.grain = grain;
  if (limit) out.limit = limit;
  return out;
}

/**
 * Run a report: queryMetrics with the report's question and the reader's choices. The result is
 * exactly what queryMetrics gives for that question, with the annotations in the period beside it.
 * Read-only staff and above; a venue the reader has no role at is not found.
 */
export async function runReport(ctx: Ctx, raw: RunReportInput): Promise<ReportRun> {
  const input = parseInput(runReportInput, raw, 'That report run');
  const def = await getReport(ctx, input.report);
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  const resolved = resolvePeriod(input.period, scope.today);
  const auto = def.chart === 'cohort' ? 'month' : grainForDays(resolved.days);
  const query = toMetricQuery(def.query, { period: input.period, compareTo: input.compareTo }, input.venueId ?? null, input.grain ?? auto, input.limit);
  const result = await queryMetrics(ctx, query);
  const annotations = await listAnnotations(ctx, { from: result.period.from, to: result.period.to, venueId: input.venueId });
  return { report: def, result, annotations };
}

export const exportReportInput = runReportInput.extend({ format: z.enum(['csv', 'ndjson']).default('csv') });

/** A report's rows as a file: the same question, through exportMetrics (owner only, audited). */
export async function exportReport(ctx: Ctx, raw: z.input<typeof exportReportInput>): Promise<MetricExport> {
  const input = parseInput(exportReportInput, raw, 'That export');
  const def = await getReport(ctx, input.report);
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  const resolved = resolvePeriod(input.period, scope.today);
  const auto = def.chart === 'cohort' ? 'month' : grainForDays(resolved.days);
  const query = toMetricQuery(def.query, { period: input.period, compareTo: input.compareTo }, input.venueId ?? null, input.grain ?? auto);
  const out = await exportMetrics(ctx, { query, format: input.format });
  return { ...out, filename: `${def.key.replace(/[^a-z0-9_.-]/gi, '_')}_${out.result.period.from}_${out.result.period.to}.${input.format}` };
}

// ── Annotations ───────────────────────────────────────────────────────────────

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30.');

export const addAnnotationInput = z
  .object({
    date: DAY,
    label: z.string().trim().min(1, 'Say what happened.').max(80),
    /** For one venue, or every venue when left out. */
    venueId: z.string().uuid().nullish(),
  })
  .strict();

const ANN_COLS = ['id', 'venue_id', 'on_date', 'label', 'created_by_id', 'created_at'] as const;
type AnnRow = { id: string; venue_id: string | null; on_date: string; label: string; created_by_id: string | null; created_at: Date };
const annotation = (r: AnnRow, names: Map<string, string>): Annotation => ({ id: r.id, venueId: r.venue_id, date: String(r.on_date).slice(0, 10), label: r.label, createdBy: (r.created_by_id && names.get(r.created_by_id)) || 'A team member', createdAt: r.created_at });

/** Mark a date on every report chart ("Menu change", "Public holiday"). Manager and above. */
export async function addAnnotation(ctx: Ctx, raw: z.input<typeof addAnnotationInput>): Promise<Annotation> {
  const input = parseInput(addAnnotationInput, raw, 'That annotation');
  if (!isRealDate(input.date)) throw invalid('That date does not exist.');
  const staff = requireStaff(ctx, { venueId: input.venueId ?? undefined, minRole: 'manager' });
  if (input.venueId) await resolveScope(ctx, [input.venueId], 'manager');
  const row = await ctx.db
    .insertInto('report_annotations')
    .values({ org_id: ctx.orgId, venue_id: input.venueId ?? null, on_date: input.date, label: input.label, created_by_id: staff?.staffId ?? null, created_at: ctx.now() })
    .returning(ANN_COLS)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'analytics.annotation_added', entityType: 'report_annotation', entityId: row.id, venueId: input.venueId ?? null, after: { date: input.date, label: input.label } });
  return annotation(row, await staffNames(ctx, [row.created_by_id]));
}

export const listAnnotationsInput = z.object({ from: DAY, to: DAY, venueId: z.string().uuid().optional() }).strict();

/** Annotations between two venue-local dates: the venue's own and the organisation-wide ones. */
export async function listAnnotations(ctx: Ctx, raw: z.input<typeof listAnnotationsInput>): Promise<Annotation[]> {
  const input = parseInput(listAnnotationsInput, raw, 'That annotation list');
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  const rows = await ctx.db
    .selectFrom('report_annotations')
    .select(ANN_COLS)
    .where('org_id', '=', ctx.orgId)
    .where('on_date', '>=', input.from)
    .where('on_date', '<=', input.to)
    .where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', 'in', scope.venueIds)]))
    .orderBy('on_date')
    .orderBy('created_at')
    .execute();
  const names = await staffNames(ctx, rows.map((r) => r.created_by_id));
  return rows.map((r) => annotation(r, names));
}

/** Take an annotation off. Manager and above; another org's is not found. */
export async function deleteAnnotation(ctx: Ctx, id: string): Promise<void> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Annotation not found');
  requireStaff(ctx, { minRole: 'manager' });
  const row = await ctx.db.selectFrom('report_annotations').select(ANN_COLS).where('org_id', '=', ctx.orgId).where('id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('Annotation not found');
  await ctx.db.deleteFrom('report_annotations').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'analytics.annotation_removed', entityType: 'report_annotation', entityId: row.id, venueId: row.venue_id, before: { date: row.on_date, label: row.label } });
}

// ── Targets ───────────────────────────────────────────────────────────────────

const MONTH = z.string().regex(/^\d{4}-\d{2}$/, 'Use a month like 2026-09.');

export const setTargetInput = z
  .object({
    metric: z.string().min(1).max(60),
    /** YYYY-MM. */
    month: MONTH,
    /** In the metric's own unit: cents for money, a share between 0 and 1 for a rate. */
    target: z.number().min(0),
    venueId: z.string().uuid().nullish(),
  })
  .strict();

export interface Target {
  id: string;
  metric: string;
  month: string;
  target: number;
  venueId: string | null;
}

const T_COLS = ['id', 'venue_id', 'metric', 'month', 'target'] as const;
const targetOf = (r: { id: string; venue_id: string | null; metric: string; month: string; target: number | string }): Target => ({ id: r.id, metric: r.metric, month: String(r.month).slice(0, 7), target: Number(r.target), venueId: r.venue_id });

/** Set (or replace) the number a venue is aiming for: one metric, one month. Manager and above. */
export async function setTarget(ctx: Ctx, raw: z.input<typeof setTargetInput>): Promise<Target> {
  const input = parseInput(setTargetInput, raw, 'That target');
  const def = getMetric(input.metric);
  if (!def) throw invalid(`"${input.metric}" is not a metric.`);
  if (def.aggregation === 'distinct') throw invalid(`${def.name} counts people and does not add up over a month, so it cannot have a monthly target.`);
  const staff = requireStaff(ctx, { venueId: input.venueId ?? undefined, minRole: 'manager' });
  if (input.venueId) await resolveScope(ctx, [input.venueId], 'manager');
  const month = `${input.month}-01`;
  const before = await ctx.db
    .selectFrom('report_targets')
    .select(T_COLS)
    .where('org_id', '=', ctx.orgId)
    .where('metric', '=', input.metric)
    .where('month', '=', month)
    .where((eb) => (input.venueId ? eb('venue_id', '=', input.venueId) : eb('venue_id', 'is', null)))
    .executeTakeFirst();
  const row = before
    ? await ctx.db.updateTable('report_targets').set({ target: input.target, updated_at: ctx.now() }).where('id', '=', before.id).returning(T_COLS).executeTakeFirstOrThrow()
    : await ctx.db
        .insertInto('report_targets')
        .values({ org_id: ctx.orgId, venue_id: input.venueId ?? null, metric: input.metric, month, target: input.target, created_by_id: staff?.staffId ?? null, created_at: ctx.now(), updated_at: ctx.now() })
        .returning(T_COLS)
        .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'analytics.target_set', entityType: 'report_target', entityId: row.id, venueId: input.venueId ?? null, before: before ? { target: Number(before.target) } : undefined, after: { metric: input.metric, month: input.month, target: input.target } });
  return targetOf(row);
}

/** Remove a target. Manager and above. */
export async function deleteTarget(ctx: Ctx, id: string): Promise<void> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Target not found');
  requireStaff(ctx, { minRole: 'manager' });
  const row = await ctx.db.selectFrom('report_targets').select(T_COLS).where('org_id', '=', ctx.orgId).where('id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('Target not found');
  await ctx.db.deleteFrom('report_targets').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'analytics.target_removed', entityType: 'report_target', entityId: row.id, venueId: row.venue_id, before: { metric: row.metric, month: row.month, target: Number(row.target) } });
}

export const targetProgressInput = z
  .object({
    metric: z.string().min(1).max(60),
    /** YYYY-MM. Default: the current month. */
    month: MONTH.optional(),
    venueId: z.string().uuid().optional(),
  })
  .strict();

export interface TargetProgress {
  metric: string;
  name: string;
  unit: string;
  month: string;
  venueId: string | null;
  target: number | null;
  /** The catalogue's value for the month so far (or the whole month, once over). */
  actual: number | null;
  /** actual ÷ target. */
  progress: number | null;
  daysElapsed: number;
  daysInMonth: number;
  /** For a metric that adds up: what the target implies for the days so far. Null for a rate. */
  expectedSoFar: number | null;
  /** Ahead of or on the pace the target needs; null when nothing can be said. */
  onTrack: boolean | null;
  period: { from: string; to: string };
}

/**
 * How a month stands against its target. The actual is queryMetrics for the month so far, so it
 * agrees with every report; the target is the venue's own number. Read-only staff and above.
 */
export async function targetProgress(ctx: Ctx, raw: z.input<typeof targetProgressInput>): Promise<TargetProgress> {
  const input = parseInput(targetProgressInput, raw, 'That target');
  const def = getMetric(input.metric);
  if (!def) throw invalid(`"${input.metric}" is not a metric.`);
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  const month = input.month ?? scope.today.slice(0, 7);
  const from = `${month}-01`;
  const end = monthEnd(from);
  const to = end < scope.today ? end : scope.today;
  if (from > scope.today) throw invalid('That month has not started yet.');
  const daysInMonth = dayDiff(from, end) + 1;
  const daysElapsed = dayDiff(from, to) + 1;
  const row = await ctx.db
    .selectFrom('report_targets')
    .select(T_COLS)
    .where('org_id', '=', ctx.orgId)
    .where('metric', '=', input.metric)
    .where('month', '=', from)
    .where((eb) => (input.venueId ? eb('venue_id', '=', input.venueId) : eb('venue_id', 'is', null)))
    .executeTakeFirst();
  const target = row ? Number(row.target) : null;
  const result = await queryMetrics(ctx, { metrics: [input.metric], period: { from, to }, ...(input.venueId ? { filters: { venue: input.venueId } } : {}) });
  const actual = result.totals.values[input.metric] ?? null;
  const adds = def.aggregation === 'sum';
  const expectedSoFar = target !== null && adds ? Math.round((target * daysElapsed) / daysInMonth) : null;
  const onTrack = target === null || actual === null ? null : adds ? actual >= expectedSoFar! : def.direction === 'down_is_good' ? actual <= target : actual >= target;
  return {
    metric: def.key,
    name: def.name,
    unit: def.unit,
    month,
    venueId: input.venueId ?? null,
    target,
    actual,
    progress: target && actual !== null ? Math.round((actual / target) * 10_000) / 10_000 : null,
    daysElapsed,
    daysInMonth,
    expectedSoFar,
    onTrack,
    period: { from, to },
  };
}

export const listTargetsInput = z.object({ venueId: z.string().uuid().optional(), metric: z.string().max(60).optional() }).strict();

/** The targets set, newest month first. */
export async function listTargets(ctx: Ctx, raw: z.input<typeof listTargetsInput> = {}): Promise<Target[]> {
  const input = parseInput(listTargetsInput, raw, 'That target list');
  const scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  let q = ctx.db
    .selectFrom('report_targets')
    .select(T_COLS)
    .where('org_id', '=', ctx.orgId)
    .where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', 'in', scope.venueIds)]))
    .orderBy('month', 'desc')
    .orderBy('metric');
  if (input.venueId) q = q.where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', input.venueId!)]));
  if (input.metric) q = q.where('metric', '=', input.metric);
  return (await q.execute()).map(targetOf);
}

/** The first day of the month after a date, for "next month" links. */
export function nextMonth(d: string): string {
  return addDays(monthEnd(d), 1);
}
