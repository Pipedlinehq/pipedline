import type { analytics } from '@ros/modules';
import { BarChart, LineChart, RankBars, type ChartAnnotation } from '@/ui';
import { percent } from '@/ui/format';
import { formatOf, nameOf, show, split, trend, unitOf, words } from '@/lib/console-analytics';
import { KpiTiles } from './blocks';
import { CohortGrid, type CohortCell } from './cohort-grid';

/**
 * The picture on a report page (docs/CONSOLE_IA.md section 9, pattern 9). One axis per chart:
 * the report's first metric is drawn and the rest sit in the table beneath. Colour follows the
 * series slot, never its rank; every chart has its table view; annotations are dashed rules with
 * their words beneath the chart and in the tooltip. A server component: it turns the result into
 * chart props and hands them to the client charts.
 */
export function ReportFigure({ report, result, annotations, compareLabel }: { report: analytics.ReportDef; result: analytics.MetricResult; annotations: analytics.Annotation[]; compareLabel: string }) {
  const lead = result.metrics[0]!.key;
  const unit = unitOf(result, lead);
  const subtitle = `${nameOf(result, lead)} · ${result.period.from} to ${result.period.to}`;
  if (report.chart === 'cohort') {
    const rate = result.metrics.find((m) => m.key === 'cohort_retention_rate')?.key ?? lead;
    const size = result.metrics.find((m) => m.key === 'cohort_size')?.key;
    const cells: CohortCell[] = result.rows.map((r) => ({ cohort: r.dimensions.cohort ?? '', index: Number(r.dimensions.periods_since ?? 0), rate: r.values[rate] ?? null, size: size ? (r.values[size] ?? null) : null }));
    return <CohortGrid title={report.name} cells={cells} grain={result.grain === 'week' ? 'week' : 'month'} />;
  }
  if (report.chart === 'tiles' || (!result.grain && !result.dimensions.length)) {
    return (
      <div className="rounded-card border border-line bg-surface p-5">
        <p className="mb-3 text-base font-semibold text-ink">{report.name}</p>
        <KpiTiles result={result} keys={result.metrics.map((m) => m.key).slice(0, 8)} compareLabel={compareLabel.toLowerCase()} />
      </div>
    );
  }
  if (result.grain && !result.dimensions.length) {
    const t = trend(result, lead, compareLabel);
    const rows = result.rows.filter((r) => r.period_start);
    const marks: ChartAnnotation[] = annotations
      .map((a) => ({ index: rows.findIndex((r, i) => a.date >= r.period_start! && (i === rows.length - 1 || a.date < rows[i + 1]!.period_start!)), label: a.label }))
      .filter((m) => m.index >= 0);
    return <LineChart title={report.name} subtitle={subtitle} x={t.x} series={t.series} format={formatOf(unit)} currency={result.currency} annotations={marks} />;
  }
  const dim = result.dimensions[0]!;
  if (report.chart === 'bars' && result.rows.length <= 24) {
    const s = split(result, dim, lead, compareLabel);
    return <BarChart title={report.name} subtitle={subtitle} x={s.x} xLabel={words(dim)} series={s.series} format={formatOf(unit)} currency={result.currency} />;
  }
  const second = result.metrics[1];
  return (
    <RankBars
      title={report.name}
      subtitle={subtitle}
      rows={result.rows.map((r) => ({ label: words(r.dimensions[dim]), value: r.values[lead] ?? 0, detail: second ? `${nameOf(result, second.key)} ${show(r.values[second.key], unitOf(result, second.key), result.currency)}` : undefined }))}
      format={formatOf(unit)}
      currency={result.currency}
      limit={25}
    />
  );
}

/** A month's target: a meter from 0 to the target with where the month should be by today. */
export function TargetMeter({ p, currency }: { p: analytics.TargetProgress; currency: string }) {
  const unit = p.unit as 'cents' | 'count' | 'ratio' | 'days' | 'number';
  if (p.target === null) return null;
  const progress = Math.min(1, Math.max(0, p.progress ?? 0));
  const pace = p.expectedSoFar !== null && p.target ? Math.min(1, p.expectedSoFar / p.target) : null;
  const tone = p.onTrack === null ? 'text-ink-2' : p.onTrack ? 'text-good' : 'text-warn';
  const month = new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(`${p.month}-01T00:00:00Z`));
  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="target-meter">
      <p className="text-sm text-ink-2">
        {p.name} target · {month}
      </p>
      <p className="mt-1 font-display text-[1.5rem] font-medium tabular-nums text-ink">
        {show(p.actual, unit, currency)} <span className="text-base text-ink-3">of {show(p.target, unit, currency)}</span>
      </p>
      <div className="relative mt-2 h-2 rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={p.target} aria-valuenow={p.actual ?? 0} aria-label={`${p.name} against its target for ${month}`}>
        <span className="block h-2 rounded-full" style={{ width: `${progress * 100}%`, background: 'var(--color-series-1)' }} />
        {pace !== null ? <span aria-hidden className="absolute top-[-3px] h-[14px] w-0.5 rounded bg-ink-3" style={{ left: `calc(${pace * 100}% - 1px)` }} title="Where the month should be by today" /> : null}
      </div>
      <p className={`mt-1.5 text-xs ${tone}`}>
        {p.progress !== null ? `${percent(p.progress, 0)} of the target` : 'Not measurable yet'}
        {p.expectedSoFar !== null ? ` · day ${p.daysElapsed} of ${p.daysInMonth}, pace needs ${show(p.expectedSoFar, unit, currency)}` : ''}
        {p.onTrack === null ? '' : p.onTrack ? ' · on track' : ' · behind'}
      </p>
    </div>
  );
}
