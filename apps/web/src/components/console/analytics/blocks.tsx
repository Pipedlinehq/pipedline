import type { ReactNode } from 'react';
import type { analytics } from '@ros/modules';
import { Badge, Card, StatTile, Table, Td, Th } from '@/ui';
import { dateTime, dayLabel } from '@/ui/format';
import { bucketLabel, goodWhen, nameOf, show, unitOf, words } from '@/lib/console-analytics';
import { Caveats, Provenance, dateRange } from '../provenance';
import { ReadError } from '../states';
import type { Read } from '@/lib/console-read';

/** Significance of a change, in words, never colour alone. */
export function SignificanceBadge({ s }: { s: analytics.Significance }) {
  if (s === 'strong') return <Badge tone="accent">Well outside normal</Badge>;
  if (s === 'notable') return <Badge tone="accent">Outside normal</Badge>;
  if (s === 'insufficient_history') return <Badge>Not enough history</Badge>;
  return <Badge>Within normal</Badge>;
}

const WINDOW_LABEL: Record<analytics.SalesWindow['window'], string> = {
  today_so_far: 'Today so far',
  yesterday: 'Yesterday',
  this_week_so_far: 'This week so far',
  last_week: 'Last week',
};

/** Today against a like-for-like baseline: the same weekdays, cut at the same time of day. */
export function TodayCard({ summary, timeZone }: { summary: analytics.SalesSummary; timeZone: string }) {
  const [today] = summary.windows;
  return (
    <Card
      title={`Today at ${summary.venue}`}
      description={`To ${summary.local_time.slice(11)} local time, against the same weekday${today?.baseline_weeks ? ` over the last ${today.baseline_weeks} weeks` : 's before'}, cut at the same time. The period filter does not apply here; the venue does.`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="today-tiles">
        {summary.windows.map((w) => (
          <div key={w.window} className="space-y-1.5">
            <StatTile
              label={`${WINDOW_LABEL[w.window]} · net sales`}
              value={show(w.net_sales_cents, 'cents', summary.currency)}
              delta={w.change_pct}
              comparedTo={w.usual_net_sales_cents === null ? undefined : `usual ${show(w.usual_net_sales_cents, 'cents', summary.currency)}`}
              hint={w.usual_net_sales_cents === null ? 'No usual yet: too little history' : undefined}
            />
            <p className="flex flex-wrap items-center gap-2 px-1 text-xs text-ink-2">
              <span>
                {w.orders.toLocaleString('en-AU')} {w.orders === 1 ? 'order' : 'orders'}
                {w.usual_orders !== null ? ` (usual ${w.usual_orders})` : ''}
              </span>
              <SignificanceBadge s={w.significance} />
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-ink" data-testid="today-summary">
        {summary.summary}
      </p>
      <Provenance
        timeZone={timeZone}
        result={{
          freshness: { latest_sale_at: summary.freshness.latest_sale_at, latest_sale_ingested_at: summary.freshness.latest_sale_ingested_at },
          as_of: summary.as_of,
          sources: [{ metrics: ['net_sales'], read_from: 'ledger', tables: ['transactions'], source_rows: {} }],
        }}
      />
      <Caveats items={summary.caveats} />
    </Card>
  );
}

/** Headline figures for the filtered period, each against the comparison period. */
export function KpiTiles({ result, keys, compareLabel }: { result: analytics.MetricResult; keys: string[]; compareLabel?: string }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="kpi-tiles">
      {keys.map((k) => {
        const unit = unitOf(result, k);
        const v = result.totals.values[k];
        const change = result.totals.change?.[k];
        const prev = result.totals.compare?.[k];
        return (
          <div key={k} data-metric={k} data-value={v ?? ''}>
          <StatTile
            label={nameOf(result, k)}
            value={show(v, unit, result.currency)}
            delta={change ? change.pct : null}
            goodWhen={goodWhen(result, k)}
            comparedTo={result.compare ? `${compareLabel ?? 'comparison'} (${show(prev, unit, result.currency)})` : undefined}
            hint={result.compare ? 'No comparison value' : undefined}
          />
          </div>
        );
      })}
    </div>
  );
}

/** Any metric result as a table: dimensions, each metric, and its change when compared. */
export function ResultTable({ result, max = 50 }: { result: analytics.MetricResult; max?: number }) {
  const keys = result.metrics.map((m) => m.key);
  const hasTime = result.grain !== null && result.rows.some((r) => r.period_start);
  return (
    <Table>
      <thead>
        <tr>
          {hasTime ? <Th>Period</Th> : null}
          {result.dimensions.map((d) => (
            <Th key={d}>{words(d)}</Th>
          ))}
          {keys.map((k) => (
            <Th key={k} align="right">
              {nameOf(result, k)}
            </Th>
          ))}
          {result.compare
            ? keys.map((k) => (
                <Th key={`${k}-c`} align="right">
                  {keys.length > 1 ? `${nameOf(result, k)} change` : 'Change'}
                </Th>
              ))
            : null}
        </tr>
      </thead>
      <tbody>
        {result.rows.slice(0, max).map((r, i) => (
          <tr key={i}>
            {hasTime ? <Td>{bucketLabel(r.period_start, result.grain)}</Td> : null}
            {result.dimensions.map((d) => (
              <Td key={d}>{words(r.dimensions[d])}</Td>
            ))}
            {keys.map((k) => (
              <Td key={k} numeric>
                {show(r.values[k], unitOf(result, k), result.currency)}
              </Td>
            ))}
            {result.compare
              ? keys.map((k) => (
                  <Td key={`${k}-c`} numeric className="text-ink-2">
                    {changeText(r.change?.[k], unitOf(result, k), result.currency)}
                  </Td>
                ))
              : null}
          </tr>
        ))}
        <tr>
          {hasTime ? <Td className="font-medium">Total</Td> : null}
          {result.dimensions.map((d, i) => (
            <Td key={d} className="font-medium">
              {i === 0 && !hasTime ? 'Total' : ''}
            </Td>
          ))}
          {keys.map((k) => (
            <Td key={k} numeric className="font-medium">
              {show(result.totals.values[k], unitOf(result, k), result.currency)}
            </Td>
          ))}
          {result.compare
            ? keys.map((k) => (
                <Td key={`${k}-c`} numeric className="font-medium text-ink-2">
                  {changeText(result.totals.change?.[k], unitOf(result, k), result.currency)}
                </Td>
              ))
            : null}
        </tr>
      </tbody>
    </Table>
  );
}

export function changeText(ch: analytics.MetricChange | undefined, unit: string, currency: string): string {
  if (!ch || ch.abs === null) return '–';
  if (unit === 'ratio') return `${ch.abs > 0 ? '+' : ''}${(ch.abs * 100).toFixed(1)} pts`;
  if (ch.pct === null) return `${ch.abs > 0 ? '+' : ''}${show(ch.abs, unit as 'cents', currency)}`;
  return `${ch.pct > 0 ? '+' : ''}${(ch.pct * 100).toFixed(1)}%`;
}

/** A section of an analytics page: its content, where the numbers came from, and the caveats. */
export function Section<T>({
  title,
  description,
  data,
  children,
  timeZone,
  provenance,
  caveats,
  actions,
}: {
  title: string;
  description?: ReactNode;
  data: Read<T>;
  children: (d: T) => ReactNode;
  timeZone: string;
  provenance?: (d: T) => Parameters<typeof Provenance>[0]['result'] | null;
  caveats?: (d: T) => string[];
  actions?: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          {description ? <p className="text-sm text-ink-2">{description}</p> : null}
        </div>
        {actions}
      </div>
      {data.ok ? (
        <>
          {children(data.data)}
          {provenance && provenance(data.data) ? <Provenance result={provenance(data.data)!} timeZone={timeZone} /> : null}
          {caveats ? <Caveats items={caveats(data.data)} /> : null}
        </>
      ) : (
        <ReadError message={data.error} />
      )}
    </section>
  );
}

export { dateRange, dateTime, dayLabel };
