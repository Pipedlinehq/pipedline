import { type Database, localParts } from '@ros/core';

/**
 * An independent oracle for the analytics tests. It reads the raw ledger rows and does every
 * sum, split and date conversion in plain JavaScript (the venue-local day comes from Intl, not
 * from Postgres), so it shares no SQL and no code with the module it checks.
 */
export const COUNTED = new Set(['completed', 'refunded', 'partially_refunded']);

export interface Line {
  name: string;
  category: string;
  qty: number;
  total: number;
}

export interface Sale {
  id: string;
  venueId: string;
  customerId: string | null;
  at: Date;
  /** Venue-local date and hour. */
  day: string;
  hour: number;
  weekday: number;
  channel: string;
  source: string;
  total: number;
  tax: number;
  tip: number;
  discount: number;
  refunded: number;
  net: number;
  items: number;
  lines: Line[];
  /** 1 for the customer's first counted sale, 2 for the second … 0 for an anonymous sale. */
  rank: number;
}

/** (total − tax − tip) × the unrefunded share, rounded half up to the cent, in integer arithmetic. */
export function netOf(total: number, tax: number, tip: number, refunded: number): number {
  if (total === 0) return 0;
  const numerator = (total - tax - tip) * Math.max(total - refunded, 0);
  return Math.floor((2 * numerator + total) / (2 * total));
}

export async function loadSales(db: Database, orgId: string, venueIds?: string[]): Promise<Sale[]> {
  const venues = await db.selectFrom('venues').select(['id', 'timezone']).where('org_id', '=', orgId).execute();
  const tz = new Map(venues.map((v) => [v.id, v.timezone]));
  let q = db
    .selectFrom('transactions')
    .select(['id', 'venue_id', 'customer_id', 'occurred_at', 'channel', 'source', 'status', 'total_cents', 'tax_cents', 'tip_cents', 'discount_cents', 'refunded_cents'])
    .where('org_id', '=', orgId);
  if (venueIds) q = q.where('venue_id', 'in', venueIds);
  const rows = (await q.execute()).filter((r) => COUNTED.has(r.status));
  const lineRows = await db.selectFrom('transaction_lines').select(['transaction_id', 'name_snapshot', 'category_snapshot', 'qty', 'total_cents']).where('org_id', '=', orgId).execute();
  const lines = new Map<string, Line[]>();
  for (const l of lineRows) {
    const list = lines.get(l.transaction_id) ?? [];
    list.push({ name: l.name_snapshot, category: l.category_snapshot ?? '(uncategorised)', qty: Number(l.qty), total: l.total_cents });
    lines.set(l.transaction_id, list);
  }
  const sales: Sale[] = rows
    .map((r) => {
      const p = localParts(r.occurred_at, tz.get(r.venue_id)!);
      const ls = lines.get(r.id) ?? [];
      return {
        id: r.id,
        venueId: r.venue_id,
        customerId: r.customer_id,
        at: r.occurred_at,
        day: p.date,
        hour: p.hour,
        weekday: p.weekday,
        channel: r.channel,
        source: r.source,
        total: r.total_cents,
        tax: r.tax_cents,
        tip: r.tip_cents,
        discount: r.discount_cents,
        refunded: r.refunded_cents,
        net: netOf(r.total_cents, r.tax_cents, r.tip_cents, r.refunded_cents),
        items: ls.reduce((s, l) => s + l.qty, 0),
        lines: ls,
        rank: 0,
      };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  const seen = new Map<string, number>();
  for (const s of sales) {
    if (!s.customerId) continue;
    const n = (seen.get(s.customerId) ?? 0) + 1;
    seen.set(s.customerId, n);
    s.rank = n;
  }
  return sales;
}

export const between = (sales: Sale[], from: string, to: string): Sale[] => sales.filter((s) => s.day >= from && s.day <= to);
export const sum = <T>(xs: T[], f: (x: T) => number): number => xs.reduce((s, x) => s + f(x), 0);

export function totals(sales: Sale[]) {
  const orders = sales.length;
  const gross = sum(sales, (s) => s.total);
  const items = sum(sales, (s) => s.items);
  const identified = sales.filter((s) => s.customerId).length;
  return {
    orders,
    gross_sales: gross,
    net_sales: sum(sales, (s) => s.net),
    avg_order_value: orders ? Math.round(gross / orders) : null,
    items_sold: items,
    items_per_order: orders ? Math.round((items / orders) * 100) / 100 : null,
    refunds: sum(sales, (s) => s.refunded),
    refunded_orders: sales.filter((s) => s.refunded > 0).length,
    refund_rate: orders ? ratio(sales.filter((s) => s.refunded > 0).length, orders) : null,
    discounts: sum(sales, (s) => s.discount),
    discounted_orders: sales.filter((s) => s.discount > 0).length,
    tips: sum(sales, (s) => s.tip),
    tax: sum(sales, (s) => s.tax),
    identified_orders: identified,
    identified_share: orders ? ratio(identified, orders) : null,
    new_customer_orders: sales.filter((s) => s.rank === 1).length,
    returning_customer_orders: sales.filter((s) => s.rank > 1).length,
  };
}

export const ratio = (a: number, b: number): number => Math.round((a / b) * 10_000) / 10_000;

export function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = out.get(k) ?? [];
    list.push(x);
    out.set(k, list);
  }
  return out;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface CustomerFacts {
  customerId: string;
  orders: number;
  spend: number;
  firstDay: string;
  secondDay: string | null;
  lastDay: string;
  segment: string;
}

/** Each identified customer as of a venue-local day, with the default segment rules written out again. */
export function customers(sales: Sale[], asOf: string): CustomerFacts[] {
  const by = groupBy(sales.filter((s) => s.customerId && s.day <= asOf), (s) => s.customerId!);
  return [...by.entries()].map(([customerId, list]) => {
    const orders = list.length;
    const lastDay = list.reduce((m, s) => (s.day > m ? s.day : m), list[0]!.day);
    const firstDay = list.reduce((m, s) => (s.day < m ? s.day : m), list[0]!.day);
    const recency = dayDiff(lastDay, asOf);
    const segment =
      orders === 1 ? (recency <= 30 ? 'new' : 'one_timer') : recency > 120 ? 'lapsed' : recency > 60 ? 'at_risk' : orders >= 10 ? 'loyal' : orders >= 5 ? 'frequent' : 'repeater';
    return { customerId, orders, spend: sum(list, (s) => s.total - s.refunded), firstDay, secondDay: list[1]?.day ?? null, lastDay, segment };
  });
}

export const DAYPART = (hour: number): string => (hour >= 5 && hour < 11 ? 'breakfast' : hour >= 11 && hour < 15 ? 'lunch' : hour >= 15 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'dinner' : 'late');
export const WEEKDAY_NAME = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
