import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { grainFor, readFilter, venueFilter } from '@/lib/console-filters';
import { approxDays, bucketLabel, show, trend, words } from '@/lib/console-analytics';
import { BarChart, Card, EmptyState, PageHeader, RankBars, StatTile, Table, Td, Th } from '@/ui';
import { percent } from '@/ui/format';
import { AnalyticsFilterRow, Caveats, Provenance, dateRange } from '@/components/console/provenance';
import { Section } from '@/components/console/analytics/blocks';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ReadError } from '@/components/console/states';

export const metadata = { title: 'Customer insight · Analytics · Restaurant OS' };

/**
 * The customer base in aggregate: new against returning, segments, cohort retention, the time
 * to a second visit and where customers came from. Never an individual guest.
 */
export default async function CustomerInsight({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const f = readFilter(await searchParams, c);
  const tz = c.venue.timezone;
  const days = approxDays(f.periodKey, f.from, f.to);
  const grain = days > 14 ? (grainFor(days) === 'day' ? 'week' : grainFor(days)) : 'day';
  const cohortPeriod = days >= 90 ? f.period : ('last_365_days' as const);
  const filters = venueFilter(f);

  const [summary, flows, cohorts] = await Promise.all([
    read((ctx) => analytics.customersSummary(ctx, { venueId: f.venueId })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['new_customers', 'returning_customers', 'returning_customer_share'], period: f.period, grain, compareTo: f.compare ?? undefined, filters })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['cohort_size', 'cohort_retention_rate'], period: cohortPeriod, grain: 'month', filters, limit: 2000 })),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title="Customer insight" description={`${f.venueLabel}. Known customers only, in aggregate. No guest is listed or described here.`} />
      <AnalyticsTabs current="/console/analytics/customers" query={f.query} manager={atLeast(c.role, 'manager')} />
      <AnalyticsFilterRow filter={f} c={c} />

      {summary.ok ? (
        <section className="space-y-3" aria-label="The customer base today">
          <h2 className="text-lg font-semibold text-ink">The customer base as of {summary.data.as_of_day}</h2>
          <p className="text-sm text-ink-2">Everyone known up to today, so the period above does not apply to this part; the venue does.</p>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="customer-tiles">
            <StatTile label="Known customers" value={summary.data.known_customers.toLocaleString('en-AU')} hint={`${percent(summary.data.identified_share_of_orders_last_28_days, 1)} of the last 28 days' orders are tied to one`} />
            <StatTile label="Repeat rate" value={percent(summary.data.repeat_rate, 1)} hint="Ordered at least twice" />
            <StatTile label="Median days to second visit" value={summary.data.median_days_to_second_order === null ? '–' : `${Math.round(summary.data.median_days_to_second_order)} days`} hint="Among customers who came back" />
            <StatTile label="Average spend to date" value={show(summary.data.avg_lifetime_spend_cents, 'cents', summary.data.currency)} hint={`${summary.data.avg_orders_per_customer ?? '–'} orders per customer`} />
          </div>
          <p className="text-sm text-ink">{summary.data.summary}</p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <RankBars
              title="Segments"
              subtitle="Customers in each segment today"
              rows={summary.data.segments.map((s) => ({ label: words(s.segment), value: s.customers, detail: `${percent(s.share_of_spend, 0)} of spend` }))}
            />
            <Card title="What each segment means" padded={false}>
              <Table>
                <thead>
                  <tr>
                    <Th>Segment</Th>
                    <Th>Meaning</Th>
                    <Th align="right">Share</Th>
                    <Th align="right">Avg spend</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.segments.map((s) => (
                    <tr key={s.segment}>
                      <Td>{words(s.segment)}</Td>
                      <Td className="text-ink-2">{s.meaning}</Td>
                      <Td numeric>{percent(s.share_of_customers, 1)}</Td>
                      <Td numeric>{show(s.avg_lifetime_spend_cents, 'cents', summary.data.currency)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
          {summary.data.by_acquisition_source.length ? (
            <Card title="Where customers first came from" description="Stamped once, when the customer was first known." padded={false}>
              <Table>
                <thead>
                  <tr>
                    <Th>Source</Th>
                    <Th align="right">Customers</Th>
                    <Th align="right">Repeat rate</Th>
                    <Th align="right">Avg spend to date</Th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.by_acquisition_source.map((s) => (
                    <tr key={s.source}>
                      <Td>{words(s.source)}</Td>
                      <Td numeric>{s.customers.toLocaleString('en-AU')}</Td>
                      <Td numeric>{percent(s.repeat_rate, 1)}</Td>
                      <Td numeric>{show(s.avg_lifetime_spend_cents, 'cents', summary.data.currency)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          ) : null}
          <Provenance result={{ as_of: summary.data.as_of }} timeZone={tz} />
          <Caveats items={summary.data.caveats} />
        </section>
      ) : (
        <ReadError message={summary.error} />
      )}

      <div>
        <Section title="New and returning" description={`Known customers with a sale, per ${grain}.`} data={flows} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare })} caveats={(d) => d.caveats}>
          {(d) => {
            const rows = d.rows.filter((r) => r.period_start);
            const share = trend(d, 'returning_customer_share', 'Comparison');
            return (
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <BarChart
                  title="New and returning customers"
                  subtitle={dateRange(d.period.from, d.period.to)}
                  x={trend(d, 'new_customers').x}
                  stacked
                  series={[
                    { key: 'new', label: 'New', values: rows.map((r) => r.values.new_customers ?? null), slot: 1 },
                    { key: 'returning', label: 'Returning', values: rows.map((r) => r.values.returning_customers ?? null), slot: 3 },
                  ]}
                />
                <BarChart title="Returning share of active customers" subtitle={dateRange(d.period.from, d.period.to)} x={share.x} series={share.series} format="percent" />
              </div>
            );
          }}
        </Section>
      </div>

      <Section
        title="Cohort retention"
        description={`Customers grouped by the month of their first order${cohortPeriod === f.period ? '' : ' over the last 365 days (the chosen period is too short for cohorts)'}, and the share who ordered again each month after.`}
        data={cohorts}
        timeZone={tz}
        provenance={(d) => ({ period: d.period })}
        caveats={(d) => d.caveats}
      >
        {(d) => <CohortTable result={d} />}
      </Section>
    </div>
  );
}

function CohortTable({ result }: { result: analytics.MetricResult }) {
  const cohorts = [...new Set(result.rows.map((r) => r.dimensions.cohort ?? ''))].filter(Boolean).sort();
  const maxSince = Math.max(0, ...result.rows.map((r) => Number(r.dimensions.periods_since ?? 0)));
  if (!cohorts.length) return <EmptyState title="No cohorts in this period">No known customer placed a first order in these dates.</EmptyState>;
  const cell = (cohort: string, since: number) => result.rows.find((r) => r.dimensions.cohort === cohort && Number(r.dimensions.periods_since) === since);
  const cols = Array.from({ length: Math.min(maxSince, 12) + 1 }, (_, i) => i);
  return (
    <div className="rounded-lg border border-line bg-surface" data-testid="cohort-table">
      <Table>
        <thead>
          <tr>
            <Th>First order in</Th>
            <Th align="right">Customers</Th>
            {cols.map((i) => (
              <Th key={i} align="right">
                {i === 0 ? 'Month 0' : `+${i}`}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((co) => (
            <tr key={co}>
              <Td>{bucketLabel(co, 'month')}</Td>
              <Td numeric>{cell(co, 0)?.values.cohort_size ?? '–'}</Td>
              {cols.map((i) => {
                const v = cell(co, i)?.values.cohort_retention_rate;
                return (
                  <Td key={i} numeric className={v === undefined ? 'text-ink-3' : ''}>
                    {v === undefined || v === null ? '' : percent(v, 0)}
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="px-4 py-2 text-xs text-ink-3">Month 0 is the month of the first order, so it is always 100%. Blank cells are months that have not happened yet.</p>
    </div>
  );
}
