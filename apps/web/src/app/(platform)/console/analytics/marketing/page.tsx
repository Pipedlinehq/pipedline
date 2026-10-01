import Link from 'next/link';
import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { grainFor, readFilter, venueFilter } from '@/lib/console-filters';
import { approxDays, trend, words } from '@/lib/console-analytics';
import { Badge, Card, EmptyState, LineChart, PageHeader, RankBars, Table, Td, Th } from '@/ui';
import { percent } from '@/ui/format';
import { AnalyticsFilterRow, Caveats, Provenance, dateRange } from '@/components/console/provenance';
import { ResultTable, Section } from '@/components/console/analytics/blocks';
import { FunnelSteps } from '@/components/console/analytics/funnel';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';

export const metadata = { title: 'Marketing · Analytics · Pipedline' };

type SP = Record<string, string | string[] | undefined>;
const SPLITS = ['utm_source', 'utm_medium', 'campaign', 'creator', 'device_class', 'landing_path'] as const;

/**
 * Visits, the ordering funnel, and what campaigns and creators are aligned with. Campaign and
 * creator results come only through the outcomes function, which applies the cohort floor, the
 * quiet period and the spend bands; this page adds no number of its own to them.
 */
export default async function Marketing({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = readFilter(sp, c);
  const tz = c.venue.timezone;
  const rawBy = Array.isArray(sp.by) ? sp.by[0] : sp.by;
  const by = SPLITS.find((s) => s === rawBy) ?? 'utm_source';
  const grain = grainFor(approxDays(f.periodKey, f.from, f.to));
  const filters = venueFilter(f);

  const [sessions, funnel, outcomes, messages] = await Promise.all([
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['web_sessions'], period: f.period, grain, compareTo: f.compare ?? undefined, filters })),
    read((ctx) => analytics.funnelReport(ctx, { venueId: f.venueId, period: f.period, by })),
    read((ctx) => analytics.campaignOutcomes(ctx, { venueId: f.venueId, period: f.period })),
    read((ctx) => analytics.queryMetrics(ctx, { metrics: ['messages_sent', 'message_delivery_rate', 'message_open_rate', 'message_click_rate', 'message_unsubscribe_rate'], dimensions: ['message_kind'], period: f.period, filters })),
  ]);
  const withBy = (b: string) => `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(f.query)), by: b }).toString()}`;

  return (
    <div className="space-y-8">
      <PageHeader title="Marketing" description={`${f.venueLabel}. Visits to the venue's site, how far they get, and what campaigns and creators are aligned with.`} />
      <AnalyticsTabs current="/console/analytics/marketing" query={f.query} manager={atLeast(c.role, 'manager')} />
      <AnalyticsFilterRow filter={f} c={c} extra={{ by }} />

      <Section title="Visits" description={`Sessions on the venue's own site, per ${grain}.`} data={sessions} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare, sources: d.sources })} caveats={(d) => d.caveats}>
        {(d) => {
          const t = trend(d, 'web_sessions', 'Comparison');
          return <LineChart title="Web sessions" subtitle={dateRange(d.period.from, d.period.to)} x={t.x} series={t.series} />;
        }}
      </Section>

      <Section title="Ordering funnel" description="A closed funnel: a visit counts at a step only if it passed every earlier one." data={funnel} timeZone={tz} provenance={(d) => ({ period: d.period })} caveats={(d) => d.caveats}>
        {(d) => (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <FunnelSteps report={d} />
            <div className="rounded-lg border border-line bg-surface">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3 text-sm">
                <span className="text-ink-2">Split by</span>
                {SPLITS.map((s) => (
                  <Link key={s} href={withBy(s)} aria-current={s === by ? 'true' : undefined} className={s === by ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
                    {words(s.replace('utm_', 'traffic '))}
                  </Link>
                ))}
              </div>
              {d.splits.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>{words(by.replace('utm_', 'traffic '))}</Th>
                      <Th align="right">Visits</Th>
                      <Th align="right">Reached the last step</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.splits.map((s) => {
                      const last = s.steps[s.steps.length - 1];
                      return (
                        <tr key={s.value}>
                          <Td>{s.value}</Td>
                          <Td numeric>{s.steps[0]?.sessions ?? 0}</Td>
                          <Td numeric>{percent(last?.conversion_from_start ?? null, 1)}</Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              ) : (
                <p className="px-4 py-6 text-sm text-ink-3">No visits to split in this period.</p>
              )}
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Campaigns and creators"
        description="Totals only. Aligned with a campaign or creator, never “caused by” it."
        data={outcomes}
        timeZone={tz}
        provenance={(d) => ({ period: d.period.from ? { from: d.period.from, to: d.period.to } : null, as_of: d.as_of })}
        caveats={(d) => d.caveats}
      >
        {(d) =>
          d.outcomes.length ? (
            <div className="space-y-4">
              <p className="rounded-md bg-accent-soft px-3 py-2 text-sm text-accent">
                {d.wording} Anything describing fewer than {d.min_cohort} guests is withheld, and nothing is shown for the first {d.quiet_days} days after a campaign starts.
              </p>
              {d.outcomes.some((o) => o.status === 'measured') ? <RankBars
                title="Visits aligned with each campaign or creator"
                subtitle="Only measured results; withheld ones are listed below"
                rows={d.outcomes.filter((o) => o.status === 'measured').map((o) => ({ label: label(o), value: o.sessions ?? 0, detail: o.revenue_band ? `spend ${o.revenue_band.label}` : undefined }))}
              /> : null}
              <Card title="Every campaign and creator" padded={false}>
                <Table>
                  <thead>
                    <tr>
                      <Th>Campaign</Th>
                      <Th>Creator</Th>
                      <Th>Status</Th>
                      <Th align="right">Visits</Th>
                      <Th align="right">New guests</Th>
                      <Th align="right">Orders</Th>
                      <Th>Spend (band)</Th>
                      <Th align="right">Came back</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.outcomes.map((o, i) => (
                      <tr key={i} data-testid="campaign-outcome">
                        <Td>{o.campaign_id ?? '–'}</Td>
                        <Td>{o.creator_id ?? '–'}</Td>
                        <Td>
                          <span className="flex flex-col items-start gap-1">
                            <Badge tone={o.status === 'measured' ? 'good' : 'neutral'}>{o.status === 'measured' ? 'Measured' : o.status === 'too_early' ? 'Too early' : 'Withheld'}</Badge>
                            <span className="min-w-48 max-w-72 text-xs text-ink-3">{o.status_note}</span>
                          </span>
                        </Td>
                        <Td numeric>{o.sessions ?? '–'}</Td>
                        <Td numeric>{o.new_customers ?? '–'}</Td>
                        <Td numeric>{o.orders ?? '–'}</Td>
                        <Td>{o.revenue_band?.label ?? '–'}</Td>
                        <Td numeric>{o.repeat_rate === null ? '–' : percent(o.repeat_rate, 0)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </Card>
              <ul className="space-y-1 text-sm text-ink-2">
                {d.outcomes
                  .filter((o) => o.status === 'measured')
                  .map((o, i) => (
                    <li key={i}>{o.summary}</li>
                  ))}
              </ul>
            </div>
          ) : (
            <EmptyState title="No campaign or creator activity yet">Visits that arrive with a campaign or creator link appear here once there are enough of them to report.</EmptyState>
          )
        }
      </Section>

      <Section title="Messages" description="Email and SMS the venue sent, by kind." data={messages} timeZone={tz} provenance={(d) => ({ period: d.period, compare: d.compare, sources: d.sources })} caveats={(d) => d.caveats}>
        {(d) =>
          d.rows.length ? (
            <div className="rounded-lg border border-line bg-surface">
              <ResultTable result={d} />
            </div>
          ) : (
            <EmptyState title="No messages sent in this period" />
          )
        }
      </Section>
    </div>
  );
}

function label(o: analytics.CampaignOutcome): string {
  return [o.campaign_id ? `Campaign ${o.campaign_id}` : null, o.creator_id ? `creator ${o.creator_id}` : null].filter(Boolean).join(' · ');
}
