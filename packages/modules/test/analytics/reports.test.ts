import { describe, expect, it } from 'vitest';
import { type AgentPrincipal, type StaffPrincipal, type ToolDef, getTool } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics } from '@ros/modules';

/**
 * Reports (pattern 9): every default report runs on both fixture organisations and is exactly
 * queryMetrics for its question; compare-to and export give the same rows; a saved report belongs
 * to one organisation; targets and annotations are read back; the two tools are pinned to the
 * same functions. Every write is read back from the database.
 */
describe('analytics: reports, targets and annotations', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const as = async (org = diner(), who: 'owner' | 'manager' | 'kitchen' | 'host' = 'manager') => ({ orgId: org.orgId, p: await org.as(who) });
  const run = <T>(org: { orgId: string; p: StaffPrincipal }, fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org.orgId, org.p, fn);

  it('the catalogue lists every default report under its category, created by Pipedline, and every one runs on both orgs as queryMetrics would', async () => {
    for (const org of [diner(), group()]) {
      const who = await as(org, 'manager');
      const list = await run(who, (ctx) => analytics.listReports(ctx));
      expect(list.filter((r) => r.createdBy === 'Pipedline').map((r) => r.key).sort()).toEqual(analytics.DEFAULT_REPORTS.map((r) => r.key).sort());
      // Six of the seven categories have reports; bookings has none yet (its measures are not in the catalogue).
      const cats = new Set(list.map((r) => r.category));
      for (const c of ['sales', 'guests', 'menu', 'delivery', 'marketing', 'team']) expect(cats.has(c as analytics.ReportCategory), c).toBe(true);
      expect(cats.has('bookings')).toBe(false);
      for (const def of analytics.DEFAULT_REPORTS) {
        const out = await run(who, (ctx) => analytics.runReport(ctx, { report: def.key, period: 'last_28_days' }));
        expect(out.report.key).toBe(def.key);
        expect(out.result.metrics.map((m) => m.key)).toEqual([...new Set(def.query.metrics)]);
        // The same question, asked of queryMetrics directly, gives the same answer.
        const grain = def.query.grain === 'auto' ? 'day' : def.query.grain;
        const { grain: _g, ...rest } = def.query;
        const direct = await run(who, (ctx) => analytics.queryMetrics(ctx, { ...rest, period: 'last_28_days', ...(grain ? { grain } : {}) }));
        expect(out.result.totals.values, def.key).toEqual(direct.totals.values);
        expect(out.result.rows.map((r) => [r.period_start, r.dimensions, r.values]), def.key).toEqual(direct.rows.map((r) => [r.period_start, r.dimensions, r.values]));
        expect(out.result.period.days).toBe(28);
      }
    }
  });

  it('compare-to adds the comparison period and the change, like for like, and a long period picks a coarser grain', async () => {
    const who = await as();
    const out = await run(who, (ctx) => analytics.runReport(ctx, { report: 'sales.over_time', period: 'last_28_days', compareTo: 'previous_period' }));
    expect(out.result.compare).toMatchObject({ kind: 'previous_period', days: 28 });
    expect(out.result.grain).toBe('day');
    expect(out.result.rows.length).toBe(28);
    for (const r of out.result.rows) {
      expect(r.compare).toBeDefined();
      expect(r.change).toBeDefined();
    }
    const direct = await run(who, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], period: 'last_28_days', compareTo: 'previous_period', grain: 'day' }));
    expect(out.result.totals).toEqual(direct.totals);
    const yearly = await run(who, (ctx) => analytics.runReport(ctx, { report: 'sales.over_time', period: 'last_365_days', compareTo: 'same_period_last_year' }));
    expect(yearly.result.grain).toBe('month');
    expect(yearly.result.compare?.kind).toBe('same_period_last_year');
    // Cohorts are monthly and never compared: the report says so in its caveats rather than failing.
    const cohorts = await run(who, (ctx) => analytics.runReport(ctx, { report: 'guests.cohorts', period: 'last_365_days', compareTo: 'previous_period' }));
    expect(cohorts.result.grain).toBe('month');
    expect(cohorts.result.compare).toBeNull();
    expect(cohorts.result.dimensions).toEqual(['cohort', 'periods_since']);
  });

  it('export gives the report\'s rows as CSV, owner only, and is audited', async () => {
    const owner = await as(diner(), 'owner');
    const ran = await run(owner, (ctx) => analytics.runReport(ctx, { report: 'sales.by_channel', period: 'last_28_days', compareTo: 'previous_period' }));
    const out = await run(owner, (ctx) => analytics.exportReport(ctx, { report: 'sales.by_channel', period: 'last_28_days', compareTo: 'previous_period', format: 'csv' }));
    const lines = out.body.trim().split('\n');
    expect(lines[0]).toBe('period_start,channel,net_sales,net_sales__compare,net_sales__change_pct,orders,orders__compare,orders__change_pct,avg_order_value,avg_order_value__compare,avg_order_value__change_pct');
    expect(out.rows).toBe(ran.result.rows.length);
    expect(lines.length).toBe(ran.result.rows.length + 1);
    for (const r of ran.result.rows) expect(lines.some((l) => l.startsWith(`,${r.dimensions.channel},${r.values.net_sales},`))).toBe(true);
    expect(out.filename).toMatch(/^sales\.by_channel_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
    const audited = await t.db.selectFrom('audit_log').select('action').where('org_id', '=', diner().orgId).where('action', '=', 'analytics.exported').execute();
    expect(audited.length).toBeGreaterThan(0);
    const manager = await as(diner(), 'manager');
    await expect(run(manager, (ctx) => analytics.exportReport(ctx, { report: 'sales.by_channel', period: 'last_7_days' }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a saved report belongs to one org: listed and runnable there, not found next door; a manager saves, a host cannot; delete removes the row', async () => {
    const manager = await as(diner(), 'manager');
    const saved = await run(manager, (ctx) => analytics.saveReport(ctx, { name: 'Friday dinners', description: 'Dinner net sales on Fridays.', category: 'sales', chart: 'line', query: { metrics: ['net_sales', 'orders'], filters: { day_of_week: 'friday', daypart: 'dinner' }, grain: 'auto' } }));
    expect(saved.key).toBe(`saved:${saved.id}`);
    expect(saved.createdBy).toBe('Morgan Manager');
    const row = await t.db.selectFrom('report_definitions').selectAll().where('id', '=', saved.id!).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner().orgId, name: 'Friday dinners', category: 'sales', chart: 'line', created_by_id: diner().staff.manager!.staffId });
    expect(row.query).toEqual({ metrics: ['net_sales', 'orders'], filters: { day_of_week: 'friday', daypart: 'dinner' }, grain: 'auto' });

    const listed = await run(manager, (ctx) => analytics.listReports(ctx, { category: 'sales' }));
    expect(listed.find((r) => r.id === saved.id)?.createdBy).toBe('Morgan Manager');
    const out = await run(manager, (ctx) => analytics.runReport(ctx, { report: saved.key, period: 'last_90_days' }));
    expect(out.report.name).toBe('Friday dinners');
    expect(out.result.grain).toBe('week');
    const direct = await run(manager, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], filters: { day_of_week: 'friday', daypart: 'dinner' }, period: 'last_90_days', grain: 'week' }));
    expect(out.result.totals.values).toEqual(direct.totals.values);
    // By name too.
    expect((await run(manager, (ctx) => analytics.getReport(ctx, 'friday dinners'))).id).toBe(saved.id);

    // Next door: nothing.
    const groupManager = await as(group(), 'manager');
    expect((await run(groupManager, (ctx) => analytics.listReports(ctx))).some((r) => r.id === saved.id)).toBe(false);
    await expect(run(groupManager, (ctx) => analytics.runReport(ctx, { report: saved.key }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(groupManager, (ctx) => analytics.deleteReport(ctx, saved.id!))).rejects.toMatchObject({ code: 'not_found' });

    // Roles: a host reads, cannot save or delete; a bad metric is refused in words.
    const host = await as(diner(), 'host');
    expect((await run(host, (ctx) => analytics.listReports(ctx))).length).toBeGreaterThan(0);
    await expect(run(host, (ctx) => analytics.saveReport(ctx, { name: 'x', category: 'sales', query: { metrics: ['net_sales'] } }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(manager, (ctx) => analytics.saveReport(ctx, { name: 'Bad', category: 'sales', query: { metrics: ['nope'] } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run(manager, (ctx) => analytics.saveReport(ctx, { name: 'Friday dinners', category: 'sales', query: { metrics: ['net_sales'] } }))).rejects.toMatchObject({ code: 'conflict' });

    await run(manager, (ctx) => analytics.deleteReport(ctx, saved.id!));
    expect(await t.db.selectFrom('report_definitions').select('id').where('id', '=', saved.id!).executeTakeFirst()).toBeUndefined();
    const audited = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', saved.id!).orderBy('occurred_at').execute();
    expect(audited.map((a) => a.action)).toEqual(['analytics.report_saved', 'analytics.report_deleted']);
  });

  it('a target is a number per metric per month; progress is the catalogue\'s own value for the month so far', async () => {
    const manager = await as(diner(), 'manager');
    const month = '2026-09';
    const target = await run(manager, (ctx) => analytics.setTarget(ctx, { metric: 'net_sales', month, target: 10_000_00 }));
    expect(target).toMatchObject({ metric: 'net_sales', month, target: 1_000_000, venueId: null });
    const row = await t.db.selectFrom('report_targets').selectAll().where('id', '=', target.id).executeTakeFirstOrThrow();
    expect(row.org_id).toBe(diner().orgId);
    expect(String(row.month).slice(0, 10)).toBe('2026-09-01');
    // Setting again replaces, never duplicates.
    const again = await run(manager, (ctx) => analytics.setTarget(ctx, { metric: 'net_sales', month, target: 2_000_000 }));
    expect(again.id).toBe(target.id);
    expect((await t.db.selectFrom('report_targets').select('id').where('org_id', '=', diner().orgId).where('metric', '=', 'net_sales').execute()).length).toBe(1);

    const progress = await run(manager, (ctx) => analytics.targetProgress(ctx, { metric: 'net_sales', month }));
    const direct = await run(manager, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales'], period: { from: '2026-09-01', to: '2026-09-30' } }));
    expect(progress.target).toBe(2_000_000);
    expect(progress.actual).toBe(direct.totals.values.net_sales);
    expect(progress.daysInMonth).toBe(30);
    expect(progress.daysElapsed).toBe(30);
    expect(progress.expectedSoFar).toBe(2_000_000);
    expect(progress.progress).toBe(Math.round((direct.totals.values.net_sales! / 2_000_000) * 10_000) / 10_000);
    expect(progress.onTrack).toBe(direct.totals.values.net_sales! >= 2_000_000);
    // A month with no target still reports the actual, with no verdict.
    const none = await run(manager, (ctx) => analytics.targetProgress(ctx, { metric: 'orders', month }));
    expect(none.target).toBeNull();
    expect(none.onTrack).toBeNull();
    expect(none.actual).toBe(direct.totals.values.orders ?? (await run(manager, (ctx) => analytics.queryMetrics(ctx, { metrics: ['orders'], period: { from: '2026-09-01', to: '2026-09-30' } }))).totals.values.orders);
    // A metric that counts people cannot have a monthly target; a host cannot set one; another org does not see it.
    await expect(run(manager, (ctx) => analytics.setTarget(ctx, { metric: 'active_customers', month, target: 10 }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run(await as(diner(), 'host'), (ctx) => analytics.setTarget(ctx, { metric: 'orders', month, target: 10 }))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await run(await as(group(), 'manager'), (ctx) => analytics.listTargets(ctx))).some((x) => x.id === target.id)).toBe(false);
    expect((await run(manager, (ctx) => analytics.listTargets(ctx))).map((x) => x.id)).toContain(target.id);
    await run(manager, (ctx) => analytics.deleteTarget(ctx, target.id));
    expect(await t.db.selectFrom('report_targets').select('id').where('id', '=', target.id).executeTakeFirst()).toBeUndefined();
  });

  it('annotations mark dates and come back with the report whose period covers them, for the venue or the whole org', async () => {
    const manager = await as(diner(), 'manager');
    const a = await run(manager, (ctx) => analytics.addAnnotation(ctx, { date: '2026-09-15', label: 'Menu change' }));
    const b = await run(manager, (ctx) => analytics.addAnnotation(ctx, { date: '2026-09-20', label: 'Public holiday', venueId: diner().venueId }));
    expect(a).toMatchObject({ date: '2026-09-15', label: 'Menu change', venueId: null, createdBy: 'Morgan Manager' });
    const rows = await t.db.selectFrom('report_annotations').selectAll().where('org_id', '=', diner().orgId).orderBy('on_date').execute();
    expect(rows.map((r) => [String(r.on_date).slice(0, 10), r.label, r.venue_id])).toEqual([['2026-09-15', 'Menu change', null], ['2026-09-20', 'Public holiday', diner().venueId]]);
    const out = await run(manager, (ctx) => analytics.runReport(ctx, { report: 'sales.over_time', period: { from: '2026-09-10', to: '2026-09-25' } }));
    expect(out.annotations.map((x) => x.label)).toEqual(['Menu change', 'Public holiday']);
    const outside = await run(manager, (ctx) => analytics.runReport(ctx, { report: 'sales.over_time', period: { from: '2026-09-21', to: '2026-09-25' } }));
    expect(outside.annotations).toEqual([]);
    // Not next door; a host cannot add; a date that does not exist is refused.
    expect((await run(await as(group(), 'manager'), (ctx) => analytics.listAnnotations(ctx, { from: '2026-09-01', to: '2026-09-30' }))).some((x) => x.id === a.id)).toBe(false);
    await expect(run(await as(diner(), 'host'), (ctx) => analytics.addAnnotation(ctx, { date: '2026-09-15', label: 'x' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(manager, (ctx) => analytics.addAnnotation(ctx, { date: '2026-02-30', label: 'x' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run(await as(group(), 'manager'), (ctx) => analytics.deleteAnnotation(ctx, b.id))).rejects.toMatchObject({ code: 'not_found' });
    await run(manager, (ctx) => analytics.deleteAnnotation(ctx, b.id));
    expect(await t.db.selectFrom('report_annotations').select('id').where('id', '=', b.id).executeTakeFirst()).toBeUndefined();
  });

  it('a venue the person has no role at is not found, by report and by target', async () => {
    const manager = await as(group(), 'manager');
    const bondi = group().venues.bondi!.id;
    await expect(run(manager, (ctx) => analytics.runReport(ctx, { report: 'sales.over_time', venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(manager, (ctx) => analytics.targetProgress(ctx, { metric: 'net_sales', venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(manager, (ctx) => analytics.setTarget(ctx, { metric: 'net_sales', month: '2026-09', target: 1, venueId: bondi }))).rejects.toMatchObject({ code: 'not_found' });
    // Their own venue works and the report is scoped to it.
    const cbd = group().venues.cbd!.id;
    const out = await run(manager, (ctx) => analytics.runReport(ctx, { report: 'sales.by_venue', venueId: cbd }));
    expect(out.result.venues).toEqual({ scope: 'selected_venues', names: ['Oak Group CBD'] });
  });

  it('the two tools are reads pinned to listReports and runReport, and their output shapes name everything they return', async () => {
    const list = getTool('reports_list') as ToolDef & { run: (t: { ctx: never; venueId: string | null }, input: unknown) => Promise<unknown> };
    const runT = getTool('report_run') as ToolDef & { run: (t: { ctx: never; venueId: string | null }, input: unknown) => Promise<unknown> };
    expect(list).toMatchObject({ module: 'analytics', effect: 'read', scope: 'metrics:read' });
    expect(runT).toMatchObject({ module: 'analytics', effect: 'read', scope: 'metrics:read' });
    const staff = await diner().as('manager');
    const agent: AgentPrincipal = { kind: 'agent', keyId: '00000000-0000-4000-8000-0000000000b2', staff, scopes: ['metrics:read'], venueIds: null, canWrite: false };
    const catalogue = (await t.app.tenant(diner().orgId, agent, (ctx) => list.run({ ctx: ctx as never, venueId: null }, list.input.parse({})))) as Record<string, any>;
    const shaped = list.output.parse(catalogue) as Record<string, any>;
    expect(JSON.parse(JSON.stringify(shaped))).toEqual(JSON.parse(JSON.stringify(catalogue)));
    expect(shaped.categories.map((c: any) => c.key)).toEqual([...analytics.REPORT_CATEGORIES]);
    expect(shaped.categories.find((c: any) => c.key === 'sales').reports.map((r: any) => r.key)).toContain('sales.over_time');
    const ran = (await t.app.tenant(diner().orgId, agent, (ctx) => runT.run({ ctx: ctx as never, venueId: null }, runT.input.parse({ report: 'sales.by_channel', period: 'last_7_days', compare_to: 'previous_period' })))) as Record<string, any>;
    const shapedRun = runT.output.parse(ran) as Record<string, any>;
    expect(JSON.parse(JSON.stringify(shapedRun))).toEqual(JSON.parse(JSON.stringify(ran)));
    expect(shapedRun.summary).toMatch(/^Sales by how it left: Net sales: /);
    const direct = await t.app.tenant(diner().orgId, staff, (ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['channel'], period: 'last_7_days', compareTo: 'previous_period' }));
    expect(shapedRun.result.totals.values).toEqual(direct.totals.values);
    expect(shapedRun.result.compared_with.kind).toBe('previous_period');
    // An unknown report is not found, in words.
    await expect(t.app.tenant(diner().orgId, agent, (ctx) => runT.run({ ctx: ctx as never, venueId: null }, runT.input.parse({ report: 'nope' })))).rejects.toMatchObject({ code: 'not_found' });
  });
});
