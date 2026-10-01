/**
 * Segment rules in plain words, and the lists the rule editor offers. Safe for client
 * components: nothing here imports server code. The service validates every rule again.
 */

export const RFM = ['new', 'one_timer', 'repeater', 'frequent', 'loyal', 'at_risk', 'lapsed'] as const;
export const SALE_CHANNELS = ['dine-in', 'pickup', 'delivery', 'catering', 'retail'] as const;
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type Leaf = { field: string; [k: string]: unknown };
export type Rule = Leaf | { all: Rule[] } | { any: Rule[] } | { not: Rule };

export const FIELDS: Array<{ value: string; label: string; kind: 'rfm' | 'score' | 'range' | 'money' | 'dates' | 'words' | 'channels' | 'venues' | 'consent' | 'yesno' | 'months' }> = [
  { value: 'rfm_segment', label: 'Customer segment', kind: 'rfm' },
  { value: 'orders', label: 'Number of orders', kind: 'range' },
  { value: 'spend_cents', label: 'Spend to date', kind: 'money' },
  { value: 'recency_days', label: 'Days since last order', kind: 'range' },
  { value: 'days_since_first_order', label: 'Days since first order', kind: 'range' },
  { value: 'last_order_date', label: 'Last order date', kind: 'dates' },
  { value: 'first_order_date', label: 'First order date', kind: 'dates' },
  { value: 'home_venue', label: 'Home venue', kind: 'venues' },
  { value: 'favourite_venue', label: 'Favourite venue', kind: 'venues' },
  { value: 'favourite_channel', label: 'Favourite channel', kind: 'channels' },
  { value: 'loyalty_member', label: 'Loyalty member', kind: 'yesno' },
  { value: 'consent', label: 'Agreed to marketing', kind: 'consent' },
  { value: 'birthday_month', label: 'Birthday month', kind: 'months' },
  { value: 'acquisition_source', label: 'First came from (source)', kind: 'words' },
  { value: 'acquisition_campaign', label: 'First came from (campaign)', kind: 'words' },
  { value: 'acquisition_creator', label: 'First came from (creator)', kind: 'words' },
  { value: 'r_score', label: 'Recency score (1 to 5)', kind: 'score' },
  { value: 'f_score', label: 'Frequency score (1 to 5)', kind: 'score' },
  { value: 'm_score', label: 'Spend score (1 to 5)', kind: 'score' },
];

const nice = (s: string) => s.replace(/[_-]/g, ' ');
const list = (xs: unknown[], f: (x: unknown) => string = (x) => String(x)) => xs.map(f).join(' or ');
const span = (min: unknown, max: unknown, unit: (n: number) => string) =>
  min !== undefined && max !== undefined ? `between ${unit(Number(min))} and ${unit(Number(max))}` : min !== undefined ? `at least ${unit(Number(min))}` : `at most ${unit(Number(max))}`;

function leafWords(r: Leaf, venueName: (id: string) => string): string {
  const inList = Array.isArray(r.in) ? (r.in as unknown[]) : [];
  switch (r.field) {
    case 'rfm_segment':
      return `segment is ${list(inList, (x) => nice(String(x)))}`;
    case 'r_score':
      return `recency score is ${list(inList)}`;
    case 'f_score':
      return `frequency score is ${list(inList)}`;
    case 'm_score':
      return `spend score is ${list(inList)}`;
    case 'recency_days':
      return `last ordered ${span(r.min, r.max, (n) => `${n} days`)} ago`;
    case 'days_since_first_order':
      return `first ordered ${span(r.min, r.max, (n) => `${n} days`)} ago`;
    case 'orders':
      return `has ${span(r.min, r.max, (n) => `${n}`)} orders`;
    case 'spend_cents':
      return `has spent ${span(r.min, r.max, (n) => `$${(n / 100).toLocaleString('en-AU')}`)}`;
    case 'first_order_date':
    case 'last_order_date':
      return `${r.field === 'first_order_date' ? 'first' : 'last'} order ${[r.after ? `after ${r.after}` : null, r.before ? `before ${r.before}` : null].filter(Boolean).join(' and ')}`;
    case 'acquisition_source':
      return `first came from ${list(inList)}`;
    case 'acquisition_creator':
      return `first came through creator ${list(inList)}`;
    case 'acquisition_campaign':
      return `first came through campaign ${list(inList)}`;
    case 'favourite_channel':
      return `mostly orders by ${list(inList)}`;
    case 'favourite_venue':
      return `mostly orders at ${list(inList, (x) => venueName(String(x)))}`;
    case 'home_venue':
      return `home venue is ${list(inList, (x) => venueName(String(x)))}`;
    case 'consent':
      return `${r.granted ? 'has agreed' : 'has not agreed'} to marketing by ${r.purpose === 'marketing_sms' ? 'SMS' : 'email'}`;
    case 'loyalty_member':
      return r.is ? 'is a loyalty member' : 'is not a loyalty member';
    case 'birthday_month':
      return `birthday is in ${list(inList, (x) => MONTHS[Number(x) - 1] ?? String(x))}`;
    default:
      return nice(r.field);
  }
}

/** A rule tree as a sentence. */
export function ruleWords(rule: Rule, venueName: (id: string) => string = () => 'a venue', top = true): string {
  if ('all' in rule) {
    const s = (rule.all as Rule[]).map((r) => ruleWords(r, venueName, false)).join(' and ');
    return top ? s : `(${s})`;
  }
  if ('any' in rule) {
    const s = (rule.any as Rule[]).map((r) => ruleWords(r, venueName, false)).join(' or ');
    return top ? s : `(${s})`;
  }
  if ('not' in rule) return `not (${ruleWords(rule.not as Rule, venueName, false)})`;
  return leafWords(rule as Leaf, venueName);
}

export interface EditorRow {
  not: boolean;
  leaf: Leaf;
}

/** The form edits "all / any of these conditions", each optionally negated. Deeper trees are shown in words only. */
export function toRows(rule: Rule): { join: 'all' | 'any'; rows: EditorRow[] } | null {
  const row = (r: Rule): EditorRow | null => {
    if ('field' in r) return { not: false, leaf: r as Leaf };
    if ('not' in r && 'field' in (r.not as Rule)) return { not: true, leaf: r.not as Leaf };
    return null;
  };
  const single = row(rule);
  if (single) return { join: 'all', rows: [single] };
  const join = 'all' in rule ? 'all' : 'any' in rule ? 'any' : null;
  if (!join) return null;
  const rows = ((rule as { all?: Rule[]; any?: Rule[] })[join] ?? []).map(row);
  return rows.every((r): r is EditorRow => r !== null) ? { join, rows } : null;
}

export function fromRows(join: 'all' | 'any', rows: EditorRow[]): Rule {
  const parts = rows.map((r) => (r.not ? { not: r.leaf } : r.leaf));
  return parts.length === 1 ? parts[0]! : ({ [join]: parts } as Rule);
}
