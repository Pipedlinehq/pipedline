import { z } from 'zod';
import { sql } from 'kysely';
import { type Ctx, addDays, localParts } from '@ros/core';
import { type Significance, classify, dm, money, pct } from './digest';
import { SALE_STATUSES } from './engine';
import { SEGMENTS } from './families/customers';
import { saleCtes } from './families/sales';
import { funnelSteps } from './families/web';
import { ledgerFreshness } from './freshness';
import { periodInput, weekStart } from './period';
import { type MetricResult, metricQueryInput, runMetricQuery } from './query';
import { type VenueScope, resolveScope } from './scope';
import { getAnalyticsSettings } from './settings';
import { parseInput } from './util';

/**
 * Ready-made answers to the questions asked most often, built on queryMetrics and the same
 * definitions. Each is one function for the console's dashboard and the assistant's tool, and
 * each returns numbers with their units in the field names, a comparison, a one-sentence
 * summary made from a template, and the caveats that apply.
 */
const venueInput = z.object({ venueId: z.string().uuid().optional() }).strict();
const q = (ctx: Ctx, scope: VenueScope, query: z.input<typeof metricQueryInput>): Promise<MetricResult> => runMetricQuery(ctx, scope, metricQueryInput.parse(query));
const scopeOf = (ctx: Ctx, venueId?: string) => resolveScope(ctx, venueId ? [venueId] : undefined);
const venueLabel = (scope: VenueScope): string => (scope.venues.length === 1 ? scope.venues[0]!.name : scope.all ? 'All venues' : `${scope.venues.length} venues`);
const percent = (v: number | null | undefined): string => (v === null || v === undefined ? 'an unknown share' : `${Math.round(v * 1000) / 10}%`);

// ── Sales ───────────────────────────────────────────────────────────────────

export interface SalesWindow {
  window: 'today_so_far' | 'yesterday' | 'this_week_so_far' | 'last_week';
  from: string;
  to: string;
  /** Set when the last day of the window is cut at the current local time, in it and in every baseline period. */
  cut_at_local_time: string | null;
  net_sales_cents: number;
  gross_sales_cents: number;
  orders: number;
  avg_order_value_cents: number | null;
  /** The mean of the same weekdays (to the same time of day) over the earlier weeks. */
  usual_net_sales_cents: number | null;
  usual_orders: number | null;
  change_pct: number | null;
  significance: Significance;
  baseline_weeks: number;
}

export interface SalesSummary {
  venue: string;
  currency: string;
  local_time: string;
  windows: SalesWindow[];
  last_7_days: {
    from: string;
    to: string;
    by_channel: Array<{ channel: string; net_sales_cents: number; orders: number; share_of_net_sales: number | null; change_pct_vs_previous_7_days: number | null }>;
    by_daypart: Array<{ daypart: string; net_sales_cents: number; orders: number; share_of_net_sales: number | null; change_pct_vs_previous_7_days: number | null }>;
  };
  summary: string;
  caveats: string[];
  freshness: { latest_sale_at: string | null; latest_sale_ingested_at: string | null };
  as_of: string;
}

/**
 * Today so far, yesterday, this week so far and last week, each against what is usual for the
 * same weekdays, plus the last seven days by channel and daypart. "So far" windows are compared
 * like for like: the baseline weeks are cut at the same time of day.
 */
export async function salesSummary(ctx: Ctx, raw: z.input<typeof venueInput> = {}): Promise<SalesSummary> {
  const input = parseInput(venueInput, raw);
  const scope = await scopeOf(ctx, input.venueId);
  const settings = await getAnalyticsSettings(ctx);
  const n = settings.digest.baselinePeriods;
  const today = scope.today;
  const now = localParts(ctx.now(), scope.timezone);
  const monday = weekStart(today);
  const windowFrom = addDays(monday, -7 * (n + 1));

  const rows = await sql<{ day: string; net: number; gross: number; orders: number; net_cut: number | null; gross_cut: number | null; orders_cut: number | null }>`
    with ${sql.join(saleCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, from: windowFrom, to: today, withRank: false, withItems: false }), sql`, `)}
    select day, sum(net_cents) as net, sum(gross_cents) as gross, sum(orders) as orders,
           sum(net_cents) filter (where local_time <= ${now.time}::time) as net_cut,
           sum(gross_cents) filter (where local_time <= ${now.time}::time) as gross_cut,
           sum(orders) filter (where local_time <= ${now.time}::time) as orders_cut
    from a_sale
    group by day`.execute(ctx.db);
  const byDay = new Map(rows.rows.map((r) => [r.day, r]));
  const first = await sql<{ d: string | null }>`
    select min((t.occurred_at at time zone v.timezone)::date) as d
    from transactions t join venues v on v.id = t.venue_id
    where t.org_id = ${ctx.orgId} and t.venue_id = any(${scope.venueIds}::uuid[]) and t.status in ${sql.raw(SALE_STATUSES)}`.execute(ctx.db);
  const earliest = first.rows[0]?.d ?? null;

  const total = (days: string[], cutLast: boolean) => {
    let net = 0;
    let gross = 0;
    let orders = 0;
    days.forEach((d, i) => {
      const r = byDay.get(d);
      if (!r) return;
      const cut = cutLast && i === days.length - 1;
      net += Number((cut ? r.net_cut : r.net) ?? 0);
      gross += Number((cut ? r.gross_cut : r.gross) ?? 0);
      orders += Number((cut ? r.orders_cut : r.orders) ?? 0);
    });
    return { net, gross, orders };
  };
  const span = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  };
  const build = (window: SalesWindow['window'], from: string, to: string, cut: boolean): SalesWindow => {
    const days = span(from, to);
    const cur = total(days, cut);
    const base: Array<{ net: number; orders: number }> = [];
    for (let k = 1; k <= n; k++) {
      const shifted = days.map((d) => addDays(d, -7 * k));
      if (earliest && shifted[0]! >= earliest) base.push(total(shifted, cut));
    }
    const c = classify(cur.net, base.map((b) => b.net), settings.digest);
    return {
      window,
      from,
      to,
      cut_at_local_time: cut ? now.time.slice(0, 5) : null,
      net_sales_cents: cur.net,
      gross_sales_cents: cur.gross,
      orders: cur.orders,
      avg_order_value_cents: cur.orders ? Math.round(cur.gross / cur.orders) : null,
      usual_net_sales_cents: c.mean === null ? null : Math.round(c.mean),
      usual_orders: base.length ? Math.round((base.reduce((s, b) => s + b.orders, 0) / base.length) * 10) / 10 : null,
      change_pct: c.mean ? Math.round(((cur.net - c.mean) / c.mean) * 10_000) / 10_000 : null,
      significance: c.significance,
      baseline_weeks: base.length,
    };
  };
  const windows = [
    build('today_so_far', today, today, true),
    build('yesterday', addDays(today, -1), addDays(today, -1), false),
    build('this_week_so_far', monday, today, true),
    build('last_week', addDays(monday, -7), addDays(monday, -1), false),
  ];

  const split = async (dim: 'channel' | 'daypart') => {
    const r = await q(ctx, scope, { metrics: ['net_sales', 'orders'], dimensions: [dim], period: 'last_7_days', compareTo: 'previous_period' });
    const whole = Number(r.totals.values.net_sales ?? 0);
    return {
      period: r.period,
      rows: r.rows
        .filter((row) => (row.values.orders ?? 0) > 0 || (row.compare?.orders ?? 0) > 0)
        .map((row) => ({
          name: row.dimensions[dim] ?? '(unknown)',
          net_sales_cents: Number(row.values.net_sales ?? 0),
          orders: Number(row.values.orders ?? 0),
          share_of_net_sales: whole ? Math.round((Number(row.values.net_sales ?? 0) / whole) * 10_000) / 10_000 : null,
          change_pct_vs_previous_7_days: row.change?.net_sales?.pct ?? null,
        })),
    };
  };
  const channels = await split('channel');
  const dayparts = await split('daypart');

  const say = (w: SalesWindow, label: string): string => {
    const head = `${label}: ${money(w.net_sales_cents)} net from ${w.orders} ${w.orders === 1 ? 'order' : 'orders'}`;
    if (w.usual_net_sales_cents === null || w.significance === 'insufficient_history') return `${head} (not enough history to say what is usual).`;
    if (w.change_pct === null) return `${head}; usual is ${money(w.usual_net_sales_cents)}.`;
    const note = w.significance === 'normal' ? 'within normal variation' : w.significance === 'strong' ? 'well outside normal variation' : 'outside normal variation';
    return `${head}, ${pct(w.change_pct)} against the usual ${money(w.usual_net_sales_cents)} (${note}).`;
  };
  const caveats: string[] = [];
  caveats.push(`"So far" windows stop at ${now.time.slice(0, 5)} local time, and so does their baseline, so the comparison is like for like.`);
  if (scope.mixedZones) caveats.push('The venues are in different time zones; the cut-off uses the org\'s own zone.');
  if (windows.some((w) => w.significance === 'insufficient_history')) caveats.push('Some windows have fewer than four earlier weeks of history: too few to say what is normal.');
  if (!windows[0]!.orders) caveats.push('No sales yet today. That can mean the venue has not opened, or that today\'s sales have not reached the ledger.');
  const fresh = await ledgerFreshness(ctx, scope.venueIds);

  return {
    venue: venueLabel(scope),
    currency: scope.currency,
    local_time: `${now.date} ${now.time.slice(0, 5)}`,
    windows,
    last_7_days: {
      from: channels.period.from,
      to: channels.period.to,
      by_channel: channels.rows.map(({ name, ...rest }) => ({ channel: name, ...rest })),
      by_daypart: dayparts.rows.map(({ name, ...rest }) => ({ daypart: name, ...rest })),
    },
    summary: [say(windows[0]!, `Today to ${now.time.slice(0, 5)}`), say(windows[2]!, 'This week so far'), say(windows[1]!, 'Yesterday'), say(windows[3]!, `Last week (${dm(windows[3]!.from)} to ${dm(windows[3]!.to)})`)].join(' '),
    caveats,
    freshness: { latest_sale_at: fresh.latestSaleAt?.toISOString() ?? null, latest_sale_ingested_at: fresh.latestIngestedAt?.toISOString() ?? null },
    as_of: ctx.now().toISOString(),
  };
}

// ── Customers ───────────────────────────────────────────────────────────────

const SEGMENT_MEANING: Record<string, string> = {
  new: 'One order, made recently.',
  one_timer: 'One order, and not recent: came once and has not returned.',
  repeater: 'Two or more orders, still active.',
  frequent: 'Five or more orders (by default), still active.',
  loyal: 'Ten or more orders (by default), still active.',
  at_risk: 'A repeat customer who has been away longer than usual.',
  lapsed: 'A repeat customer who has been away a long time.',
};

export interface CustomersSummary {
  venue: string;
  currency: string;
  as_of_day: string;
  known_customers: number;
  identified_share_of_orders_last_28_days: number | null;
  repeat_rate: number | null;
  one_timer_share: number | null;
  median_days_to_second_order: number | null;
  avg_lifetime_spend_cents: number | null;
  avg_orders_per_customer: number | null;
  segments: Array<{ segment: string; meaning: string; customers: number; share_of_customers: number | null; share_of_spend: number | null; avg_lifetime_spend_cents: number | null }>;
  last_28_days: { from: string; to: string; active_customers: number; new_customers: number; returning_customers: number; change_pct_active_vs_previous_28_days: number | null };
  by_acquisition_source: Array<{ source: string; customers: number; repeat_rate: number | null; avg_lifetime_spend_cents: number | null }>;
  summary: string;
  caveats: string[];
  as_of: string;
}

/** The customer base in aggregate: how many, how many come back, how long it takes, and the segments. Never a guest. */
export async function customersSummary(ctx: Ctx, raw: z.input<typeof venueInput> = {}): Promise<CustomersSummary> {
  const input = parseInput(venueInput, raw);
  const scope = await scopeOf(ctx, input.venueId);
  const base = await q(ctx, scope, { metrics: ['customers_total', 'repeat_rate', 'one_timer_share', 'median_days_to_second_order', 'customer_lifetime_value', 'avg_orders_per_customer'], period: 'today' });
  const segs = await q(ctx, scope, { metrics: ['customers_total', 'customer_share', 'customer_spend_share', 'customer_lifetime_value'], dimensions: ['segment'], period: 'today' });
  const flows = await q(ctx, scope, { metrics: ['active_customers', 'new_customers', 'returning_customers'], period: 'last_28_days', compareTo: 'previous_period' });
  const sources = await q(ctx, scope, { metrics: ['customers_total', 'repeat_rate', 'customer_lifetime_value'], dimensions: ['acquisition_source'], period: 'today' });
  const ident = await q(ctx, scope, { metrics: ['identified_share'], period: 'last_28_days' });

  const t = base.totals.values;
  const known = Number(t.customers_total ?? 0);
  const bySegment = new Map(segs.rows.map((r) => [r.dimensions.segment, r.values]));
  const segments = SEGMENTS.map((s) => {
    const v = bySegment.get(s);
    return {
      segment: s,
      meaning: SEGMENT_MEANING[s]!,
      customers: Number(v?.customers_total ?? 0),
      share_of_customers: v?.customer_share ?? (known ? 0 : null),
      share_of_spend: v?.customer_spend_share ?? (known ? 0 : null),
      avg_lifetime_spend_cents: v?.customer_lifetime_value ?? null,
    };
  });
  const identified = ident.totals.values.identified_share ?? null;
  const everIdentified = (await q(ctx, scope, { metrics: ['identified_share'], period: 'all_time' })).totals.values.identified_share ?? null;
  const cameBack = segments.filter((s) => s.segment !== 'new' && s.segment !== 'one_timer').reduce((total, s) => total + (s.share_of_spend ?? 0), 0);
  const sentences: string[] = [];
  if (!known) {
    sentences.push('No sales are tied to a known customer yet, so there is nothing to say about customers. That is unmeasured, not zero loyalty.');
  } else {
    sentences.push(`${known.toLocaleString('en-AU')} known customers.`);
    sentences.push(`${percent(identified)} of orders in the last 28 days were tied to one, so everything here describes that share.`);
    const gap = t.median_days_to_second_order;
    sentences.push(`${percent(t.repeat_rate)} have ordered at least twice${gap === null || gap === undefined ? '' : `, typically returning ${Math.round(gap)} days after their first order`}.`);
    sentences.push(`Customers who came back account for ${percent(Math.round(cameBack * 10_000) / 10_000)} of known-customer spend.`);
    sentences.push(`In the last 28 days: ${flows.totals.values.new_customers ?? 0} new and ${flows.totals.values.returning_customers ?? 0} returning.`);
  }
  const summary = sentences.join(' ');
  const inherited = [...base.caveats, ...flows.caveats].filter((c) => !c.startsWith('Only ') && !c.startsWith('The period includes today'));
  const caveats = [
    `${percent(everIdentified)} of all sales to date are tied to a known customer (${percent(identified)} in the last 28 days). Every figure here describes only those sales and says nothing about the rest.`,
    ...new Set(inherited),
    'Lifetime spend is spend to date, not a forecast.',
    'Aggregates only: this never lists or describes an individual guest.',
  ];

  return {
    venue: venueLabel(scope),
    currency: scope.currency,
    as_of_day: base.period.to,
    known_customers: known,
    identified_share_of_orders_last_28_days: identified,
    repeat_rate: t.repeat_rate ?? null,
    one_timer_share: t.one_timer_share ?? null,
    median_days_to_second_order: t.median_days_to_second_order ?? null,
    avg_lifetime_spend_cents: t.customer_lifetime_value ?? null,
    avg_orders_per_customer: t.avg_orders_per_customer ?? null,
    segments,
    last_28_days: {
      from: flows.period.from,
      to: flows.period.to,
      active_customers: Number(flows.totals.values.active_customers ?? 0),
      new_customers: Number(flows.totals.values.new_customers ?? 0),
      returning_customers: Number(flows.totals.values.returning_customers ?? 0),
      change_pct_active_vs_previous_28_days: flows.totals.change?.active_customers?.pct ?? null,
    },
    by_acquisition_source: sources.rows.map((r) => ({
      source: r.dimensions.acquisition_source ?? '(unknown)',
      customers: Number(r.values.customers_total ?? 0),
      repeat_rate: r.values.repeat_rate ?? null,
      avg_lifetime_spend_cents: r.values.customer_lifetime_value ?? null,
    })),
    summary,
    caveats,
    as_of: ctx.now().toISOString(),
  };
}

// ── Menu ────────────────────────────────────────────────────────────────────

export const menuPerformanceInput = z
  .object({
    venueId: z.string().uuid().optional(),
    period: periodInput.default('last_28_days'),
    by: z.enum(['item', 'category']).default('item'),
    sortBy: z.enum(['revenue', 'quantity', 'attach_rate']).default('revenue'),
    limit: z.number().int().min(1).max(100).default(15),
  })
  .strict();

export interface MenuRow {
  name: string;
  quantity: number;
  revenue_cents: number;
  revenue_share: number | null;
  orders_containing: number;
  attach_rate: number | null;
  revenue_change_pct: number | null;
  previous_revenue_cents: number | null;
}

export interface MenuPerformance {
  venue: string;
  currency: string;
  period: MetricResult['period'];
  compared_with: MetricResult['compare'];
  by: 'item' | 'category';
  rows: MenuRow[];
  total_lines: number;
  rising: Array<{ name: string; revenue_change_cents: number }>;
  falling: Array<{ name: string; revenue_change_cents: number }>;
  totals: { quantity: number; revenue_cents: number };
  summary: string;
  caveats: string[];
  as_of: string;
}

/** What sells: quantity, revenue, share of the mix and attach rate per item or category, against the period before. */
export async function menuPerformance(ctx: Ctx, raw: z.input<typeof menuPerformanceInput> = {}): Promise<MenuPerformance> {
  const input = parseInput(menuPerformanceInput, raw);
  const scope = await scopeOf(ctx, input.venueId);
  const sort = { revenue: 'item_revenue', quantity: 'item_quantity', attach_rate: 'item_attach_rate' }[input.sortBy];
  const r = await q(ctx, scope, {
    metrics: ['item_revenue', 'item_quantity', 'item_revenue_share', 'item_orders', 'item_attach_rate'],
    dimensions: [input.by],
    period: input.period,
    compareTo: 'previous_period',
    sort: { by: sort, direction: 'desc' },
    limit: 5000,
  });
  const all = r.rows.map((row) => ({
    name: row.dimensions[input.by] ?? '(unknown)',
    quantity: Number(row.values.item_quantity ?? 0),
    revenue_cents: Number(row.values.item_revenue ?? 0),
    revenue_share: row.values.item_revenue_share ?? null,
    orders_containing: Number(row.values.item_orders ?? 0),
    attach_rate: row.values.item_attach_rate ?? null,
    revenue_change_pct: row.change?.item_revenue?.pct ?? null,
    previous_revenue_cents: row.compare?.item_revenue ?? null,
    delta: Number(row.values.item_revenue ?? 0) - Number(row.compare?.item_revenue ?? 0),
  }));
  const movers = [...all].sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));
  const rising = movers.filter((m) => m.delta > 0).slice(0, 3).map((m) => ({ name: m.name, revenue_change_cents: m.delta }));
  const falling = movers.filter((m) => m.delta < 0).reverse().slice(0, 3).map((m) => ({ name: m.name, revenue_change_cents: m.delta }));
  const rows = all.filter((x) => x.revenue_cents > 0 || x.quantity > 0).slice(0, input.limit).map(({ delta, ...rest }) => (void delta, rest));
  const top = rows[0];
  const summary = !top
    ? 'No item sales were recorded in this period. That is unmeasured, not a poor menu.'
    : `${dm(r.period.from)} to ${dm(r.period.to)}: the top ${input.by} by ${input.sortBy.replace('_', ' ')} is ${top.name} (${money(top.revenue_cents)}, ${percent(top.revenue_share)} of item revenue, on ${percent(top.attach_rate)} of orders).` +
      (rising[0] ? ` Up most on the period before: ${rising[0].name} (+${money(rising[0].revenue_change_cents)}).` : '') +
      (falling[0] ? ` Down most: ${falling[0].name} (${money(falling[0].revenue_change_cents)}).` : '');
  return {
    venue: venueLabel(scope),
    currency: scope.currency,
    period: r.period,
    compared_with: r.compare,
    by: input.by,
    rows,
    total_lines: all.filter((x) => x.revenue_cents > 0 || x.quantity > 0).length,
    rising,
    falling,
    totals: { quantity: Number(r.totals.values.item_quantity ?? 0), revenue_cents: Number(r.totals.values.item_revenue ?? 0) },
    summary,
    caveats: [...r.caveats, 'Item revenue is line totals before sale-level discounts and refunds, so it does not sum to net sales.'],
    as_of: ctx.now().toISOString(),
  };
}

// ── Funnel ──────────────────────────────────────────────────────────────────

export const funnelReportInput = z
  .object({
    venueId: z.string().uuid().optional(),
    period: periodInput.default('last_28_days'),
    funnel: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).default('order'),
    by: z.enum(['utm_source', 'utm_medium', 'campaign', 'creator', 'device_class', 'landing_path']).optional(),
  })
  .strict();

export interface FunnelStepRow {
  step: number;
  event: string;
  meaning: string;
  sessions: number;
  conversion_from_start: number | null;
  conversion_from_previous: number | null;
}

export interface FunnelReport {
  venue: string;
  period: MetricResult['period'];
  funnel: string;
  steps: FunnelStepRow[];
  biggest_drop: { from_event: string; to_event: string; lost_share: number } | null;
  split_by: string | null;
  splits: Array<{ value: string; steps: Array<{ step: number; event: string; sessions: number; conversion_from_start: number | null }> }>;
  summary: string;
  caveats: string[];
  as_of: string;
}

/** How far visits get through a declared funnel, step by step, optionally split by where they came from. */
export async function funnelReport(ctx: Ctx, raw: z.input<typeof funnelReportInput> = {}): Promise<FunnelReport> {
  const input = parseInput(funnelReportInput, raw);
  const scope = await scopeOf(ctx, input.venueId);
  const declared = funnelSteps(input.funnel);
  const meaning = new Map(declared.map((s) => [s.event, s.description]));
  const metrics = ['funnel_sessions', 'funnel_conversion_rate', 'funnel_step_rate'];
  const r = await q(ctx, scope, { metrics, period: input.period, funnel: input.funnel });
  const steps: FunnelStepRow[] = r.rows.map((row) => ({
    step: Number(row.dimensions.funnel_step),
    event: row.dimensions.funnel_event ?? '',
    meaning: meaning.get(row.dimensions.funnel_event ?? '') ?? '',
    sessions: Number(row.values.funnel_sessions ?? 0),
    conversion_from_start: row.values.funnel_conversion_rate ?? null,
    conversion_from_previous: row.values.funnel_step_rate ?? null,
  }));
  let biggest: FunnelReport['biggest_drop'] = null;
  for (let i = 1; i < steps.length; i++) {
    const rate = steps[i]!.conversion_from_previous;
    if (rate === null) continue;
    const lost = Math.round((1 - rate) * 10_000) / 10_000;
    if (!biggest || lost > biggest.lost_share) biggest = { from_event: steps[i - 1]!.event, to_event: steps[i]!.event, lost_share: lost };
  }

  const splits: FunnelReport['splits'] = [];
  if (input.by) {
    const s = await q(ctx, scope, { metrics: ['funnel_sessions', 'funnel_conversion_rate'], dimensions: ['funnel_step', input.by], period: input.period, funnel: input.funnel, limit: 2000 });
    const groups = new Map<string, FunnelReport['splits'][number]>();
    for (const row of s.rows) {
      const value = row.dimensions[input.by] ?? '(none)';
      const g = groups.get(value) ?? { value, steps: [] };
      g.steps.push({ step: Number(row.dimensions.funnel_step), event: row.dimensions.funnel_event ?? '', sessions: Number(row.values.funnel_sessions ?? 0), conversion_from_start: row.values.funnel_conversion_rate ?? null });
      groups.set(value, g);
    }
    for (const g of groups.values()) g.steps.sort((a, b) => a.step - b.step);
    splits.push(...[...groups.values()].sort((a, b) => (b.steps[0]?.sessions ?? 0) - (a.steps[0]?.sessions ?? 0) || a.value.localeCompare(b.value)).slice(0, 25));
  }

  const started = steps[0]?.sessions ?? 0;
  const last = steps[steps.length - 1];
  const summary = !steps.length
    ? `No funnel named "${input.funnel}" is declared.`
    : !started
      ? 'No visits started in this period, so there is no funnel to describe. That is unmeasured, not a failing funnel.'
      : `${started.toLocaleString('en-AU')} visits started; ${percent(last!.conversion_from_start)} reached the last declared step (${last!.event}).` +
        (biggest ? ` The biggest drop is between ${biggest.from_event} and ${biggest.to_event}: ${percent(biggest.lost_share)} of visits stop there.` : '');
  const caveats = [...r.caveats, 'A closed funnel: a visit counts at a step only if it also passed every earlier step.', 'The funnel covers only the steps modules have declared; a venue with ordering switched off has a short funnel.'];
  return { venue: venueLabel(scope), period: r.period, funnel: input.funnel, steps, biggest_drop: biggest, split_by: input.by ?? null, splits, summary, caveats: [...new Set(caveats)], as_of: ctx.now().toISOString() };
}
