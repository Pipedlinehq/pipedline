import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { show, words } from '@/lib/console-analytics';
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th } from '@/ui';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { Provenance } from '@/components/console/provenance';
import { ReadError } from '@/components/console/states';

export const metadata = { title: 'Benchmarks · Analytics · Pipedline' };

const POSITION: Record<analytics.BenchmarkComparison['position'], { label: string; tone: 'neutral' | 'accent' }> = {
  below_p25: { label: 'Bottom quarter', tone: 'neutral' },
  p25_to_p50: { label: 'Below the middle', tone: 'neutral' },
  p50_to_p75: { label: 'Above the middle', tone: 'accent' },
  above_p75: { label: 'Top quarter', tone: 'accent' },
  unmeasured: { label: 'Unmeasured', tone: 'neutral' },
};

/** The organisation against the bands of similar venues. Opt-in, whole-org only, bands only. */
export default async function Benchmarks() {
  const c = await getConsole();
  const b = await read((ctx) => analytics.getBenchmarks(ctx));
  return (
    <div className="space-y-6">
      <PageHeader title="Benchmarks" description="How the organisation compares with similar venues that have opted in. Only bands are shared: no venue is named and no single venue's number leaves it." />
      <AnalyticsTabs current="/console/analytics/benchmarks" manager={atLeast(c.role, 'manager')} />
      {!b.ok ? (
        b.code === 'forbidden' ? (
          <EmptyState title="Benchmarks describe the whole organisation">They are shown to people who can see every venue. Your role covers some of them.</EmptyState>
        ) : (
          <ReadError message={b.error} />
        )
      ) : !b.data.opted_in || !b.data.comparisons.length ? (
        <EmptyState title={b.data.opted_in ? 'No bands yet' : 'Not switched on'}>{b.data.note}</EmptyState>
      ) : (
        <Card title={`Bands for ${b.data.period ? `${b.data.period.from} to ${b.data.period.to}` : 'the latest period'}`} description={b.data.note} padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Metric</Th>
                <Th>Compared with</Th>
                <Th align="right">You</Th>
                <Th align="right">Lower quarter</Th>
                <Th align="right">Middle</Th>
                <Th align="right">Upper quarter</Th>
                <Th align="right">Organisations</Th>
                <Th>Where you sit</Th>
              </tr>
            </thead>
            <tbody>
              {b.data.comparisons.map((x) => (
                <tr key={`${x.metric}-${x.cohort}`}>
                  <Td>{x.name}</Td>
                  <Td className="text-ink-2">{words(x.cohort)}</Td>
                  <Td numeric className="font-medium">
                    {show(x.your_value, x.unit)}
                  </Td>
                  <Td numeric>{show(x.p25, x.unit)}</Td>
                  <Td numeric>{show(x.p50, x.unit)}</Td>
                  <Td numeric>{show(x.p75, x.unit)}</Td>
                  <Td numeric>{x.n_orgs}</Td>
                  <Td>
                    <Badge tone={POSITION[x.position].tone}>{POSITION[x.position].label}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="px-5 pb-4">
            <Provenance result={{ as_of: b.data.as_of }} timeZone={c.venue.timezone} />
            <p className="mt-1 text-xs text-ink-3">A band needs at least {b.data.min_orgs} organisations. Whether a high or low position is good depends on the metric: see the data dictionary.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
