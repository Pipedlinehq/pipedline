import type { ReactNode } from 'react';
import type { ConsoleContext } from '@/lib/console';
import { COMPARE_OPTIONS, PERIOD_OPTIONS, type AnalyticsFilter } from '@/lib/console-filters';
import { dateTime, dayLabel } from '@/ui/format';
import { FilterRow } from './filter-row';

/** The filter row for analytics pages, with the person's own venues. */
export function AnalyticsFilterRow({ filter, c, showCompare = true, extra }: { filter: AnalyticsFilter; c: ConsoleContext; showCompare?: boolean; extra?: Record<string, string> | Array<[string, string]> }) {
  const venues = [...(c.venues.length > 1 ? [{ value: 'all', label: `All ${c.venues.length} venues` }] : []), ...c.venues.map((v) => ({ value: v.id, label: v.name }))];
  return (
    <FilterRow
      periods={PERIOD_OPTIONS}
      compares={COMPARE_OPTIONS}
      venues={venues}
      showCompare={showCompare}
      extra={extra}
      value={{ period: filter.periodKey, from: filter.from, to: filter.to, compare: filter.compareKey, venue: filter.venueKey }}
    />
  );
}

/** "2 Sep – 29 Sep 2026" from venue-local dates. */
export function dateRange(from: string, to: string): string {
  if (from === to) return `${dayLabel(from)} ${from.slice(0, 4)}`;
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${dayLabel(from)}${sameYear ? '' : ` ${from.slice(0, 4)}`} – ${dayLabel(to)} ${to.slice(0, 4)}`;
}

interface ResultLike {
  period?: { from: string; to: string; timezone?: string; includes_today?: boolean } | null;
  compare?: { from: string; to: string; basis: string } | null;
  sources?: Array<{ metrics: string[]; read_from: string; tables: string[]; source_rows: Record<string, number> }>;
  freshness?: { latest_sale_at: string | null; latest_sale_ingested_at?: string | null; facts_computed_at?: string | null } | null;
  as_of?: string;
  venues?: { scope: string; names: string[] };
}

/**
 * Where a number came from: the dates it covers, what it is compared with, which tables it
 * was read from and how many rows stand behind it, and how fresh the ledger is. Shown under
 * every figure, because a number without its source is an opinion (INTEGRATION_STRATEGY §5).
 */
export function Provenance({ result, timeZone, className }: { result: ResultLike; timeZone: string; className?: string }) {
  const parts: ReactNode[] = [];
  if (result.period) parts.push(<span key="p">{dateRange(result.period.from, result.period.to)}{result.period.timezone ? ` (${result.period.timezone === "each venue's own" ? "each venue's local days" : result.period.timezone})` : ''}</span>);
  if (result.compare) parts.push(<span key="c">compared with {dateRange(result.compare.from, result.compare.to)}, {result.compare.basis}</span>);
  if (result.venues) parts.push(<span key="v">{result.venues.names.join(', ')}</span>);
  if (result.sources?.length) {
    parts.push(
      <span key="s">
        read from{' '}
        {result.sources
          .map((s) => `${s.read_from === 'facts' ? 'derived daily facts' : 'the ledger'} (${Object.entries(s.source_rows)
            .map(([t, n]) => `${t}: ${n.toLocaleString('en-AU')} rows`)
            .join(', ') || s.tables.join(', ')})`)
          .join('; ')}
      </span>,
    );
  }
  if (result.freshness) {
    parts.push(
      <span key="f">
        latest sale {result.freshness.latest_sale_at ? dateTime(result.freshness.latest_sale_at, timeZone) : 'none yet'}
        {result.freshness.latest_sale_ingested_at ? `, received ${dateTime(result.freshness.latest_sale_ingested_at, timeZone, { date: false })}` : ''}
      </span>,
    );
  }
  if (result.as_of) parts.push(<span key="a">worked out {dateTime(result.as_of, timeZone)}</span>);
  return (
    <p className={className ?? 'mt-2 text-xs text-ink-3'} data-testid="provenance" data-from={result.period?.from} data-to={result.period?.to}>
      {parts.map((p, i) => (
        <span key={i}>
          {i ? ' · ' : ''}
          {p}
        </span>
      ))}
    </p>
  );
}

/** The caveats a query returned, in full. Never hidden behind a hover. */
export function Caveats({ items, title = 'Read these numbers with this in mind' }: { items: string[] | null | undefined; title?: string }) {
  const list = [...new Set(items ?? [])];
  if (!list.length) return null;
  return (
    <details className="mt-3 rounded-md bg-sunken px-3 py-2 text-xs text-ink-2" open={list.length <= 2}>
      <summary className="cursor-pointer font-medium text-ink-2">
        {title} ({list.length})
      </summary>
      <ul className="mt-1.5 list-disc space-y-1 pl-4">
        {list.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </details>
  );
}

/** A caveat list folded into one line for a chart's `note`. */
export function noteOf(items: string[] | null | undefined, max = 2): string | null {
  const list = [...new Set(items ?? [])];
  if (!list.length) return null;
  return list.slice(0, max).join(' ') + (list.length > max ? ` (+${list.length - max} more below)` : '');
}
