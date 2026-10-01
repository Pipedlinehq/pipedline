import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, auth, ledger, tenancy } from '@ros/modules';
import { WORKER, sale } from './helpers';

/**
 * Benchmarks are opt-in and anonymous: a band needs five opted-in orgs, an org that has not
 * opted in neither contributes nor sees one, and the table holds nothing that names a business.
 * The window is the 28 days ending yesterday: 2 to 29 September 2026.
 */
describe('analytics: benchmarks', () => {
  const t = useTestEnv();
  const extra: Array<{ orgId: string; slug: string; aov: number; ownerUserId: string }> = [];

  /** A new org with `orders` sales of `aovCents` each inside the window. */
  async function addOrg(slug: string, aovCents: number, opts: { cuisine?: string; orders?: number; state?: string; optIn?: boolean } = {}) {
    const created = await t.app.platform('test', (pctx) =>
      tenancy.createOrg(pctx, {
        slug,
        legalName: `${slug} Pty Ltd`,
        tradingName: slug,
        cuisineTags: [opts.cuisine ?? 'steakhouse'],
        priceBand: 3,
        owner: { email: `owner@${slug}.test`, firstName: 'Olive' },
        venue: { name: `${slug} venue`, state: opts.state ?? 'NSW' },
      }),
    );
    await t.app.tenant(created.orgId, WORKER, async (ctx) => {
      for (let i = 0; i < (opts.orders ?? 12); i++) {
        const tax = Math.round(aovCents / 11);
        await ledger.recordTransaction(
          ctx,
          sale(`bm-${slug}-${i}`, `2026-09-${String(3 + i).padStart(2, '0')}T02:30:00Z`, { totalCents: aovCents, subtotalCents: aovCents, taxCents: tax, lines: [{ lineNo: 1, name: 'Set menu', category: 'Mains', qty: 1, unitPriceCents: aovCents, modifiers: [], discountCents: 0, taxCents: tax, totalCents: aovCents }] }),
          { venueId: created.venueId },
        );
      }
    });
    if (opts.optIn !== false) await optIn(created.orgId, created.ownerUserId, true);
    extra.push({ orgId: created.orgId, slug, aov: aovCents, ownerUserId: created.ownerUserId });
    return created;
  }
  async function optIn(orgId: string, ownerUserId: string, on: boolean) {
    const owner = (await auth.staffPrincipal(t.app, ownerUserId, orgId))!;
    await t.app.tenant(orgId, owner, (ctx) => tenancy.updateOrg(ctx, { benchmarkOptIn: on }));
  }
  const bands = () => t.db.selectFrom('benchmark_bands').selectAll().orderBy('metric').orderBy('cohort').execute();
  const mine = async (org: { orgId: string; as(who: 'owner'): Promise<import('@ros/core').StaffPrincipal> }) => t.app.tenant(org.orgId, await org.as('owner'), (ctx) => analytics.getBenchmarks(ctx));
  const aovOf = async (orgId: string) =>
    (await t.app.tenant(orgId, WORKER, (ctx) => analytics.queryMetrics(ctx, { metrics: ['avg_order_value'], period: { from: '2026-09-02', to: '2026-09-29' } }))).totals.values.avg_order_value!;

  it('nobody opted in: nothing is computed and nothing is shown', async () => {
    const run = await analytics.computeBenchmarks(t.app);
    expect(run).toEqual({ period: { from: '2026-09-02', to: '2026-09-29' }, orgsOptedIn: 0, orgsContributing: 0, bandsWritten: 0 });
    expect(await bands()).toEqual([]);
    const view = await mine(t.fixture.diner);
    expect(view).toMatchObject({ opted_in: false, period: null, comparisons: [], min_orgs: 5 });
    expect(view.note).toMatch(/opt-in/);
  });

  it('with four opted-in orgs there is still no band', async () => {
    const { diner, group } = t.fixture;
    await optIn(diner.orgId, diner.staff.owner!.userId, true);
    await optIn(group.orgId, group.staff.owner!.userId, true);
    await addOrg('bm-alpha', 4000);
    await addOrg('bm-bravo', 6000);
    const run = await analytics.computeBenchmarks(t.app);
    expect(run).toMatchObject({ orgsOptedIn: 4, orgsContributing: 4, bandsWritten: 0 });
    expect(await bands()).toEqual([]);
    const view = await mine(diner);
    expect(view).toMatchObject({ opted_in: true, period: null, comparisons: [] });
    expect(view.note).toMatch(/at least 5/);
  });

  it('the fifth org crosses the threshold: bands appear, equal to the percentiles of the five, and name nobody', async () => {
    await addOrg('bm-charlie', 8000);
    const run = await analytics.computeBenchmarks(t.app);
    expect(run).toMatchObject({ orgsOptedIn: 5, orgsContributing: 5 });
    const rows = await bands();
    expect(rows.length).toBe(run.bandsWritten);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.every((r) => r.n_orgs === 5)).toBe(true);
    expect(new Set(rows.map((r) => r.cohort))).toEqual(new Set(['all', 'band:3', 'cuisine:steakhouse', 'state:NSW', 'cuisine:steakhouse|band:3|state:NSW']));
    expect(rows.every((r) => r.period_start === '2026-09-02' && r.period_end === '2026-09-29')).toBe(true);

    const values = [await aovOf(t.fixture.diner.orgId), await aovOf(t.fixture.group.orgId), 4000, 6000, 8000].sort((a, b) => a - b);
    const aov = rows.find((r) => r.metric === 'avg_order_value' && r.cohort === 'all')!;
    expect([Number(aov.p25), Number(aov.p50), Number(aov.p75)]).toEqual([values[1], values[2], values[3]]);
    expect(analytics.percentile([1, 2, 3, 4], 0.5)).toBe(2.5);

    // The table has no column that could name a business, and no row mentions one.
    const cols = await sql<{ column_name: string }>`select column_name from information_schema.columns where table_name = 'benchmark_bands' order by 1`.execute(t.db);
    expect(cols.rows.map((c) => c.column_name)).toEqual(['cohort', 'computed_at', 'id', 'metric', 'n_orgs', 'p25', 'p50', 'p75', 'period_end', 'period_start']);
    const text = JSON.stringify(rows);
    for (const o of [t.fixture.diner, t.fixture.group, ...extra]) {
      expect(text).not.toContain(o.orgId);
      expect(text).not.toContain(o.slug);
    }

    // An org sees its own value against the band of each cohort it belongs to.
    const view = await mine(t.fixture.diner);
    expect(view).toMatchObject({ opted_in: true, period: { from: '2026-09-02', to: '2026-09-29' }, min_orgs: 5 });
    const own = view.comparisons.find((c) => c.metric === 'avg_order_value' && c.cohort === 'all')!;
    const dinerAov = await aovOf(t.fixture.diner.orgId);
    expect(own).toMatchObject({ your_value: dinerAov, p25: values[1], p50: values[2], p75: values[3], n_orgs: 5, unit: 'cents' });
    expect(own.position).toBe(dinerAov < values[1]! ? 'below_p25' : dinerAov < values[2]! ? 'p25_to_p50' : dinerAov <= values[3]! ? 'p50_to_p75' : 'above_p75');
    expect(new Set(view.comparisons.map((c) => c.cohort)).size).toBe(5);
    expect(JSON.stringify(view)).not.toContain(t.fixture.group.orgId);
  });

  it('an org that has not opted in neither contributes nor sees a band; a thin org does not contribute either', async () => {
    const outsider = await addOrg('bm-delta', 20000, { optIn: false });
    const thin = await addOrg('bm-echo', 30000, { orders: 3 });
    const run = await analytics.computeBenchmarks(t.app);
    expect(run).toMatchObject({ orgsOptedIn: 6, orgsContributing: 5 });
    const rows = await bands();
    expect(rows.every((r) => r.n_orgs === 5)).toBe(true);
    expect(Number(rows.find((r) => r.metric === 'avg_order_value' && r.cohort === 'all')!.p75)).toBeLessThan(20000);

    const outsiderOwner = (await auth.staffPrincipal(t.app, outsider.ownerUserId, outsider.orgId))!;
    const hidden = await t.app.tenant(outsider.orgId, outsiderOwner, (ctx) => analytics.getBenchmarks(ctx));
    expect(hidden).toMatchObject({ opted_in: false, comparisons: [], period: null });
    const thinOwner = (await auth.staffPrincipal(t.app, thin.ownerUserId, thin.orgId))!;
    const thinView = await t.app.tenant(thin.orgId, thinOwner, (ctx) => analytics.getBenchmarks(ctx));
    expect(thinView).toMatchObject({ opted_in: true, comparisons: [] });
    expect(thinView.note).toMatch(/fewer than 10 sales/);
  });

  it('cohorts are separate: a sixth org of another cuisine and state joins "all" but makes no band of its own', async () => {
    const thai = await addOrg('bm-foxtrot', 5000, { cuisine: 'thai', state: 'VIC' });
    await analytics.computeBenchmarks(t.app);
    const rows = await bands();
    const n = (cohort: string) => rows.find((r) => r.metric === 'avg_order_value' && r.cohort === cohort)?.n_orgs;
    expect(n('all')).toBe(6);
    expect(n('band:3')).toBe(6);
    expect(n('cuisine:steakhouse')).toBe(5);
    expect(n('state:NSW')).toBe(5);
    expect(n('cuisine:thai')).toBeUndefined();
    expect(n('state:VIC')).toBeUndefined();
    expect(rows.every((r) => r.n_orgs >= 5)).toBe(true);
    const owner = (await auth.staffPrincipal(t.app, thai.ownerUserId, thai.orgId))!;
    const view = await t.app.tenant(thai.orgId, owner, (ctx) => analytics.getBenchmarks(ctx));
    expect(new Set(view.comparisons.map((c) => c.cohort))).toEqual(new Set(['all', 'band:3']));
    expect(view.comparisons.find((c) => c.metric === 'avg_order_value' && c.cohort === 'all')!.your_value).toBe(5000);
  });

  it('opting out removes an org from the next run, and a cohort that drops below five disappears', async () => {
    const { diner } = t.fixture;
    await optIn(diner.orgId, diner.staff.owner!.userId, false);
    const run = await analytics.computeBenchmarks(t.app);
    expect(run.orgsContributing).toBe(5);
    const rows = await bands();
    expect(new Set(rows.map((r) => r.cohort))).toEqual(new Set(['all', 'band:3']));
    expect(rows.every((r) => r.n_orgs === 5)).toBe(true);
    expect(await mine(diner)).toMatchObject({ opted_in: false, comparisons: [] });
    const audit = await t.db.selectFrom('audit_log').select(['action']).where('org_id', '=', diner.orgId).where('action', '=', 'org.updated').execute();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('a tenant can read bands but never write them, and the daily job recomputes them', async () => {
    const owner = await t.fixture.group.as('owner');
    await expect(
      t.app.tenant(t.fixture.group.orgId, owner, (ctx) => ctx.db.insertInto('benchmark_bands').values({ metric: 'avg_order_value', cohort: 'all', period_start: '2026-09-02', period_end: '2026-09-29', p25: 1, p50: 1, p75: 1, n_orgs: 99 }).execute()),
    ).rejects.toThrow(/permission denied|row-level security/);
    await t.db.deleteFrom('benchmark_bands').execute();
    await tickSchedules(t.app, { only: ['analytics.benchmarks'] });
    const queued = await t.db.selectFrom('jobs').select(['org_id', 'kind']).where('kind', '=', 'analytics.benchmarks').where('status', '=', 'queued').execute();
    expect(queued).toEqual([{ org_id: null, kind: 'analytics.benchmarks' }]);
    expect(await drainJobs(t.app, { kinds: ['analytics.benchmarks'] })).toMatchObject({ ran: 1, succeeded: 1 });
    expect((await bands()).length).toBeGreaterThan(0);
  });
});
