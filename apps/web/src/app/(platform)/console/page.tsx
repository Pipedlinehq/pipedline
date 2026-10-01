import Link from 'next/link';
import { analytics } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { grainFor, readFilter, venueFilter } from '@/lib/console-filters';
import { PERIOD_WORDS, approxDays, digestsFor, heat, split, trend } from '@/lib/console-analytics';
import { BarChart, EmptyState, HourHeatmap, LineChart, PageHeader, RankBars } from '@/ui';
import { AnalyticsFilterRow, Caveats, Provenance, dateRange, noteOf } from '@/components/console/provenance';
import { KpiTiles, Section, TodayCard } from '@/components/console/analytics/blocks';
import { DigestFindings } from '@/components/console/analytics/digest';
import { PinnedViews } from '@/components/console/analytics/views';
import { FunnelSteps } from '@/components/console/analytics/funnel';
import { ReadError } from '@/components/console/states';

export const metadata = { title: 'Overview · Pipedline' };

const COMPARE_WORDS = { previous_period: 'Previous period', same_period_last_year: 'Same period last year' } as const;

/**
 * The overview: today against a like-for-like baseline first, then the filtered period's
 * trend, splits, heat-map, menu, customers, funnel, the latest digest and the pinned views.
 * Every number comes from the analytics module's deterministic queries and says where from.
 */
export default async function ConsoleHome({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const f = readFilter(await searchParams, c);
  const tz = c.venue.timezone;
  const compareTo = f.compare ?? undefined;
  const compareLabel = f.compare ? COMPARE_WORDS[f.compare] : 'Comparison';
  const grain = grainFor(approxDays(f.periodKey, f.from, f.to));
  const filters = venueFilter(f);

  const [today, kpis, sales, channel, daypart, hours, menu, flows, funnel, digests, pinned] = await Promise.all([
    read((ctx) => analytics.salesSummary(ctx, { venueId: f.venueId })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders', 'avg_order_value', 'identified_share'], period: f.period, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], period: f.period, grain, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: f.period, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['daypart'], period: f.period, compareTo, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['day_of_week', 'hour'], period: f.period, filters, limit: 500 })),
    read((ctx) => analytics.menuPerformance(ctx, { venueId: f.venueId, period: f.period, limit: 8 })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['new_customers', 'returning_customers', 'active_customers'], period: f.period, grain: grain === 'day' && approxDays(f.periodKey, f.from, f.to) > 14 ? 'week' : grain, compareTo, filters })),
    read((ctx) => analytics.funnelReport(ctx, { venueId: f.venueId, period: f.period })),
    read((ctx) => digestsFor(ctx, f.venueId, c.venues.length, { period: 'week', limit: 1 })),
    read(async (ctx) => {
      const views = (await analytics.listViews(ctx, { pinnedOnly: true })).slice(0, 4);
      const out = [];
      for (const v of views) {
        try {
          out.push({ view: v, result: (await analytics.runView(ctx, { id: v.id })).result, error: null as string | null });
        } catch (e) {
          out.push({ view: v, result: null, error: (e as Error).message });
        }
      }
      return out;
    }),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" description={`${f.venueLabel}. Every figure below says which dates it covers, what it is compared with and where it was read from.`} />

      <div className="space-y-4">
        <AnalyticsFilterRow filter={f} c={c} />
        {today.ok ? <TodayCard summary={today.data} timeZone={tz} /> : <ReadError message={today.error} />}
      </div>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-ink">{f.periodKey === 'custom' ? 'The chosen dates' : (PERIOD_WORDS[f.periodKey] ?? '').replace(/^./, (x) => x.toUpperCase())}</h2>
        {kpis.ok ? (
          <>
            <KpiTiles result={kpis.data} keys={['net_sales', 'orders', 'avg_order_value', 'identified_share']} compareLabel={compareLabel.toLowerCase()} />
            <Provenance result={kpis.data} timeZone={tz} />
            <Caveats items={kpis.data.caveats} />
          </>
        ) : (
          <ReadError message={kpis.error} />
        )}
      </div>

      <Section title="Sales trend" description={`Net sales by ${grain}${f.compare ? `, against ${compareLabel.toLowerCase()}` : ''}.`} data={sales} timeZone={tz} provenance={(d) => d} caveats={(d) => d.caveats}>
        {(d) => {
          const t = trend(d, 'net_sales', compareLabel);
          const o = trend(d, 'orders', compareLabel);
          return (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <LineChart title="Net sales" subtitle={dateRange(d.period.from, d.period.to)} x={t.x} series={t.series} format="money" currency={d.currency} note={noteOf(d.metrics[0]?.caveats, 1)} />
              <LineChart title="Orders" subtitle={dateRange(d.period.from, d.period.to)} x={o.x} series={o.series} format="number" />
            </div>
          );
        }}
      </Section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Section title="By channel" description="How guests were served." data={channel} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare })} caveats={(d) => d.caveats}>
          {(d) => {
            const s = split(d, 'channel', 'net_sales', compareLabel);
            return <BarChart title="Net sales by channel" x={s.x} xLabel="Channel" series={s.series} format="money" currency={d.currency} />;
          }}
        </Section>
        <Section title="By daypart" description="By the venue-local hour of the sale." data={daypart} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare })} caveats={(d) => d.caveats}>
          {(d) => {
            const s = split(d, 'daypart', 'net_sales', compareLabel);
            return <BarChart title="Net sales by daypart" x={s.x} xLabel="Daypart" series={s.series} format="money" currency={d.currency} />;
          }}
        </Section>
      </div>

      <Section title="When it sells" description="Net sales by weekday and hour, venue-local time." data={hours} timeZone={tz} provenance={(d) => ({ period: d.period, sources: d.sources })} caveats={(d) => d.caveats}>
        {(d) => {
          const h = heat(d, 'net_sales');
          return h.hours.length ? (
            <HourHeatmap title="Net sales by hour and weekday" subtitle={dateRange(d.period.from, d.period.to)} rows={h.rows} hours={h.hours} format="money" currency={d.currency} />
          ) : (
            <EmptyState title="No sales in this period">Nothing was recorded for these dates and venues. That is unmeasured, not a quiet week.</EmptyState>
          );
        }}
      </Section>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Section
          title="Menu"
          description={<Link className="text-accent hover:underline" href={`/console/analytics/menu?${f.query}`}>Full menu performance →</Link>}
          data={menu}
          timeZone={tz}
          provenance={(d) => ({ period: d.period, compare: d.compared_with })}
          caveats={(d) => d.caveats}
        >
          {(d) => (
            <>
              <RankBars title="Top items by revenue" subtitle={d.summary} rows={d.rows.map((r) => ({ label: r.name, value: r.revenue_cents, detail: `${r.quantity} sold` }))} format="money" currency={d.currency} limit={8} />
            </>
          )}
        </Section>
        <Section
          title="Customers"
          description={<Link className="text-accent hover:underline" href={`/console/analytics/customers?${f.query}`}>Segments, cohorts and retention →</Link>}
          data={flows}
          timeZone={tz}
          provenance={(d) => ({ period: d.period, compare: d.compare })}
          caveats={(d) => d.caveats}
        >
          {(d) => {
            const rows = d.rows.filter((r) => r.period_start);
            return (
              <BarChart
                title="New and returning customers"
                subtitle="Known customers only"
                x={trend(d, 'new_customers').x}
                xLabel="Period"
                stacked
                series={[
                  { key: 'new', label: 'New', values: rows.map((r) => r.values.new_customers ?? null), slot: 1 },
                  { key: 'ret', label: 'Returning', values: rows.map((r) => r.values.returning_customers ?? null), slot: 3 },
                ]}
              />
            );
          }}
        </Section>
      </div>

      <div className="grid grid-cols-1 gap-8 xl:grid-cols-2">
        <Section
          title="Ordering funnel"
          description={<Link className="text-accent hover:underline" href={`/console/analytics/marketing?${f.query}`}>Funnel by source, campaigns and creators →</Link>}
          data={funnel}
          timeZone={tz}
          provenance={(d) => ({ period: d.period })}
          caveats={(d) => d.caveats}
        >
          {(d) => <FunnelSteps report={d} />}
        </Section>
        <Section
          title="This week's digest"
          description={<Link className="text-accent hover:underline" href="/console/analytics/digest">All digests →</Link>}
          data={digests}
          timeZone={tz}
        >
          {(d) =>
            d[0] ? (
              <DigestFindings digest={d[0]} timeZone={tz} compact />
            ) : (
              <EmptyState title="No weekly digest yet">Digests are written after each complete week. The first appears the Monday after a full week of sales.</EmptyState>
            )
          }
        </Section>
      </div>

      <Section title="Pinned views" description={<Link className="text-accent hover:underline" href="/console/analytics/views">All saved views →</Link>} data={pinned} timeZone={tz}>
        {(d) => (d.length ? <PinnedViews items={d} timeZone={tz} /> : <EmptyState title="Nothing pinned yet">Pin a saved view and it appears here, asked afresh each time you open the overview.</EmptyState>)}
      </Section>
      <p className="text-xs text-ink-3">
        Every metric is defined in the <Link href="/console/analytics/dictionary" className="text-accent hover:underline">data dictionary</Link>.
      </p>
    </div>
  );
}
