import 'server-only';
import { addDays, localDate, zonedTimeToUtc } from '@ros/core';
import type { events } from '@ros/modules';

/** The "when" filter every list with dates offers, in the venue's own days. */
export const WHEN_OPTIONS: FilterOption[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
  { value: '28d', label: 'Last 28 days' },
  { value: '90d', label: 'Last 90 days' },
];

/** The instants a "when" value covers, from the venue's midnight to the next: [from, to). */
export function whenRange(value: string | undefined, now: Date, tz: string): { from: Date; to: Date } | null {
  const today = localDate(now, tz);
  const at = (date: string) => zonedTimeToUtc(date, '00:00', tz);
  switch (value) {
    case 'today':
      return { from: at(today), to: at(addDays(today, 1)) };
    case 'yesterday':
      return { from: at(addDays(today, -1)), to: at(today) };
    case '7d':
      return { from: at(addDays(today, -6)), to: at(addDays(today, 1)) };
    case '28d':
      return { from: at(addDays(today, -27)), to: at(addDays(today, 1)) };
    case '90d':
      return { from: at(addDays(today, -89)), to: at(addDays(today, 1)) };
    default:
      return null;
  }
}

/**
 * Saved views on an index page (docs/CONSOLE_IA.md section 9, wave 1; pattern 1): a row of view
 * tabs, filter tokens the URL carries so a view is shareable, and the venue's own saved views
 * beside the default ones that are code and cannot be deleted. Sort is never part of a view.
 *
 * The URL grammar: `?view=<default key | saved:<id>>` names the tab. Filter keys are only read
 * when `f=1` is present (the filter form sets it), so a view link with no filters shows the
 * view's own filters and a cleared filter form shows nothing filtered, with no ambiguity.
 */
export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterField {
  key: string;
  label: string;
  kind: 'select' | 'text' | 'date';
  options?: FilterOption[];
  placeholder?: string;
}

export interface DefaultView {
  key: string;
  label: string;
  filters: Record<string, string>;
}

export interface ViewSpec {
  page: events.ConsoleViewPage;
  /** Where the page lives, for links. */
  path: string;
  defaults: DefaultView[];
  /** The default view shown when the URL names none. */
  landing: string;
  fields: FilterField[];
}

export interface ViewTab {
  key: string;
  label: string;
  href: string;
  isDefault: boolean;
  id?: string;
}

export interface ResolvedView {
  /** The tab that is current. */
  current: ViewTab;
  /** The filters in force: the view's own, or the URL's when the filter form was used. */
  filters: Record<string, string>;
  /** The filters differ from the current view's saved ones ("Save view as" / "Update view" apply). */
  dirty: boolean;
  tabs: ViewTab[];
  /** The query string that reproduces this list, for links that should keep it. */
  query: string;
  /** The words for each filter in force, for the token chips. */
  tokens: Array<{ key: string; label: string; value: string; words: string; removeHref: string }>;
}

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => {
  const v = sp[k];
  return Array.isArray(v) ? v[0] : v;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Only the spec's own keys, and for a select only its own values, are read from the URL or a saved view. */
function cleanFilters(spec: ViewSpec, raw: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = (raw[f.key] ?? '').trim().slice(0, 200);
    if (!v) continue;
    if (f.kind === 'select' && !f.options?.some((o) => o.value === v)) continue;
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    out[f.key] = v;
  }
  return out;
}

export function viewHref(spec: ViewSpec, viewKey: string, filters?: Record<string, string>): string {
  const q = new URLSearchParams();
  if (viewKey !== spec.landing) q.set('view', viewKey);
  if (filters) {
    q.set('f', '1');
    for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  }
  const s = q.toString();
  return s ? `${spec.path}?${s}` : spec.path;
}

const same = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).filter((k) => a[k]);
  const kb = Object.keys(b).filter((k) => b[k]);
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
};

export function resolveView(spec: ViewSpec, sp: SP, saved: events.ConsoleViewRow[]): ResolvedView {
  const tabs: ViewTab[] = [
    ...spec.defaults.map((d) => ({ key: d.key, label: d.label, href: viewHref(spec, d.key), isDefault: true })),
    ...saved.map((v) => ({ key: `saved:${v.id}`, label: v.name, href: viewHref(spec, `saved:${v.id}`), isDefault: false, id: v.id })),
  ];
  const wanted = one(sp, 'view') ?? spec.landing;
  const current = tabs.find((t) => t.key === wanted) ?? tabs.find((t) => t.key === spec.landing) ?? tabs[0]!;
  const own = current.isDefault ? (spec.defaults.find((d) => d.key === current.key)?.filters ?? {}) : (saved.find((v) => v.id === current.id)?.filters ?? {});
  const ownClean = cleanFilters(spec, own);
  const fromForm = one(sp, 'f') === '1';
  const filters = fromForm ? cleanFilters(spec, Object.fromEntries(spec.fields.map((f) => [f.key, one(sp, f.key)]))) : ownClean;
  const dirty = fromForm && !same(filters, ownClean);
  const tokens = Object.entries(filters).map(([key, value]) => {
    const field = spec.fields.find((f) => f.key === key)!;
    const words = field.kind === 'select' ? (field.options?.find((o) => o.value === value)?.label ?? value) : value;
    const rest = { ...filters };
    delete rest[key];
    return { key, label: field.label, value, words, removeHref: viewHref(spec, current.key, rest) };
  });
  return { current, filters, dirty, tabs, query: viewHref(spec, current.key, fromForm ? filters : undefined).split('?')[1] ?? '', tokens };
}

/** Where each index page with views lives, for the actions that send a person back to one. */
export const VIEW_PAGE_PATHS: Record<events.ConsoleViewPage, string> = {
  orders: '/console/orders',
  bookings: '/console/bookings',
  customers: '/console/customers',
  menu: '/console/menu',
  offers: '/console/offers',
  activity: '/console/activity',
};

/** True when the id in a `saved:<id>` view key is well formed. */
export const savedViewId = (key: string): string | null => (key.startsWith('saved:') && UUID.test(key.slice(6)) ? key.slice(6) : null);
