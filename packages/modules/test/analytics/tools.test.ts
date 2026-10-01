import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AgentPrincipal, type StaffPrincipal, type ToolDef, getTool, listTools, localParts } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, hub, identity } from '@ros/modules';
import { type Sale, between, customers, groupBy, loadSales, sum, totals } from './oracle';

/**
 * The assistant's surface. Each tool is called the way the hub calls it: the input is parsed by
 * the tool's input shape, the handler runs as an assistant key, and the result is passed
 * through the declared output shape, which is the allowlist of what may leave.
 */
const TOOLS: Record<string, string> = {
  metrics_catalogue: 'metrics:read',
  metrics_query: 'metrics:read',
  sales_summary: 'sales:read',
  customers_summary: 'customers:read',
  menu_performance: 'sales:read',
  funnel_report: 'metrics:read',
  campaign_outcomes: 'outcomes:read',
  insights_digest: 'metrics:read',
  event_dictionary: 'metrics:read',
  saved_view_run: 'metrics:read',
};

describe('analytics: the assistant surface, saved views and export', () => {
  const t = useTestEnv();
  let sales: Sale[];
  let needles: string[];
  const org = () => t.fixture.diner;

  const agentFor = (staff: StaffPrincipal, venueIds: string[] | null = null): AgentPrincipal => ({ kind: 'agent', keyId: '00000000-0000-4000-8000-0000000000a1', staff, scopes: Object.values(TOOLS), venueIds, canWrite: false });
  /** Call a tool as the hub does and return both what the handler built and what the output shape let through. */
  async function call(name: string, args: Record<string, unknown> = {}, fixture = org(), who: 'owner' | 'manager' | 'kitchen' = 'owner') {
    const tool = getTool(name) as ToolDef & { run: (t: { ctx: never; venueId: string | null }, input: unknown) => Promise<unknown> };
    const input = tool.input.parse(args);
    const principal = agentFor(await fixture.as(who));
    const built = await t.app.tenant(fixture.orgId, principal, (ctx) => tool.run({ ctx: ctx as never, venueId: null }, input));
    const shaped = tool.output.parse(built) as Record<string, any>;
    return { built, shaped };
  }

  beforeAll(async () => {
    await analytics.rollup(t.app, org().orgId);
    sales = await loadSales(t.db, org().orgId);
    // Everything that would identify a guest: ids, emails, phones, names in full, and every
    // stored identity value (which includes the hashed card references).
    const people = await t.db.selectFrom('customers').select(['id', 'primary_email', 'primary_phone', 'first_name', 'last_name']).where('org_id', 'in', [org().orgId, t.fixture.group.orgId]).execute();
    const identities = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('org_id', 'in', [org().orgId, t.fixture.group.orgId]).execute();
    expect(identities.some((i) => i.kind === 'card_fingerprint')).toBe(true);
    needles = [
      ...people.map((p) => p.id),
      ...people.flatMap((p) => [p.primary_email, p.primary_phone].filter((v): v is string => !!v)),
      ...people.filter((p) => p.first_name && p.last_name).map((p) => `${p.first_name} ${p.last_name}`),
      ...identities.map((i) => i.value),
    ];
    expect(needles.length).toBeGreaterThan(2000);
  });

  const leaks = (value: unknown): string[] => {
    const text = JSON.stringify(value).toLowerCase();
    return needles.filter((n) => text.includes(n.toLowerCase())).slice(0, 5);
  };

  it('declares the ten read tools, each with a scope, a careful description and strict shapes', () => {
    const mine = listTools().filter((x) => x.module === 'analytics');
    expect(Object.fromEntries(mine.map((x) => [x.name, x.scope]))).toEqual(TOOLS);
    expect(analytics.analyticsTools).toHaveLength(10);
    for (const tool of mine) {
      expect(tool.effect, tool.name).toBe('read');
      expect(tool.venueScoped, tool.name).toBeFalsy();
      expect(tool.description.length, tool.name).toBeGreaterThan(150);
      expect(tool.input instanceof z.ZodObject, tool.name).toBe(true);
      expect(tool.output instanceof z.ZodObject, tool.name).toBe(true);
      // Every answer has a plain-words summary; nothing takes an org.
      const schema = z.toJSONSchema(tool.output) as { properties: Record<string, unknown>; required: string[] };
      expect(schema.required, tool.name).toContain('summary');
      const input = z.toJSONSchema(tool.input) as { properties: Record<string, unknown> };
      expect(Object.keys(input.properties).some((k) => /org/i.test(k)), tool.name).toBe(false);
    }
    // Only the outcomes tool carries the scope a creator-side plug would hold, and it is the only tool with it.
    expect(mine.filter((x) => x.scope === 'outcomes:read').map((x) => x.name)).toEqual(['campaign_outcomes']);
    // Export is deliberately not a tool.
    expect(listTools().some((x) => /export/.test(x.name))).toBe(false);
  });

  it('no tool output contains a customer id, an email, a phone number, a guest name or a card hash', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ['metrics_catalogue', {}],
      ['metrics_catalogue', { group: 'customer_base' }],
      ['metrics_query', { metrics: ['net_sales', 'orders', 'identified_share'], dimensions: ['channel', 'daypart'], compare_to: 'previous_period' }],
      ['metrics_query', { metrics: ['customers_total', 'repeat_rate', 'customer_lifetime_value', 'median_days_to_second_order'], dimensions: ['segment'], period: 'today' }],
      ['metrics_query', { metrics: ['customers_total', 'customer_spend'], dimensions: ['acquisition_source'], period: 'today' }],
      ['metrics_query', { metrics: ['active_customers', 'new_customers', 'returning_customers'], grain: 'day', period: 'last_90_days', limit: 500 }],
      ['metrics_query', { metrics: ['cohort_size', 'cohort_retention_rate'], period: 'last_365_days', limit: 500 }],
      ['metrics_query', { metrics: ['item_revenue', 'item_orders', 'item_attach_rate'], dimensions: ['item', 'category'], period: 'last_365_days', limit: 500 }],
      ['metrics_query', { metrics: ['campaign_sessions', 'campaign_new_customers', 'campaign_orders', 'campaign_revenue', 'campaign_repeat_rate'], dimensions: ['campaign', 'creator', 'channel'], period: 'last_365_days', limit: 500 }],
      ['metrics_query', { metrics: ['campaign_new_customers', 'campaign_orders'], dimensions: ['creator'], grain: 'day', period: 'last_90_days', limit: 500 }],
      ['metrics_query', { metrics: ['web_sessions'], dimensions: ['utm_source', 'landing_path', 'device_class'], period: 'last_90_days', limit: 500 }],
      ['metrics_query', { metrics: ['event_count'], dimensions: ['event_name', 'campaign'], period: 'last_90_days', limit: 500 }],
      ['metrics_query', { metrics: ['messages_sent', 'message_open_rate'], dimensions: ['template', 'message_campaign'], period: 'last_365_days', limit: 500 }],
      ['metrics_query', { metrics: ['funnel_sessions', 'funnel_conversion_rate'], dimensions: ['creator'], period: 'last_90_days' }],
      ['sales_summary', {}],
      ['customers_summary', {}],
      ['menu_performance', { limit: 100 }],
      ['menu_performance', { by: 'category', sort_by: 'attach_rate' }],
      ['funnel_report', { by: 'campaign', period: 'last_90_days' }],
      ['campaign_outcomes', {}],
      ['campaign_outcomes', { creator: 'creator_wagyu_wes', period: 'last_90_days' }],
      ['insights_digest', {}],
      ['insights_digest', { period: 'month' }],
      ['insights_digest', { period: 'day' }],
      ['event_dictionary', {}],
      ['saved_view_run', {}],
      ['saved_view_run', { name: 'Weekly sales by channel' }],
    ];
    for (const fixture of [org(), t.fixture.group]) {
      for (const [name, args] of calls) {
        const { built, shaped } = await call(name, args, fixture);
        const label = `${name} ${JSON.stringify(args)}`;
        expect(leaks(shaped), label).toEqual([]);
        expect(leaks(built), label).toEqual([]);
        // The declared shape names everything the handler returns: nothing is silently dropped.
        expect(JSON.parse(JSON.stringify(shaped)), label).toEqual(JSON.parse(JSON.stringify(built)));
        expect(typeof shaped.summary, label).toBe('string');
        expect(shaped.summary.length, label).toBeGreaterThan(20);
        // No field name suggests a person.
        expect(JSON.stringify(shaped), label).not.toMatch(/"(customer_id|guest_id|email|phone|first_name|last_name|card[a-z_]*|fingerprint)"/);
      }
    }
    // The needles are real: a guest lookup, which is a different scope, does contain one.
    const someone = await t.db.selectFrom('customers').select(['id', 'primary_email']).where('org_id', '=', org().orgId).where('primary_email', 'is not', null).limit(1).executeTakeFirstOrThrow();
    const found = await t.app.tenant(org().orgId, await org().as('owner'), (ctx) => identity.getCustomer(ctx, someone.id));
    expect(leaks(found).length).toBeGreaterThan(0);
  });

  it('metrics_catalogue tells an assistant what it can ask for', async () => {
    const { shaped } = await call('metrics_catalogue');
    const keys = shaped.groups.flatMap((g: any) => g.metrics.map((m: any) => m.key));
    expect(keys).toEqual(analytics.METRIC_KEYS);
    const salesGroup = shaped.groups.find((g: any) => g.group === 'sales');
    expect(salesGroup.dimensions).toEqual(['venue', 'channel', 'source', 'daypart', 'day_of_week', 'hour']);
    expect(salesGroup.time_grains).toEqual(['day', 'week', 'month']);
    expect(salesGroup.metrics.find((m: any) => m.key === 'net_sales')).toMatchObject({ unit: 'cents', adds_up_across_rows: true, good_direction: 'up_is_good' });
    expect(shaped.units.cents).toMatch(/whole cents/);
    expect(shaped.periods).toContain('last_28_days');
    // Brief by default; one group in full on request.
    expect(salesGroup.metrics[0].how_it_is_computed).toBeUndefined();
    const full = (await call('metrics_catalogue', { group: 'customer_base' })).shaped;
    expect(full.groups).toHaveLength(1);
    expect(full.groups[0].metrics.find((m: any) => m.key === 'repeat_rate')).toMatchObject({ how_it_is_computed: expect.stringMatching(/two or more/), caveats: [expect.stringMatching(/little time to return/)] });
    expect(full.groups[0].time_grains).toEqual([]);
    expect((await call('metrics_catalogue', { group: 'nope' })).shaped.summary).toMatch(/no group called "nope"/);
  });

  it('metrics_query returns the same numbers as the console function, compactly, with a sentence and caveats', async () => {
    const { shaped } = await call('metrics_query', { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: 'last_28_days', compare_to: 'previous_period' });
    const direct = await t.app.tenant(org().orgId, await org().as('owner'), (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: 'last_28_days', compareTo: 'previous_period', limit: 100 }));
    const want = totals(between(sales, '2026-09-02', '2026-09-29'));
    expect(shaped.totals.values).toEqual({ net_sales: want.net_sales, orders: want.orders });
    expect(shaped.rows.map((r: any) => r.values)).toEqual(direct.rows.map((r) => r.values));
    expect(shaped.rows[0].change_pct.net_sales).toBe(direct.rows[0]!.change!.net_sales!.pct);
    expect(shaped.metrics.map((m: any) => [m.key, m.unit])).toEqual([['net_sales', 'cents'], ['orders', 'count']]);
    expect(shaped.period).toMatchObject({ from: '2026-09-02', to: '2026-09-29', timezone: 'Australia/Sydney' });
    expect(shaped.compared_with).toMatchObject({ from: '2026-08-05', to: '2026-09-01' });
    expect(shaped.read_from[0]).toMatchObject({ source: 'facts', tables: ['fact_sales_daily'] });
    expect(shaped.freshness.latest_sale_at).toBe(direct.freshness.latest_sale_at);
    expect(shaped.as_of).toBe('2026-09-30T02:00:00.000Z');
    const dollars = (want.net_sales / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(shaped.summary).toMatch(new RegExp(`^Net sales: \\$${dollars.replace('.', '\\.')} for 2026-09-02 to 2026-09-29, [+-][\\d.]+% against \\$[\\d,.]+ in the 28 days immediately before \\(same weekdays\\)\\. 1 more metric is in totals\\. 2 rows by channel\\.$`));

    // A venue is chosen by name or short name among the venues the key can see, never by org.
    const group = t.fixture.group;
    const groupSales = await loadSales(t.db, group.orgId);
    const cbd = (await call('metrics_query', { metrics: ['orders'], venue: 'cbd', period: 'last_28_days' }, group)).shaped;
    expect(cbd.totals.values.orders).toBe(between(groupSales, '2026-09-02', '2026-09-29').filter((s) => s.venueId === group.venues.cbd!.id).length);
    expect(cbd.venues).toEqual({ scope: 'selected_venues', names: ['Oak Group CBD'] });
    expect((await call('metrics_query', { metrics: ['orders'], venue: 'Oak Group CBD', period: 'last_28_days' }, group)).shaped.totals).toEqual(cbd.totals);
    await expect(call('metrics_query', { metrics: ['orders'], venue: 'bondi' }, group, 'manager')).rejects.toMatchObject({ code: 'not_found' });
    await expect(call('metrics_query', { metrics: ['orders'], venue: 'main' }, group)).rejects.toMatchObject({ code: 'not_found' });
    // Arguments outside the shape are refused before anything runs.
    expect(() => getTool('metrics_query')!.input.parse({ metrics: [] })).toThrow();
    expect(() => getTool('metrics_query')!.input.parse({ metrics: ['orders'], limit: 100000 })).toThrow();
    await expect(call('metrics_query', { metrics: ['orders'], filters: { venue: t.fixture.group.venueId } })).resolves.toBeTruthy();
  });

  it('sales_summary compares "so far" with the same time of day in earlier weeks', async () => {
    const { shaped } = await call('sales_summary');
    expect(shaped.local_time).toBe('2026-09-30 12:00');
    const upTo = (s: Sale, day: string, cut: boolean) => s.day === day && (!cut || localParts(s.at, 'Australia/Sydney').time <= '12:00:00');
    const byWindow = Object.fromEntries(shaped.windows.map((w: any) => [w.window, w]));
    const today = sales.filter((s) => upTo(s, '2026-09-30', true));
    expect(byWindow.today_so_far).toMatchObject({ from: '2026-09-30', to: '2026-09-30', cut_at_local_time: '12:00', net_sales_cents: sum(today, (s) => s.net), orders: today.length, baseline_weeks: 8 });
    const usualToday = Array.from({ length: 8 }, (_, i) => sum(sales.filter((s) => upTo(s, new Date(Date.parse('2026-09-30') - (i + 1) * 7 * 86_400_000).toISOString().slice(0, 10), true)), (s) => s.net));
    expect(byWindow.today_so_far.usual_net_sales_cents).toBe(Math.round(usualToday.reduce((a, b) => a + b, 0) / 8));

    const yesterday = totals(between(sales, '2026-09-29', '2026-09-29'));
    expect(byWindow.yesterday).toMatchObject({ cut_at_local_time: null, net_sales_cents: yesterday.net_sales, gross_sales_cents: yesterday.gross_sales, orders: yesterday.orders, avg_order_value_cents: yesterday.avg_order_value });
    const lastWeek = totals(between(sales, '2026-09-21', '2026-09-27'));
    expect(byWindow.last_week).toMatchObject({ from: '2026-09-21', to: '2026-09-27', net_sales_cents: lastWeek.net_sales, orders: lastWeek.orders });
    const weeks = Array.from({ length: 8 }, (_, i) => totals(between(sales, new Date(Date.parse('2026-09-21') - (i + 1) * 7 * 86_400_000).toISOString().slice(0, 10), new Date(Date.parse('2026-09-27') - (i + 1) * 7 * 86_400_000).toISOString().slice(0, 10))).net_sales);
    expect(byWindow.last_week.usual_net_sales_cents).toBe(Math.round(weeks.reduce((a, b) => a + b, 0) / 8));
    // This week so far = Monday and Tuesday in full plus Wednesday to noon.
    const soFar = [...between(sales, '2026-09-28', '2026-09-29'), ...today];
    expect(byWindow.this_week_so_far).toMatchObject({ from: '2026-09-28', to: '2026-09-30', net_sales_cents: sum(soFar, (s) => s.net), orders: soFar.length });

    const last7 = between(sales, '2026-09-23', '2026-09-29');
    expect(shaped.last_7_days).toMatchObject({ from: '2026-09-23', to: '2026-09-29' });
    const byChannel = groupBy(last7, (s) => s.channel);
    for (const row of shaped.last_7_days.by_channel) expect([row.net_sales_cents, row.orders], row.channel).toEqual([sum(byChannel.get(row.channel)!, (s) => s.net), byChannel.get(row.channel)!.length]);
    expect(sum(shaped.last_7_days.by_daypart as any[], (r) => r.net_sales_cents)).toBe(sum(last7, (s) => s.net));
    expect(shaped.summary).toMatch(/^Today to 12:00: \$[\d,]+ net from \d+ orders?/);
    expect(shaped.caveats.join(' ')).toMatch(/like for like/);

    // Later in the day the cut moves, and with it both the figure and its baseline.
    t.clock.set('2026-09-30T11:30:00Z');
    const evening = (await call('sales_summary')).shaped;
    expect(evening.windows[0].cut_at_local_time).toBe('21:30');
    expect(evening.windows[0].usual_net_sales_cents).toBeGreaterThan(byWindow.today_so_far.usual_net_sales_cents);
    t.clock.set('2026-09-30T02:00:00Z');
  });

  it('customers_summary is aggregates only and equals the ledger', async () => {
    const { shaped } = await call('customers_summary');
    const base = customers(sales, '2026-09-30');
    expect(shaped.known_customers).toBe(base.length);
    expect(shaped.as_of_day).toBe('2026-09-30');
    expect(shaped.repeat_rate).toBe(Math.round((base.filter((c) => c.orders >= 2).length / base.length) * 10_000) / 10_000);
    expect(shaped.avg_lifetime_spend_cents).toBe(Math.round(sum(base, (c) => c.spend) / base.length));
    expect(shaped.segments.map((s: any) => s.segment)).toEqual(['new', 'one_timer', 'repeater', 'frequent', 'loyal', 'at_risk', 'lapsed']);
    const bySeg = groupBy(base, (c) => c.segment);
    for (const s of shaped.segments) expect(s.customers, s.segment).toBe(bySeg.get(s.segment)?.length ?? 0);
    expect(sum(shaped.segments as any[], (s) => s.customers)).toBe(base.length);
    const inPeriod = between(sales, '2026-09-02', '2026-09-29').filter((s) => s.customerId);
    expect(shaped.last_28_days).toMatchObject({ active_customers: new Set(inPeriod.map((s) => s.customerId)).size, new_customers: new Set(inPeriod.filter((s) => s.rank === 1).map((s) => s.customerId)).size });
    expect(sum(shaped.by_acquisition_source as any[], (s) => s.customers)).toBe(base.length);
    expect(shaped.summary).toMatch(new RegExp(`^${base.length} known customers\\. [\\d.]+% of orders in the last 28 days were tied to one`));
    expect(shaped.caveats[0]).toMatch(/of all sales to date are tied to a known customer/);
    expect(shaped.caveats.join(' ')).toMatch(/never lists or describes an individual guest/);
    // Every leaf is a number, a short label or a sentence we wrote: there is no list of people to be found.
    expect(Object.keys(shaped).sort()).toEqual(['as_of', 'as_of_day', 'avg_lifetime_spend_cents', 'avg_orders_per_customer', 'by_acquisition_source', 'caveats', 'currency', 'identified_share_of_orders_last_28_days', 'known_customers', 'last_28_days', 'median_days_to_second_order', 'one_timer_share', 'repeat_rate', 'segments', 'summary', 'venue']);
  });

  it('menu_performance and funnel_report equal the ledger and the event stream', async () => {
    const { shaped: menu } = await call('menu_performance', { limit: 5 });
    const inPeriod = between(sales, '2026-09-02', '2026-09-29');
    const lines = inPeriod.flatMap((s) => s.lines.map((l) => ({ ...l, saleId: s.id })));
    const byItem = [...groupBy(lines, (l) => l.name)].map(([name, list]) => ({ name, revenue: sum(list, (l) => l.total), qty: sum(list, (l) => l.qty), orders: new Set(list.map((l) => l.saleId)).size })).sort((a, b) => b.revenue - a.revenue);
    expect(menu.rows).toHaveLength(5);
    expect(menu.rows.map((r: any) => [r.name, r.revenue_cents, r.quantity, r.orders_containing])).toEqual(byItem.slice(0, 5).map((i) => [i.name, i.revenue, i.qty, i.orders]));
    expect(menu.total_lines).toBe(byItem.length);
    expect(menu.totals).toEqual({ quantity: sum(lines, (l) => l.qty), revenue_cents: sum(lines, (l) => l.total) });
    expect(menu.compared_with).toMatchObject({ from: '2026-08-05', to: '2026-09-01' });
    const prevTop = sum(between(sales, '2026-08-05', '2026-09-01').flatMap((s) => s.lines).filter((l) => l.name === byItem[0]!.name), (l) => l.total);
    expect(menu.rows[0].previous_revenue_cents).toBe(prevTop);
    expect(menu.summary).toContain(byItem[0]!.name);
    expect(menu.caveats.join(' ')).toMatch(/does not sum to net sales/);

    const { shaped: funnel } = await call('funnel_report', { by: 'utm_source' });
    expect(funnel.funnel).toBe('order');
    expect(funnel.steps[0]).toMatchObject({ step: 1, event: 'session.started', conversion_from_start: 1, conversion_from_previous: null });
    expect(funnel.steps[1].event).toBe('menu.viewed');
    expect(funnel.steps[1].meaning.length).toBeGreaterThan(10);
    for (let i = 1; i < funnel.steps.length; i++) expect(funnel.steps[i].sessions).toBeLessThanOrEqual(funnel.steps[i - 1].sessions);
    expect(funnel.biggest_drop).not.toBeNull();
    expect(sum(funnel.splits as any[], (s) => s.steps[0].sessions)).toBe(funnel.steps[0].sessions);
    expect(funnel.split_by).toBe('utm_source');
    expect((await call('funnel_report', { funnel: 'nope' })).shaped.summary).toBe('No funnel named "nope" is declared.');
  });

  it('campaign_outcomes returns only the floored, banded totals; insights_digest and event_dictionary explain themselves', async () => {
    const { shaped } = await call('campaign_outcomes');
    const direct = await t.app.tenant(org().orgId, await org().as('owner'), (ctx) => analytics.campaignOutcomes(ctx, {}));
    expect(shaped.outcomes).toEqual(direct.outcomes);
    expect(shaped.summary).toMatch(/^\d+ of \d+ campaign and creator combinations can be reported/);
    expect(shaped.summary).toMatch(/aligned with/);
    for (const o of shaped.outcomes) expect(Object.keys(o).sort()).toEqual(['campaign_id', 'creator_id', 'first_activity_on', 'new_customers', 'orders', 'repeat_rate', 'revenue_band', 'sessions', 'status', 'status_note', 'summary']);
    // A key holding only outcomes:read is still staff-backed and sees only its venues' totals.
    const limited: AgentPrincipal = { kind: 'agent', keyId: '00000000-0000-4000-8000-0000000000a2', staff: await t.fixture.group.as('owner'), scopes: ['outcomes:read'], venueIds: [t.fixture.group.venues.newtown!.id], canWrite: false };
    const tool = getTool('campaign_outcomes') as any;
    const narrow = tool.output.parse(await t.app.tenant(t.fixture.group.orgId, limited, (ctx) => tool.run({ ctx, venueId: null }, tool.input.parse({}))));
    expect(narrow.venues_covered).toBe(1);

    const digest = (await call('insights_digest')).shaped;
    expect(digest.period).toEqual({ kind: 'week', from: '2026-09-21', to: '2026-09-27', complete: true });
    expect(digest.headline[0]).toMatchObject({ metric: 'net_sales', unit: 'cents', value: totals(between(sales, '2026-09-21', '2026-09-27')).net_sales });
    expect(digest.baseline.method).toMatch(/same weekdays/);
    const stored = await t.db.selectFrom('insight_digests').select(['summary']).where('org_id', '=', org().orgId).where('period', '=', 'week').where('period_start', '=', '2026-09-21').where('venue_id', 'is', null).executeTakeFirstOrThrow();
    expect(stored.summary).toBe(digest.summary);

    const dict = (await call('event_dictionary')).shaped;
    const recorded = dict.events.find((e: any) => e.name === 'transaction.recorded');
    expect(recorded).toMatchObject({ module: 'ledger', sent_by: 'server', funnel: null });
    expect(recorded.properties).toEqual(expect.arrayContaining([{ name: 'total_cents', type: 'integer', required: true }, { name: 'identified', type: 'boolean', required: true, description: 'Whether the sale is tied to a known customer' }]));
    expect(dict.events.find((e: any) => e.name === 'menu.viewed')).toMatchObject({ sent_by: 'browser', funnel: { name: 'order', step: 2 } });
    expect(dict.funnels.find((f: any) => f.name === 'order').steps.slice(0, 2)).toEqual([{ step: 1, event: 'session.started' }, { step: 2, event: 'menu.viewed' }]);
    const onlyLedger = (await call('event_dictionary', { module: 'ledger' })).shaped;
    expect(onlyLedger.events.map((e: any) => e.name)).toEqual(expect.arrayContaining(['transaction.recorded', 'transaction.refunded']));
    expect(onlyLedger.events.every((e: any) => e.module === 'ledger')).toBe(true);
  });

  it('through the hub: a key holding only outcomes:read is offered the outcomes tool and nothing else of ours', async () => {
    const group = t.fixture.group;
    const owner = await group.as('owner');
    const issue = async (scopes: string[], venueIds?: string[]) => {
      const made = await t.app.tenant(group.orgId, owner, (ctx) => hub.createAgentKey(ctx, { name: `analytics ${scopes.join(' ')}`, scopes, expiresInDays: 7, ...(venueIds ? { venueIds } : {}) }));
      return (await hub.resolveAgentKey(t.app, made.key))!;
    };
    const mine = (caller: hub.ResolvedAgentKey) => hub.offeredTools(caller, { canAsk: false }).filter((o) => o.tool.module === 'analytics');

    const plug = await issue(['outcomes:read'], [group.venues.cbd!.id]);
    expect(mine(plug).map((o) => o.tool.name)).toEqual(['campaign_outcomes']);
    const answer = await hub.runTool(t.app, plug, mine(plug)[0]!, {});
    expect(answer.ok).toBe(true);
    const output = (answer as { ok: true; output: Record<string, any> }).output;
    expect(output.venues_covered).toBe(1);
    expect(Object.keys(output).sort()).toEqual(['as_of', 'caveats', 'currency', 'min_cohort', 'outcomes', 'period', 'quiet_days', 'summary', 'venue', 'venues_covered', 'wording']);
    expect(leaks(output)).toEqual([]);
    // Read back: the call is on the record, with no arguments and no results.
    const logged = await t.db.selectFrom('agent_calls').select(['tool', 'effect', 'outcome']).where('key_id', '=', plug.keyId).execute();
    expect(logged).toEqual([{ tool: 'campaign_outcomes', effect: 'read', outcome: 'answered' }]);

    const analyst = await issue(['metrics:read', 'sales:read']);
    expect(mine(analyst).map((o) => o.tool.name).sort()).toEqual(['event_dictionary', 'funnel_report', 'insights_digest', 'menu_performance', 'metrics_catalogue', 'metrics_query', 'sales_summary', 'saved_view_run']);
    const query = mine(analyst).find((o) => o.tool.name === 'metrics_query')!;
    const ok = await hub.runTool(t.app, analyst, query, { metrics: ['orders'], venue: 'newtown', period: 'last_28_days' });
    expect(ok).toMatchObject({ ok: true, output: { venues: { names: ['Oak Group Newtown'] } } });
    // What the function refuses, the person is told in its own words.
    const bad = await hub.runTool(t.app, analyst, query, { metrics: ['profit'] });
    expect(bad).toEqual({ ok: false, message: '"profit" is not a metric. Ask for the metric catalogue to see what can be measured.' });
  });

  it('saved views: save a query under a name, run it again, pin it; it always runs as the caller', async () => {
    const group = t.fixture.group;
    const as = async <T>(who: 'owner' | 'manager' | 'host' | 'accounts', fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(group.orgId, await group.as(who), fn);
    const query: analytics.MetricQuery = { metrics: ['net_sales', 'orders'], dimensions: ['venue'], period: 'last_7_days', compareTo: 'previous_period' };
    const saved = await as('manager', (ctx) => analytics.saveView(ctx, { name: 'Venues, last 7 days', description: 'Net sales by venue.', query }));
    expect(saved).toMatchObject({ name: 'Venues, last 7 days', pinned: false, query });
    const row = await t.db.selectFrom('saved_views').selectAll().where('id', '=', saved.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: group.orgId, name: 'Venues, last 7 days', is_pinned: false, created_by_kind: 'staff', query });
    expect(await t.db.selectFrom('audit_log').select(['action']).where('entity_id', '=', saved.id).execute()).toEqual([{ action: 'analytics.view_saved' }]);

    // Running it asks the question afresh, as whoever runs it.
    const mine = await as('manager', (ctx) => analytics.runView(ctx, { name: 'Venues, last 7 days' }));
    expect(mine.result.rows.map((r) => r.dimensions.venue).sort()).toEqual(['Oak Group CBD', 'Oak Group Newtown']);
    const theirs = await as('accounts', (ctx) => analytics.runView(ctx, { id: saved.id }));
    expect(theirs.result.rows.map((r) => r.dimensions.venue).sort()).toEqual(['Oak Group Bondi', 'Oak Group CBD', 'Oak Group Newtown']);
    expect(theirs.result.period).toMatchObject({ from: '2026-09-23', to: '2026-09-29' });
    t.clock.advanceDays(1);
    expect((await as('accounts', (ctx) => analytics.runView(ctx, { id: saved.id }))).result.period).toMatchObject({ from: '2026-09-24', to: '2026-09-30' });
    t.clock.set('2026-09-30T02:00:00Z');

    // A view naming a venue the caller cannot see is not found for them.
    await as('owner', (ctx) => analytics.saveView(ctx, { name: 'Bondi only', query: { metrics: ['orders'], filters: { venue: group.venues.bondi!.id }, period: 'last_28_days' } }));
    await expect(as('manager', (ctx) => analytics.runView(ctx, { name: 'Bondi only' }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await as('accounts', (ctx) => analytics.runView(ctx, { name: 'Bondi only' }))).result.venues.names).toEqual(['Oak Group Bondi']);
    // Nor can the manager save a view of a venue they cannot see, or an unanswerable one.
    await expect(as('manager', (ctx) => analytics.saveView(ctx, { name: 'Sneaky', query: { metrics: ['orders'], filters: { venue: group.venues.bondi!.id } } }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as('manager', (ctx) => analytics.saveView(ctx, { name: 'Broken', query: { metrics: ['nope'] } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(as('manager', (ctx) => analytics.saveView(ctx, { name: '', query }))).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.db.selectFrom('saved_views').select('name').where('org_id', '=', group.orgId).where('name', 'in', ['Sneaky', 'Broken']).execute()).toEqual([]);

    // Pin, replace, list, delete: manager and above; read-only staff may list and run.
    await expect(as('accounts', (ctx) => analytics.saveView(ctx, { name: 'Mine', query }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(as('host', (ctx) => analytics.pinView(ctx, { id: saved.id, pinned: true }))).rejects.toMatchObject({ code: 'forbidden' });
    const pinned = await as('manager', (ctx) => analytics.pinView(ctx, { id: saved.id, pinned: true }));
    expect(pinned.pinned).toBe(true);
    expect((await t.db.selectFrom('saved_views').select('is_pinned').where('id', '=', saved.id).executeTakeFirstOrThrow()).is_pinned).toBe(true);
    const replaced = await as('manager', (ctx) => analytics.saveView(ctx, { name: 'Venues, last 7 days', query: { ...query, period: 'last_14_days' } }));
    expect(replaced.id).toBe(saved.id);
    expect(replaced.pinned).toBe(true);
    expect((await as('host', (ctx) => analytics.listViews(ctx))).map((v) => [v.name, v.pinned])).toEqual([
      ['Venues, last 7 days', true],
      ['Weekly sales by channel', true],
      ['Bondi only', false],
      ['Top items this month', false],
    ]);
    expect((await as('host', (ctx) => analytics.listViews(ctx, { pinnedOnly: true }))).length).toBe(2);
    await expect(as('manager', (ctx) => analytics.runView(ctx, { name: 'No such view' }))).rejects.toMatchObject({ code: 'not_found' });
    // Another org's view id is not found here.
    const dinerView = await t.db.selectFrom('saved_views').select('id').where('org_id', '=', org().orgId).limit(1).executeTakeFirstOrThrow();
    await expect(as('owner', (ctx) => analytics.runView(ctx, { id: dinerView.id }))).rejects.toMatchObject({ code: 'not_found' });
    await as('manager', (ctx) => analytics.deleteView(ctx, { id: saved.id }));
    expect(await t.db.selectFrom('saved_views').select('id').where('id', '=', saved.id).execute()).toEqual([]);
    expect((await t.db.selectFrom('audit_log').select(['action']).where('entity_id', '=', saved.id).orderBy('occurred_at').execute()).map((a) => a.action).sort()).toEqual(['analytics.view_deleted', 'analytics.view_pinned', 'analytics.view_saved', 'analytics.view_updated']);

    // Through the tool: list, then run by name.
    const listed = (await call('saved_view_run', {}, group)).shaped;
    expect(listed.result).toBeNull();
    expect(listed.available_views.map((v: any) => v.name)).toEqual(['Weekly sales by channel', 'Bondi only', 'Top items this month']);
    const ran = (await call('saved_view_run', { name: 'Weekly sales by channel' }, group)).shaped;
    const direct = await as('owner', (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['channel'], period: 'last_28_days', compareTo: 'previous_period' }));
    expect(ran.view).toEqual({ name: 'Weekly sales by channel', description: expect.any(String), pinned: true });
    expect(ran.result.totals.values).toEqual(direct.totals.values);
    expect(ran.summary.startsWith('Weekly sales by channel: Net sales: $')).toBe(true);
  });

  it('export is for the owner, from the console: CSV or NDJSON of the same aggregates, audited', async () => {
    const owner = await org().as('owner');
    const query: analytics.MetricQuery = { metrics: ['net_sales', 'orders'], dimensions: ['channel'], grain: 'week', period: 'last_28_days', compareTo: 'previous_period' };
    const direct = await t.app.tenant(org().orgId, owner, (ctx) => analytics.queryMetrics(ctx, query));
    const csv = await t.app.tenant(org().orgId, owner, (ctx) => analytics.exportMetrics(ctx, { query, format: 'csv' }));
    expect(csv).toMatchObject({ filename: 'metrics_2026-09-02_2026-09-29.csv', contentType: 'text/csv; charset=utf-8', rows: direct.rows.length });
    const lines = csv.body.trimEnd().split('\n');
    expect(lines[0]).toBe('period_start,channel,net_sales,net_sales__compare,net_sales__change_pct,orders,orders__compare,orders__change_pct');
    expect(lines).toHaveLength(direct.rows.length + 1);
    const first = direct.rows[0]!;
    expect(lines[1]).toBe([first.period_start, first.dimensions.channel, first.values.net_sales, first.compare!.net_sales, first.change!.net_sales!.pct ?? '', first.values.orders, first.compare!.orders, first.change!.orders!.pct ?? ''].join(','));
    expect(leaks(csv.body)).toEqual([]);

    const nd = await t.app.tenant(org().orgId, owner, (ctx) => analytics.exportMetrics(ctx, { query, format: 'ndjson' }));
    const objects = nd.body.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(objects[0]).toMatchObject({ type: 'meta', currency: 'AUD', period: { from: '2026-09-02', to: '2026-09-29' }, totals: JSON.parse(JSON.stringify(direct.totals)) });
    expect(objects.slice(1).map(({ type, ...row }) => (expect(type).toBe('row'), row))).toEqual(JSON.parse(JSON.stringify(direct.rows)));
    expect(nd.contentType).toBe('application/x-ndjson');

    // Text that a spreadsheet would run as a formula is quoted as text.
    await t.app.tenant(org().orgId, { kind: 'worker', job: 'test' }, (ctx) =>
      ctx.db.insertInto('visitor_sessions').values({ id: '00000000-0000-4000-8000-00000000f00d', org_id: org().orgId, venue_id: org().venueId, first_seen_at: new Date('2026-09-20T02:00:00Z'), last_seen_at: new Date('2026-09-20T02:00:00Z'), utm_source: '=HYPERLINK("http://evil.example","x")' }).execute(),
    );
    const risky = await t.app.tenant(org().orgId, owner, (ctx) => analytics.exportMetrics(ctx, { query: { metrics: ['web_sessions'], dimensions: ['utm_source'], period: { from: '2026-09-20', to: '2026-09-20' } } }));
    expect(risky.body).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    expect(risky.body).not.toMatch(/^=HYPERLINK/m);

    // Read back the audit trail: who exported what, never the numbers.
    const audit = await t.db.selectFrom('audit_log').select(['actor_kind', 'after']).where('org_id', '=', org().orgId).where('action', '=', 'analytics.exported').orderBy('occurred_at').execute();
    expect(audit).toHaveLength(3);
    expect(audit[0]).toMatchObject({ actor_kind: 'staff', after: { metrics: ['net_sales', 'orders'], format: 'csv', rows: direct.rows.length } });

    // Not for a manager, not for an assistant (even the owner's), not for a guest.
    await expect(t.app.tenant(org().orgId, await org().as('manager'), (ctx) => analytics.exportMetrics(ctx, { query }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(org().orgId, agentFor(owner), (ctx) => analytics.exportMetrics(ctx, { query }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(org().orgId, { kind: 'anon' }, (ctx) => analytics.exportMetrics(ctx, { query }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(t.app.tenant(org().orgId, owner, (ctx) => analytics.exportMetrics(ctx, { query, format: 'xlsx' } as never))).rejects.toMatchObject({ code: 'invalid' });
    expect((await t.db.selectFrom('audit_log').select('id').where('org_id', '=', org().orgId).where('action', '=', 'analytics.exported').execute()).length).toBe(3);

    // The data dictionary: every metric and every event, as data.
    const dict = await t.app.tenant(org().orgId, owner, (ctx) => analytics.dataDictionary(ctx));
    expect(dict.metrics.map((m) => m.key)).toEqual(analytics.METRIC_KEYS);
    expect(dict.events.map((e) => e.name)).toEqual(expect.arrayContaining(['transaction.recorded', 'session.started', 'message.sent', 'customer.created']));
    expect(dict.segments.thresholds).toEqual({ newWindowDays: 30, atRiskDays: 60, lapsedDays: 120, frequentOrders: 5, loyalOrders: 10 });
    expect(dict.privacy).toEqual({ min_cohort: 5, campaign_quiet_days: 7 });
    expect(dict.dayparts!.map((d) => d.key)).toEqual(['breakfast', 'lunch', 'afternoon', 'dinner', 'late']);
    expect((await analytics.dataDictionary()).privacy).toBeNull();
  });
});
