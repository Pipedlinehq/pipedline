/**
 * Scale and isolation at volume. Starts its own throwaway Postgres, seeds hundreds of orgs and
 * millions of ledger rows with direct SQL, then measures and asserts:
 *
 *   - the cross-tenant leak test still passes
 *   - the main tenant queries read through tenant-leading indexes (EXPLAIN shows no scan across
 *     tenants) and stay inside their budgets for one tenant, at a tenth of the volume and at
 *     all of it
 *   - several workers claiming one job queue never run a job twice
 *   - what one scheduler tick costs per org
 *
 *   npx tsx scripts/scale-test.ts                     300 orgs, 400 venues, 2.4M sales + 2.4M lines
 *   SCALE_ORGS=100 SCALE_VENUES=130 npx tsx scripts/scale-test.ts
 *   SCALE_TXNS_PER_VENUE=2000 npx tsx scripts/scale-test.ts
 *   SCALE_DATABASE_URL=postgres://… npx tsx scripts/scale-test.ts   an EMPTY, migrated database of your own
 *
 * Exits non-zero if any assertion fails. Memory: Postgres runs with its defaults (128 MB shared
 * buffers); the peak of this process and of the Postgres processes is sampled and reported.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { createDatabase, migrateDatabase, startLocalPg, type LocalPg } from '../packages/testkit/src/local-pg';
import {
  BUDGETS_MS,
  FULL_SCALE,
  type Measurement,
  type ScaleSizes,
  buildFacts,
  createScaleEnv,
  jobContention,
  leakCheck,
  measureTenant,
  scaleTenant,
  scheduleCost,
  seedScale,
  tableCounts,
} from '../packages/modules/test/scale/lib';

const int = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive whole number`);
  return n;
};

const sizes: ScaleSizes = {
  ...FULL_SCALE,
  orgs: int('SCALE_ORGS', FULL_SCALE.orgs),
  venues: int('SCALE_VENUES', FULL_SCALE.venues),
  txnsPerVenue: int('SCALE_TXNS_PER_VENUE', FULL_SCALE.txnsPerVenue),
  customersPerOrg: int('SCALE_CUSTOMERS_PER_ORG', FULL_SCALE.customersPerOrg),
};
if (sizes.venues < sizes.orgs) throw new Error('SCALE_VENUES must be at least SCALE_ORGS');
const QUEUE_JOBS = int('SCALE_QUEUE_JOBS', 20_000);
const WORKERS = int('SCALE_WORKERS', 8);
/** The test must stay well inside the machine: stop if this process and Postgres together pass this. */
const MEMORY_LIMIT_MB = int('SCALE_MEMORY_LIMIT_MB', 4096);
/**
 * One scheduler tick, per org, the first time in a time bucket (every schedule enqueues). The
 * tick is sequential: at this budget 300 orgs take half a minute, which is the ceiling a
 * 30-second scheduler interval allows.
 */
const SCHEDULER_BUDGET_MS_PER_ORG = 100;

// ── Memory: this process and the Postgres server it started, by proportional set size ──────────

function pssMb(pid: number): number {
  try {
    const m = /^Pss:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'));
    return m ? Number(m[1]) / 1024 : 0;
  } catch {
    return 0;
  }
}

function postgresPids(dataDir: string | null): number[] {
  if (!dataDir) return [];
  const pids: number[] = [];
  let postmaster = 0;
  const all = readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  for (const pid of all) {
    try {
      if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dataDir)) postmaster = pid;
    } catch {
      // gone
    }
  }
  if (!postmaster) return [];
  pids.push(postmaster);
  for (const pid of all) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === postmaster) pids.push(pid);
    } catch {
      // gone
    }
  }
  return pids;
}

const peak = { node: 0, postgres: 0, both: 0 };
function sampleMemory(dataDir: string | null): void {
  const node = process.memoryUsage().rss / 1024 / 1024;
  const postgres = postgresPids(dataDir).reduce((s, pid) => s + pssMb(pid), 0);
  peak.node = Math.max(peak.node, node);
  peak.postgres = Math.max(peak.postgres, postgres);
  peak.both = Math.max(peak.both, node + postgres);
  if (node + postgres > MEMORY_LIMIT_MB) {
    console.error(`\nSTOPPED: memory passed ${MEMORY_LIMIT_MB} MB (this process ${Math.round(node)} MB, Postgres ${Math.round(postgres)} MB).`);
    // Never leave a Postgres running behind a stopped run.
    void (server ? server.stop() : Promise.resolve()).finally(() => process.exit(3));
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  if (!ok) failures.push(what);
};
const line = (s = '') => console.log(s);
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const num = (n: number) => n.toLocaleString('en-AU');

function table(title: string, rows: Measurement[]): void {
  line(`\n${title}`);
  line(`  ${pad('query', 28)}${pad('median ms', 11)}${pad('max ms', 9)}${pad('budget', 8)}${pad('stmts', 7)}plan`);
  for (const m of rows) {
    line(`  ${pad(m.name, 28)}${pad(m.medianMs, 11)}${pad(m.maxMs, 9)}${pad(m.budgetMs, 8)}${pad(m.statements, 7)}${m.problems.length ? `${m.problems.length} PROBLEM(S)` : 'tenant-bound'}`);
    for (const p of m.problems) line(`      ${p.detail}\n        in: ${p.statement}`);
    check(m.problems.length === 0, `${title}: ${m.name} scans across tenants (${m.problems.map((p) => p.detail).join('; ')})`);
    check(m.medianMs <= m.budgetMs, `${title}: ${m.name} took ${m.medianMs} ms against a budget of ${m.budgetMs} ms`);
  }
}

let server: LocalPg | null = null;
let dataDir: string | null = null;
let url = process.env.SCALE_DATABASE_URL ?? '';
const started = Date.now();

if (!url) {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'ros-scale-'));
  server = await startLocalPg({ dataDir });
  url = await createDatabase(server, 'ros_scale');
  await migrateDatabase(url);
} else {
  const probe = new pg.Client({ connectionString: url });
  await probe.connect();
  const orgs = await probe.query('select count(*)::int as n from orgs');
  await probe.end();
  if (orgs.rows[0].n > 0) throw new Error('SCALE_DATABASE_URL must point at an empty, migrated database: this script writes millions of rows.');
}
const sampler = setInterval(() => sampleMemory(dataDir), 1000);
const env = createScaleEnv(url, { poolSize: WORKERS + 8 });

try {
  line(`Scale test: ${num(sizes.orgs)} orgs, ${num(sizes.venues)} venues, ${num(sizes.venues * sizes.txnsPerVenue)} sales (and as many lines), ${num(sizes.orgs * sizes.customersPerOrg)} customers`);

  // 1. A tenth of the orgs, then measure the first org.
  const baseOrgs = Math.max(2, Math.ceil(sizes.orgs / 10));
  const seedA = await seedScale(env, sizes, { fromOrg: 0, toOrg: baseOrgs }, (s) => line(`  ${s}`));
  const tenant = await scaleTenant(env, 0);
  const countsA = await tableCounts(env, ['transactions']);
  const small = await measureTenant(env, tenant);
  table(`Main tenant queries, org 0 of ${baseOrgs} (${num(countsA.transactions!)} sales in the database)`, small);

  // 2. The rest, then measure the same org again. Its own data has not changed.
  const seedB = await seedScale(env, sizes, { fromOrg: baseOrgs, toOrg: sizes.orgs }, (s) => line(`  ${s}`));
  const counts = await tableCounts(env, ['orgs', 'venues', 'customers', 'transactions', 'transaction_lines', 'orders', 'order_items', 'kitchen_tickets', 'jobs']);
  line(`\nSeeded in ${Math.round(seedA.seconds + seedB.seconds)}s: ${Object.entries(counts).map(([t, n]) => `${t} ${num(n)}`).join(', ')}`);
  const size = await env.pool.query(`select pg_size_pretty(pg_database_size(current_database())) as size`);
  line(`Database size on disk: ${size.rows[0].size}`);

  const facts = await buildFacts(env, tenant);
  line(`Built org 0's analytics facts from its ledger: ${facts.days} days in ${facts.seconds}s`);
  const full = await measureTenant(env, tenant, { withFacts: true });
  table(`Main tenant queries, org 0 of ${sizes.orgs} (${num(counts.transactions!)} sales in the database)`, full);

  line('\nOne tenant, a tenth of the volume against all of it (median ms):');
  for (const m of full) {
    const before = small.find((s) => s.name === m.name);
    if (!before) continue;
    const ratio = before.medianMs > 0 ? m.medianMs / before.medianMs : 1;
    line(`  ${pad(m.name, 28)}${pad(before.medianMs, 9)}→ ${pad(m.medianMs, 9)}x${ratio.toFixed(2)}`);
    // Ten times the data in the database must not make one tenant's query several times slower.
    // (A floor of 15 ms keeps timer noise on the fastest queries from failing the run.)
    check(m.medianMs <= Math.max(15, before.medianMs * 3), `${m.name} for one tenant went from ${before.medianMs} ms to ${m.medianMs} ms as the database grew tenfold`);
  }

  // 3. The leak test at volume.
  const other = await scaleTenant(env, sizes.orgs - 1);
  const leak = await leakCheck(env, tenant, other);
  line(`\nCross-tenant leak test: ${leak.tablesChecked} tenant tables checked, leaks: ${leak.leaks.length ? leak.leaks.join(', ') : 'none'}; orgs visible to the tenant: ${leak.orgsSeen}; write into another org: ${leak.crossWrite}`);
  for (const u of leak.unfiltered) line(`  ${pad(u.table, 20)}tenant sees ${num(u.seen)} of about ${num(u.total)} rows (its own: ${num(u.own)})`);
  check(leak.leaks.length === 0, `leak: org 0 can read rows of another org in ${leak.leaks.join(', ')}`);
  check(leak.orgsSeen === 1, `leak: org 0 sees ${leak.orgsSeen} orgs`);
  check(leak.crossWrite === 'refused', 'leak: org 0 could write a row into another org');
  check(leak.tablesChecked > 60, `leak: only ${leak.tablesChecked} tables were checked`);
  for (const u of leak.unfiltered) check(u.seen === u.own, `leak: org 0 sees ${u.seen} rows of ${u.table}, its own count is ${u.own}`);
  check(leak.problems.length === 0, `leak: row-level security filtered a big table by scanning it (${leak.problems.map((p) => p.detail).join('; ')})`);

  // 4. Job claim under contention.
  const jobs = await jobContention(env, { jobs: QUEUE_JOBS, workers: WORKERS });
  line(`\nJob queue: ${num(jobs.jobs)} jobs, ${jobs.workers} workers, ${jobs.seconds}s (${num(jobs.jobsPerSecond)} jobs/s) over a queue table of ${num(counts.jobs! + jobs.jobs)} rows`);
  line(`  handler calls ${num(jobs.handlerCalls)}; ran twice ${jobs.ranTwice}; never ran ${jobs.neverRan}; succeeded ${num(jobs.succeeded)}; attempts over one ${jobs.attemptsOverOne}`);
  for (const p of jobs.claimPlans) line(`  ${p.nodes.join(' + ') || '(no scan of jobs)'}  ←  ${p.statement.slice(0, 80)}`);
  for (const c of jobs.claimStatementMs) line(`  ${pad(`${c.ms} ms`, 10)}${c.statement}`);
  check(jobs.handlerCalls === jobs.jobs && jobs.ranTwice === 0, `jobs: ${jobs.ranTwice} jobs ran more than once (${jobs.handlerCalls} handler calls for ${jobs.jobs} jobs)`);
  check(jobs.neverRan === 0 && jobs.succeeded === jobs.jobs, `jobs: ${jobs.neverRan} jobs never ran`);
  check(jobs.attemptsOverOne === 0, `jobs: ${jobs.attemptsOverOne} jobs were claimed more than once`);
  check(jobs.problems.length === 0, `jobs: ${jobs.problems.map((p) => p.detail).join('; ')}`);

  // 5. The scheduler.
  const sched = await scheduleCost(env);
  line(`\nScheduler tick: ${sched.schedules} schedules over ${num(sched.orgs)} orgs: ${sched.ms} ms, ${num(sched.statements)} statements, ${num(sched.enqueued)} jobs enqueued`);
  line(`  per org: ${sched.perOrgMs} ms, ${sched.perOrgStatements} statements (budget ${SCHEDULER_BUDGET_MS_PER_ORG} ms). The same tick again: ${sched.secondTickMs} ms, ${sched.secondTickNewJobs} new jobs`);
  check(sched.secondTickNewJobs === 0, `scheduler: a second tick in the same bucket enqueued ${sched.secondTickNewJobs} more jobs`);
  check(sched.problems.length === 0, `scheduler: ${sched.problems.map((p) => p.detail).join('; ')}`);
  check(sched.perOrgMs <= SCHEDULER_BUDGET_MS_PER_ORG, `scheduler: a tick costs ${sched.perOrgMs} ms per org (budget ${SCHEDULER_BUDGET_MS_PER_ORG} ms)`);

  line(`\nBudgets (ms, one tenant): ${Object.entries(BUDGETS_MS).map(([k, v]) => `${k} ${v}`).join(', ')}`);
} finally {
  clearInterval(sampler);
  sampleMemory(dataDir);
  await env.close().catch(() => undefined);
  if (server) await server.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}

line(`\nPeak memory: this process ${Math.round(peak.node)} MB, Postgres ${Math.round(peak.postgres)} MB, together ${Math.round(peak.both)} MB (limit ${MEMORY_LIMIT_MB} MB). Wall time ${Math.round((Date.now() - started) / 1000)}s.`);
if (failures.length) {
  line(`\nFAILED (${failures.length}):`);
  for (const f of failures) line(`  - ${f}`);
  process.exit(1);
}
line('\nPASSED');
