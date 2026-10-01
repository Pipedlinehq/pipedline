import 'server-only';
import type { Ctx } from '@ros/core';
import { analytics as analyticsModule, type analytics } from '@ros/modules';

/**
 * Stored digests for the filter. A single-venue org's digests are written for the org as a
 * whole, so when the one venue has none of its own, the org's describe the same thing.
 */
export async function digestsFor(ctx: Ctx, venueId: string | undefined, venuesSeen: number, opts: { period?: 'day' | 'week' | 'month'; limit?: number }): Promise<analytics.StoredDigest[]> {
  const own = await analyticsModule.listDigests(ctx, { venueId, ...opts });
  if (own.length || !venueId || venuesSeen > 1) return own;
  return analyticsModule.listDigests(ctx, opts);
}
import type { ValueFormat } from '@/ui';
import { compact, dayLabel, money, percent } from '@/ui/format';

/** Shared presentation rules for analytics numbers. Arithmetic stays in the analytics module. */

export type Unit = 'cents' | 'count' | 'ratio' | 'days' | 'number';

export function formatOf(unit: Unit): ValueFormat {
  return unit === 'cents' ? 'money' : unit === 'ratio' ? 'percent' : 'number';
}

export function show(value: number | null | undefined, unit: Unit, currency = 'AUD'): string {
  if (value === null || value === undefined) return '–';
  if (unit === 'cents') return money(value, currency);
  if (unit === 'ratio') return percent(value, 1);
  if (unit === 'days') return `${compact(Math.round(value * 10) / 10)} days`;
  return compact(value);
}

/** The metric's unit as the result declared it. */
export function unitOf(result: analytics.MetricResult, key: string): Unit {
  return (result.metrics.find((m) => m.key === key)?.unit ?? 'number') as Unit;
}

export function nameOf(result: analytics.MetricResult, key: string): string {
  return result.metrics.find((m) => m.key === key)?.name ?? key;
}

/** Which way is good for a StatTile, from the metric's own definition. */
export function goodWhen(result: analytics.MetricResult, key: string): 'up' | 'down' | 'neither' {
  const d = result.metrics.find((m) => m.key === key)?.good_direction;
  return d === 'up_is_good' ? 'up' : d === 'down_is_good' ? 'down' : 'neither';
}

const WORDS: Record<string, string> = {
  'dine-in': 'Dine-in',
  'dine-in-qr': 'Dine-in (QR)',
  pickup: 'Pickup',
  delivery: 'Delivery',
  catering: 'Catering',
  retail: 'Retail',
  'online-order': 'Online order',
  one_timer: 'One-timer',
  at_risk: 'At risk',
  qr: 'QR code',
  sim: 'Simulated POS',
  utm_source: 'Traffic source',
  utm_medium: 'Traffic medium',
};

/** A dimension value as a person would say it. Values that are data (item names) pass through. */
export function words(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '(none)';
  if (WORDS[value]) return WORDS[value]!;
  if (/^[a-z][a-z0-9_.-]*$/.test(value)) return value.charAt(0).toUpperCase() + value.slice(1).replace(/[_.-]/g, ' ');
  return value;
}

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A time bucket's label on an axis. */
export function bucketLabel(start: string | null, grain: 'day' | 'week' | 'month' | null): string {
  if (!start) return '';
  if (grain === 'month') return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'short', year: '2-digit' }).format(new Date(`${start}T00:00:00Z`));
  if (grain === 'week') return `w/c ${dayLabel(start)}`;
  return dayLabel(start);
}

// ── Turning a metric result into chart props. Values pass through untouched. ──

export interface SeriesOut {
  key: string;
  label: string;
  values: Array<number | null>;
  slot?: 1 | 2 | 3 | 4 | 'muted';
}

/** One metric over time: the period itself and, when compared, the comparison lined up by position. */
export function trend(result: analytics.MetricResult, key: string, compareLabel = 'Comparison'): { x: string[]; series: SeriesOut[] } {
  const rows = result.rows.filter((r) => r.period_start);
  const x = rows.map((r) => bucketLabel(r.period_start, result.grain));
  const series: SeriesOut[] = [{ key, label: nameOf(result, key), values: rows.map((r) => r.values[key] ?? null), slot: 1 }];
  if (result.compare) series.push({ key: `${key}-compare`, label: compareLabel, values: rows.map((r) => r.compare?.[key] ?? null), slot: 'muted' });
  return { x, series };
}

/** A metric split by one dimension, current against comparison, as bars. */
export function split(result: analytics.MetricResult, dim: string, key: string, compareLabel = 'Comparison'): { x: string[]; series: SeriesOut[] } {
  const rows = result.rows.filter((r) => (r.values[key] ?? 0) !== 0 || (r.compare?.[key] ?? 0) !== 0);
  const x = rows.map((r) => words(r.dimensions[dim]));
  const series: SeriesOut[] = [{ key, label: 'This period', values: rows.map((r) => r.values[key] ?? null), slot: 1 }];
  if (result.compare) series.push({ key: `${key}-compare`, label: compareLabel, values: rows.map((r) => r.compare?.[key] ?? null), slot: 'muted' });
  return { x, series };
}

/** Day of week × hour, Monday first, trimmed to the hours that trade. */
export function heat(result: analytics.MetricResult, key: string): { rows: Array<{ label: string; values: Array<number | null> }>; hours: number[] } {
  const grid = new Map<string, number | null>();
  const traded = new Set<number>();
  for (const r of result.rows) {
    const day = r.dimensions.day_of_week ?? '';
    const hour = Number(r.dimensions.hour);
    const v = r.values[key] ?? null;
    grid.set(`${day}:${hour}`, v);
    if (v) traded.add(hour);
  }
  if (!traded.size) return { rows: [], hours: [] };
  const lo = Math.min(...traded);
  const hi = Math.max(...traded);
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return {
    hours,
    rows: WEEKDAYS.map((d, i) => ({ label: WEEKDAY_SHORT[i]!, values: hours.map((h) => grid.get(`${d}:${h}`) ?? null) })),
  };
}

/** Roughly how many days a filter covers, to choose a readable grain before asking. */
export function approxDays(periodKey: string, from?: string, to?: string): number {
  const fixed: Record<string, number> = { today: 1, yesterday: 1, this_week: 7, last_week: 7, last_7_days: 7, last_14_days: 14, last_28_days: 28, last_30_days: 30, last_90_days: 90, last_365_days: 365, this_month: 31, last_month: 31, this_year: 366, last_year: 365, all_time: 1000 };
  if (periodKey === 'custom' && from && to) return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  return fixed[periodKey] ?? 28;
}

export const PERIOD_WORDS: Record<string, string> = {
  today: 'today',
  yesterday: 'yesterday',
  this_week: 'this week',
  last_week: 'last week',
  last_7_days: 'the last 7 days',
  last_14_days: 'the last 14 days',
  last_28_days: 'the last 28 days',
  last_30_days: 'the last 30 days',
  last_90_days: 'the last 90 days',
  last_365_days: 'the last 365 days',
  this_month: 'this month',
  last_month: 'last month',
  this_year: 'this year',
  last_year: 'last year',
  all_time: 'all time',
  custom: 'the chosen dates',
};
