import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { words } from '@/lib/console-analytics';
import { Badge, Card, PageHeader, Table, Td, Th } from '@/ui';
import { dateTime } from '@/ui/format';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { Facts, ReadError } from '@/components/console/states';

export const metadata = { title: 'Data dictionary · Analytics · Restaurant OS' };

const DIRECTION = { up_is_good: 'Higher is better', down_is_good: 'Lower is better', neutral: 'Neither' } as const;

/**
 * Every metric and every event, with its definition: the same entries the dashboards and an
 * assistant compute from, so a number on screen can always be traced to how it was made.
 */
export default async function Dictionary() {
  const c = await getConsole();
  const [dict, facts] = await Promise.all([read((ctx) => analytics.dataDictionary(ctx)), read((ctx) => analytics.factsState(ctx))]);
  if (!dict.ok) return <ReadError message={dict.error} />;
  const d = dict.data;
  const groups = [...new Set(d.metrics.map((m) => m.group))];
  const propsOf = (schema: unknown): string => {
    const p = (schema as { properties?: Record<string, unknown> })?.properties;
    return p ? Object.keys(p).join(', ') : '–';
  };
  return (
    <div className="space-y-8">
      <PageHeader title="Data dictionary" description={`Catalogue version ${d.catalogue_version}: ${d.metrics.length} metrics, ${d.dimensions.length} ways to split them and ${d.events.length} events. Definitions, not opinions.`} />
      <AnalyticsTabs current="/console/analytics/dictionary" manager={atLeast(c.role, 'manager')} />

      <nav aria-label="On this page" className="flex flex-wrap gap-3 text-sm">
        {[...groups.map((g) => [g, `g-${g}`]), ['Dimensions', 'dimensions'], ['Events', 'events'], ['Funnels', 'funnels'], ['Rules and settings', 'rules']].map(([label, id]) => (
          <a key={id} href={`#${id!.replace(/\W+/g, '-')}`} className="text-accent hover:underline">
            {label}
          </a>
        ))}
      </nav>

      {groups.map((g) => (
        <Card key={g} title={g} description={d.metrics.find((m) => m.group === g)?.period_means} padded={false}>
          <div id={`g-${g}`.replace(/\W+/g, '-')} className="divide-y divide-line">
            {d.metrics
              .filter((m) => m.group === g)
              .map((m) => (
                <div key={m.key} className="grid grid-cols-1 gap-2 px-5 py-4 lg:grid-cols-[16rem_minmax(0,1fr)]" data-testid="dictionary-metric">
                  <div>
                    <p className="font-medium text-ink">{m.name}</p>
                    <p className="font-mono text-xs text-ink-3">{m.key}</p>
                    <p className="mt-1 flex flex-wrap gap-1">
                      <Badge>{d.units[m.unit as keyof typeof d.units] ? m.unit : m.unit}</Badge>
                      <Badge>{DIRECTION[m.good_direction]}</Badge>
                      <Badge>{m.adds_up ? 'Adds up across rows' : 'Does not add up'}</Badge>
                    </p>
                  </div>
                  <div className="space-y-1 text-sm">
                    <p className="text-ink">{m.description}</p>
                    <p className="text-ink-2">
                      <span className="font-medium">How: </span>
                      {m.how_it_is_computed}
                    </p>
                    <p className="text-xs text-ink-3">
                      Split by: {m.dimensions.map((x) => words(x)).join(', ') || 'nothing'}
                      {m.time_grains.length ? ` · over time by ${m.time_grains.join(', ')}` : ' · a state at the end of the period, not over time'}
                      {m.requires_one_of_dimensions.length ? ` · needs one of: ${m.requires_one_of_dimensions.join(', ')}` : ''} · definition v{m.definition_version}
                    </p>
                    {m.caveats.length ? (
                      <ul className="list-disc pl-4 text-xs text-ink-2">
                        {m.caveats.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              ))}
          </div>
        </Card>
      ))}

      <Card title="Dimensions" description="The ways a metric can be split or filtered." padded={false}>
        <div id="dimensions">
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Key</Th>
                <Th>Meaning</Th>
                <Th>Values</Th>
              </tr>
            </thead>
            <tbody>
              {d.dimensions.map((x) => (
                <tr key={x.key}>
                  <Td>{x.name}</Td>
                  <Td className="font-mono text-xs">{x.key}</Td>
                  <Td className="text-ink-2">{x.description}</Td>
                  <Td className="text-ink-2">{x.values ?? '–'}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card title="Events" description="Everything the platform records, declared by the module that records it." padded={false}>
        <div id="events">
          <Table>
            <thead>
              <tr>
                <Th>Event</Th>
                <Th>Meaning</Th>
                <Th>Recorded by</Th>
                <Th>Properties</Th>
              </tr>
            </thead>
            <tbody>
              {d.events.map((e) => (
                <tr key={e.name} data-testid="dictionary-event">
                  <Td className="font-mono text-xs">{e.name}</Td>
                  <Td className="text-ink-2">
                    {e.description}
                    {e.funnel ? <span className="ml-1 text-xs text-ink-3">(step in a funnel)</span> : null}
                  </Td>
                  <Td>
                    {words(e.module)} · {e.sent_by}
                  </Td>
                  <Td className="font-mono text-xs text-ink-2">{propsOf(e.properties)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      </Card>

      <Card title="Funnels">
        <div id="funnels" className="space-y-3">
          {d.funnels.map((fn) => (
            <div key={fn.name}>
              <p className="font-medium text-ink">{words(fn.name)}</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-ink-2">
                {fn.steps.map((s) => (
                  <li key={s.event}>
                    <span className="font-mono text-xs text-ink">{s.event}</span>: {s.description}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Rules and settings">
        <div id="rules" className="space-y-4 text-sm">
          <Facts
            items={[
              ['Periods', `${d.periods.relative.map((p) => words(p).toLowerCase()).join(', ')}; or ${d.periods.absolute}. ${d.periods.note}`],
              ['Comparisons', d.comparisons.map((x) => words(x)).join(', ')],
              ['Segments', `${d.segments.rule}${d.segments.thresholds ? ` Thresholds: new for ${d.segments.thresholds.newWindowDays} days; at risk after ${d.segments.thresholds.atRiskDays}; lapsed after ${d.segments.thresholds.lapsedDays}; frequent from ${d.segments.thresholds.frequentOrders} orders; loyal from ${d.segments.thresholds.loyalOrders}.` : ''}`],
              ['Dayparts', d.dayparts ? d.dayparts.map((p) => `${words(p.key)} ${p.fromHour}:00–${p.toHour}:00`).join(', ') : '–'],
              ['Privacy floor', d.privacy ? `Campaign and creator results need at least ${d.privacy.min_cohort} guests, and nothing is shown for the first ${d.privacy.campaign_quiet_days} days.` : '–'],
              [
                'Derived facts',
                facts.ok
                  ? `${facts.data.salesFresh ? 'Level with the ledger' : 'Behind the ledger: queries read the ledger directly until they catch up'}; last computed ${facts.data.computedAt ? dateTime(facts.data.computedAt, c.venue.timezone) : 'never'}. Customer snapshot as of ${facts.data.customersAsOf ?? '–'}${facts.data.customersFresh ? '' : ' (being refreshed)'}.`
                  : facts.error,
              ],
            ]}
          />
        </div>
      </Card>
    </div>
  );
}
