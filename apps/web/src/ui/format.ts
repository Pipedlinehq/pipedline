/** Formatting for display. Dates are always shown in the venue's own time zone. */

export function money(cents: number | null | undefined, currency = 'AUD'): string {
  if (cents === null || cents === undefined) return '–';
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency, maximumFractionDigits: cents % 100 === 0 && Math.abs(cents) >= 100_000 ? 0 : 2 }).format(cents / 100);
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (Math.abs(n) < 10_000) return new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 }).format(n);
  return short(n);
}

/**
 * 12.3K / 4M / 1.2B, worked out here rather than by Intl's compact notation: the server's and the
 * browser's ICU data disagree on it ("$10.0K" against "$10K"), which breaks hydration of charts.
 */
function short(n: number): string {
  const a = Math.abs(n);
  const [div, suffix] = a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
  const v = Math.round((a / div) * 10) / 10;
  return `${n < 0 ? '-' : ''}${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}${suffix}`;
}

export function compactMoney(cents: number | null | undefined, currency = 'AUD'): string {
  if (cents === null || cents === undefined) return '–';
  const dollars = cents / 100;
  if (Math.abs(dollars) < 10_000) return money(cents, currency);
  const symbol = new Intl.NumberFormat('en-AU', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? '';
  return `${dollars < 0 ? '-' : ''}${symbol}${short(Math.abs(dollars))}`;
}

export function percent(ratio: number | null | undefined, digits = 0): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '–';
  return new Intl.NumberFormat('en-AU', { style: 'percent', maximumFractionDigits: digits }).format(ratio);
}

export function dateTime(at: Date | string | null | undefined, timeZone: string, opts: { date?: boolean; time?: boolean } = { date: true, time: true }): string {
  if (!at) return '–';
  const d = typeof at === 'string' ? new Date(at) : at;
  return new Intl.DateTimeFormat('en-AU', {
    timeZone,
    ...(opts.date !== false ? { day: 'numeric', month: 'short', year: 'numeric' } : {}),
    ...(opts.time !== false ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(d);
}

export function timeOnly(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(typeof at === 'string' ? new Date(at) : at);
}

export function dayLabel(date: string): string {
  // `date` is a venue-local calendar date (YYYY-MM-DD); format it without shifting zones.
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00Z`));
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
