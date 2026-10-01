import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { BUDGETS_MS, SUITE_SCALE, type ScaleEnv, type ScaleTenant, buildFacts, createScaleEnv, jobContention, leakCheck, measureTenant, scaleTenant, scheduleCost, seedScale, tableCounts } from './lib';

/**
 * Scale and isolation at volume, at a size the suite can afford on every run: 40 orgs beside
 * the two fixture orgs, about 60,000 sales. `scripts/scale-test.ts` runs the same checks at
 * hundreds of orgs and millions of rows and reports the numbers.
 */
describe('scale: many orgs in one database', () => {
  const name = `scale_${randomBytes(5).toString('hex')}`;
  const server = (database: string) => `postgres://postgres:postgres@127.0.0.1:${process.env.ROS_TEST_PG_PORT}/${database}`;
  let env: ScaleEnv;
  let first: ScaleTenant;
  let last: ScaleTenant;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: server('postgres') });
    await admin.connect();
    // The seeded template (packages/testkit global-setup): migrated, with the two fixture orgs.
    await admin.query(`create database "${name}" template "ros_template"`);
    await admin.end();
    env = createScaleEnv(server(name));
    await seedScale(env, SUITE_SCALE, { fromOrg: 0, toOrg: SUITE_SCALE.orgs });
    first = await scaleTenant(env, 0);
    last = await scaleTenant(env, SUITE_SCALE.orgs - 1);
  }, 300_000);

  afterAll(async () => {
    await env?.close();
    const admin = new pg.Client({ connectionString: server('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.end();
  });

  it('seeds the volume it says it does', async () => {
    const s = SUITE_SCALE;
    const counts = await tableCounts(env, ['orgs', 'venues', 'transactions', 'transaction_lines', 'customers', 'orders', 'kitchen_tickets']);
    expect(counts.orgs).toBe(s.orgs + 2);
    expect(counts.transactions).toBeGreaterThanOrEqual(s.venues * s.txnsPerVenue);
    expect(counts.transaction_lines).toBeGreaterThanOrEqual(s.venues * s.txnsPerVenue);
    expect(counts.customers).toBeGreaterThanOrEqual(s.orgs * s.customersPerOrg);
    // The first orgs have two venues; the measured one is one of them.
    expect(first.venueIds).toHaveLength(2);
    expect(last.venueIds).toHaveLength(1);
    const own = await env.pool.query('select count(*)::int as n from transactions where org_id = $1', [first.orgId]);
    expect(own.rows[0].n).toBe(2 * s.txnsPerVenue);
  });

  it('the cross-tenant leak test passes at volume, and row-level security reads through the tenant\'s own index', async () => {
    const r = await leakCheck(env, first, last);
    expect(r.tablesChecked).toBeGreaterThan(60);
    expect(r.leaks).toEqual([]);
    expect(r.orgsSeen).toBe(1);
    expect(r.crossWrite).toBe('refused');
    // With no filter of its own, a tenant sees exactly its own rows of each big table, never the total.
    expect(r.unfiltered.length).toBeGreaterThanOrEqual(3);
    for (const u of r.unfiltered) {
      expect(u.seen, u.table).toBe(u.own);
      expect(u.total, u.table).toBeGreaterThan(u.own * 5);
    }
    expect(r.problems).toEqual([]);
    // And the same from a fixture org's side: none of the seeded rows.
    const fixture = await env.pool.query(`select id from orgs where slug = 'oak-diner'`);
    const seen = await env.app.tenant(fixture.rows[0].id, { kind: 'worker', job: 'leak-test' }, async (ctx) => {
      const { sql } = await import('kysely');
      return (await sql<{ n: number }>`select count(*)::int as n from transactions where external_ref like 'scale-%'`.execute(ctx.db)).rows[0]!.n;
    });
    expect(seen).toBe(0);
  });

  it('the main tenant queries read through tenant-leading indexes and stay inside their budgets', async () => {
    await buildFacts(env, first);
    const measured = await measureTenant(env, first, { runs: 5, withFacts: true });
    expect(measured.map((m) => m.name).sort()).toEqual(Object.keys(BUDGETS_MS).sort());
    for (const m of measured) {
      expect(m.statements, m.name).toBeGreaterThan(0);
      expect(m.problems, `${m.name}: ${JSON.stringify(m.problems)}`).toEqual([]);
      expect(m.medianMs, `${m.name} took ${m.medianMs} ms against a budget of ${m.budgetMs} ms`).toBeLessThanOrEqual(m.budgetMs);
    }
    // The plan check is not vacuous: the ledger queries really did read the big table.
    const ledger = measured.find((m) => m.name === 'metrics_by_day_ledger')!;
    expect(ledger.plans.some((p) => p.nodes.some((n) => n.includes('transactions')))).toBe(true);
  });

  it('several workers claiming one queue never run a job twice', async () => {
    const r = await jobContention(env, { jobs: 1500, workers: 6, batch: 10 });
    expect(r.jobs).toBe(1500);
    expect(r.handlerCalls).toBe(1500);
    expect(r.ranTwice).toBe(0);
    expect(r.neverRan).toBe(0);
    expect(r.succeeded).toBe(1500);
    expect(r.attemptsOverOne).toBe(0);
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
  });

  it('a scheduler tick enqueues once per org and bucket, and scans no big table to do it', async () => {
    const r = await scheduleCost(env);
    expect(r.orgs).toBe(SUITE_SCALE.orgs + 2);
    expect(r.enqueued).toBeGreaterThan(r.orgs);
    expect(r.secondTickNewJobs).toBe(0);
    expect(r.problems, JSON.stringify(r.problems)).toEqual([]);
    // A handful of statements per org, not one per row of anything.
    expect(r.perOrgStatements).toBeLessThan(r.schedules * 2 + 5);
  });
});
