import { z } from 'zod';
import { defineModule } from '@ros/core';

/**
 * Analytics is a spine module: always on, with no per-venue switch, so this per-venue config is
 * empty. What an org can set (dayparts, segment thresholds, the cohort floor, digest sensitivity)
 * is org-level and lives in ./settings.ts, stored under orgs.settings.analytics.
 */
export const analyticsConfig = z.object({});
export type AnalyticsConfig = z.infer<typeof analyticsConfig>;

export const analyticsModule = defineModule({
  key: 'analytics',
  name: 'Analytics',
  description: 'The metric catalogue, derived facts, digests and saved views, for people and for assistants.',
  spine: true,
  dependsOn: ['ledger', 'events', 'identity'],
  manifest: {
    name: 'Analytics',
    purpose: 'The venue\'s numbers, each defined once so every assistant gives the same answer: sales, covers, repeat rate, best sellers, the Monday digest, saved views.',
    category: 'insight',
    kind: 'module',
    needs: ['Sales arriving (a till connected or Online ordering on). Everything else switched on adds detail.'],
    reads: ['sales', 'guest records, as totals', 'the activity stream', 'orders, bookings and campaigns where they are on'],
    writes: ['daily and hourly facts', 'digests', 'saved views'],
    consent: 'Figures are totals. No figure is given for a group of guests smaller than the venue\'s minimum, and nothing per guest leaves the venue.',
  },
  tables: ['fact_sales_daily', 'fact_sales_hourly', 'fact_item_daily', 'fact_customer', 'fact_events_daily', 'fact_campaign_daily', 'rollup_state', 'insight_digests', 'saved_views', 'benchmark_bands', 'report_definitions', 'report_targets', 'report_annotations'],
  configSchema: analyticsConfig,
  configVersion: 1,
  defaultConfig: analyticsConfig.parse({}),
});
