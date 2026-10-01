/** Display helpers for venue sites. Pure; safe on the server and in the browser. */

export { money, cx } from '@/ui/format';

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday first, the way Australian venues print their hours. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/** "17:30:00" → "5:30pm", "12:00" → "12pm". */
export function clock12(t: string): string {
  const [h = 0, m = 0] = t.split(':').map(Number);
  const suffix = h >= 12 && h < 24 ? 'pm' : 'am';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

export interface DayHours {
  day: number;
  name: string;
  short: string;
  /** e.g. ["12pm–3pm", "5:30pm–10pm"]; empty when closed. */
  periods: string[];
}

export function weeklyHours(hours: Array<{ dayOfWeek: number; opensAt: string; closesAt: string }>): DayHours[] {
  return WEEK.map((day) => ({
    day,
    name: DAY_LONG[day]!,
    short: DAY_SHORT[day]!,
    periods: hours
      .filter((h) => h.dayOfWeek === day)
      .sort((a, b) => a.opensAt.localeCompare(b.opensAt))
      .map((h) => `${clock12(h.opensAt)}–${clock12(h.closesAt)}`),
  }));
}

/** A venue-local calendar date "2026-10-04" → "Sat 4 Oct". */
export function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return `${DAY_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${d.toLocaleString('en-AU', { month: 'short', timeZone: 'UTC' })}`;
}

export function timeIn(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(typeof at === 'string' ? new Date(at) : at);
}

export function dateTimeIn(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(typeof at === 'string' ? new Date(at) : at);
}

const DIET: Record<string, string> = {
  v: 'Vegetarian',
  vg: 'Vegan',
  gf: 'Gluten free',
  df: 'Dairy free',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  'gluten-free': 'Gluten free',
  gluten_free: 'Gluten free',
  'dairy-free': 'Dairy free',
  halal: 'Halal',
  kosher: 'Kosher',
  nf: 'Nut free',
};

/** A dietary tag in words. Unknown tags are shown as the venue wrote them. */
export function dietLabel(tag: string): string {
  return DIET[tag.toLowerCase()] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
}

/** Paragraphs of venue-written copy: blank lines separate paragraphs; everything stays text. */
export function paragraphs(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function sentenceList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export const ORDER_STATUS_WORDS: Record<string, string> = {
  draft: 'Not sent',
  pending_payment: 'Waiting for payment',
  placed: 'Sent to the kitchen',
  accepted: 'Accepted',
  preparing: 'Being prepared',
  ready: 'Ready',
  completed: 'Collected',
  rejected: 'Not accepted',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
};
