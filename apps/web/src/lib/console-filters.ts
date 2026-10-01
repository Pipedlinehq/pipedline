import 'server-only';
import type { ConsoleContext } from './console';

/**
 * The analytics filter row (period, compare, venue), read from the URL. Everything here is a
 * request, not a permission: the venue is checked against the person's own venues here and
 * again by the analytics service, which answers a venue they cannot see as not-found.
 */
export const PERIOD_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'this_week', label: 'This week' },
  { value: 'last_week', label: 'Last week' },
  { value: 'last_7_days', label: 'Last 7 days' },
  { value: 'last_14_days', label: 'Last 14 days' },
  { value: 'last_28_days', label: 'Last 28 days' },
  { value: 'last_90_days', label: 'Last 90 days' },
  { value: 'last_365_days', label: 'Last 365 days' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_year', label: 'Last year' },
  { value: 'custom', label: 'Custom dates' },
] as const;

export const COMPARE_OPTIONS = [
  { value: 'previous_period', label: 'Previous period' },
  { value: 'same_period_last_year', label: 'Same period last year' },
  { value: 'none', label: 'No comparison' },
] as const;

export type RelativePeriodValue = Exclude<(typeof PERIOD_OPTIONS)[number]['value'], 'custom'>;
export type PeriodValue = RelativePeriodValue | { from: string; to: string };
export type CompareValue = 'previous_period' | 'same_period_last_year';

export interface AnalyticsFilter {
  /** What to hand queryMetrics as `period`. */
  period: PeriodValue;
  /** The select's value ("custom" for dates). */
  periodKey: string;
  from: string;
  to: string;
  compare: CompareValue | null;
  compareKey: string;
  /** 'all' = every venue the person can see; otherwise one venue id from their own list. */
  venueKey: string;
  /** Undefined = all the person's venues. */
  venueId: string | undefined;
  venueLabel: string;
  /** For links that keep the filter. */
  query: string;
}

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => {
  const v = sp[k];
  return Array.isArray(v) ? v[0] : v;
};
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function readFilter(sp: SP, c: ConsoleContext, defaults: { period?: RelativePeriodValue; compare?: CompareValue | null } = {}): AnalyticsFilter {
  const rawPeriod = one(sp, 'period') ?? defaults.period ?? 'last_28_days';
  const from = one(sp, 'from') ?? '';
  const to = one(sp, 'to') ?? '';
  let period: PeriodValue;
  let periodKey: string;
  if (rawPeriod === 'custom' && ISO.test(from) && ISO.test(to) && from <= to) {
    period = { from, to };
    periodKey = 'custom';
  } else {
    const known = PERIOD_OPTIONS.find((p) => p.value === rawPeriod && p.value !== 'custom');
    periodKey = known ? known.value : (defaults.period ?? 'last_28_days');
    period = periodKey as RelativePeriodValue;
  }

  const rawCompare = one(sp, 'compare') ?? (defaults.compare === null ? 'none' : (defaults.compare ?? 'previous_period'));
  const compare: CompareValue | null = rawCompare === 'previous_period' || rawCompare === 'same_period_last_year' ? rawCompare : null;

  const rawVenue = one(sp, 'venue');
  let venueKey: string;
  let venueId: string | undefined;
  if (rawVenue === 'all' && c.venues.length > 1) {
    venueKey = 'all';
    venueId = undefined;
  } else {
    const chosen = c.venues.find((v) => v.id === rawVenue) ?? c.venue;
    venueKey = chosen.id;
    venueId = chosen.id;
  }
  const venueLabel = venueId ? (c.venues.find((v) => v.id === venueId)?.name ?? c.venue.name) : `All ${c.venues.length} of your venues`;

  const q = new URLSearchParams();
  q.set('period', periodKey);
  if (periodKey === 'custom') {
    q.set('from', from);
    q.set('to', to);
  }
  q.set('compare', compare ?? 'none');
  q.set('venue', venueKey);
  return { period, periodKey, from, to, compare, compareKey: compare ?? 'none', venueKey, venueId, venueLabel, query: q.toString() };
}

/** The venue filter for queryMetrics: nothing for "all my venues", else the one venue. */
export function venueFilter(f: AnalyticsFilter): Record<string, string> {
  return f.venueId ? { venue: f.venueId } : {};
}

/** A sensible time grain for a period, so a trend has a readable number of points. */
export function grainFor(days: number): 'day' | 'week' | 'month' {
  if (days <= 62) return 'day';
  if (days <= 190) return 'week';
  return 'month';
}
