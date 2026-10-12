import { z } from 'zod';
import { type ToolContext, defineTool } from '@ros/core';
import { COMPARISONS, GRAINS, RELATIVE_PERIODS } from './period';
import { REPORT_CATEGORIES, REPORT_CATEGORY_WORDS, listReports, runReport } from './reports';
import { pickVenue, resolveScope } from './scope';
import { presentResult } from './tools';

/**
 * The reports catalogue for an assistant: the same list the console's Reports page shows, and the
 * same run (queryMetrics with the report's question). Reads only; what a report says is what the
 * catalogue says, with its period, comparison and caveats.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const venueArg = z.string().min(1).max(120).optional().describe('A venue name, its address slug or its id, to look at one venue. Leave out for every venue this key can see.');

async function venueOf(t: ToolContext, named: string | undefined): Promise<string | undefined> {
  if (!named) return t.venueId ?? undefined;
  return pickVenue(await resolveScope(t.ctx), named)?.[0];
}

const reportShape = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  chart: z.string(),
  metrics: z.array(z.string()),
  dimensions: z.array(z.string()),
  created_by: z.string(),
});

export const reportsListTool = defineTool({
  name: 'reports_list',
  module: 'analytics',
  title: 'The reports catalogue',
  description:
    'Lists the reports the venue can run, by category (sales, guests, bookings, menu, delivery, marketing, team): the default ones, created by Pipedline, and any the venue saved itself. Each report is a question from the metric catalogue with a chart to draw it; run one with report_run, giving its key, a period and optionally a comparison. A category with no reports yet says so: that means the catalogue has no measures for it yet, not that nothing happened.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    category: z.enum(REPORT_CATEGORIES).optional().describe('One category. Leave out for every category.'),
  }),
  output: z.object({
    summary: z.string(),
    categories: z.array(z.object({ key: z.string(), name: z.string(), what_it_covers: z.string(), reports: z.array(reportShape) })),
    periods: z.array(z.string()),
    comparisons: z.array(z.string()),
  }),
  async run(t, input) {
    const reports = await listReports(t.ctx, input.category ? { category: input.category } : {});
    const cats = REPORT_CATEGORIES.filter((c) => !input.category || c === input.category);
    return {
      summary: `${reports.length} ${reports.length === 1 ? 'report' : 'reports'} in ${cats.length} ${cats.length === 1 ? 'category' : 'categories'}. Run one with report_run and its key.`,
      categories: cats.map((c) => ({
        key: c,
        name: REPORT_CATEGORY_WORDS[c].title,
        what_it_covers: REPORT_CATEGORY_WORDS[c].blurb,
        reports: reports
          .filter((r) => r.category === c)
          .map((r) => ({ key: r.key, name: r.name, description: r.description, category: r.category, chart: r.chart, metrics: r.query.metrics, dimensions: r.query.dimensions ?? [], created_by: r.createdBy })),
      })),
      periods: [...RELATIVE_PERIODS],
      comparisons: [...COMPARISONS],
    };
  },
});

export const reportRunTool = defineTool({
  name: 'report_run',
  module: 'analytics',
  title: 'Run a report',
  description:
    'Runs one report from reports_list for a period, optionally compared with the previous period or the same period last year, and optionally for one venue. The answer is the same as metrics_query for the report\'s question: every number is computed by the database from the sales ledger and event stream, in whole cents for money and shares between 0 and 1 for rates. Quote the figures as given, pass the caveats on, and treat null as not measurable rather than zero. Annotations are dates the team marked ("Menu change", "Public holiday") that fall inside the period.',
  effect: 'read',
  scope: 'metrics:read',
  input: z.object({
    report: z.string().min(1).max(120).describe('The report key from reports_list, e.g. "sales.over_time" or "saved:<id>".'),
    venue: venueArg,
    period: z
      .union([z.enum(RELATIVE_PERIODS), z.object({ from: date, to: date }).strict()])
      .optional()
      .describe('Default last_28_days. A named period, or { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } in the venue\'s own dates, inclusive.'),
    compare_to: z.enum(COMPARISONS).optional().describe('Add the same numbers for a comparison period and the change.'),
    grain: z.enum(GRAINS).optional().describe('For a report drawn over time: split by day, week or month. Default: chosen from the period\'s length.'),
  }),
  output: z.object({
    summary: z.string(),
    report: reportShape,
    annotations: z.array(z.object({ date: z.string(), label: z.string() })),
    result: z.object({
      summary: z.string(),
      currency: z.string(),
      period: z.object({ from: z.string(), to: z.string(), days: z.number(), label: z.string(), timezone: z.string(), includes_today: z.boolean() }),
      compared_with: z.object({ kind: z.string(), from: z.string(), to: z.string(), days: z.number(), basis: z.string() }).nullable(),
      grain: z.string().nullable(),
      dimensions: z.array(z.string()),
      metrics: z.array(z.object({ key: z.string(), name: z.string(), unit: z.string(), good_direction: z.string(), adds_up_across_rows: z.boolean(), definition_version: z.number(), caveats: z.array(z.string()) })),
      rows: z.array(z.object({ period_start: z.string().nullable(), dimensions: z.record(z.string(), z.string().nullable()), values: z.record(z.string(), z.number().nullable()), compare: z.record(z.string(), z.number().nullable()).optional(), change_pct: z.record(z.string(), z.number().nullable()).optional() })),
      totals: z.object({ values: z.record(z.string(), z.number().nullable()), compare: z.record(z.string(), z.number().nullable()).optional(), change_pct: z.record(z.string(), z.number().nullable()).optional() }),
      row_count: z.number(),
      truncated: z.boolean(),
      caveats: z.array(z.string()),
      as_of: z.string(),
    }),
  }),
  async run(t, input) {
    const venueId = await venueOf(t, input.venue);
    const run = await runReport(t.ctx, {
      report: input.report,
      period: input.period ?? 'last_28_days',
      ...(input.compare_to ? { compareTo: input.compare_to } : {}),
      ...(venueId ? { venueId } : {}),
      ...(input.grain ? { grain: input.grain } : {}),
      limit: 100,
    });
    const r = presentResult(run.result);
    const def = run.report;
    return {
      summary: `${def.name}: ${r.summary}`,
      report: { key: def.key, name: def.name, description: def.description, category: def.category, chart: def.chart, metrics: def.query.metrics, dimensions: def.query.dimensions ?? [], created_by: def.createdBy },
      annotations: run.annotations.map((a) => ({ date: a.date, label: a.label })),
      result: {
        summary: r.summary,
        currency: r.currency,
        period: r.period,
        compared_with: r.compared_with,
        grain: r.grain,
        dimensions: r.dimensions,
        metrics: r.metrics,
        rows: r.rows,
        totals: r.totals,
        row_count: r.row_count,
        truncated: r.truncated,
        caveats: r.caveats,
        as_of: r.as_of,
      },
    };
  },
});

export const reportTools = [reportsListTool, reportRunTool];
