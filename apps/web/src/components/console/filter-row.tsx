'use client';

import { useState } from 'react';

/**
 * The one filter row above whatever it scopes: period, comparison, venue. A plain GET form, so
 * the filter lives in the URL (shareable, back-button safe) and works before scripts load.
 */
export function FilterRow({
  periods,
  compares,
  venues,
  value,
  showCompare = true,
  showVenue = true,
  extra,
}: {
  periods: ReadonlyArray<{ value: string; label: string }>;
  compares: ReadonlyArray<{ value: string; label: string }>;
  venues: Array<{ value: string; label: string }>;
  value: { period: string; from: string; to: string; compare: string; venue: string };
  showCompare?: boolean;
  showVenue?: boolean;
  /** Extra hidden fields to keep (e.g. a tab); pairs allow a name more than once. */
  extra?: Record<string, string> | Array<[string, string]>;
}) {
  const [period, setPeriod] = useState(value.period);
  const submit = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    if (e.currentTarget.name === 'period' && e.currentTarget.value === 'custom') return;
    e.currentTarget.form?.requestSubmit();
  };
  const select = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';
  return (
    <form method="get" role="search" aria-label="Filter" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
      {extra ? (Array.isArray(extra) ? extra : Object.entries(extra)).map(([k, v], i) => <input key={`${k}-${i}`} type="hidden" name={k} value={v} />) : null}
      <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
        Period
        <select name="period" defaultValue={value.period} onChange={(e) => (setPeriod(e.currentTarget.value), submit(e))} className={select}>
          {periods.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      {period === 'custom' ? (
        <>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            From
            <input type="date" name="from" defaultValue={value.from} required className={select} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            To
            <input type="date" name="to" defaultValue={value.to} required className={select} />
          </label>
        </>
      ) : null}
      {showCompare ? (
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Compare with
          <select name="compare" defaultValue={value.compare} onChange={submit} className={select}>
            {compares.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input type="hidden" name="compare" value={value.compare} />
      )}
      {showVenue && venues.length > 1 ? (
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Venue
          <select name="venue" defaultValue={value.venue} onChange={submit} className={select}>
            {venues.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input type="hidden" name="venue" value={value.venue} />
      )}
      <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
        Apply
      </button>
    </form>
  );
}
