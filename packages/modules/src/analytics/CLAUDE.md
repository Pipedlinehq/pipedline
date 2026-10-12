# analytics — metrics, facts, digests, outcomes

The metric catalogue and every aggregate read: numbers are computed by the database from the
ledger and the event stream (or from derived fact tables that are re-derivable), never by a
model. Also campaign/creator outcomes, the one shape in which results leave toward Criota.

**Spine** (always on, no venue switch; depends on ledger, events, identity). Owns
`fact_sales_daily`, `fact_sales_hourly`, `fact_item_daily`, `fact_customer`, `fact_events_daily`,
`fact_campaign_daily`, `rollup_state`, `insight_digests`, `saved_views`, `benchmark_bands`, and
since the console depth pass (wave 2, pattern 9) `report_definitions`, `report_targets`,
`report_annotations`. Only `fact_customer` holds a row about a person (see hooks). Migrations 0600, 0800.

## Public functions by purpose
Console (read-only staff and above unless noted; `resolveScope` answers a venue the caller has no role at as not found):
- `queryMetrics(ctx, MetricQuery)` metrics × dimensions × grain × comparison; `metricCatalogue()`, `METRIC_KEYS`.
- `salesSummary`, `customersSummary`, `menuPerformance`, `funnelReport` (ctx, {venueId?, …}).
- `buildDigest(ctx, {period, date?, venueId?})`, `listDigests(ctx, …)`.
- `campaignOutcomes(ctx, {venueId?, campaignId?, creatorId?, period?})` floored, banded, "aligned with".
- Saved views: `saveView`/`pinView`/`deleteView` (manager+), `listViews`, `runView`.
- `exportMetrics(ctx, {query, format})` owner only, from the console, audited; never a tool.
- `getAnalyticsSettings(ctx)`, `setAnalyticsSettings(ctx, patch)` (manager+). `requestBackfill(ctx, {from?, to?})` owner.
- `getBenchmarks(ctx, …)`, `dataDictionary(ctx?)`, `factsState(ctx)`, `resolveScope(ctx, venueIds?)`.
Jobs/internal: `rollup(app, orgId)`, `backfill(app, …)`, `computeBenchmarks(app)`.

Reports (`reports.ts`; docs/CONSOLE_IA.md section 9, pattern 9; console `/console/analytics/reports`):
- `DEFAULT_REPORTS` (24, code; "Created by Pipedline") by `REPORT_CATEGORIES` sales · guests · bookings · menu ·
  delivery · marketing · team, each a `ReportQuery` (metricQueryInput without period/compareTo; `grain: 'auto'`
  picks day/week/month from the period) and a `chart` (line · bars · rank · cohort · tiles). Bookings has none:
  the catalogue has no booking measures yet. A default naming an unknown metric throws at load.
- `listReports(ctx, {category?})`, `getReport(ctx, key)` (a default key, `saved:<id>`, an id, or a name).
- `runReport(ctx, {report, period, compareTo?, venueId?, grain?, limit?})` → `{report, result, annotations}`:
  `result` IS `queryMetrics` for the report's question (nothing recomputed); `exportReport(ctx, {…, format})`
  → `exportMetrics` (owner, audited). `toMetricQuery`, `grainForDays`.
- `saveReport(ctx, {name, description?, category, chart, query, id?})` manager+, proved by one short run,
  one org, name unique per org (`conflict`); `deleteReport(ctx, id)`.
- Targets: `setTarget(ctx, {metric, month 'YYYY-MM', target, venueId?})` manager+ (a `distinct` metric is
  refused), `deleteTarget`, `listTargets`, `targetProgress(ctx, {metric, month?, venueId?})` → actual from
  queryMetrics for the month so far, `expectedSoFar` (pace) for metrics that add up, `onTrack`.
- Annotations: `addAnnotation(ctx, {date, label, venueId?})` manager+, `listAnnotations(ctx, {from, to, venueId?})`
  (the venue's and the org-wide ones), `deleteAnnotation`. `runReport` returns the ones in the period.
- Audit: `analytics.report_saved|report_updated|report_deleted|target_set|target_removed|annotation_added|annotation_removed`.

## Assistant tools (`tools.ts` and `reports-tools.ts`, all reads, not `venueScoped`)
`metrics_catalogue`, `metrics_query`, `event_dictionary`, `funnel_report`, `insights_digest`,
`saved_view_run`, `reports_list`, `report_run` (`metrics:read`); `sales_summary`, `menu_performance` (`sales:read`);
`customers_summary` (`customers:read`); `campaign_outcomes` (`outcomes:read`).
Each takes an optional `venue` (name, slug or id) and otherwise covers every venue the key can see.
The hub runs them with the key narrowed to the venues where that tool is usable (`hub.narrowTo`), so a
venue where the hub is off, the scope is not allowed or the person's role is too low is not found.

## The Criota boundary (`outcomes.ts`)
With a `service:<plug>` key (`ctx.principal.audience`): only Criota (`hub.isCriotaPlug`); only venues where
`hub.criotaSharing(ctx, venueId).enabled`; one venue at a time (two sharing venues and none named → "Name one
venue"); floor = max(analytics `minCohort`, venue `criota_min_cohort`); only rows with a creator or source
`criota`. With a staff key or a person: unchanged (analytics' own floor, every campaign).

## Hooks
Registers on `identity.onCustomerErase` and `identity.onCustomerMerge` (drops `fact_customer` rows) and
`identity.registerCustomerDataProvider('analytics', …)` (a guest's own summary in their data export).

## Config surface
No venue config. Org settings `analytics`: `minCohort` (≥5), `campaignQuietDays` (≥7), `dayparts[]`,
`segments{…}`, `digest{baselinePeriods, notableSd, strongSd, minChangeRatio, topMovers}`.

## Jobs and schedules
`analytics.rollup` (every 15 min, per org; also `reconcile` daily), `analytics.backfill`,
`analytics.weekly_digest` (hourly check, per org), `analytics.benchmarks` (daily, platform).

## Simulated vs real
No providers. Everything is SQL over the ledger, events and customers.

## Known gaps
Benchmarks need enough opted-in orgs to publish a band. Anonymous sales cannot be described per guest
(answers say what share of sales is identified).
