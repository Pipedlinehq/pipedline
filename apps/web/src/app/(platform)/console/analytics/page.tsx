import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { grainFor, readFilter, venueFilter } from '@/lib/console-filters';
import { approxDays, heat, split, trend, words } from '@/lib/console-analytics';
import { BarChart, EmptyState, HourHeatmap, LineChart, PageHeader, RankBars } from '@/ui';
import { AnalyticsFilterRow, Caveats, Provenance, dateRange } from '@/components/console/provenance';
import { KpiTiles, ResultTable, Section } from '@/components/console/analytics/blocks';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ReadError } from '@/components/console/states';

export const metadata = { title: 'Sales · Analytics · Restaurant OS' };

const COMPARE_WORDS = { previous_period: 'Previous period', same_period_last_year: 'Same period last year' } as const;

/** Sales in depth: the headline figures, the trend split by channel and daypart, venues side by side, and when it sells. */
export default async function SalesAnalytics({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const f = readFilter(await searchParams, c);
  const tz = c.venue.timezone;
  const compareTo = f.compare ?? undefined;
  const compareLabel = f.compare ? COMPARE_WORDS[f.compare] : 'Comparison';
  const days = approxDays(f.periodKey, f.from, f.to);
  const grain = grainFor(days);
  const barGrain = days > 31 ? grainFor(days) : days > 14 ? 'week' : 'day';
  const filters = venueFilter(f);
  const KPI = ['net_sales', 'gross_sales', 'orders', 'avg_order_value', 'items_per_order', 'refunds', 'refund_rate', 'discounts', 'tips', 'tip_rate', 'identified_share', 'returning_order_share'];

  const [kpis, byDay, byChannel, byDaypart, byVenue, hours, sources] = await Promise.all([
    read((ctx) => analytics.queryMetrics(ctx, { metrics: KPI, period: f.period, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'avg_order_value'], period: f.period, grain, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales'], dimensions: ['channel'], period: f.period, grain: barGrain, filters, limit: 2000 })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales'], dimensions: ['daypart'], period: f.period, grain: barGrain, filters, limit: 2000 })),
    f.venueId ? Promise.resolve(null) : read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['venue'], period: f.period, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], dimensions: ['day_of_week', 'hour'], period: f.period, filters, limit: 500 })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['source'], period: f.period, compareTo, filters })),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title="Analytics" description={`${f.venueLabel}. Sales from the ledger, split the ways a manager asks about them.`} />
      <AnalyticsTabs current="/console/analytics" query={f.query} manager={atLeast(c.role, 'manager')} />
      <div>
        <AnalyticsFilterRow filter={f} c={c} />
        {kpis.ok ? (
          <>
            <div className="space-y-3">
              <KpiTiles result={kpis.data} keys={KPI.slice(0, 4)} compareLabel={compareLabel.toLowerCase()} />
              <KpiTiles result={kpis.data} keys={KPI.slice(4, 8)} compareLabel={compareLabel.toLowerCase()} />
              <KpiTiles result={kpis.data} keys={KPI.slice(8, 12)} compareLabel={compareLabel.toLowerCase()} />
            </div>
            <Provenance result={kpis.data} timeZone={tz} />
            <Caveats items={kpis.data.caveats} />
          </>
        ) : (
          <ReadError message={kpis.error} />
        )}
      </div>

      <Section title="Trend" description={`By ${grain}.`} data={byDay} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare })} caveats={(d) => d.caveats}>
        {(d) => {
          const net = trend(d, 'net_sales', compareLabel);
          const aov = trend(d, 'avg_order_value', compareLabel);
          return (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <LineChart title="Net sales" subtitle={dateRange(d.period.from, d.period.to)} x={net.x} series={net.series} format="money" currency={d.currency} />
              <LineChart title="Average order value" subtitle={dateRange(d.period.from, d.period.to)} x={aov.x} series={aov.series} format="money" currency={d.currency} />
            </div>
          );
        }}
      </Section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Section title="Channel mix over time" description={`Net sales by channel, per ${barGrain}.`} data={byChannel} timeZone={tz} provenance={(d) => ({ period: d.period })} caveats={(d) => d.caveats}>
          {(d) => <Stacked result={d} dim="channel" title="Net sales by channel" />}
        </Section>
        <Section title="Daypart mix over time" description={`Net sales by daypart, per ${barGrain}.`} data={byDaypart} timeZone={tz} provenance={(d) => ({ period: d.period })} caveats={(d) => d.caveats}>
          {(d) => <Stacked result={d} dim="daypart" title="Net sales by daypart" />}
        </Section>
      </div>

      {byVenue ? (
        <Section title="Venues side by side" data={byVenue} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare, venues: d.venues })} caveats={(d) => d.caveats}>
          {(d) => {
            const s = split(d, 'venue', 'net_sales', compareLabel);
            return (
              <div className="space-y-4">
                <BarChart title="Net sales by venue" x={s.x} xLabel="Venue" series={s.series} format="money" currency={d.currency} />
                <div className="rounded-lg border border-line bg-surface">
                  <ResultTable result={d} />
                </div>
              </div>
            );
          }}
        </Section>
      ) : null}

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Section title="Busiest hours" description="Orders by weekday and hour, venue-local time." data={hours} timeZone={tz} provenance={(d) => ({ period: d.period })} caveats={(d) => d.caveats}>
          {(d) => {
            const h = heat(d, 'orders');
            return h.hours.length ? (
              <HourHeatmap title="Orders by hour and weekday" subtitle={dateRange(d.period.from, d.period.to)} rows={h.rows} hours={h.hours} />
            ) : (
              <EmptyState title="No sales in this period">That is unmeasured, not a quiet week.</EmptyState>
            );
          }}
        </Section>
        <Section title="Where sales were recorded" description="The system each sale came from." data={sources} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare })} caveats={(d) => d.caveats}>
          {(d) => (
            <RankBars title="Net sales by source" rows={d.rows.map((r) => ({ label: words(r.dimensions.source), value: r.values.net_sales ?? 0, detail: `${r.values.orders ?? 0} orders` }))} format="money" currency={d.currency} />
          )}
        </Section>
      </div>
    </div>
  );
}

/** A part-to-whole bar per period, one segment per member of the dimension. */
function Stacked({ result, dim, title }: { result: analytics.MetricResult; dim: string; title: string }) {
  const buckets = [...new Set(result.rows.map((r) => r.period_start).filter((b): b is string => !!b))].sort();
  const members = [...new Set(result.rows.map((r) => r.dimensions[dim] ?? '(none)'))]
    .map((m) => ({ m, total: result.rows.filter((r) => (r.dimensions[dim] ?? '(none)') === m).reduce((s, r) => s + (r.values.net_sales ?? 0), 0) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);
  if (!buckets.length || !members.length) return <EmptyState title="No sales in this period">That is unmeasured, not a quiet period.</EmptyState>;
  // Four colours at most: the rest are grouped as "Other" so colour always means one thing.
  const top = members.slice(0, 3).map((x) => x.m);
  const groups = members.length > 4 ? [...top, 'Other'] : members.map((x) => x.m);
  const value = (b: string, g: string) =>
    result.rows
      .filter((r) => r.period_start === b && (g === 'Other' ? !top.includes(r.dimensions[dim] ?? '(none)') : (r.dimensions[dim] ?? '(none)') === g))
      .reduce((s, r) => s + (r.values.net_sales ?? 0), 0);
  const trendX = trend({ ...result, rows: buckets.map((b) => ({ period_start: b, dimensions: {}, values: {} })) } as analytics.MetricResult, 'net_sales').x;
  return (
    <BarChart
      title={title}
      subtitle={dateRange(result.period.from, result.period.to)}
      x={trendX}
      stacked
      series={groups.map((g, i) => ({ key: g, label: words(g), values: buckets.map((b) => value(b, g)), slot: g === 'Other' ? 'muted' : (((i % 4) + 1) as 1 | 2 | 3 | 4) }))}
      format="money"
      currency={result.currency}
    />
  );
}
