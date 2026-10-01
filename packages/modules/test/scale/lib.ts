/**
 * Scale and isolation at volume: the harness behind `packages/modules/test/scale/*.test.ts`
 * (small, inside the suite) and `scripts/scale-test.ts` (hundreds of orgs, millions of rows).
 *
 *   seed      many orgs written straight in with SQL through the platform connection: the
 *             cheapest way to make a database look like 300 venues. Nothing here goes through a
 *             service function; the rows have the shape the service functions write.
 *   measure   the main tenant queries, called through the real service functions as a staff
 *             member of ONE org. Every statement they run is captured, re-planned with EXPLAIN
 *             under the tenant role, and held to "no scan across tenants".
 *   leak      the cross-tenant leak test, against the volume.
 *   jobs      several workers claiming one queue: no job may run twice.
 *   schedule  what one scheduler tick costs per org.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  type App,
  type Ctx,
  type DB,
  type Database,
  type Principal,
  type StaffPrincipal,
  createApp,
  createPool,
  addDays,
  deadJobSummary,
  defineJob,
  listModuleDefs,
  listScheduleDefs,
  localDate,
  noPayload,
  runDueJobs,
  silentLogger,
  tableSecretStore,
  tickSchedules,
} from '@ros/core';
import { createSimAdapters } from '@ros/adapters';
import { analytics, identity, ordering } from '@ros/modules';
import { FIXTURE_NOW, TEST_CONFIG, fakeClock, type FakeClock } from '@ros/testkit';

export interface ScaleSizes {
  orgs: number;
  /** At least `orgs`. Venue n belongs to org n % orgs, so the first (venues - orgs) orgs have two. */
  venues: number;
  txnsPerVenue: number;
  customersPerOrg: number;
  ordersPerVenue: number;
  /** Of those orders, how many have a kitchen ticket; the newest 8 are live. */
  ticketsPerVenue: number;
  /** Finished jobs per org, so the queue table has history behind it. */
  jobHistoryPerOrg: number;
  /** Sales are spread over this many days, ending yesterday. */
  days: number;
}

export const FULL_SCALE: ScaleSizes = { orgs: 300, venues: 400, txnsPerVenue: 6000, customersPerOrg: 1500, ordersPerVenue: 400, ticketsPerVenue: 60, jobHistoryPerOrg: 500, days: 180 };
export const SUITE_SCALE: ScaleSizes = { orgs: 40, venues: 50, txnsPerVenue: 1200, customersPerOrg: 300, ordersPerVenue: 120, ticketsPerVenue: 40, jobHistoryPerOrg: 100, days: 90 };

export interface CapturedQuery {
  sql: string;
  parameters: readonly unknown[];
  ms: number;
}

export interface ScaleEnv {
  app: App;
  db: Database;
  pool: pg.Pool;
  clock: FakeClock;
  /** Run `fn` and return every statement it sent. */
  capture<T>(fn: () => Promise<T>): Promise<{ result: T; queries: CapturedQuery[] }>;
  close(): Promise<void>;
}

/** An App on simulated providers whose database handle records every statement while capturing. */
export function createScaleEnv(url: string, opts: { poolSize?: number } = {}): ScaleEnv {
  const pool = createPool(url, { max: opts.poolSize ?? 16 });
  // An idle connection closed under the pool (the database being dropped at the end) is not an error here.
  pool.on('error', () => undefined);
  let sink: CapturedQuery[] | null = null;
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    log(event) {
      if (sink && event.level === 'query') sink.push({ sql: event.query.sql, parameters: event.query.parameters, ms: event.queryDurationMillis });
    },
  });
  const clock = fakeClock(FIXTURE_NOW);
  const { registry } = createSimAdapters({ clock });
  const app = createApp({ db, config: TEST_CONFIG, adapters: registry, secrets: tableSecretStore, clock, log: silentLogger });
  return {
    app,
    db,
    pool,
    clock,
    async capture(fn) {
      const queries: CapturedQuery[] = [];
      sink = queries;
      try {
        return { result: await fn(), queries };
      } finally {
        sink = null;
      }
    },
    close: () => db.destroy(),
  };
}

// ── Seeding ─────────────────────────────────────────────────────────────────

export interface SeedReport {
  orgs: number;
  venues: number;
  seconds: number;
}

const FIRST = `array['Ava','Ben','Cara','Dev','Elle','Finn','Gia','Hugo','Isla','Jai','Kira','Leo','Mia','Noah','Olive','Pia','Quinn','Remy','Sam','Tess']`;
const LAST = `array['Smith','Nguyen','Jones','Brown','Wilson','Taylor','Lee','Martin','Walker','Singh','Kelly','King','Young','Hall','Wright','Scott','Green','Baker','Adams','Clark','Evans','Ryan','Chen','Khan','Murphy']`;

/**
 * Seed orgs [fromOrg, toOrg) with their venues, customers, sales, orders, tickets and job
 * history. Direct SQL as the platform (bypassing row-level security and, for speed, foreign-key
 * triggers: the rows are consistent by construction). Call again with the next range to grow
 * the same database.
 */
export async function seedScale(env: ScaleEnv, sizes: ScaleSizes, range: { fromOrg: number; toOrg: number }, onProgress?: (line: string) => void): Promise<SeedReport> {
  const started = performance.now();
  const now = env.clock();
  const N = sizes.orgs;
  const modules = listModuleDefs().filter((d) => !d.spine && !d.key.startsWith('test_') && !d.key.startsWith('scale_')).map((d) => d.key);
  const client = await env.pool.connect();
  const run = (text: string, values: unknown[] = []) => client.query(text, values);
  try {
    await run(`create schema if not exists scale`);
    await run(`create unlogged table if not exists scale.orgs (n int primary key, id uuid not null unique)`);
    await run(`create unlogged table if not exists scale.venues (n int primary key, org_n int not null, id uuid not null unique, org_id uuid not null)`);
    await run(`create unlogged table if not exists scale.customers (org_n int not null, k int not null, id uuid not null, primary key (org_n, k))`);
    await run(`set session_replication_role = replica`);

    const CHUNK = 20;
    for (let a = range.fromOrg; a < range.toOrg; a += CHUNK) {
      const b = Math.min(range.toOrg, a + CHUNK);
      await run('begin');
      await run(`insert into scale.orgs (n, id) select n, gen_random_uuid() from generate_series($1::int, $2::int - 1) n`, [a, b]);
      await run(
        `insert into scale.venues (n, org_n, id, org_id)
         select v, v % $3::int, gen_random_uuid(), o.id from generate_series(0, $4::int - 1) v join scale.orgs o on o.n = v % $3::int
         where v % $3::int >= $1::int and v % $3::int < $2::int`,
        [a, b, N, sizes.venues],
      );
      await run(
        `insert into orgs (id, slug, legal_name, trading_name, status, timezone)
         select id, 'scale-' || n, 'Scale Org ' || n || ' Pty Ltd', 'Scale Org ' || n, 'live', 'Australia/Sydney' from scale.orgs where n >= $1 and n < $2`,
        [a, b],
      );
      await run(
        `insert into venues (id, org_id, slug, name, status, timezone, suburb)
         select id, org_id, 'v' || n, 'Scale Venue ' || n, 'live', 'Australia/Sydney', 'Sydney' from scale.venues where org_n >= $1 and org_n < $2`,
        [a, b],
      );
      await run(
        `insert into trading_hours (org_id, venue_id, day_of_week, opens_at, closes_at)
         select v.org_id, v.id, d, '11:00', '21:00' from scale.venues v cross join generate_series(0, 6) d where v.org_n >= $1 and v.org_n < $2`,
        [a, b],
      );
      await run(
        `insert into venue_modules (org_id, venue_id, module_key, enabled, config, enabled_at)
         select v.org_id, v.id, m, true,
                case when m = 'hub' then '{"hosted_agents":["ops_watch","weekly_digest"]}'::jsonb else '{}'::jsonb end, $4
         from scale.venues v cross join unnest($3::text[]) m where v.org_n >= $1 and v.org_n < $2`,
        [a, b, modules, now],
      );
      await run(
        `insert into connections (org_id, venue_id, plug_key, status, external_account_id, config, connected_at, last_ok_at)
         select v.org_id, v.id, 'sim-pos', 'connected', 'scale-' || v.n, jsonb_build_object('locationRef', 'loc-' || v.n), $3, $3
         from scale.venues v where v.org_n >= $1 and v.org_n < $2`,
        [a, b, now],
      );
      await run(
        `insert into scale.customers (org_n, k, id) select o.n, k, gen_random_uuid() from scale.orgs o cross join generate_series(0, $3::int - 1) k where o.n >= $1 and o.n < $2`,
        [a, b, sizes.customersPerOrg],
      );
      await run(
        `insert into customers (id, org_id, primary_email, primary_phone, first_name, last_name, first_seen_venue_id, created_at, acquisition_at)
         select c.id, o.id, 'c' || c.k || '@o' || o.n || '.example', '+614' || lpad(((o.n * 7919 + c.k) % 100000000)::text, 8, '0'),
                (${FIRST})[1 + c.k % 20], (${LAST})[1 + (c.k / 20) % 25], v.id,
                $3::timestamptz - (c.k % 400) * interval '1 day', $3::timestamptz - (c.k % 400) * interval '1 day'
         from scale.customers c join scale.orgs o on o.n = c.org_n join scale.venues v on v.n = o.n
         where o.n >= $1 and o.n < $2`,
        [a, b, now],
      );
      // Sales: each venue's, spread over `days` days ending yesterday, between 11:00 and 21:00 Sydney time.
      await run(
        `insert into transactions (org_id, venue_id, occurred_at, source, external_ref, customer_id, channel, subtotal_cents, tax_cents, total_cents, status, tender_type, raw, ingested_at, updated_at)
         select v.org_id, v.id, t.at, 'sim', 'scale-' || v.n || '-' || g,
                case when g % 5 < 3 then c.id end,
                (array['dine-in','pickup','delivery'])[1 + g % 3]::txn_channel,
                t.cents, round(t.cents / 11.0)::int, t.cents, 'completed', 'card',
                jsonb_build_object('id', 'scale-' || v.n || '-' || g, 'tender', 'card', 'card', jsonb_build_object('brand', 'VISA', 'last4', lpad((g % 10000)::text, 4, '0'))),
                t.at + interval '1 minute', t.at + interval '1 minute'
         from scale.venues v
         cross join generate_series(1, $3::int) g
         cross join lateral (select date_trunc('day', $5::timestamptz) - ($4::int - (g % $4::int)) * interval '1 day' + (60 + (g::bigint * 7919) % 600) * interval '1 minute' + (g % 60) * interval '1 second' as at,
                                    (1500 + (g::bigint * 37) % 9000)::int as cents) t
         left join scale.customers c on c.org_n = v.org_n and c.k = (g::bigint * 31) % $6::int
         where v.org_n >= $1 and v.org_n < $2`,
        [a, b, sizes.txnsPerVenue, sizes.days, now, sizes.customersPerOrg],
      );
      await run(
        `insert into transaction_lines (org_id, transaction_id, line_no, name_snapshot, category_snapshot, qty, unit_price_cents, tax_cents, total_cents)
         select t.org_id, t.id, 1, 'Item ' || (abs(hashtext(t.external_ref)) % 40), 'Category ' || (abs(hashtext(t.external_ref)) % 5), 1, t.total_cents, t.tax_cents, t.total_cents
         from transactions t join scale.orgs o on o.id = t.org_id where o.n >= $1 and o.n < $2`,
        [a, b],
      );
      // Online orders, newest first: the newest 8 still in the kitchen's hands.
      await run(
        `insert into orders (org_id, venue_id, customer_id, reference, channel, status, payment_status, subtotal_cents, tax_cents, total_cents, customer_name, idempotency_key, placed_at, created_at, updated_at)
         select v.org_id, v.id, c.id, 'S' || g, 'pickup',
                (case when g <= 3 then 'placed' when g <= 6 then 'accepted' when g <= 8 then 'preparing' else 'completed' end)::order_status,
                'paid', 2200, 200, 2200, 'Guest ' || g, 'scale-' || v.n || '-' || g,
                $4::timestamptz - g * interval '30 minutes', $4::timestamptz - g * interval '30 minutes', $4::timestamptz - g * interval '30 minutes'
         from scale.venues v cross join generate_series(1, $3::int) g
         left join scale.customers c on c.org_n = v.org_n and c.k = (g * 17) % $5::int
         where v.org_n >= $1 and v.org_n < $2`,
        [a, b, sizes.ordersPerVenue, now, sizes.customersPerOrg],
      );
      await run(
        `insert into order_items (org_id, order_id, name_snapshot, category_snapshot, qty, unit_price_cents, line_total_cents)
         select o.org_id, o.id, 'Fries, aioli', 'Sides', 2, 1100, 2200 from orders o join scale.orgs s on s.id = o.org_id where s.n >= $1 and s.n < $2`,
        [a, b],
      );
      await run(
        `insert into kitchen_tickets (org_id, venue_id, order_id, ticket_number, service_date, status, channel, guest_name, received_at, bumped_at)
         with seeded as materialized (
           select o.*, split_part(o.idempotency_key, '-', 3) as g from orders o join scale.orgs s on s.id = o.org_id
           where s.n >= $1 and s.n < $2 and o.idempotency_key like 'scale-%'
         )
         select o.org_id, o.venue_id, o.id, o.g::int, (o.created_at at time zone 'Australia/Sydney')::date,
                (case when o.status in ('placed') then 'new' when o.status in ('accepted', 'preparing') then 'acknowledged' else 'bumped' end)::ticket_status,
                'pickup', o.customer_name, o.created_at, case when o.status = 'completed' then o.created_at + interval '20 minutes' end
         from seeded o where o.g::int <= $3::int`,
        [a, b, sizes.ticketsPerVenue],
      );
      await run(
        `insert into jobs (org_id, kind, payload, run_at, status, attempts, idempotency_key, created_at, finished_at)
         select o.id, 'analytics.rollup', '{"mode":"incremental"}', $4::timestamptz - g * interval '15 minutes', 'succeeded', 1, 'scale-hist-' || g,
                $4::timestamptz - g * interval '15 minutes', $4::timestamptz - g * interval '15 minutes' + interval '2 seconds'
         from scale.orgs o cross join generate_series(1, $3::int) g where o.n >= $1 and o.n < $2`,
        [a, b, sizes.jobHistoryPerOrg, now],
      );
      await run('commit');
      onProgress?.(`seeded orgs ${a}..${b - 1} (${Math.round((performance.now() - started) / 1000)}s)`);
    }
    await run(`set session_replication_role = origin`);
    await run(`analyze`);
  } catch (e) {
    await run('rollback').catch(() => undefined);
    throw e;
  } finally {
    await run(`set session_replication_role = origin`).catch(() => undefined);
    client.release();
  }
  const venues = await env.pool.query(`select count(*)::int as n from scale.venues where org_n >= $1 and org_n < $2`, [range.fromOrg, range.toOrg]);
  return { orgs: range.toOrg - range.fromOrg, venues: venues.rows[0].n, seconds: Math.round((performance.now() - started) / 100) / 10 };
}

export interface ScaleTenant {
  n: number;
  orgId: string;
  venueIds: string[];
  owner: StaffPrincipal;
}

/** One seeded org, with an owner principal built by hand (the scale orgs have no staff rows). */
export async function scaleTenant(env: ScaleEnv, n: number): Promise<ScaleTenant> {
  const org = await env.pool.query(`select id from scale.orgs where n = $1`, [n]);
  if (!org.rows[0]) throw new Error(`No scale org ${n}`);
  const venues = await env.pool.query(`select id from scale.venues where org_n = $1 order by n`, [n]);
  const venueIds: string[] = venues.rows.map((r: { id: string }) => r.id);
  const id = '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
  return { n, orgId: org.rows[0].id, venueIds, owner: { kind: 'staff', staffId: id, userId: id, isOwner: true, venueRoles: Object.fromEntries(venueIds.map((v) => [v, 'owner' as const])) } };
}

export async function tableCounts(env: ScaleEnv, tables: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = Number((await env.pool.query(`select count(*) as n from ${pg.escapeIdentifier(t)}`)).rows[0].n);
  return out;
}

// ── Plans ───────────────────────────────────────────────────────────────────

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Recheck Cond'?: string;
  Filter?: string;
  Plans?: PlanNode[];
}

export interface PlanProblem {
  statement: string;
  node: string;
  table: string;
  detail: string;
}

export interface TableFacts {
  /** Tenant tables (they have org_id) with more rows than the threshold: a scan of one is a scan across tenants. */
  big: Map<string, number>;
  indexTable: Map<string, string>;
}

/** Tables a tenant-blind scan would matter on, from the planner's own row counts (run ANALYZE first). */
export async function tableFacts(env: ScaleEnv, minRows = 10_000): Promise<TableFacts> {
  const t = await env.pool.query(
    `select c.relname as name, c.reltuples::bigint as rows
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)`,
  );
  const big = new Map<string, number>();
  for (const r of t.rows as Array<{ name: string; rows: string }>) if (Number(r.rows) >= minRows) big.set(r.name, Number(r.rows));
  const i = await env.pool.query(`select indexname, tablename from pg_indexes where schemaname = 'public'`);
  return { big, indexTable: new Map((i.rows as Array<{ indexname: string; tablename: string }>).map((r) => [r.indexname, r.tablename])) };
}

/** An index condition that pins the scan to one tenant's rows: equality on the org, a venue, or a row id. */
const TENANT_BOUND = /\b(org_id|venue_id|id|[a-z_]+_id)\s*=\s|\b(org_id|venue_id|id|[a-z_]+_id) = ANY/;

function walk(node: PlanNode, visit: (n: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/**
 * Plan every captured statement as the tenant role for `orgId` and report any node that reads a
 * big tenant table without being bound to the tenant: a sequential scan, or an index scan whose
 * condition names no org, venue or row id.
 */
export async function planProblems(env: ScaleEnv, orgId: string, queries: CapturedQuery[], facts: TableFacts): Promise<{ planned: number; problems: PlanProblem[]; plans: Array<{ statement: string; nodes: string[] }> }> {
  const problems: PlanProblem[] = [];
  const plans: Array<{ statement: string; nodes: string[] }> = [];
  let planned = 0;
  const client = await env.pool.connect();
  try {
    for (const q of queries) {
      if (!/^\s*(with|select|insert|update|delete)\b/i.test(q.sql) || /set_config\('role'/.test(q.sql)) continue;
      await client.query('begin');
      try {
        await client.query(`select set_config('role', 'app_tenant', true), set_config('app.org_id', $1, true)`, [orgId]);
        const r = await client.query(`explain (format json) ${q.sql}`, q.parameters as unknown[]);
        planned++;
        const root = (r.rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
        const statement = q.sql.replace(/\s+/g, ' ').slice(0, 160);
        const nodes: string[] = [];
        walk(root, (n) => {
          const table = n['Relation Name'] ?? (n['Index Name'] ? facts.indexTable.get(n['Index Name']) : undefined);
          if (!table) return;
          nodes.push(`${n['Node Type']} ${table}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`);
          if (!facts.big.has(table)) return;
          if (n['Node Type'] === 'Seq Scan') {
            problems.push({ statement, node: 'Seq Scan', table, detail: `sequential scan of ${table} (${facts.big.get(table)} rows)${n.Filter ? `, filter ${n.Filter.slice(0, 120)}` : ''}` });
          } else if (/Index (Only )?Scan|Bitmap Index Scan/.test(n['Node Type'])) {
            const cond = n['Index Cond'] ?? '';
            if (!TENANT_BOUND.test(cond)) problems.push({ statement, node: n['Node Type'], table, detail: `${n['Index Name']} read without a tenant-bound condition (${cond || 'no index condition'})` });
          }
        });
        plans.push({ statement, nodes });
      } finally {
        await client.query('rollback');
      }
    }
  } finally {
    client.release();
  }
  return { planned, problems, plans };
}

// ── The main tenant queries ─────────────────────────────────────────────────

export interface Measurement {
  name: string;
  /** Milliseconds, median of the timed runs (after one warm-up). */
  medianMs: number;
  maxMs: number;
  budgetMs: number;
  statements: number;
  problems: PlanProblem[];
  plans: Array<{ statement: string; nodes: string[] }>;
}

/** Stated budgets for ONE tenant, whatever the database holds in total. Milliseconds, median. */
export const BUDGETS_MS = {
  sales_summary: 250,
  metrics_by_day_ledger: 250,
  metrics_by_channel_ledger: 250,
  metrics_by_day_facts: 100,
  metrics_by_channel_facts: 100,
  customer_search: 60,
  order_list: 60,
  live_tickets: 60,
  rollup_one_org_day: 400,
} as const;

const WORKER: Principal = { kind: 'worker', job: 'scale-test' };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

async function measure(env: ScaleEnv, facts: TableFacts, tenant: ScaleTenant, name: keyof typeof BUDGETS_MS, fn: () => Promise<unknown>, runs: number): Promise<Measurement> {
  const { queries } = await env.capture(fn);
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const planned = await planProblems(env, tenant.orgId, queries, facts);
  return { name, medianMs: Math.round(median(times) * 10) / 10, maxMs: Math.round(Math.max(...times) * 10) / 10, budgetMs: BUDGETS_MS[name], statements: planned.planned, problems: planned.problems, plans: planned.plans };
}

/**
 * The main tenant queries for one org, through the service functions a console page calls.
 * `withFacts` also measures the analytics queries reading the derived facts, which needs the
 * org's facts built first (see `buildFacts`).
 */
export async function measureTenant(env: ScaleEnv, tenant: ScaleTenant, opts: { runs?: number; withFacts?: boolean } = {}): Promise<Measurement[]> {
  const runs = opts.runs ?? 7;
  const facts = await tableFacts(env);
  const as = <T>(fn: (ctx: Ctx) => Promise<T>, who: Principal = tenant.owner) => env.app.tenant(tenant.orgId, who, fn);
  const venueId = tenant.venueIds[0]!;
  const yesterday = addDays(localDate(env.clock(), 'Australia/Sydney'), -1);
  const out: Measurement[] = [];
  const m = async (name: keyof typeof BUDGETS_MS, fn: () => Promise<unknown>) => void out.push(await measure(env, facts, tenant, name, fn, runs));

  await m('sales_summary', () => as((ctx) => analytics.salesSummary(ctx, {})));
  await m('metrics_by_day_ledger', () => as((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], grain: 'day', period: 'last_28_days', source: 'ledger' })));
  await m('metrics_by_channel_ledger', () => as((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: 'last_28_days', source: 'ledger' })));
  if (opts.withFacts) {
    await m('metrics_by_day_facts', () => as((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], grain: 'day', period: 'last_28_days', source: 'facts' })));
    await m('metrics_by_channel_facts', () => as((ctx) => analytics.queryMetrics(ctx, { metrics: ['net_sales', 'orders'], dimensions: ['channel'], period: 'last_28_days', source: 'facts' })));
  }
  await m('customer_search', () => as((ctx) => identity.searchCustomers(ctx, { q: 'nguyen' })));
  await m('order_list', () => as((ctx) => ordering.listOrders(ctx, { venueId, limit: 50 })));
  await m('live_tickets', () => as((ctx) => ordering.listLiveTickets(ctx, { venueId })));
  await m('rollup_one_org_day', () => as((ctx) => analytics.rollupDays(ctx, [yesterday]), WORKER));
  return out;
}

/** Build one org's facts from its ledger (the analytics back-fill), timed. */
export async function buildFacts(env: ScaleEnv, tenant: ScaleTenant): Promise<{ seconds: number; days: number }> {
  const t0 = performance.now();
  const r = await analytics.backfill(env.app, tenant.orgId);
  return { seconds: Math.round((performance.now() - t0) / 100) / 10, days: r.daysExamined };
}

// ── The leak test, at volume ────────────────────────────────────────────────

export interface LeakReport {
  tablesChecked: number;
  leaks: string[];
  /** Rows of the big tables tenant A sees with no filter at all, against its true count. */
  unfiltered: Array<{ table: string; seen: number; own: number; total: number }>;
  orgsSeen: number;
  crossWrite: 'refused' | 'allowed';
  problems: PlanProblem[];
}

/**
 * Tenant A looks for tenant B's rows in every tenant table, counts the big tables with no
 * filter of its own (row-level security must supply it, through an index), and tries to write
 * a row into B.
 */
export async function leakCheck(env: ScaleEnv, a: ScaleTenant, b: ScaleTenant): Promise<LeakReport> {
  const facts = await tableFacts(env);
  const tables = (
    await env.pool.query(
      `select c.relname as name, coalesce(obj_description(c.oid, 'pg_class'), '') as tag
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
         and exists (select 1 from pg_attribute x where x.attrelid = c.oid and x.attname = 'org_id' and not x.attisdropped)
       order by 1`,
    )
  ).rows as Array<{ name: string; tag: string }>;
  const leaks: string[] = [];
  let checked = 0;
  let orgsSeen = 0;
  const unfiltered: LeakReport['unfiltered'] = [];
  const bigOnes = ['transactions', 'transaction_lines', 'customers', 'orders', 'order_items', 'kitchen_tickets', 'jobs'].filter((t) => facts.big.has(t));
  const { queries } = await env.capture(() =>
    env.app.tenant(a.orgId, { kind: 'worker', job: 'leak-test' }, async (ctx) => {
      for (const t of tables) {
        if (t.tag.includes('@platform')) continue;
        const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t.name)} where org_id = ${b.orgId}`.execute(ctx.db);
        checked++;
        if (r.rows[0]!.n > 0) leaks.push(t.name);
      }
      orgsSeen = (await sql<{ id: string }>`select id from orgs`.execute(ctx.db)).rows.length;
      for (const t of bigOnes) {
        const seen = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t)}`.execute(ctx.db);
        unfiltered.push({ table: t, seen: seen.rows[0]!.n, own: 0, total: 0 });
      }
    }),
  );
  for (const u of unfiltered) {
    u.own = Number((await env.pool.query(`select count(*) as n from ${pg.escapeIdentifier(u.table)} where org_id = $1`, [a.orgId])).rows[0].n);
    u.total = facts.big.get(u.table) ?? 0;
  }
  let crossWrite: LeakReport['crossWrite'] = 'allowed';
  try {
    await env.app.tenant(a.orgId, { kind: 'worker', job: 'leak-test' }, (ctx) => ctx.db.insertInto('customers').values({ org_id: b.orgId, first_name: 'Intruder' }).execute());
  } catch (e) {
    if (/row-level security/.test((e as Error).message)) crossWrite = 'refused';
    else throw e;
  }
  const planned = await planProblems(env, a.orgId, queries, facts);
  return { tablesChecked: checked, leaks, unfiltered, orgsSeen, crossWrite, problems: planned.problems };
}

// ── Job claim under contention ──────────────────────────────────────────────

const ran = new Map<string, number>();

export const scaleNoopJob = defineJob({
  kind: 'scale.noop',
  schema: noPayload,
  maxAttempts: 3,
  async handler(_app, job) {
    ran.set(job.id, (ran.get(job.id) ?? 0) + 1);
    // Yield, so workers interleave as they would around real work.
    await new Promise((r) => setImmediate(r));
  },
});

export interface ContentionReport {
  jobs: number;
  workers: number;
  handlerCalls: number;
  ranTwice: number;
  neverRan: number;
  succeeded: number;
  attemptsOverOne: number;
  seconds: number;
  jobsPerSecond: number;
  /** Milliseconds each statement of one claim took against the full queue table (reclaim sweep, pick, mark). */
  claimStatementMs: Array<{ statement: string; ms: number }>;
  problems: PlanProblem[];
  claimPlans: Array<{ statement: string; nodes: string[] }>;
}

/** Queue `jobs` jobs across the seeded orgs and let `workers` workers race for them. */
export async function jobContention(env: ScaleEnv, opts: { jobs: number; workers: number; batch?: number }): Promise<ContentionReport> {
  ran.clear();
  const orgs = (await env.pool.query(`select id from scale.orgs order by n`)).rows.map((r: { id: string }) => r.id);
  const now = env.clock();
  await env.pool.query(
    `insert into jobs (org_id, kind, payload, run_at, status, max_attempts, idempotency_key)
     select ($1::uuid[])[1 + g % array_length($1::uuid[], 1)], 'scale.noop', '{}', $3::timestamptz - (g % 600) * interval '1 second', 'queued', 3, 'scale-noop-' || g
     from generate_series(1, $2::int) g`,
    [orgs, opts.jobs, now],
  );
  await env.pool.query('analyze jobs');
  const queued = (await env.pool.query(`select id from jobs where kind = 'scale.noop'`)).rows.map((r: { id: string }) => r.id);

  // The statements one claim makes, for their plans.
  const first = await env.capture(() => runDueJobs(env.app, { kinds: ['scale.noop'], limit: 1, workerId: 'scale-probe' }));
  // And the tenant-health read of jobs that ran out of attempts: for one org, and for all.
  const health = await env.capture(async () => {
    await deadJobSummary(env.app, [orgs[0]!]);
    await deadJobSummary(env.app);
  });
  const claimStatements = [...first.queries, ...health.queries].filter((q) => /\bjobs\b/.test(q.sql));

  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: opts.workers }, async (_, w) => {
      for (;;) {
        const r = await runDueJobs(env.app, { kinds: ['scale.noop'], limit: opts.batch ?? 25, workerId: `scale-worker-${w}` });
        if (r.ran === 0) break;
      }
    }),
  );
  const elapsed = performance.now() - t0;
  const seconds = Math.round(elapsed / 100) / 10;

  // The queue is the platform's, read across orgs by design: what matters is that it is read through an index.
  const client = await env.pool.connect();
  const problems: PlanProblem[] = [];
  const claimPlans: ContentionReport['claimPlans'] = [];
  try {
    for (const q of claimStatements) {
      if (!/^\s*(select|update)\b/i.test(q.sql)) continue;
      const r = await client.query(`explain (format json) ${q.sql}`, q.parameters as unknown[]);
      const root = (r.rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
      const statement = q.sql.replace(/\s+/g, ' ').slice(0, 160);
      const nodes: string[] = [];
      walk(root, (n) => {
        if (n['Relation Name'] !== 'jobs') return;
        nodes.push(`${n['Node Type']}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`);
        if (n['Node Type'] === 'Seq Scan') problems.push({ statement, node: 'Seq Scan', table: 'jobs', detail: `sequential scan of the job queue${n.Filter ? `, filter ${n.Filter.slice(0, 120)}` : ''}` });
      });
      claimPlans.push({ statement, nodes });
    }
  } finally {
    client.release();
  }
  const rows = (await env.pool.query(`select id, status, attempts from jobs where kind = 'scale.noop'`)).rows as Array<{ id: string; status: string; attempts: number }>;
  return {
    jobs: queued.length,
    workers: opts.workers,
    handlerCalls: [...ran.values()].reduce((s, n) => s + n, 0),
    ranTwice: [...ran.values()].filter((n) => n > 1).length,
    neverRan: queued.filter((id) => !ran.has(id)).length,
    succeeded: rows.filter((r) => r.status === 'succeeded').length,
    attemptsOverOne: rows.filter((r) => r.attempts > 1).length,
    seconds,
    jobsPerSecond: Math.round(queued.length / Math.max(0.001, elapsed / 1000)),
    claimStatementMs: claimStatements.map((q) => ({ statement: q.sql.replace(/\s+/g, ' ').slice(0, 90), ms: Math.round(q.ms * 100) / 100 })),
    problems,
    claimPlans,
  };
}

// ── What a scheduler tick costs ─────────────────────────────────────────────

export interface ScheduleReport {
  orgs: number;
  schedules: number;
  enqueued: number;
  statements: number;
  ms: number;
  perOrgMs: number;
  perOrgStatements: number;
  /** A second tick in the same time bucket: it must enqueue nothing new. */
  secondTickNewJobs: number;
  secondTickMs: number;
  problems: PlanProblem[];
}

/** One `tickSchedules` over every org, with every registered schedule, and the same tick again. */
export async function scheduleCost(env: ScaleEnv): Promise<ScheduleReport> {
  const orgs = Number((await env.pool.query(`select count(*) as n from orgs where status in ('onboarding', 'live')`)).rows[0].n);
  const before = Number((await env.pool.query(`select count(*) as n from jobs`)).rows[0].n);
  const t0 = performance.now();
  const { queries } = await env.capture(() => tickSchedules(env.app));
  const ms = performance.now() - t0;
  const after = Number((await env.pool.query(`select count(*) as n from jobs`)).rows[0].n);
  const t1 = performance.now();
  await tickSchedules(env.app);
  const secondTickMs = performance.now() - t1;
  const again = Number((await env.pool.query(`select count(*) as n from jobs`)).rows[0].n);

  // The scheduler is platform code: it reads across orgs by design. Hold it to "no sequential scan of a big table".
  const facts = await tableFacts(env);
  const distinct = new Map<string, CapturedQuery>();
  for (const q of queries) if (!distinct.has(q.sql)) distinct.set(q.sql, q);
  const problems: PlanProblem[] = [];
  const client = await env.pool.connect();
  try {
    for (const q of distinct.values()) {
      if (!/^\s*(select|insert)\b/i.test(q.sql)) continue;
      const r = await client.query(`explain (format json) ${q.sql}`, q.parameters as unknown[]);
      const root = (r.rows[0]['QUERY PLAN'] as Array<{ Plan: PlanNode }>)[0]!.Plan;
      walk(root, (n) => {
        const table = n['Relation Name'];
        if (table && facts.big.has(table) && n['Node Type'] === 'Seq Scan') problems.push({ statement: q.sql.replace(/\s+/g, ' ').slice(0, 160), node: 'Seq Scan', table, detail: `sequential scan of ${table} (${facts.big.get(table)} rows) on every tick` });
      });
    }
  } finally {
    client.release();
  }
  return {
    orgs,
    schedules: listScheduleDefs().length,
    enqueued: after - before,
    statements: queries.length,
    ms: Math.round(ms),
    perOrgMs: Math.round((ms / Math.max(1, orgs)) * 100) / 100,
    perOrgStatements: Math.round((queries.length / Math.max(1, orgs)) * 10) / 10,
    secondTickNewJobs: again - after,
    secondTickMs: Math.round(secondTickMs),
    problems,
  };
}
