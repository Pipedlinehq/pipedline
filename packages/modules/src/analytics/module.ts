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
  tables: ['fact_sales_daily', 'fact_sales_hourly', 'fact_item_daily', 'fact_customer', 'fact_events_daily', 'fact_campaign_daily', 'rollup_state', 'insight_digests', 'saved_views', 'benchmark_bands'],
  configSchema: analyticsConfig,
  configVersion: 1,
  defaultConfig: analyticsConfig.parse({}),
});
