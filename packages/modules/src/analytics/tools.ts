import { z } from 'zod';
import { type ToolContext, defineTool } from '@ros/core';
import { eventDictionary } from '../events/sessions';
import { FAMILIES, METRICS, metricCatalogue } from './catalogue';
import { buildDigest } from './digest';
import { funnelNames, funnelSteps } from './families/web';
import { campaignOutcomes } from './outcomes';
import { COMPARISONS, GRAINS, RELATIVE_PERIODS } from './period';
import { type MetricResult, queryMetrics } from './query';
import { pickVenue, resolveScope } from './scope';
import { customersSummary, funnelReport, menuPerformance, salesSummary } from './summaries';
import { listViews, runView } from './views';

/**
 * The assistant's view of analytics. Every tool is a read, is pinned to the same function the
 * console calls, and declares its output as an allowlist. Nothing here can return a guest: the
 * functions underneath only ever produce aggregates, and the output shapes have no field a
 * guest's name, contact detail or identifier could travel in.
 *
 * Written for a reader that cannot see a chart: units sit beside every number, comparisons are
 * included, each answer has a one-sentence summary built from a template (never by a model),
 * the caveats that apply to it, and the moment it was computed.
 */
const venueArg = z.string().min(1).max(120).optional().describe('A venue name, its address slug or its id, to look at one venue. Leave out for every venue this key can see.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const periodArg = z
  .union([z.enum(RELATIVE_PERIODS), z.object({ from: date, to: date }).strict()])
  .describe('A named period, or { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } in the venue\'s own calendar dates, both inclusive. last_N_days means N complete days ending yesterday.');

/** The venue a tool call is about: the one named, else the one the hub resolved, else all the key can see. */
async function venueOf(t: ToolContext, named: string | undefined): Promise<string | undefined> {
  if (!named) return t.venueId ?? undefined;
  return pickVenue(await resolveScope(t.ctx), named)?.[0];
}

const periodShape = z.object({ from: z.string(), to: z.string(), days: z.number(), label: z.string(), timezone: z.string(), includes_today: z.boolean() });
const compareShape = z.object({ kind: z.string(), from: z.string(), to: z.string(), days: z.number(), basis: z.string() }).nullable();
const numbers = z.record(z.string(), z.number().nullable());
const freshnessShape = z.object({ latest_sale_at: z.string().nullable(), latest_sale_ingested_at: z.string().nullable() });
const significance = z.enum(['normal', 'notable', 'strong', 'insufficient_history']);

// ── metrics_catalogue ───────────────────────────────────────────────────────

export const metricsCatalogueTool = defineTool({
  name: 'metrics_catalogue',
  module: 'analytics',
  title: 'What can be measured',
  description:
    'Lists every metric that exists, grouped, with its unit, what it means, which dimensions it can be split by, which time grains it supports, and the caveats to keep in mind. Call this first, before metrics_query, and use only the keys it returns. Pass a group to see one group with full definitions.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    group: z.string().max(60).optional().describe('A group key such as sales, items, customers, customer_base, cohorts, web, events, funnel, campaigns or messages. Leave out for every group in brief.'),
  }),
  output: z.object({
    catalogue_version: z.number(),
    groups: z.array(
      z.object({
        group: z.string(),
        name: z.string(),
        what_the_period_selects: z.string(),
        time_grains: z.array(z.string()),
        dimensions: z.array(z.string()),
        caveats: z.array(z.string()),
        metrics: z.array(
          z.object({
            key: z.string(),
            name: z.string(),
            unit: z.string(),
            description: z.string(),
            how_it_is_computed: z.string().optional(),
            adds_up_across_rows: z.boolean(),
            good_direction: z.string(),
            needs_one_of_dimensions: z.array(z.string()).optional(),
            caveats: z.array(z.string()).optional(),
            definition_version: z.number(),
          }),
        ),
      }),
    ),
    dimensions: z.array(z.object({ key: z.string(), name: z.string(), description: z.string(), values: z.string().optional() })),
    units: z.record(z.string(), z.string()),
    periods: z.array(z.string()),
    comparisons: z.array(z.string()),
    summary: z.string(),
  }),
  async run(_t, input) {
    const cat = metricCatalogue();
    const families = Object.values(FAMILIES).filter((f) => !input.group || f.key === input.group);
    const full = !!input.group;
    return {
      catalogue_version: cat.version,
      groups: families.map((f) => ({
        group: f.key,
        name: f.name,
        what_the_period_selects: f.periodMeans,
        time_grains: f.grains,
        dimensions: f.dimensions,
        caveats: f.caveats,
        metrics: METRICS.filter((m) => m.family === f.key).map((m) => ({
          key: m.key,
          name: m.name,
          unit: m.unit,
          description: m.description,
          ...(full ? { how_it_is_computed: m.computation, caveats: m.caveats } : {}),
          adds_up_across_rows: m.aggregation === 'sum',
          good_direction: m.direction,
          ...(m.needsOneOf ? { needs_one_of_dimensions: m.needsOneOf } : {}),
          definition_version: m.version,
        })),
      })),
      dimensions: cat.dimensions.filter((d) => families.some((f) => f.dimensions.includes(d.key))),
      units: cat.units,
      periods: [...RELATIVE_PERIODS],
      comparisons: [...COMPARISONS],
      summary: families.length
        ? `${METRICS.filter((m) => families.some((f) => f.key === m.family)).length} metrics in ${families.length} ${families.length === 1 ? 'group' : 'groups'}. Money is in whole cents; ratios are between 0 and 1. Ask for numbers with metrics_query using these keys.`
        : `There is no group called "${input.group}". Leave group out to see them all.`,
    };
  },
});

// ── metrics_query ───────────────────────────────────────────────────────────

const queryOutput = z.object({
  summary: z.string(),
  currency: z.string(),
  period: periodShape,
  compared_with: compareShape,
  grain: z.string().nullable(),
  dimensions: z.array(z.string()),
  metrics: z.array(z.object({ key: z.string(), name: z.string(), unit: z.string(), good_direction: z.string(), adds_up_across_rows: z.boolean(), definition_version: z.number(), caveats: z.array(z.string()) })),
  rows: z.array(
    z.object({
      period_start: z.string().nullable(),
      dimensions: z.record(z.string(), z.string().nullable()),
      values: numbers,
      compare: numbers.optional(),
      change_pct: numbers.optional(),
    }),
  ),
  totals: z.object({ values: numbers, compare: numbers.optional(), change_pct: numbers.optional() }),
  row_count: z.number(),
  truncated: z.boolean(),
  read_from: z.array(z.object({ metrics: z.array(z.string()), source: z.enum(['ledger', 'facts']), tables: z.array(z.string()), source_rows: z.record(z.string(), z.number()) })),
  freshness: freshnessShape.extend({ facts_computed_at: z.string().nullable() }),
  venues: z.object({ scope: z.string(), names: z.array(z.string()) }),
  caveats: z.array(z.string()),
  as_of: z.string(),
});

const showValue = (unit: string, v: number | null | undefined): string => {
  if (v === null || v === undefined) return 'not measurable';
  if (unit === 'cents') return `$${(Math.round(v) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (unit === 'ratio') return `${Math.round(v * 1000) / 10}%`;
  if (unit === 'days') return `${v} days`;
  return v.toLocaleString('en-AU');
};

/** The metric result in the compact shape assistants get, with a one-line summary from a template. */
export function presentResult(r: MetricResult): z.infer<typeof queryOutput> {
  const pctOf = (c: MetricResult['totals']['change']) => (c ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.pct])) : undefined);
  const lead = r.metrics[0]!;
  const total = r.totals.values[lead.key];
  let summary = `${lead.name}: ${showValue(lead.unit, total)} for ${r.period.from} to ${r.period.to}`;
  if (r.compare) {
    const c = r.totals.change?.[lead.key]?.pct;
    summary += c === null || c === undefined ? `; no comparable figure for ${r.compare.basis}` : `, ${c >= 0 ? '+' : ''}${Math.round(c * 1000) / 10}% against ${showValue(lead.unit, r.totals.compare?.[lead.key])} in ${r.compare.basis}`;
  }
  summary += '.';
  if (r.metrics.length > 1) summary += ` ${r.metrics.length - 1} more ${r.metrics.length === 2 ? 'metric is' : 'metrics are'} in totals.`;
  if (r.grain || r.dimensions.length) summary += ` ${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'} by ${[r.grain, ...r.dimensions].filter(Boolean).join(' and ')}.`;
  return {
    summary,
    currency: r.currency,
    period: r.period,
    compared_with: r.compare,
    grain: r.grain,
    dimensions: r.dimensions,
    metrics: r.metrics.map((m) => ({ key: m.key, name: m.name, unit: m.unit, good_direction: m.good_direction, adds_up_across_rows: m.adds_up, definition_version: m.definition_version, caveats: m.caveats })),
    rows: r.rows.map((row) => ({
      period_start: row.period_start,
      dimensions: row.dimensions,
      values: row.values,
      ...(row.compare ? { compare: row.compare, change_pct: pctOf(row.change) } : {}),
    })),
    totals: { values: r.totals.values, ...(r.totals.compare ? { compare: r.totals.compare, change_pct: pctOf(r.totals.change) } : {}) },
    row_count: r.row_count,
    truncated: r.truncated,
    read_from: r.sources.map((s) => ({ metrics: s.metrics, source: s.read_from, tables: s.tables, source_rows: s.source_rows })),
    freshness: r.freshness,
    venues: r.venues,
    caveats: r.caveats,
    as_of: r.as_of,
  };
}

const filterArg = z.union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(50)]);

export const metricsQueryTool = defineTool({
  name: 'metrics_query',
  module: 'analytics',
  title: 'Query metrics',
  description:
    'Returns numbers for one or more metrics from metrics_catalogue, optionally split by dimensions and by day, week or month, and compared with the previous period or the same period last year. Every number is computed by the database from the sales ledger and event stream; quote them as given and do not recompute them. Money is in whole cents. The answer states the exact dates used, where it was read from, and the caveats that apply: pass the caveats on. A value of null means not measurable, which is not the same as zero or low. Aggregates only; it cannot return a guest.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    metrics: z.array(z.string().min(1).max(60)).min(1).max(12).describe('Metric keys from metrics_catalogue, e.g. ["net_sales", "orders"].'),
    dimensions: z.array(z.string().min(1).max(40)).max(3).optional().describe('Dimension keys to split by, e.g. ["channel"]. Every metric asked for must support them.'),
    filters: z.record(z.string(), filterArg).optional().describe('Keep only some values of a dimension, e.g. { "channel": "pickup" } or { "day_of_week": ["friday", "saturday"] }.'),
    venue: venueArg,
    period: periodArg.optional().describe('Default last_28_days. A named period, or { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } in the venue\'s own dates, inclusive.'),
    grain: z.enum(GRAINS).optional().describe('Split the period into days, weeks (Monday to Sunday) or calendar months.'),
    compare_to: z.enum(COMPARISONS).optional().describe('Add the same numbers for a comparison period and the change. The answer says which dates were compared.'),
    funnel: z.string().max(40).optional().describe('For funnel metrics: which declared funnel. Default "order".'),
    sort_by: z.string().max(60).optional().describe('A metric key to rank rows by, largest first.'),
    limit: z.number().int().min(1).max(500).optional().describe('Most rows to return. Default 100.'),
  }),
  output: queryOutput,
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    const filters: Record<string, string | string[]> = { ...(input.filters ?? {}) };
    delete filters.venue;
    if (venueId) filters.venue = [venueId];
    const result = await queryMetrics(t.ctx, {
      metrics: input.metrics,
      dimensions: input.dimensions ?? [],
      filters,
      period: input.period ?? 'last_28_days',
      ...(input.grain ? { grain: input.grain } : {}),
      ...(input.compare_to ? { compareTo: input.compare_to } : {}),
      ...(input.funnel ? { funnel: input.funnel } : {}),
      ...(input.sort_by ? { sort: { by: input.sort_by, direction: 'desc' as const } } : {}),
      limit: input.limit ?? 100,
    });
    return presentResult(result);
  },
});

// ── sales_summary ───────────────────────────────────────────────────────────

const splitRow = { net_sales_cents: z.number(), orders: z.number(), share_of_net_sales: z.number().nullable(), change_pct_vs_previous_7_days: z.number().nullable() };

export const salesSummaryTool = defineTool({
  name: 'sales_summary',
  module: 'analytics',
  title: 'Sales summary',
  description:
    'How trade is going: today so far, yesterday, this week so far and last week, each against what is usual for the same weekdays over the previous weeks, plus the last 7 days by channel and daypart. "So far" figures are compared with the same time of day in earlier weeks, so a quiet-looking morning is not mistaken for a bad day. Each window says whether the difference is within normal variation. Totals and counts only. Use metrics_query for anything more specific.',
  effect: 'read',
  scope: 'sales:read',
  input: z.object({ venue: venueArg }),
  output: z.object({
    summary: z.string(),
    venue: z.string(),
    currency: z.string(),
    local_time: z.string(),
    windows: z.array(
      z.object({
        window: z.enum(['today_so_far', 'yesterday', 'this_week_so_far', 'last_week']),
        from: z.string(),
        to: z.string(),
        cut_at_local_time: z.string().nullable(),
        net_sales_cents: z.number(),
        gross_sales_cents: z.number(),
        orders: z.number(),
        avg_order_value_cents: z.number().nullable(),
        usual_net_sales_cents: z.number().nullable(),
        usual_orders: z.number().nullable(),
        change_pct: z.number().nullable(),
        significance,
        baseline_weeks: z.number(),
      }),
    ),
    last_7_days: z.object({
      from: z.string(),
      to: z.string(),
      by_channel: z.array(z.object({ channel: z.string(), ...splitRow })),
      by_daypart: z.array(z.object({ daypart: z.string(), ...splitRow })),
    }),
    caveats: z.array(z.string()),
    freshness: freshnessShape,
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    return salesSummary(t.ctx, venueId ? { venueId } : {});
  },
});

// ── customers_summary ───────────────────────────────────────────────────────

export const customersSummaryTool = defineTool({
  name: 'customers_summary',
  module: 'analytics',
  title: 'Customers summary',
  description:
    'The customer base in aggregate: how many known customers, what share of sales they account for, how many come back and how quickly, average spend to date, the segments (new, one_timer, repeater, frequent, loyal, at_risk, lapsed) with their share of customers and of spend, and new versus returning customers over the last 28 days. Only sales tied to a known customer can be described; the answer says what share that is, and nothing here should be read as describing anonymous sales. Counts and shares only: it never lists, names or describes an individual guest.',
  effect: 'read',
  scope: 'customers:read',
  input: z.object({ venue: venueArg }),
  output: z.object({
    summary: z.string(),
    venue: z.string(),
    currency: z.string(),
    as_of_day: z.string(),
    known_customers: z.number(),
    identified_share_of_orders_last_28_days: z.number().nullable(),
    repeat_rate: z.number().nullable(),
    one_timer_share: z.number().nullable(),
    median_days_to_second_order: z.number().nullable(),
    avg_lifetime_spend_cents: z.number().nullable(),
    avg_orders_per_customer: z.number().nullable(),
    segments: z.array(
      z.object({ segment: z.string(), meaning: z.string(), customers: z.number(), share_of_customers: z.number().nullable(), share_of_spend: z.number().nullable(), avg_lifetime_spend_cents: z.number().nullable() }),
    ),
    last_28_days: z.object({ from: z.string(), to: z.string(), active_customers: z.number(), new_customers: z.number(), returning_customers: z.number(), change_pct_active_vs_previous_28_days: z.number().nullable() }),
    by_acquisition_source: z.array(z.object({ source: z.string(), customers: z.number(), repeat_rate: z.number().nullable(), avg_lifetime_spend_cents: z.number().nullable() })),
    caveats: z.array(z.string()),
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    return customersSummary(t.ctx, venueId ? { venueId } : {});
  },
});

// ── menu_performance ────────────────────────────────────────────────────────

export const menuPerformanceTool = defineTool({
  name: 'menu_performance',
  module: 'analytics',
  title: 'Menu performance',
  description:
    'What sells: for each item (or category) the quantity sold, revenue, its share of all item revenue, how many orders included it and the share of orders that did (attach rate), with the change in revenue against the period before and the biggest risers and fallers. Items are reported under the name they were sold as. Item revenue is before sale-level discounts and refunds, so it will not add up to net sales.',
  effect: 'read',
  scope: 'sales:read',
  input: z.object({
    venue: venueArg,
    period: periodArg.optional().describe('Default last_28_days.'),
    by: z.enum(['item', 'category']).optional().describe('Default item.'),
    sort_by: z.enum(['revenue', 'quantity', 'attach_rate']).optional().describe('Default revenue.'),
    limit: z.number().int().min(1).max(100).optional().describe('Most rows to return. Default 15.'),
  }),
  output: z.object({
    summary: z.string(),
    venue: z.string(),
    currency: z.string(),
    period: periodShape,
    compared_with: compareShape,
    by: z.enum(['item', 'category']),
    rows: z.array(
      z.object({
        name: z.string(),
        quantity: z.number(),
        revenue_cents: z.number(),
        revenue_share: z.number().nullable(),
        orders_containing: z.number(),
        attach_rate: z.number().nullable(),
        revenue_change_pct: z.number().nullable(),
        previous_revenue_cents: z.number().nullable(),
      }),
    ),
    total_lines: z.number(),
    rising: z.array(z.object({ name: z.string(), revenue_change_cents: z.number() })),
    falling: z.array(z.object({ name: z.string(), revenue_change_cents: z.number() })),
    totals: z.object({ quantity: z.number(), revenue_cents: z.number() }),
    caveats: z.array(z.string()),
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    return menuPerformance(t.ctx, {
      ...(venueId ? { venueId } : {}),
      ...(input.period ? { period: input.period } : {}),
      ...(input.by ? { by: input.by } : {}),
      ...(input.sort_by ? { sortBy: input.sort_by } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
  },
});

// ── funnel_report ───────────────────────────────────────────────────────────

export const funnelReportTool = defineTool({
  name: 'funnel_report',
  module: 'analytics',
  title: 'Funnel report',
  description:
    'How far visits to the venue\'s site or QR menu get: the number of visits reaching each declared step, the share of all visits that got that far, the share of the previous step that continued, and where the biggest drop is. Optionally split by where the visits came from. A visit counts at a step only if it passed every earlier step. It covers first-party visits only and only the steps the venue\'s switched-on features declare.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    venue: venueArg,
    period: periodArg.optional().describe('Default last_28_days. Visits are placed by the day they started.'),
    funnel: z.string().max(40).optional().describe('Which declared funnel. Default "order".'),
    by: z.enum(['utm_source', 'utm_medium', 'campaign', 'creator', 'device_class', 'landing_path']).optional().describe('Also split the funnel by this.'),
  }),
  output: z.object({
    summary: z.string(),
    venue: z.string(),
    period: periodShape,
    funnel: z.string(),
    steps: z.array(z.object({ step: z.number(), event: z.string(), meaning: z.string(), sessions: z.number(), conversion_from_start: z.number().nullable(), conversion_from_previous: z.number().nullable() })),
    biggest_drop: z.object({ from_event: z.string(), to_event: z.string(), lost_share: z.number() }).nullable(),
    split_by: z.string().nullable(),
    splits: z.array(z.object({ value: z.string(), steps: z.array(z.object({ step: z.number(), event: z.string(), sessions: z.number(), conversion_from_start: z.number().nullable() })) })),
    caveats: z.array(z.string()),
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    return funnelReport(t.ctx, {
      ...(venueId ? { venueId } : {}),
      ...(input.period ? { period: input.period } : {}),
      ...(input.funnel ? { funnel: input.funnel } : {}),
      ...(input.by ? { by: input.by } : {}),
    });
  },
});

// ── campaign_outcomes ───────────────────────────────────────────────────────

export const campaignOutcomesTool = defineTool({
  name: 'campaign_outcomes',
  module: 'analytics',
  title: 'Campaign and creator outcomes',
  description:
    'What each campaign or creator is aligned with at this venue: visits, new guests, orders, spend as a band (never an exact figure) and the share of purchasing guests who came back. Totals only, and only above a minimum number of guests: a smaller group returns "not enough guests yet" and no numbers, and nothing is shown for the first days after a campaign starts. A withheld result is unmeasured, not low. Say "aligned with", never "drove" or "caused": these figures do not prove the campaign produced the result.',
  effect: 'read',
  scope: 'outcomes:read',
  input: z.object({
    venue: venueArg,
    campaign: z.string().min(1).max(100).optional().describe('One campaign identifier. Leave out for all.'),
    creator: z.string().min(1).max(100).optional().describe('One creator identifier. Leave out for all.'),
    period: periodArg.optional().describe('Default: everything since each campaign\'s first activity.'),
  }),
  output: z.object({
    summary: z.string(),
    venue: z.string().nullable(),
    venues_covered: z.number(),
    period: z.object({ from: z.string().nullable(), to: z.string() }),
    min_cohort: z.number(),
    quiet_days: z.number(),
    currency: z.string(),
    outcomes: z.array(
      z.object({
        campaign_id: z.string().nullable(),
        creator_id: z.string().nullable(),
        status: z.enum(['measured', 'too_early', 'not_enough_guests']),
        status_note: z.string(),
        first_activity_on: z.string().nullable(),
        sessions: z.number().nullable(),
        new_customers: z.number().nullable(),
        orders: z.number().nullable(),
        revenue_band: z.object({ label: z.string(), low_cents: z.number(), high_cents: z.number().nullable() }).nullable(),
        repeat_rate: z.number().nullable(),
        summary: z.string(),
      }),
    ),
    wording: z.string(),
    caveats: z.array(z.string()),
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    const r = await campaignOutcomes(t.ctx, {
      ...(venueId ? { venueId } : {}),
      ...(input.campaign ? { campaignId: input.campaign } : {}),
      ...(input.creator ? { creatorId: input.creator } : {}),
      ...(input.period ? { period: input.period } : {}),
    });
    const measured = r.outcomes.filter((o) => o.status === 'measured').length;
    const withheld = r.outcomes.length - measured;
    return {
      ...r,
      summary: !r.outcomes.length
        ? 'No campaign or creator activity has been recorded for this venue.'
        : `${measured} of ${r.outcomes.length} campaign and creator combinations can be reported; ${withheld} ${withheld === 1 ? 'is' : 'are'} withheld (too early or not enough guests), which means unmeasured, not low. ${r.wording}`,
    };
  },
});

// ── insights_digest ─────────────────────────────────────────────────────────

const finding = z.object({
  metric: z.string(),
  name: z.string(),
  unit: z.string(),
  value: z.number().nullable(),
  baseline: z.number().nullable(),
  change_abs: z.number().nullable(),
  change_pct: z.number().nullable(),
  direction: z.enum(['up', 'down', 'flat', 'unknown']),
  reads_as: z.enum(['good', 'bad', 'neutral']),
  significance,
  usual_range: z.tuple([z.number(), z.number()]).nullable(),
  baseline_periods: z.number(),
  caveats: z.array(z.string()),
});

export const insightsDigestTool = defineTool({
  name: 'insights_digest',
  module: 'analytics',
  title: 'What changed',
  description:
    'A digest of a day, a week or a month: each headline metric against what is usual for the same weekdays over the weeks before, which of them moved beyond normal variation, and the items, channels, dayparts and campaigns that moved most. It is arithmetic, not opinion: a flagged change is a difference from the usual pattern and says nothing about why. Default is the last complete week. "insufficient_history" means there is too little history to judge, not that nothing changed.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    venue: venueArg,
    period: z.enum(['day', 'week', 'month']).optional().describe('Default week.'),
    date: date.optional().describe('Any date inside the day, week or month wanted, YYYY-MM-DD. Default: the last complete one.'),
  }),
  output: z.object({
    summary: z.string(),
    period: z.object({ kind: z.enum(['day', 'week', 'month']), from: z.string(), to: z.string(), complete: z.boolean() }),
    venue: z.string().nullable(),
    currency: z.string(),
    baseline: z.object({ method: z.string(), periods_asked: z.number(), shift_days: z.number(), earliest_from: z.string() }),
    headline: z.array(finding),
    flagged: z.array(z.string()),
    movers: z.array(
      z.object({
        dimension: z.enum(['item', 'channel', 'daypart', 'campaign']),
        member: z.string(),
        metric: z.string(),
        unit: z.string(),
        value: z.number(),
        baseline: z.number(),
        change_abs: z.number(),
        change_pct: z.number().nullable(),
        direction: z.enum(['up', 'down']),
        significance,
      }),
    ),
    caveats: z.array(z.string()),
    as_of: z.string(),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    const d = await buildDigest(t.ctx, { period: input.period ?? 'week', ...(input.date ? { date: input.date } : {}), ...(venueId ? { venueId } : {}) });
    return { summary: d.summary, period: d.period, venue: d.venue, currency: d.currency, baseline: d.baseline, headline: d.headline, flagged: d.flagged, movers: d.movers, caveats: d.caveats, as_of: d.as_of };
  },
});

// ── event_dictionary ────────────────────────────────────────────────────────

interface JsonSchema {
  type?: string | string[];
  enum?: unknown[];
  description?: string;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  format?: string;
}

function typeOf(s: JsonSchema): string {
  if (s.enum) return `one of: ${s.enum.map(String).join(', ')}`;
  if (s.anyOf) return [...new Set(s.anyOf.map(typeOf))].join(' or ');
  const t = Array.isArray(s.type) ? s.type.join(' or ') : (s.type ?? 'any');
  return s.format ? `${t} (${s.format})` : t;
}

export const eventDictionaryTool = defineTool({
  name: 'event_dictionary',
  module: 'analytics',
  title: 'Event dictionary',
  description:
    'Every kind of event the platform records (a visit starting, a menu viewed, a sale entering the ledger, a message opened …): its name, what it means, which part of the product records it, whether the browser or the server sends it, its properties, and its place in a funnel if it has one. Use it to understand event_count in metrics_query and the steps in funnel_report. It describes what can be recorded, not what has been.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({ module: z.string().max(40).optional().describe('Only events recorded by this part of the product, e.g. ledger, events, comms, ordering.') }),
  output: z.object({
    summary: z.string(),
    events: z.array(
      z.object({
        name: z.string(),
        module: z.string(),
        description: z.string(),
        sent_by: z.enum(['browser', 'server']),
        funnel: z.object({ name: z.string(), step: z.number() }).nullable(),
        properties: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), description: z.string().optional() })),
      }),
    ),
    funnels: z.array(z.object({ name: z.string(), steps: z.array(z.object({ step: z.number(), event: z.string() })) })),
  }),
  async run(_t, input) {
    const events = eventDictionary()
      .filter((e) => !input.module || e.module === input.module)
      .map((e) => {
        const schema = (e.properties ?? {}) as JsonSchema;
        const required = new Set(schema.required ?? []);
        return {
          name: e.name,
          module: e.module,
          description: e.description,
          sent_by: e.sent_by,
          funnel: e.funnel,
          properties: Object.entries(schema.properties ?? {}).map(([name, p]) => ({ name, type: typeOf(p), required: required.has(name), ...(p.description ? { description: p.description } : {}) })),
        };
      });
    return {
      summary: `${events.length} event ${events.length === 1 ? 'type' : 'types'}${input.module ? ` recorded by ${input.module}` : ''}. Count them with metrics_query (metric event_count, dimension event_name).`,
      events,
      funnels: funnelNames().map((name) => ({ name, steps: funnelSteps(name).map((s) => ({ step: s.step, event: s.event })) })),
    };
  },
});

// ── saved_view_run ──────────────────────────────────────────────────────────

const viewShape = z.object({ name: z.string(), description: z.string().nullable(), pinned: z.boolean() });

export const savedViewRunTool = defineTool({
  name: 'saved_view_run',
  module: 'analytics',
  title: 'Run a saved view',
  description:
    'Runs a metric query the venue saved under a name (a pinned report), so a recurring question is asked the same way every time. Give the view\'s name. With no name it lists the saved views. The numbers are computed afresh on each run, for the venues this key can see.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({ name: z.string().min(1).max(80).optional().describe('The saved view\'s name. Leave out to list the views that exist.') }),
  output: z.object({
    summary: z.string(),
    view: viewShape.nullable(),
    available_views: z.array(viewShape),
    result: queryOutput.nullable(),
  }),
  async run(t, input) {
    const views = (await listViews(t.ctx)).map((v) => ({ name: v.name, description: v.description, pinned: v.pinned }));
    if (!input.name) {
      return { summary: views.length ? `${views.length} saved ${views.length === 1 ? 'view' : 'views'}. Give a name to run one.` : 'No views have been saved yet. They are saved from the console.', view: null, available_views: views, result: null };
    }
    const r = await runView(t.ctx, { name: input.name });
    const result = presentResult(r.result);
    return { summary: `${r.view.name}: ${result.summary}`, view: { name: r.view.name, description: r.view.description, pinned: r.view.pinned }, available_views: views, result };
  },
});

export const analyticsTools = [
  metricsCatalogueTool,
  metricsQueryTool,
  salesSummaryTool,
  customersSummaryTool,
  menuPerformanceTool,
  funnelReportTool,
  campaignOutcomesTool,
  insightsDigestTool,
  eventDictionaryTool,
  savedViewRunTool,
];
