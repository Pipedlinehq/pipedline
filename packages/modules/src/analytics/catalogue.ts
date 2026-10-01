import type { Measures } from './engine';
import type { Grain } from './period';

/**
 * The metric catalogue: one declarative definition per thing that can be measured. The console
 * and an assistant read the same entries, and queryMetrics computes from them, so the number a
 * person sees on a dashboard and the number an assistant quotes cannot drift apart.
 *
 * A definition says what the number means, how it is computed, what it can be split by, and
 * what a careful reader should keep in mind. When the way a metric is computed changes, its
 * `version` goes up; every answer carries the version it was computed with.
 */
export const CATALOGUE_VERSION = 1;

export type Unit = 'cents' | 'count' | 'ratio' | 'days' | 'number';
export type FamilyKey = 'sales' | 'items' | 'customers' | 'customer_base' | 'cohorts' | 'web' | 'events' | 'funnel' | 'campaigns' | 'messages';

export interface MetricDef {
  key: string;
  name: string;
  description: string;
  unit: Unit;
  family: FamilyKey;
  version: number;
  /** 'sum' values add up across rows; 'ratio' values never do; 'distinct' counts people and do not add. */
  aggregation: 'sum' | 'ratio' | 'distinct' | 'median';
  /** Which way is good news, so a change can be described without guessing. */
  direction: 'up_is_good' | 'down_is_good' | 'neutral';
  /** How it is computed, in words a person can check against the ledger. */
  computation: string;
  caveats: string[];
  /** At least one of these dimensions must be asked for. */
  needsOneOf?: string[];
  /** Internal: the measures the family must produce, and the arithmetic over them. */
  measures: string[];
  value(m: Measures): number | null;
}

export interface FamilyDef {
  key: FamilyKey;
  name: string;
  /** Time grains the family can be split by. Empty: the metric describes a state, not a flow. */
  grains: Grain[];
  dimensions: string[];
  /** What the period selects, in words. */
  periodMeans: string;
  caveats: string[];
  /** True when every metric in the family describes identified customers only. */
  customerScoped?: boolean;
}

export interface DimensionDef {
  key: string;
  name: string;
  description: string;
  values?: string;
}

const n = (v: number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const has = (m: Measures, ...keys: string[]): boolean => keys.every((k) => m[k] !== null && m[k] !== undefined);
const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => {
  if (a === null || a === undefined || b === null || b === undefined || Number(b) === 0) return null;
  return Math.round((Number(a) / Number(b)) * 10_000) / 10_000;
};
const perUnit = (a: number | null | undefined, b: number | null | undefined, places = 0): number | null => {
  if (a === null || a === undefined || b === null || b === undefined || Number(b) === 0) return null;
  const f = 10 ** places;
  return Math.round((Number(a) / Number(b)) * f) / f;
};
const pass = (key: string) => (m: Measures) => (has(m, key) ? Number(m[key]) : null);

export const DIMENSIONS: DimensionDef[] = [
  { key: 'venue', name: 'Venue', description: 'The venue the sale, visit or event belongs to.' },
  { key: 'channel', name: 'Channel', description: 'How the guest was served.', values: 'dine-in, pickup, delivery, catering, retail' },
  { key: 'source', name: 'Source', description: 'The system the sale was recorded in.', values: 'square, lightspeed, online-order, pos, manual, aggregator, sim' },
  { key: 'daypart', name: 'Daypart', description: 'The part of the trading day, by the venue-local hour of the sale. The hours are an org setting.', values: 'breakfast, lunch, afternoon, dinner, late (defaults)' },
  { key: 'day_of_week', name: 'Day of week', description: 'The venue-local weekday.', values: 'monday … sunday' },
  { key: 'hour', name: 'Hour', description: 'The venue-local hour the sale was made in.', values: '0 … 23' },
  { key: 'item', name: 'Item', description: 'The item as it was named on the sale (a snapshot, so renamed items keep their old name on old sales).' },
  { key: 'category', name: 'Category', description: 'The menu section the item was sold under, as snapshotted on the sale.' },
  { key: 'segment', name: 'Customer segment', description: 'Where a known customer stands as of the end of the period.', values: 'new, one_timer, repeater, frequent, loyal, at_risk, lapsed' },
  { key: 'acquisition_source', name: 'Acquisition source', description: 'Where the customer first came from, stamped once when the record was created.', values: 'organic, walk-in, criota, meta, google, qr, referral …' },
  { key: 'cohort', name: 'Cohort', description: 'The week or calendar month of a customer\'s first order (its first day).' },
  { key: 'periods_since', name: 'Periods since first order', description: 'Weeks or months after the cohort period; 0 is the cohort period itself.' },
  { key: 'utm_source', name: 'Traffic source', description: 'Where a visit came from; "direct" when nothing was carried.' },
  { key: 'utm_medium', name: 'Traffic medium', description: 'The kind of traffic, e.g. social, paid_social, organic.' },
  { key: 'campaign', name: 'Campaign', description: 'The campaign identifier carried by the visit or stamped on the customer.' },
  { key: 'creator', name: 'Creator', description: 'The creator identifier carried by the visit or stamped on the customer.' },
  { key: 'device_class', name: 'Device', description: 'The visitor\'s device.', values: 'mobile, tablet, desktop' },
  { key: 'landing_path', name: 'Landing page', description: 'The first page of the visit.' },
  { key: 'event_name', name: 'Event', description: 'The declared event name; see the event dictionary.' },
  { key: 'funnel_step', name: 'Funnel step', description: 'The position of a step in a declared funnel, from 1.' },
  { key: 'message_channel', name: 'Message channel', description: 'How a message was sent.', values: 'email, sms' },
  { key: 'message_kind', name: 'Message kind', description: 'Whether a message was transactional or marketing.', values: 'transactional, marketing' },
  { key: 'template', name: 'Message template', description: 'The template a message was built from.' },
  { key: 'message_campaign', name: 'Message campaign', description: 'The campaign a marketing message belonged to.' },
];

const SALES_NOTE = 'Counts sales with status completed, refunded or partially refunded; pending and voided sales are never counted.';
const IDENTIFIED_NOTE = 'Describes identified customers only: sales with no customer attached are not represented.';

export const FAMILIES: Record<FamilyKey, FamilyDef> = {
  sales: {
    key: 'sales',
    name: 'Sales',
    grains: ['day', 'week', 'month'],
    dimensions: ['venue', 'channel', 'source', 'daypart', 'day_of_week', 'hour'],
    periodMeans: 'Sales whose venue-local date falls in the period.',
    caveats: [SALES_NOTE, 'A day is the venue\'s calendar day: trade after midnight belongs to the next day.'],
  },
  items: {
    key: 'items',
    name: 'Menu items',
    grains: ['day', 'week', 'month'],
    dimensions: ['item', 'category', 'venue', 'channel'],
    periodMeans: 'Lines of sales whose venue-local date falls in the period.',
    caveats: [SALES_NOTE, 'Item revenue is line totals before refunds: a refund is recorded against the sale, not against a line.'],
  },
  customers: {
    key: 'customers',
    name: 'Customer activity',
    grains: ['day', 'week', 'month'],
    dimensions: ['acquisition_source'],
    periodMeans: 'Identified customers with at least one sale in the period.',
    caveats: [IDENTIFIED_NOTE, 'Customers are people, not sales: counts do not add up across days, weeks or venues.'],
    customerScoped: true,
  },
  customer_base: {
    key: 'customer_base',
    name: 'Customer base',
    grains: [],
    dimensions: ['segment', 'acquisition_source'],
    periodMeans: 'Every identified customer with a sale on or before the last day of the period, described as of that day. The start of the period is not used.',
    caveats: [IDENTIFIED_NOTE],
    customerScoped: true,
  },
  cohorts: {
    key: 'cohorts',
    name: 'Cohort retention',
    grains: ['week', 'month'],
    dimensions: ['cohort', 'periods_since'],
    periodMeans: 'Customers whose first order falls in the period, grouped by the week or month of that first order and followed to today.',
    caveats: [IDENTIFIED_NOTE],
    customerScoped: true,
  },
  web: {
    key: 'web',
    name: 'Web sessions',
    grains: ['day', 'week', 'month'],
    dimensions: ['venue', 'utm_source', 'utm_medium', 'campaign', 'creator', 'device_class', 'landing_path'],
    periodMeans: 'Visits that started on a venue-local date in the period.',
    caveats: ['First-party visits to the venue\'s own site and QR menu only; visits to third-party pages are not seen.'],
  },
  events: {
    key: 'events',
    name: 'Events',
    grains: ['day', 'week', 'month'],
    dimensions: ['event_name', 'venue', 'utm_source', 'campaign', 'creator'],
    periodMeans: 'Events that occurred on a venue-local date in the period.',
    caveats: [],
  },
  funnel: {
    key: 'funnel',
    name: 'Funnel',
    grains: ['day', 'week', 'month'],
    dimensions: ['funnel_step', 'venue', 'utm_source', 'utm_medium', 'campaign', 'creator', 'device_class', 'landing_path'],
    periodMeans: 'Visits that started in the period; a visit is followed through every later step whenever that step happened.',
    caveats: ['A closed funnel: a visit counts at a step only if it also passed every earlier step.'],
  },
  campaigns: {
    key: 'campaigns',
    name: 'Campaign and creator outcomes',
    grains: ['day', 'week', 'month'],
    dimensions: ['campaign', 'creator', 'channel', 'venue'],
    periodMeans: 'Visits that started, customers first stamped, and attributed sales made on venue-local dates in the period.',
    caveats: [
      'Aligned with the campaign or creator, not proof that it caused the result.',
      'Guest figures appear only when at least the minimum number of guests stand behind them; below that they are hidden, which means unmeasured, not low.',
      'Attribution is first touch: the campaign or creator stamped on the customer when their record was created.',
    ],
    customerScoped: true,
  },
  messages: {
    key: 'messages',
    name: 'Message performance',
    grains: ['day', 'week', 'month'],
    dimensions: ['message_channel', 'message_kind', 'template', 'message_campaign', 'venue'],
    periodMeans: 'Message events (sent, delivered, opened …) that occurred in the period.',
    caveats: [
      'Each count is of distinct messages with that event in the period; an open that happens after the period is not counted in it.',
      'Opens are as reported by the email provider and are inflated by privacy features that pre-load images.',
    ],
  },
};

const sales = (d: Omit<MetricDef, 'family' | 'version' | 'caveats'> & { caveats?: string[] }): MetricDef => ({ family: 'sales', version: 1, caveats: [], ...d });
const item = (d: Omit<MetricDef, 'family' | 'version' | 'caveats'> & { caveats?: string[] }): MetricDef => ({ family: 'items', version: 1, caveats: [], ...d });
const def = (family: FamilyKey, d: Omit<MetricDef, 'family' | 'version' | 'caveats'> & { caveats?: string[] }): MetricDef => ({ family, version: 1, caveats: [], ...d });

const NEW_NOTE = 'A customer is new on their first counted sale within the venues asked about, and returning on any later one.';

export const METRICS: MetricDef[] = [
  // ── Sales ────────────────────────────────────────────────────────────────
  sales({ key: 'gross_sales', name: 'Gross sales', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'What guests paid: sale totals including GST and tips, after discounts, before refunds.', computation: 'Sum of total_cents over counted sales.', measures: ['gross'], value: pass('gross') }),
  sales({ key: 'net_sales', name: 'Net sales', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'Sales the venue keeps: excluding GST and tips, after discounts and after refunds.', computation: 'Per sale, (total − GST − tips) × the share of the sale not refunded, rounded to the cent; then summed.', measures: ['net'], value: pass('net'), caveats: ['A partial refund is assumed to reduce GST and tips in proportion.'] }),
  sales({ key: 'orders', name: 'Orders', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Number of sales, including ones later refunded.', computation: 'Count of counted sales.', measures: ['orders'], value: pass('orders') }),
  sales({ key: 'avg_order_value', name: 'Average order value', unit: 'cents', aggregation: 'ratio', direction: 'up_is_good', description: 'The average amount a guest paid per sale, including GST and tips, before refunds.', computation: 'gross_sales ÷ orders.', measures: ['gross', 'orders'], value: (m) => perUnit(m.gross, m.orders) }),
  sales({ key: 'items_sold', name: 'Items sold', unit: 'number', aggregation: 'sum', direction: 'up_is_good', description: 'Total quantity across all lines of counted sales.', computation: 'Sum of line quantities.', measures: ['items'], value: pass('items') }),
  sales({ key: 'items_per_order', name: 'Items per order', unit: 'number', aggregation: 'ratio', direction: 'up_is_good', description: 'Average quantity of items on a sale.', computation: 'items_sold ÷ orders.', measures: ['items', 'orders'], value: (m) => perUnit(m.items, m.orders, 2) }),
  sales({ key: 'refunds', name: 'Refunds', unit: 'cents', aggregation: 'sum', direction: 'down_is_good', description: 'Money refunded on sales made in the period.', computation: 'Sum of refunded_cents over counted sales, dated by the original sale, not by when the refund was given.', measures: ['refunded'], value: pass('refunded'), caveats: ['A refund given later is counted on the day of the original sale, so past days can change.'] }),
  sales({ key: 'refunded_orders', name: 'Refunded orders', unit: 'count', aggregation: 'sum', direction: 'down_is_good', description: 'Sales with any amount refunded.', computation: 'Count of counted sales with refunded_cents above zero.', measures: ['refunded_orders'], value: pass('refunded_orders') }),
  sales({ key: 'refund_rate', name: 'Refund rate', unit: 'ratio', aggregation: 'ratio', direction: 'down_is_good', description: 'Share of sales that were refunded in full or in part.', computation: 'refunded_orders ÷ orders.', measures: ['refunded_orders', 'orders'], value: (m) => ratio(m.refunded_orders, m.orders) }),
  sales({ key: 'discounts', name: 'Discounts', unit: 'cents', aggregation: 'sum', direction: 'neutral', description: 'Value of discounts given on counted sales.', computation: 'Sum of discount_cents.', measures: ['discount'], value: pass('discount') }),
  sales({ key: 'discounted_orders', name: 'Discounted orders', unit: 'count', aggregation: 'sum', direction: 'neutral', description: 'Sales that carried a discount.', computation: 'Count of counted sales with discount_cents above zero.', measures: ['discounted_orders'], value: pass('discounted_orders') }),
  sales({ key: 'discount_rate', name: 'Discount rate', unit: 'ratio', aggregation: 'ratio', direction: 'neutral', description: 'Share of sales that carried a discount.', computation: 'discounted_orders ÷ orders.', measures: ['discounted_orders', 'orders'], value: (m) => ratio(m.discounted_orders, m.orders) }),
  sales({ key: 'tips', name: 'Tips', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'Tips paid on counted sales.', computation: 'Sum of tip_cents.', measures: ['tip'], value: pass('tip') }),
  sales({ key: 'tip_rate', name: 'Tip rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Tips as a share of what guests paid before the tip.', computation: 'tips ÷ (gross_sales − tips).', measures: ['tip', 'gross'], value: (m) => (has(m, 'tip', 'gross') ? ratio(m.tip, n(m.gross) - n(m.tip)) : null) }),
  sales({ key: 'tax', name: 'GST collected', unit: 'cents', aggregation: 'sum', direction: 'neutral', description: 'GST included in counted sales, before refunds.', computation: 'Sum of tax_cents.', measures: ['tax'], value: pass('tax') }),
  sales({ key: 'identified_orders', name: 'Identified orders', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Sales tied to a known customer.', computation: 'Count of counted sales with a customer attached.', measures: ['identified_orders'], value: pass('identified_orders') }),
  sales({ key: 'identified_share', name: 'Identified share', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of sales tied to a known customer. Every customer metric describes only this share.', computation: 'identified_orders ÷ orders.', measures: ['identified_orders', 'orders'], value: (m) => ratio(m.identified_orders, m.orders) }),
  sales({ key: 'identified_sales_share', name: 'Identified share of sales value', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of gross sales that came from known customers.', computation: 'Gross sales with a customer attached ÷ gross_sales.', measures: ['identified_gross', 'gross'], value: (m) => ratio(m.identified_gross, m.gross) }),
  sales({ key: 'new_customer_orders', name: 'New-customer orders', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Sales that were a known customer\'s first.', computation: 'Count of counted sales that are the customer\'s first counted sale.', measures: ['new_customer_orders'], value: pass('new_customer_orders'), caveats: [NEW_NOTE, IDENTIFIED_NOTE] }),
  sales({ key: 'returning_customer_orders', name: 'Returning-customer orders', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Sales by known customers who had bought before.', computation: 'Count of counted sales by a customer with an earlier counted sale.', measures: ['returning_customer_orders'], value: pass('returning_customer_orders'), caveats: [NEW_NOTE, IDENTIFIED_NOTE] }),
  sales({ key: 'returning_order_share', name: 'Returning share of identified orders', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Of sales tied to a known customer, the share made by someone who had bought before.', computation: 'returning_customer_orders ÷ identified_orders.', measures: ['returning_customer_orders', 'identified_orders'], value: (m) => ratio(m.returning_customer_orders, m.identified_orders), caveats: [NEW_NOTE, IDENTIFIED_NOTE] }),

  // ── Items ────────────────────────────────────────────────────────────────
  item({ key: 'item_quantity', name: 'Quantity sold', unit: 'number', aggregation: 'sum', direction: 'up_is_good', description: 'Units of the item or category sold.', computation: 'Sum of line quantity.', measures: ['qty'], value: pass('qty') }),
  item({ key: 'item_revenue', name: 'Item revenue', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'Line totals, including GST and modifiers, before sale-level discounts and refunds.', computation: 'Sum of line total_cents.', measures: ['revenue'], value: pass('revenue') }),
  item({ key: 'item_orders', name: 'Orders containing', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Sales that included the item or category at least once.', computation: 'Count of distinct sales with a matching line.', measures: ['item_orders'], value: pass('item_orders'), caveats: ['Counts sales, so it does not add up across items: one sale can contain several.'] }),
  item({ key: 'item_revenue_share', name: 'Revenue mix', unit: 'ratio', aggregation: 'ratio', direction: 'neutral', description: 'The item\'s or category\'s share of all item revenue in the same period and slice.', computation: 'item_revenue ÷ total item revenue in the slice.', needsOneOf: ['item', 'category'], measures: ['revenue', 'total_revenue'], value: (m) => ratio(m.revenue, m.total_revenue) }),
  item({ key: 'item_quantity_share', name: 'Quantity mix', unit: 'ratio', aggregation: 'ratio', direction: 'neutral', description: 'The item\'s or category\'s share of all units sold in the same period and slice.', computation: 'item_quantity ÷ total quantity in the slice.', needsOneOf: ['item', 'category'], measures: ['qty', 'total_qty'], value: (m) => ratio(m.qty, m.total_qty) }),
  item({ key: 'item_attach_rate', name: 'Attach rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of sales that included the item or category.', computation: 'item_orders ÷ all sales with at least one line in the slice.', needsOneOf: ['item', 'category'], measures: ['item_orders', 'total_orders'], value: (m) => ratio(m.item_orders, m.total_orders) }),

  // ── Customer activity in a period ────────────────────────────────────────
  def('customers', { key: 'active_customers', name: 'Active customers', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Known customers with at least one sale in the period.', computation: 'Count of distinct customers on counted sales in the period.', measures: ['active'], value: pass('active') }),
  def('customers', { key: 'new_customers', name: 'New customers', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Known customers whose first ever sale was in the period.', computation: 'Count of distinct customers whose earliest counted sale falls in the period.', measures: ['new'], value: pass('new'), caveats: [NEW_NOTE] }),
  def('customers', { key: 'returning_customers', name: 'Returning customers', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Known customers who bought in the period and had first bought before it.', computation: 'active_customers − new_customers.', measures: ['active', 'new'], value: (m) => (has(m, 'active', 'new') ? n(m.active) - n(m.new) : null), caveats: [NEW_NOTE] }),
  def('customers', { key: 'returning_customer_share', name: 'Returning share of active customers', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Of known customers who bought in the period, the share who were not new.', computation: 'returning_customers ÷ active_customers.', measures: ['active', 'new'], value: (m) => (has(m, 'active', 'new') ? ratio(n(m.active) - n(m.new), m.active) : null) }),

  // ── The customer base as of a day ────────────────────────────────────────
  def('customer_base', { key: 'customers_total', name: 'Known customers', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Identified customers with at least one sale up to the end of the period. Split by segment for the RFM segments.', computation: 'Count of distinct customers on counted sales up to the as-of day.', measures: ['customers'], value: pass('customers') }),
  def('customer_base', { key: 'customer_share', name: 'Share of customers', unit: 'ratio', aggregation: 'ratio', direction: 'neutral', description: 'The slice\'s share of all known customers.', computation: 'customers_total in the slice ÷ customers_total overall.', needsOneOf: ['segment', 'acquisition_source'], measures: ['customers', 'total_customers'], value: (m) => ratio(m.customers, m.total_customers) }),
  def('customer_base', { key: 'repeat_rate', name: 'Repeat rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of known customers who have bought at least twice.', computation: 'Customers with two or more counted sales ÷ customers_total, as of the end of the period.', measures: ['repeaters', 'customers'], value: (m) => ratio(m.repeaters, m.customers), caveats: ['Recently acquired customers have had little time to return, so a growing venue reads lower.'] }),
  def('customer_base', { key: 'one_timer_share', name: 'One-timer share', unit: 'ratio', aggregation: 'ratio', direction: 'down_is_good', description: 'Share of known customers who have bought exactly once.', computation: 'Customers with exactly one counted sale ÷ customers_total, as of the end of the period. It is 1 − repeat_rate.', measures: ['one_timers', 'customers'], value: (m) => ratio(m.one_timers, m.customers), caveats: ['Includes customers who only just made their first purchase; the one_timer segment excludes those still inside the new window.'] }),
  def('customer_base', { key: 'median_days_to_second_order', name: 'Median days to second order', unit: 'days', aggregation: 'median', direction: 'down_is_good', description: 'For customers who came back, the typical gap between their first and second sale.', computation: 'Median of (second sale date − first sale date) in venue-local days, over customers with a second sale.', measures: ['median_days_to_second'], value: (m) => (has(m, 'median_days_to_second') ? Math.round(n(m.median_days_to_second) * 10) / 10 : null), caveats: ['Only customers who have already returned are included, so it understates how long the others will take.'] }),
  def('customer_base', { key: 'customer_lifetime_value', name: 'Customer lifetime value (to date)', unit: 'cents', aggregation: 'ratio', direction: 'up_is_good', description: 'Average amount a known customer has spent so far, after refunds. Historic, not a forecast.', computation: 'Sum of (total − refunded) over known customers\' counted sales ÷ customers_total.', measures: ['spend', 'customers'], value: (m) => perUnit(m.spend, m.customers), caveats: ['Spend to date, not a prediction of future spend.'] }),
  def('customer_base', { key: 'customer_spend', name: 'Customer spend (to date)', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'Total spent so far by known customers, after refunds.', computation: 'Sum of (total − refunded) over known customers\' counted sales.', measures: ['spend'], value: pass('spend') }),
  def('customer_base', { key: 'customer_spend_share', name: 'Share of customer spend', unit: 'ratio', aggregation: 'ratio', direction: 'neutral', description: 'The slice\'s share of everything known customers have spent.', computation: 'customer_spend in the slice ÷ customer_spend overall.', needsOneOf: ['segment', 'acquisition_source'], measures: ['spend', 'total_spend'], value: (m) => ratio(m.spend, m.total_spend) }),
  def('customer_base', { key: 'avg_orders_per_customer', name: 'Orders per customer', unit: 'number', aggregation: 'ratio', direction: 'up_is_good', description: 'Average number of sales per known customer so far.', computation: 'Counted sales by known customers ÷ customers_total.', measures: ['cust_orders', 'customers'], value: (m) => perUnit(m.cust_orders, m.customers, 2) }),
  def('customer_base', { key: 'avg_recency_days', name: 'Average days since last order', unit: 'days', aggregation: 'ratio', direction: 'down_is_good', description: 'Average number of days since a known customer last bought.', computation: 'Mean of (as-of day − last sale date) over known customers.', measures: ['avg_recency'], value: (m) => (has(m, 'avg_recency') ? Math.round(n(m.avg_recency) * 10) / 10 : null) }),

  // ── Cohort retention ─────────────────────────────────────────────────────
  def('cohorts', { key: 'cohort_size', name: 'Cohort size', unit: 'count', aggregation: 'distinct', direction: 'neutral', description: 'Customers whose first order fell in the cohort period.', computation: 'Count of distinct customers by the week or month of their first counted sale.', measures: ['cohort_size'], value: pass('cohort_size') }),
  def('cohorts', { key: 'cohort_active_customers', name: 'Cohort customers active', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Customers of the cohort who bought in the given later period.', computation: 'Count of distinct cohort customers with a counted sale N periods after the cohort period.', measures: ['cohort_active'], value: pass('cohort_active') }),
  def('cohorts', { key: 'cohort_retention_rate', name: 'Cohort retention', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of a cohort that bought again N periods after their first order. Period 0 is always 1.', computation: 'cohort_active_customers ÷ cohort_size.', measures: ['cohort_active', 'cohort_size'], value: (m) => ratio(m.cohort_active, m.cohort_size), caveats: ['A small cohort makes a jumpy percentage; read cohort_size alongside it.'] }),

  // ── Web ──────────────────────────────────────────────────────────────────
  def('web', { key: 'web_sessions', name: 'Web sessions', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Visits to the venue\'s site or QR menu.', computation: 'Count of visitor sessions by the venue-local date they started.', measures: ['sessions'], value: pass('sessions') }),
  def('events', { key: 'event_count', name: 'Events', unit: 'count', aggregation: 'sum', direction: 'neutral', description: 'How many times declared events occurred. Split or filter by event_name.', computation: 'Count of rows in the event stream.', measures: ['events'], value: pass('events') }),
  def('funnel', { key: 'funnel_sessions', name: 'Sessions reaching the step', unit: 'count', aggregation: 'distinct', direction: 'up_is_good', description: 'Visits that reached a funnel step, having passed every step before it.', computation: 'Count of sessions started in the period with the event of this step and of every earlier step.', needsOneOf: ['funnel_step'], measures: ['funnel_sessions'], value: pass('funnel_sessions') }),
  def('funnel', { key: 'funnel_conversion_rate', name: 'Conversion from the first step', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of visits that reached the step, out of all that entered the funnel.', computation: 'funnel_sessions at the step ÷ funnel_sessions at step 1.', needsOneOf: ['funnel_step'], measures: ['funnel_sessions', 'first_step_sessions'], value: (m) => ratio(m.funnel_sessions, m.first_step_sessions) }),
  def('funnel', { key: 'funnel_step_rate', name: 'Conversion from the previous step', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of visits at the previous step that went on to this one. Empty for step 1.', computation: 'funnel_sessions at the step ÷ funnel_sessions at the step before.', needsOneOf: ['funnel_step'], measures: ['funnel_sessions', 'prev_step_sessions'], value: (m) => ratio(m.funnel_sessions, m.prev_step_sessions) }),

  // ── Campaigns and creators ───────────────────────────────────────────────
  def('campaigns', { key: 'campaign_sessions', name: 'Campaign sessions', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Visits that arrived carrying a campaign or creator.', computation: 'Count of visitor sessions with a campaign or creator identifier.', measures: ['sessions'], value: pass('sessions') }),
  def('campaigns', { key: 'campaign_new_customers', name: 'New customers aligned with a campaign', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Customer records first created with the campaign or creator stamped on them.', computation: 'Count of active customers by write-once acquisition stamp and the date it was stamped.', measures: ['new_customers'], value: pass('new_customers') }),
  def('campaigns', { key: 'campaign_orders', name: 'Orders aligned with a campaign', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Sales by customers who were acquired through the campaign or creator.', computation: 'Count of counted sales with an acquisition-model attribution row.', measures: ['orders'], value: pass('orders') }),
  def('campaigns', { key: 'campaign_revenue', name: 'Revenue aligned with a campaign', unit: 'cents', aggregation: 'sum', direction: 'up_is_good', description: 'What those customers paid, after refunds, including GST and tips.', computation: 'Sum of (total − refunded) over attributed counted sales.', measures: ['revenue'], value: pass('revenue') }),
  def('campaigns', { key: 'campaign_repeat_orders', name: 'Repeat orders aligned with a campaign', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Attributed sales that were not the customer\'s first.', computation: 'Count of attributed counted sales by a customer with an earlier counted sale.', measures: ['repeat_orders'], value: pass('repeat_orders') }),
  def('campaigns', { key: 'campaign_repeat_rate', name: 'Repeat rate of campaign customers', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Of the campaign\'s customers who bought in the period, the share who made a repeat purchase in it.', computation: 'Distinct customers with an attributed sale that was not their first ÷ distinct customers with an attributed sale.', measures: ['repeat_buyers', 'buyers'], value: (m) => ratio(m.repeat_buyers, m.buyers) }),

  // ── Messages ─────────────────────────────────────────────────────────────
  def('messages', { key: 'messages_sent', name: 'Messages sent', unit: 'count', aggregation: 'sum', direction: 'neutral', description: 'Messages handed to the email or SMS provider.', computation: 'Distinct messages with a message.sent event.', measures: ['sent'], value: pass('sent') }),
  def('messages', { key: 'messages_delivered', name: 'Messages delivered', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Messages the provider confirmed as delivered.', computation: 'Distinct messages with a message.delivered event.', measures: ['delivered'], value: pass('delivered') }),
  def('messages', { key: 'messages_opened', name: 'Messages opened', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Emails opened, as far as the provider can tell.', computation: 'Distinct messages with a message.opened event.', measures: ['opened'], value: pass('opened') }),
  def('messages', { key: 'messages_clicked', name: 'Messages clicked', unit: 'count', aggregation: 'sum', direction: 'up_is_good', description: 'Messages with at least one link clicked.', computation: 'Distinct messages with a message.clicked event.', measures: ['clicked'], value: pass('clicked') }),
  def('messages', { key: 'messages_bounced', name: 'Messages bounced', unit: 'count', aggregation: 'sum', direction: 'down_is_good', description: 'Messages that could not be delivered.', computation: 'Distinct messages with a message.bounced event.', measures: ['bounced'], value: pass('bounced') }),
  def('messages', { key: 'messages_unsubscribed', name: 'Unsubscribes', unit: 'count', aggregation: 'sum', direction: 'down_is_good', description: 'Messages that led to an opt-out.', computation: 'Distinct messages with a message.unsubscribed event.', measures: ['unsubscribed'], value: pass('unsubscribed') }),
  def('messages', { key: 'message_delivery_rate', name: 'Delivery rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of sent messages that were delivered.', computation: 'messages_delivered ÷ messages_sent.', measures: ['delivered', 'sent'], value: (m) => ratio(m.delivered, m.sent) }),
  def('messages', { key: 'message_open_rate', name: 'Open rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of delivered messages that were opened.', computation: 'messages_opened ÷ messages_delivered.', measures: ['opened', 'delivered'], value: (m) => ratio(m.opened, m.delivered) }),
  def('messages', { key: 'message_click_rate', name: 'Click rate', unit: 'ratio', aggregation: 'ratio', direction: 'up_is_good', description: 'Share of delivered messages with a click.', computation: 'messages_clicked ÷ messages_delivered.', measures: ['clicked', 'delivered'], value: (m) => ratio(m.clicked, m.delivered) }),
  def('messages', { key: 'message_unsubscribe_rate', name: 'Unsubscribe rate', unit: 'ratio', aggregation: 'ratio', direction: 'down_is_good', description: 'Share of delivered messages that led to an opt-out.', computation: 'messages_unsubscribed ÷ messages_delivered.', measures: ['unsubscribed', 'delivered'], value: (m) => ratio(m.unsubscribed, m.delivered) }),
];

const byKey = new Map(METRICS.map((m) => [m.key, m]));
if (byKey.size !== METRICS.length) throw new Error('Duplicate metric key in the analytics catalogue');

export function getMetric(key: string): MetricDef | undefined {
  return byKey.get(key);
}

export const METRIC_KEYS = METRICS.map((m) => m.key);
export const DIMENSION_KEYS = DIMENSIONS.map((d) => d.key);

export interface CatalogueEntry {
  key: string;
  name: string;
  description: string;
  unit: Unit;
  group: string;
  how_it_is_computed: string;
  adds_up: boolean;
  good_direction: MetricDef['direction'];
  time_grains: Grain[];
  dimensions: string[];
  requires_one_of_dimensions: string[];
  period_means: string;
  caveats: string[];
  definition_version: number;
}

/** The catalogue as data: what can be measured, in plain words. No role check; it holds no tenant data. */
export function metricCatalogue(): { version: number; metrics: CatalogueEntry[]; dimensions: DimensionDef[]; units: Record<Unit, string> } {
  return {
    version: CATALOGUE_VERSION,
    metrics: METRICS.map((m) => {
      const f = FAMILIES[m.family];
      return {
        key: m.key,
        name: m.name,
        description: m.description,
        unit: m.unit,
        group: f.name,
        how_it_is_computed: m.computation,
        adds_up: m.aggregation === 'sum',
        good_direction: m.direction,
        time_grains: f.grains,
        dimensions: f.dimensions,
        requires_one_of_dimensions: m.needsOneOf ?? [],
        period_means: f.periodMeans,
        caveats: [...f.caveats, ...m.caveats],
        definition_version: m.version,
      };
    }),
    dimensions: DIMENSIONS,
    units: {
      cents: 'Money in whole cents of the org\'s currency. Divide by 100 for dollars.',
      count: 'A whole number of things.',
      ratio: 'A share between 0 and 1. Multiply by 100 for a percentage.',
      days: 'A number of days.',
      number: 'A plain number, possibly fractional.',
    },
  };
}
