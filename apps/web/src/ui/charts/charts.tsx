'use client';

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { compact, compactMoney, cx, money, percent } from '../format';

/**
 * The console's charts. One set of rules (thin marks, hairline grid, one axis, a legend for two
 * or more series, a tooltip that lists every series, and a table view of the same numbers), so
 * every dashboard reads the same way. Series colours are fixed slots in a validated order:
 * colour follows the series, never its rank.
 */

export type ValueFormat = 'money' | 'number' | 'percent';
export type Slot = 1 | 2 | 3 | 4 | 'muted';

export interface ChartSeries {
  key: string;
  label: string;
  /** One value per x position; null where there is no data. Money is in cents. */
  values: Array<number | null>;
  slot?: Slot;
}

const SLOT_VAR: Record<string, string> = {
  1: 'var(--color-series-1)',
  2: 'var(--color-series-2)',
  3: 'var(--color-series-3)',
  4: 'var(--color-series-4)',
  muted: 'var(--color-series-muted)',
};

const colourOf = (s: ChartSeries, i: number) => SLOT_VAR[String(s.slot ?? ((i % 4) + 1))]!;

export function formatValue(v: number | null | undefined, format: ValueFormat, currency = 'AUD', full = false): string {
  if (v === null || v === undefined) return '–';
  if (format === 'money') return full ? money(v, currency) : compactMoney(v, currency);
  if (format === 'percent') return percent(v, 1);
  return full ? new Intl.NumberFormat('en-AU', { maximumFractionDigits: 2 }).format(v) : compact(v);
}

/** Round axis bounds and ticks to clean numbers. */
function niceScale(max: number, ticks = 4): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const rough = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Number(v.toFixed(10)));
  return { max: top, ticks: out };
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.max(240, Math.floor(entries[0]!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function Legend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {series.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 rounded-full" style={{ background: colourOf(s, i) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function DataTable({ x, series, format, currency, xLabel }: { x: string[]; series: ChartSeries[]; format: ValueFormat; currency: string; xLabel: string }) {
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th scope="col" className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-ink-3">
              {xLabel}
            </th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-right text-xs font-medium text-ink-3">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {x.map((label, i) => (
            <tr key={label + i}>
              <th scope="row" className="border-b border-line px-3 py-1.5 font-normal text-ink-2">
                {label}
              </th>
              {series.map((s) => (
                <td key={s.key} className="border-b border-line px-3 py-1.5 text-right tabular-nums text-ink">
                  {formatValue(s.values[i], format, currency, true)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The card every chart sits in: title, what it shows, and the switch to the same data as a table. */
export function ChartFrame({
  title,
  subtitle,
  children,
  table,
  note,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  table: ReactNode;
  /** A caveat that applies to these numbers. Shown under the chart, not hidden in a tooltip. */
  note?: string | null;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <figure className="rounded-lg border border-line bg-surface p-5">
      <figcaption className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-base font-semibold text-ink">{title}</p>
          {subtitle ? <p className="mt-0.5 text-sm text-ink-2">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-ink-2 hover:bg-sunken hover:text-ink"
        >
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </figcaption>
      {asTable ? table : children}
      {note ? <p className="mt-3 text-xs text-ink-3">{note}</p> : null}
    </figure>
  );
}

interface CartesianProps {
  title: string;
  subtitle?: string;
  /** Labels along the x axis, already formatted (e.g. "12 Sep"). */
  x: string[];
  xLabel?: string;
  series: ChartSeries[];
  format?: ValueFormat;
  currency?: string;
  height?: number;
  note?: string | null;
}

const M = { top: 8, right: 12, bottom: 24, left: 52 };

function Tooltip({ left, top, title, rows, width }: { left: number; top: number; title: string; rows: Array<{ label: string; value: string; colour: string }>; width: number }) {
  const flip = left > width * 0.6;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-36 rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm"
      style={{ left: flip ? undefined : left + 12, right: flip ? width - left + 12 : undefined, top }}
    >
      <p className="mb-1 text-ink-3">{title}</p>
      {rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-ink-2">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: r.colour }} />
            {r.label}
          </span>
          <span className="font-semibold tabular-nums text-ink">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

function YAxis({ ticks, y, width, format, currency }: { ticks: number[]; y: (v: number) => number; width: number; format: ValueFormat; currency: string }) {
  return (
    <g>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--color-line-strong)' : 'var(--color-line)'} strokeWidth={1} />
          <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[11px] tabular-nums">
            {formatValue(t, format, currency)}
          </text>
        </g>
      ))}
    </g>
  );
}

function xTickIndexes(n: number, plotWidth: number): number[] {
  const max = Math.max(2, Math.floor(plotWidth / 72));
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / max);
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  return out;
}

/** Change over time. One axis; a second measure on another scale gets its own chart. */
export function LineChart({ title, subtitle, x, xLabel = 'Date', series, format = 'number', currency = 'AUD', height = 240, note }: CartesianProps) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const maxV = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = useMemo(() => niceScale(maxV), [maxV]);
  const px = (i: number) => M.left + (x.length <= 1 ? plotW / 2 : (i / (x.length - 1)) * plotW);
  const py = (v: number) => M.top + plotH - (v / scale.max) * plotH;

  const path = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const onMove = (clientX: number, rect: DOMRect) => {
    if (!x.length) return;
    const ratio = (clientX - rect.left - M.left) / Math.max(1, plotW);
    setHover(Math.max(0, Math.min(x.length - 1, Math.round(ratio * (x.length - 1)))));
  };

  const single = series.length === 1;
  return (
    <ChartFrame title={title} subtitle={subtitle} note={note} table={<DataTable x={x} series={series} format={format} currency={currency} xLabel={xLabel} />}>
      <Legend series={series} />
      <div ref={ref} className="relative" style={{ height }}>
        {x.length === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-ink-3">Nothing to show for this period.</p>
        ) : (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${title}. ${series.map((s) => s.label).join(', ')}. Use "Show table" for the values.`}
              tabIndex={0}
              onPointerMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
              onPointerLeave={() => setHover(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') setHover((h) => Math.min(x.length - 1, (h ?? -1) + 1));
                if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? x.length) - 1));
                if (e.key === 'Escape') setHover(null);
              }}
              onBlur={() => setHover(null)}
              className="block touch-none rounded-sm"
            >
              <YAxis ticks={scale.ticks} y={py} width={width} format={format} currency={currency} />
              {xTickIndexes(x.length, plotW).map((i) => (
                <text key={i} x={px(i)} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                  {x[i]}
                </text>
              ))}
              {single && series[0] ? (
                <path
                  d={`${path(series[0].values)}L${px(x.length - 1).toFixed(1)},${py(0)}L${px(0).toFixed(1)},${py(0)}Z`}
                  fill={colourOf(series[0], 0)}
                  opacity={0.1}
                />
              ) : null}
              {series.map((s, i) => (
                <path key={s.key} d={path(s.values)} fill="none" stroke={colourOf(s, i)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {hover !== null ? (
                <g>
                  <line x1={px(hover)} x2={px(hover)} y1={M.top} y2={M.top + plotH} stroke="var(--color-line-strong)" strokeWidth={1} />
                  {series.map((s, i) => {
                    const v = s.values[hover];
                    return v === null || v === undefined ? null : (
                      <circle key={s.key} cx={px(hover)} cy={py(v)} r={4} fill={colourOf(s, i)} stroke="var(--color-surface)" strokeWidth={2} />
                    );
                  })}
                </g>
              ) : (
                // The last point of each line carries its value: the only direct labels.
                series.map((s, i) => {
                  const last = s.values.length - 1;
                  const v = s.values[last];
                  return v === null || v === undefined ? null : (
                    <circle key={s.key} cx={px(last)} cy={py(v)} r={4} fill={colourOf(s, i)} stroke="var(--color-surface)" strokeWidth={2} />
                  );
                })
              )}
            </svg>
            {hover !== null ? (
              <Tooltip
                left={px(hover)}
                top={M.top}
                width={width}
                title={x[hover] ?? ''}
                rows={series.map((s, i) => ({ label: s.label, value: formatValue(s.values[hover], format, currency, true), colour: colourOf(s, i) }))}
              />
            ) : null}
          </>
        )}
      </div>
    </ChartFrame>
  );
}

/** Magnitude per category or per period. Pass `stacked` for part-to-whole. */
export function BarChart({ title, subtitle, x, xLabel = 'Period', series, format = 'number', currency = 'AUD', height = 240, note, stacked = false }: CartesianProps & { stacked?: boolean }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = width - M.left - M.right;
  const plotH = height - M.top - M.bottom;
  const totals = x.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const maxV = stacked ? Math.max(0, ...totals) : Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const scale = useMemo(() => niceScale(maxV), [maxV]);
  const band = x.length ? plotW / x.length : plotW;
  const groupN = stacked ? 1 : series.length;
  // Thin bars: capped at 24px, the rest of the band is air.
  const barW = Math.max(2, Math.min(24, (band * 0.7) / groupN - 2));
  const py = (v: number) => M.top + plotH - (v / scale.max) * plotH;
  const cx0 = (i: number) => M.left + band * i + band / 2;

  const topRounded = (xPos: number, yTop: number, w: number, h: number) => {
    const r = Math.min(4, w / 2, h);
    return `M${xPos},${yTop + h}V${yTop + r}Q${xPos},${yTop} ${xPos + r},${yTop}H${xPos + w - r}Q${xPos + w},${yTop} ${xPos + w},${yTop + r}V${yTop + h}Z`;
  };

  return (
    <ChartFrame title={title} subtitle={subtitle} note={note} table={<DataTable x={x} series={series} format={format} currency={currency} xLabel={xLabel} />}>
      <Legend series={series} />
      <div ref={ref} className="relative" style={{ height }}>
        {x.length === 0 ? (
          <p className="flex h-full items-center justify-center text-sm text-ink-3">Nothing to show for this period.</p>
        ) : (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={`${title}. ${series.map((s) => s.label).join(', ')}. Use "Show table" for the values.`}
              tabIndex={0}
              onPointerMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const i = Math.floor((e.clientX - rect.left - M.left) / band);
                setHover(i >= 0 && i < x.length ? i : null);
              }}
              onPointerLeave={() => setHover(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') setHover((h) => Math.min(x.length - 1, (h ?? -1) + 1));
                if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? x.length) - 1));
                if (e.key === 'Escape') setHover(null);
              }}
              onBlur={() => setHover(null)}
              className="block touch-none rounded-sm"
            >
              <YAxis ticks={scale.ticks} y={py} width={width} format={format} currency={currency} />
              {xTickIndexes(x.length, plotW).map((i) => (
                <text key={i} x={cx0(i)} y={height - 6} textAnchor="middle" className="fill-ink-3 text-[11px]">
                  {x[i]}
                </text>
              ))}
              {x.map((_, i) => {
                const dim = hover !== null && hover !== i ? 0.55 : 1;
                if (stacked) {
                  let acc = 0;
                  const live = series.map((s, si) => ({ s, si, v: s.values[i] ?? 0 })).filter((d) => d.v > 0);
                  return (
                    <g key={i} opacity={dim}>
                      {live.map((d, k) => {
                        const y0 = py(acc);
                        acc += d.v;
                        const y1 = py(acc);
                        const isTop = k === live.length - 1;
                        // A 2px gap in the surface colour separates segments; no strokes.
                        const h = Math.max(1, y0 - y1 - (isTop ? 0 : 2));
                        const xPos = cx0(i) - barW / 2;
                        return isTop ? (
                          <path key={d.s.key} d={topRounded(xPos, y1, barW, h)} fill={colourOf(d.s, d.si)} />
                        ) : (
                          <rect key={d.s.key} x={xPos} y={y1 + 2} width={barW} height={h} fill={colourOf(d.s, d.si)} />
                        );
                      })}
                    </g>
                  );
                }
                const groupW = groupN * barW + (groupN - 1) * 2;
                return (
                  <g key={i} opacity={dim}>
                    {series.map((s, si) => {
                      const v = s.values[i];
                      if (v === null || v === undefined || v <= 0) return null;
                      const xPos = cx0(i) - groupW / 2 + si * (barW + 2);
                      return <path key={s.key} d={topRounded(xPos, py(v), barW, py(0) - py(v))} fill={colourOf(s, si)} />;
                    })}
                  </g>
                );
              })}
            </svg>
            {hover !== null ? (
              <Tooltip
                left={cx0(hover)}
                top={M.top}
                width={width}
                title={x[hover] ?? ''}
                rows={[
                  ...series.map((s, i) => ({ label: s.label, value: formatValue(s.values[hover], format, currency, true), colour: colourOf(s, i) })),
                  ...(stacked && series.length > 1 ? [{ label: 'Total', value: formatValue(totals[hover], format, currency, true), colour: 'transparent' }] : []),
                ]}
              />
            ) : null}
          </>
        )}
      </div>
    </ChartFrame>
  );
}

/** A ranked list with a bar per row: the form for "which items, channels or campaigns lead". One hue. */
export function RankBars({
  title,
  subtitle,
  rows,
  format = 'number',
  currency = 'AUD',
  note,
  limit = 10,
}: {
  title: string;
  subtitle?: string;
  rows: Array<{ label: string; value: number; detail?: string }>;
  format?: ValueFormat;
  currency?: string;
  note?: string | null;
  limit?: number;
}) {
  const shown = rows.slice(0, limit);
  const max = Math.max(1, ...shown.map((r) => r.value));
  const asSeries: ChartSeries[] = [{ key: 'value', label: 'Value', values: rows.map((r) => r.value) }];
  return (
    <ChartFrame title={title} subtitle={subtitle} note={note} table={<DataTable x={rows.map((r) => r.label)} series={asSeries} format={format} currency={currency} xLabel="Name" />}>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">Nothing to show for this period.</p>
      ) : (
        <ol className="space-y-2.5">
          {shown.map((r) => (
            <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
              <span className="truncate text-sm text-ink" title={r.label}>
                {r.label}
                {r.detail ? <span className="ml-2 text-xs text-ink-3">{r.detail}</span> : null}
              </span>
              <span className="text-sm font-medium tabular-nums text-ink">{formatValue(r.value, format, currency, true)}</span>
              <span className="col-span-2 h-1.5 rounded-full bg-sunken">
                <span className="block h-1.5 rounded-full" style={{ width: `${Math.max(1, (r.value / max) * 100)}%`, background: 'var(--color-series-1)' }} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </ChartFrame>
  );
}

export function Sparkline({ values, width = 96, height = 28 }: { values: Array<number | null>; width?: number; height?: number }) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return null;
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => (v === null ? null : `${((i / (values.length - 1)) * (width - 4) + 2).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden className="block">
      <polyline points={pts} fill="none" stroke="var(--color-series-muted)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A headline number. `delta` is the change against a named period; `goodWhen` says which
 * direction is good, so colour means direction-times-meaning and the arrow and words carry it too.
 */
export function StatTile({
  label,
  value,
  delta,
  comparedTo,
  goodWhen = 'up',
  trend,
  hint,
}: {
  label: string;
  value: string;
  delta?: number | null;
  comparedTo?: string;
  goodWhen?: 'up' | 'down' | 'neither';
  trend?: Array<number | null>;
  hint?: string;
}) {
  const id = useId();
  const has = delta !== null && delta !== undefined && Number.isFinite(delta);
  const up = has && delta! > 0;
  const flat = has && Math.abs(delta!) < 0.0005;
  const good = goodWhen === 'neither' || flat ? null : goodWhen === 'up' ? up : !up;
  return (
    <div className="rounded-lg border border-line bg-surface p-4" aria-labelledby={id}>
      <p id={id} className="text-sm text-ink-2">
        {label}
      </p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="text-2xl font-semibold tracking-tight text-ink">{value}</p>
        {trend ? <Sparkline values={trend} /> : null}
      </div>
      {has ? (
        <p className={cx('mt-1 text-xs', good === null ? 'text-ink-3' : good ? 'text-good' : 'text-bad')}>
          <span aria-hidden>{flat ? '→' : up ? '↑' : '↓'}</span> {flat ? 'No change' : `${percent(Math.abs(delta!), 1)} ${up ? 'up' : 'down'}`}
          {comparedTo ? <span className="text-ink-3"> vs {comparedTo}</span> : null}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

/** Day-of-week by hour, one hue from light to dark. Magnitude only; the table view carries the values. */
export function HourHeatmap({
  title,
  subtitle,
  rows,
  hours,
  format = 'number',
  currency = 'AUD',
  note,
}: {
  title: string;
  subtitle?: string;
  /** One row per day label, one value per hour in `hours`. */
  rows: Array<{ label: string; values: Array<number | null> }>;
  hours: number[];
  format?: ValueFormat;
  currency?: string;
  note?: string | null;
}) {
  const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const max = Math.max(0, ...rows.flatMap((r) => r.values.map((v) => v ?? 0)));
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const fill = (v: number | null) => (v === null || v <= 0 || max === 0 ? 'var(--color-sunken)' : RAMP[Math.min(RAMP.length - 1, Math.floor((v / max) * RAMP.length))]!);
  const series: ChartSeries[] = rows.map((r) => ({ key: r.label, label: r.label, values: r.values }));
  const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  return (
    <ChartFrame title={title} subtitle={subtitle} note={note} table={<DataTable x={hours.map(hourLabel)} series={series} format={format} currency={currency} xLabel="Hour" />}>
      <div className="overflow-x-auto" role="group" aria-label={`${title}, scrolls sideways`} tabIndex={0}>
        <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `3rem repeat(${hours.length}, minmax(1.5rem, 1fr))` }} role="img" aria-label={`${title}. Use "Show table" for the values.`}>
          <span />
          {hours.map((h) => (
            <span key={h} className="text-center text-[11px] text-ink-3">
              {hourLabel(h)}
            </span>
          ))}
          {rows.map((r, ri) => (
            <div key={r.label} className="contents">
              <span className="pr-2 text-right text-xs leading-6 text-ink-2">{r.label}</span>
              {r.values.map((v, ci) => (
                <span
                  key={ci}
                  tabIndex={0}
                  onPointerEnter={() => setHover({ r: ri, c: ci })}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover({ r: ri, c: ci })}
                  onBlur={() => setHover(null)}
                  className="h-6 rounded-sm"
                  style={{ background: fill(v) }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 h-4 text-xs text-ink-2" role="status">
        {hover ? `${rows[hover.r]!.label}, ${hourLabel(hours[hover.c]!)}: ${formatValue(rows[hover.r]!.values[hover.c], format, currency, true)}` : ''}
      </p>
      <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
        Less
        <span className="flex gap-0.5" aria-hidden>
          {RAMP.map((c) => (
            <span key={c} className="size-3 rounded-sm" style={{ background: c }} />
          ))}
        </span>
        More
      </p>
    </ChartFrame>
  );
}
