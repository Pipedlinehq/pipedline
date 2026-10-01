import Link from 'next/link';
import type { analytics } from '@ros/modules';
import { BarChart, LineChart, RankBars } from '@/ui';
import { formatOf, nameOf, split, trend, unitOf, words } from '@/lib/console-analytics';
import { Caveats, Provenance, dateRange } from '../provenance';
import { KpiTiles, ResultTable } from './blocks';

/** The right picture for any metric result: a line over time, bars per member, or headline tiles. */
export function ResultChart({ result, title }: { result: analytics.MetricResult; title: string }) {
  const key = result.metrics[0]!.key;
  const unit = unitOf(result, key);
  const subtitle = `${nameOf(result, key)} · ${dateRange(result.period.from, result.period.to)}`;
  if (result.grain && result.dimensions.length === 0) {
    const t = trend(result, key, 'Comparison');
    return <LineChart title={title} subtitle={subtitle} x={t.x} series={t.series} format={formatOf(unit)} currency={result.currency} />;
  }
  if (result.dimensions.length === 1 && !result.grain) {
    const dim = result.dimensions[0]!;
    if (result.compare && result.rows.length <= 12) {
      const s = split(result, dim, key, 'Comparison');
      return <BarChart title={title} subtitle={subtitle} x={s.x} xLabel={words(dim)} series={s.series} format={formatOf(unit)} currency={result.currency} />;
    }
    return (
      <RankBars
        title={title}
        subtitle={subtitle}
        rows={result.rows.map((r) => ({ label: words(r.dimensions[dim]), value: r.values[key] ?? 0 }))}
        format={formatOf(unit)}
        currency={result.currency}
      />
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface p-5">
      <p className="mb-3 text-base font-semibold text-ink">{title}</p>
      {result.dimensions.length === 0 && !result.grain ? <KpiTiles result={result} keys={result.metrics.map((m) => m.key).slice(0, 4)} /> : <ResultTable result={result} max={20} />}
    </div>
  );
}

export function PinnedViews({ items, timeZone }: { items: Array<{ view: analytics.SavedView; result: analytics.MetricResult | null; error: string | null }>; timeZone: string }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      {items.map(({ view, result, error }) => (
        <div key={view.id} data-testid="pinned-view">
          {result ? (
            <>
              <ResultChart result={result} title={view.name} />
              {view.description ? <p className="mt-1 text-xs text-ink-2">{view.description}</p> : null}
              <Provenance result={result} timeZone={timeZone} />
              <Caveats items={result.caveats} />
              <Link href={`/console/analytics/views?view=${view.id}`} className="mt-1 inline-block text-xs text-accent hover:underline">
                Open as a table
              </Link>
            </>
          ) : (
            <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
              {view.name}: {error}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
