import { z } from 'zod';
import { type Ctx, audit, forbidden, requireOwner } from '@ros/core';
import { eventDictionary } from '../events/sessions';
import { CATALOGUE_VERSION, metricCatalogue } from './catalogue';
import { SEGMENTS } from './families/customers';
import { funnelNames, funnelSteps } from './families/web';
import { COMPARISONS, GRAINS, RELATIVE_PERIODS } from './period';
import { type MetricResult, metricQueryInput, queryMetrics } from './query';
import { resolveScope } from './scope';
import { getAnalyticsSettings } from './settings';
import { parseInput } from './util';

/**
 * Export of a metric query's result: aggregates only, the same rows queryMetrics returns.
 * Owner only, from the console; it is deliberately not a tool (docs/modules/hub.md section 3).
 */
export const exportInput = z.object({ query: metricQueryInput, format: z.enum(['csv', 'ndjson']).default('csv') }).strict();

export interface MetricExport {
  filename: string;
  contentType: string;
  body: string;
  rows: number;
  result: Pick<MetricResult, 'period' | 'compare' | 'caveats' | 'sources' | 'as_of'>;
}

/** A spreadsheet must never run a cell: text that would start a formula is quoted as text. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportMetrics(ctx: Ctx, raw: z.input<typeof exportInput>): Promise<MetricExport> {
  const input = parseInput(exportInput, raw, 'That export');
  if (ctx.principal.kind === 'agent') throw forbidden('Exports are made from the console, not through an assistant.');
  requireOwner(ctx);
  const result = await queryMetrics(ctx, { ...(raw as { query: object }).query, limit: 5000 } as z.input<typeof metricQueryInput>);
  const metrics = result.metrics.map((m) => m.key);
  const dims = [...new Set(result.rows.flatMap((r) => Object.keys(r.dimensions)))];
  const compared = !!result.compare;

  let body: string;
  if (input.format === 'csv') {
    const header = ['period_start', ...dims, ...metrics.flatMap((m) => (compared ? [m, `${m}__compare`, `${m}__change_pct`] : [m]))];
    const lines = [header.map(csvCell).join(',')];
    for (const r of result.rows) {
      lines.push(
        [
          csvCell(r.period_start),
          ...dims.map((d) => csvCell(r.dimensions[d])),
          ...metrics.flatMap((m) => (compared ? [csvCell(r.values[m]), csvCell(r.compare?.[m]), csvCell(r.change?.[m]?.pct)] : [csvCell(r.values[m])])),
        ].join(','),
      );
    }
    body = `${lines.join('\n')}\n`;
  } else {
    const meta = { type: 'meta', as_of: result.as_of, currency: result.currency, period: result.period, compare: result.compare, grain: result.grain, metrics: result.metrics, sources: result.sources, caveats: result.caveats, totals: result.totals };
    body = `${[meta, ...result.rows.map((r) => ({ type: 'row', ...r }))].map((o) => JSON.stringify(o)).join('\n')}\n`;
  }
  await audit(ctx, { action: 'analytics.exported', entityType: 'metric_export', after: { metrics, dimensions: result.dimensions, period: result.period, format: input.format, rows: result.rows.length } });
  return {
    filename: `metrics_${result.period.from}_${result.period.to}.${input.format}`,
    contentType: input.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
    body,
    rows: result.rows.length,
    result: { period: result.period, compare: result.compare, caveats: result.caveats, sources: result.sources, as_of: result.as_of },
  };
}

/**
 * The data dictionary: every metric, dimension and event that exists, as structured data. It
 * describes the product, not a tenant, so it needs no tenant context; pass one to include the
 * org's own settings (dayparts, segment thresholds, cohort floor); that needs staff.
 */
export async function dataDictionary(ctx?: Ctx) {
  const catalogue = metricCatalogue();
  if (ctx) await resolveScope(ctx);
  const settings = ctx ? await getAnalyticsSettings(ctx) : null;
  return {
    catalogue_version: CATALOGUE_VERSION,
    metrics: catalogue.metrics,
    dimensions: catalogue.dimensions,
    units: catalogue.units,
    periods: { relative: [...RELATIVE_PERIODS], absolute: '{ "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" } in venue-local dates, inclusive', note: 'last_N_days means N complete days ending yesterday; today is excluded because it is still in progress.' },
    grains: [...GRAINS],
    comparisons: [...COMPARISONS],
    segments: {
      values: [...SEGMENTS],
      rule: 'One order: new while inside the new window, then one_timer. Two or more: lapsed or at_risk by days since the last order, otherwise loyal, frequent or repeater by order count.',
      thresholds: settings?.segments ?? null,
    },
    dayparts: settings?.dayparts ?? null,
    privacy: settings ? { min_cohort: settings.minCohort, campaign_quiet_days: settings.campaignQuietDays } : null,
    funnels: funnelNames().map((name) => ({ name, steps: funnelSteps(name) })),
    events: eventDictionary(),
  };
}
