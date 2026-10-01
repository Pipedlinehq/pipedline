import { z } from 'zod';
import { addDays, invalid } from '@ros/core';

/**
 * Periods are venue-local calendar dates, inclusive at both ends. A relative period is resolved
 * against "today" in the venue's own zone, and the answer always states the dates it used, so
 * an assistant never has to guess what "last week" meant.
 */
export const RELATIVE_PERIODS = [
  'today',
  'yesterday',
  'last_7_days',
  'last_14_days',
  'last_28_days',
  'last_30_days',
  'last_90_days',
  'last_365_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_year',
  'last_year',
  'all_time',
] as const;
export type RelativePeriod = (typeof RELATIVE_PERIODS)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30.');
export const periodInput = z.union([
  z.enum(RELATIVE_PERIODS),
  z.object({ from: isoDate, to: isoDate }).strict(),
]);
export type PeriodInput = z.infer<typeof periodInput>;

export const GRAINS = ['day', 'week', 'month'] as const;
export type Grain = (typeof GRAINS)[number];
export const COMPARISONS = ['previous_period', 'same_period_last_year'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export interface ResolvedPeriod {
  from: string;
  to: string;
  days: number;
  /** The relative name asked for, or 'custom'. */
  label: string;
  /** True when the period includes today, which is still in progress. */
  includesToday: boolean;
}

export interface ResolvedComparison {
  kind: Comparison;
  from: string;
  to: string;
  days: number;
  /** How the comparison period was chosen, in plain words. */
  basis: string;
}

const parse = (d: string): [number, number, number] => d.split('-').map(Number) as [number, number, number];
const fmt = (y: number, m: number, d: number): string => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

export function isRealDate(d: string): boolean {
  const [y, m, day] = parse(d);
  return fmt(y, m, day) === d;
}

/** Whole days from a to b; b the day after a gives 1. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** 1 = Monday … 7 = Sunday, the ISO numbering Postgres calls isodow. */
export function isoWeekday(d: string): number {
  const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
  return wd === 0 ? 7 : wd;
}

export function weekStart(d: string): string {
  return addDays(d, 1 - isoWeekday(d));
}

export function monthStart(d: string): string {
  return `${d.slice(0, 7)}-01`;
}

export function monthEnd(d: string): string {
  const [y, m] = parse(d);
  return fmt(y, m + 1, 0);
}

/** Shift by whole months, clamping the day to the target month's length. */
export function addMonths(d: string, months: number): string {
  const [y, m, day] = parse(d);
  const last = Number(fmt(y, m + months + 1, 0).slice(8));
  const first = fmt(y, m + months, 1);
  return `${first.slice(0, 8)}${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function bucketStart(d: string, grain: Grain): string {
  return grain === 'day' ? d : grain === 'week' ? weekStart(d) : monthStart(d);
}

/** Every bucket a period touches, in order. The first and last may be partial. */
export function bucketsOf(from: string, to: string, grain: Grain): string[] {
  const out: string[] = [];
  let cur = bucketStart(from, grain);
  while (cur <= to) {
    out.push(cur);
    cur = grain === 'day' ? addDays(cur, 1) : grain === 'week' ? addDays(cur, 7) : addMonths(cur, 1);
  }
  return out;
}

const isWholeMonths = (from: string, to: string) => from === monthStart(from) && to === monthEnd(to);

export function resolvePeriod(input: PeriodInput, today: string, earliest: string | null = null): ResolvedPeriod {
  let from: string;
  let to: string;
  let label: string;
  if (typeof input === 'string') {
    label = input;
    const lastN = /^last_(\d+)_days$/.exec(input);
    if (lastN) {
      // N complete days ending yesterday: today is still in progress and would skew the total.
      from = addDays(today, -Number(lastN[1]));
      to = addDays(today, -1);
    } else {
      switch (input) {
        case 'today':
          from = to = today;
          break;
        case 'yesterday':
          from = to = addDays(today, -1);
          break;
        case 'this_week':
          from = weekStart(today);
          to = today;
          break;
        case 'last_week':
          from = addDays(weekStart(today), -7);
          to = addDays(weekStart(today), -1);
          break;
        case 'this_month':
          from = monthStart(today);
          to = today;
          break;
        case 'last_month':
          from = addMonths(monthStart(today), -1);
          to = monthEnd(from);
          break;
        case 'this_year':
          from = `${today.slice(0, 4)}-01-01`;
          to = today;
          break;
        case 'last_year':
          from = `${Number(today.slice(0, 4)) - 1}-01-01`;
          to = `${Number(today.slice(0, 4)) - 1}-12-31`;
          break;
        case 'all_time':
          from = earliest ?? today;
          to = today;
          break;
        default:
          throw invalid('That period is not recognised.');
      }
    }
  } else {
    if (!isRealDate(input.from) || !isRealDate(input.to)) throw invalid('That date does not exist.');
    if (input.from > input.to) throw invalid('The period must start on or before the day it ends.');
    from = input.from;
    to = input.to;
    label = 'custom';
  }
  const days = dayDiff(from, to) + 1;
  if (days > 1830) throw invalid('Ask for at most five years at a time.');
  return { from, to, days, label, includesToday: from <= today && to >= today };
}

/**
 * The period to compare with. Kept like-for-like where that is possible: whole calendar months
 * compare with whole calendar months, a week or month to date with the same stretch of the one
 * before, and a year-on-year comparison of anything else moves back 52 weeks so that the same
 * weekdays line up (a Saturday is compared with a Saturday).
 */
export function resolveComparison(p: ResolvedPeriod, kind: Comparison): ResolvedComparison {
  const wholeMonths = isWholeMonths(p.from, p.to);
  let from: string;
  let to: string;
  let basis: string;
  if (kind === 'previous_period') {
    if (wholeMonths) {
      const months = (Number(p.to.slice(0, 4)) - Number(p.from.slice(0, 4))) * 12 + Number(p.to.slice(5, 7)) - Number(p.from.slice(5, 7)) + 1;
      from = addMonths(p.from, -months);
      to = monthEnd(addMonths(p.from, -1));
      basis = months === 1 ? 'the calendar month before' : `the ${months} calendar months before`;
    } else if (p.label === 'this_month') {
      from = addMonths(p.from, -1);
      to = addMonths(p.to, -1);
      basis = 'the same days of the month before';
    } else if (p.label === 'this_week') {
      from = addDays(p.from, -7);
      to = addDays(p.to, -7);
      basis = 'the same weekdays of the week before';
    } else if (p.label === 'this_year') {
      from = addMonths(p.from, -12);
      to = addMonths(p.to, -12);
      basis = 'the same dates of the year before';
    } else {
      from = addDays(p.from, -p.days);
      to = addDays(p.from, -1);
      basis = p.days % 7 === 0 ? `the ${p.days} days immediately before (same weekdays)` : `the ${p.days} ${p.days === 1 ? 'day' : 'days'} immediately before`;
    }
  } else if (wholeMonths || p.label === 'this_month' || p.label === 'this_year') {
    from = addMonths(p.from, -12);
    to = wholeMonths ? monthEnd(addMonths(p.to, -12)) : addMonths(p.to, -12);
    basis = 'the same calendar dates one year earlier';
  } else {
    from = addDays(p.from, -364);
    to = addDays(p.to, -364);
    basis = 'the same weekdays 52 weeks earlier';
  }
  return { kind, from, to, days: dayDiff(from, to) + 1, basis };
}
