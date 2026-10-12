'use client';

import { useState } from 'react';
import { ChartFrame } from '@/ui/charts/charts';
import { percent } from '@/ui/format';

/** One cell of the grid: the cohort (its first day), how many periods after it, the share who came back, and the cohort's size. */
export interface CohortCell {
  cohort: string;
  index: number;
  rate: number | null;
  size: number | null;
}

/**
 * Cohorts by first-visit month (or week) across the periods after: one hue, light to dark, the
 * share who came back. Magnitude only in the colour; the table view and the readout carry the
 * values, and the guest count sits beside each row because a small group makes a jumpy percentage.
 */
export function CohortGrid({ title, cells, grain }: { title: string; cells: CohortCell[]; grain: 'week' | 'month' }) {
  const RAMP = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'];
  const cohorts = [...new Set(cells.map((c) => c.cohort))].sort();
  const maxIdx = Math.max(0, ...cells.map((c) => c.index));
  const cols = Array.from({ length: Math.min(maxIdx, 12) + 1 }, (_, i) => i);
  const cell = new Map(cells.map((c) => [`${c.cohort}:${c.index}`, c]));
  const [hover, setHover] = useState<string | null>(null);
  const fill = (v: number | null | undefined) => (v === null || v === undefined ? 'var(--color-sunken)' : RAMP[Math.min(RAMP.length - 1, Math.floor(v * RAMP.length))]!);
  const label = (c: string) => (grain === 'month' ? new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'short', year: '2-digit' }).format(new Date(`${c}T00:00:00Z`)) : `w/c ${c.slice(5)}`);
  const sizeOf = (c: string) => cell.get(`${c}:0`)?.size ?? null;
  const table = (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr>
            <th className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-xs font-medium text-ink-3">First visit</th>
            <th className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-right text-xs font-medium text-ink-3">Guests</th>
            {cols.map((i) => (
              <th key={i} className="sticky top-0 border-b border-line bg-surface px-3 py-2 text-right text-xs font-medium text-ink-3">
                +{i}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c}>
              <th scope="row" className="border-b border-line px-3 py-1.5 font-normal text-ink-2">
                {label(c)}
              </th>
              <td className="border-b border-line px-3 py-1.5 text-right tabular-nums text-ink">{sizeOf(c) ?? '–'}</td>
              {cols.map((i) => (
                <td key={i} className="border-b border-line px-3 py-1.5 text-right tabular-nums text-ink">
                  {cell.get(`${c}:${i}`) ? percent(cell.get(`${c}:${i}`)!.rate, 0) : '–'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  if (!cohorts.length) {
    return (
      <ChartFrame title={title} subtitle="No guests made a first visit in this period." table={table}>
        <p className="py-8 text-center text-sm text-ink-3">Nothing to show for this period.</p>
      </ChartFrame>
    );
  }
  const current = hover ? cell.get(hover) : undefined;
  return (
    <ChartFrame title={title} subtitle={`Of the guests whose first visit was in a ${grain}, the share who bought again in each ${grain} after it. Column +0 is the ${grain} itself.`} table={table} note="A small group makes a jumpy percentage: read the guest count beside it.">
      <div className="overflow-x-auto" role="group" aria-label={`${title}, scrolls sideways`} tabIndex={0}>
        <div className="inline-grid gap-0.5" style={{ gridTemplateColumns: `5rem 3.5rem repeat(${cols.length}, minmax(2rem, 1fr))` }} role="img" aria-label={`${title}. Use "Show table" for the values.`}>
          <span className="text-[11px] text-ink-3">First visit</span>
          <span className="text-right text-[11px] text-ink-3">Guests</span>
          {cols.map((i) => (
            <span key={i} className="text-center text-[11px] text-ink-3">
              +{i}
            </span>
          ))}
          {cohorts.map((c) => (
            <div key={c} className="contents">
              <span className="pr-2 text-xs leading-6 text-ink-2">{label(c)}</span>
              <span className="pr-2 text-right text-xs leading-6 tabular-nums text-ink-2">{sizeOf(c) ?? ''}</span>
              {cols.map((i) => {
                const key = `${c}:${i}`;
                return <span key={i} tabIndex={0} onPointerEnter={() => setHover(key)} onPointerLeave={() => setHover(null)} onFocus={() => setHover(key)} onBlur={() => setHover(null)} className="h-6 rounded-sm" style={{ background: fill(cell.get(key)?.rate) }} />;
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-2 h-4 text-xs text-ink-2" role="status">
        {current ? `${label(current.cohort)}, +${current.index}: ${percent(current.rate, 1)} of ${sizeOf(current.cohort) ?? '?'} guests came back` : ''}
      </p>
      <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-3">
        0%
        <span className="flex gap-0.5" aria-hidden>
          {RAMP.map((c) => (
            <span key={c} className="size-3 rounded-sm" style={{ background: c }} />
          ))}
        </span>
        100%
      </p>
    </ChartFrame>
  );
}
