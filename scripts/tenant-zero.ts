/**
 * Tenant-zero acceptance ("Acceptance tests that only real data can give").
 *
 * Given a database and an org whose venue has a connected point of sale, it runs the back-fill
 * and then reports, pass or fail:
 *
 *   1. the ledger against the provider for the period: counts and totals, and every gap named
 *      sale by sale (nothing is rounded away)
 *   2. ingesting twice changes nothing: same rows, same totals, same customers
 *   3. each weekday's share of revenue, through `queryMetrics`, checked to the cent against the
 *      provider's own sales
 *   4. a search of every text and JSON column of the database for a raw card identifier
 *   5. the cross-tenant leak check, against the volume just ingested
 *
 * READ-ONLY TOWARDS THE PROVIDER: the only provider call made here, directly or through the
 * ingest, is "list sales at a location". A connection to a real provider that holds a write
 * scope fails check 0, as the document requires read-only scopes.
 *
 *   DATABASE_URL=… npx tsx scripts/tenant-zero.ts --org united-meat-co
 *       [--months 16]                      how far back to fill and compare (default 16)
 *       [--connection <uuid>]              when the org has more than one POS connection
 *       [--expect-card-count 29442]        the known number of card sales, within --tolerance
 *       [--expect-total 5920000]           the known total in dollars, within --tolerance
 *       [--tolerance 0.02]
 *       [--expect-weekday saturday=0.959]  a known share of revenue (repeatable), within --share-tolerance
 *       [--share-tolerance 0.01]
 *       [--simulate-history 29442]         simulated POS only: ring up this many card sales first
 *       [--simulate-saturday-share 0.959]
 *       [--create-simulated-org]           simulated providers only: first create --org as a new org with one
 *                                          venue connected to the simulated POS (a clean ledger to test on)
 *
 * To try it now, with no real provider (any empty migrated database, e.g. the one `pnpm dev:db` prints):
 *   DATABASE_URL=… npx tsx scripts/tenant-zero.ts --org tz-trial --create-simulated-org \
 *     --simulate-history 29442 --expect-card-count 29442 --expect-weekday saturday=0.959
 *
 * Providers come from the environment exactly as for the running app (packages/runtime:
 * ROS_ADAPTERS=sim | mixed | live, and the provider variables). Exit status 0 only when every
 * check passes.
 */
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import {
  type App,
  type ConnectionHandle,
  type Ctx,
  type PosAdapter,
  type Principal,
  type TxnStatus,
  adapterFor,
  addDays,
  getPlug,
  isAppError,
  localDate,
  resolveConnection,
  zonedTimeToUtc,
} from '@ros/core';
import type { SimPosAdapter } from '@ros/adapters';
import { analytics, ledger } from '@ros/modules';

const WORKER: Principal = { kind: 'worker', job: 'tenant-zero' };
const COUNTED: TxnStatus[] = ['completed', 'refunded', 'partially_refunded'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
/** A gap is always listed sale by sale. Past this many the rest are counted, and the run has failed anyway. */
const GAP_LINES_SHOWN = 500;
/** Sales left out on purpose are not gaps: a sample is shown and the rest counted by reason. */
const EXPLAINED_LINES_SHOWN = 12;

export interface TenantZeroOptions {
  /** The org's slug or id. Named by the operator on the command line; never read from a request. */
  org: string;
  months?: number;
  connectionId?: string;
  expect?: {
    cardCount?: number;
    totalCents?: number;
    /** Relative tolerance for the two above. Default 0.02. */
    tolerance?: number;
    /** weekday → share of gross sales, e.g. { saturday: 0.959 }. */
    weekdayShare?: Record<string, number>;
    /** Absolute tolerance for a share. Default 0.01. */
    shareTolerance?: number;
  };
  pageSize?: number;
  onProgress?: (line: string) => void;
}

export interface TenantZeroCheck {
  key: 'connection' | 'backfill' | 'totals' | 'idempotent' | 'weekday_share' | 'card_identifiers' | 'isolation';
  title: string;
  ok: boolean;
  lines: string[];
}

export interface TenantZeroNumbers {
  from: string;
  to: string;
  provider: { sales: number; cardSales: number; totalCents: number; refundedCents: number };
  ledger: { sales: number; cardSales: number; totalCents: number; refundedCents: number };
  gaps: { missing: number; different: number; extra: number; explained: number };
  firstRun: { fetched: number; created: number; changed: number; unchanged: number; skipped: number; seconds: number };
  secondRun: { fetched: number; created: number; changed: number; unchanged: number; skipped: number; seconds: number };
  weekdayShare: Record<string, number>;
  cardSearch: { columns: number; values: number; identifiersKnown: number; hits: number };
  isolation: { tablesChecked: number; orgsProbed: number; leaks: number };
}

export interface TenantZeroReport {
  ok: boolean;
  checks: TenantZeroCheck[];
  numbers: TenantZeroNumbers;
  /** The plain report, as printed. It never contains a card identifier or a guest's contact detail. */
  text: string;
}

const dollars = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number): string => n.toLocaleString('en-AU');
const pct = (v: number): string => `${(v * 100).toFixed(2)}%`;

interface ProviderSale {
  ref: string;
  status: TxnStatus;
  totalCents: number;
  refundedCents: number;
  tender: string | null;
  occurredAt: Date;
  locationRef: string | null;
  originatedHere: boolean;
}

const CARD_KEYS = new Set(['fingerprint', 'payment_account_reference', 'par', 'card_fingerprint']);

/** Every card identifier a provider payload carries, by key, at any depth. Held in memory only. */
function collectCardValues(raw: unknown, into: Set<string>, depth = 0): void {
  if (raw === null || typeof raw !== 'object' || depth > 12) return;
  if (Array.isArray(raw)) {
    for (const v of raw) collectCardValues(v, into, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (CARD_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v.length >= 6) into.add(v);
    else collectCardValues(v, into, depth + 1);
  }
}

interface IngestTotals {
  fetched: number;
  created: number;
  changed: number;
  unchanged: number;
  skipped: number;
  seconds: number;
  failed: string[];
}

/** Ask for the back-fill and run it, and the rolling sync after it, to the end. Returns what was read and written. */
async function runIngest(app: App, orgId: string, connectionId: string, months: number, pageSize: number, onProgress?: (l: string) => void): Promise<IngestTotals & { from: Date }> {
  const t0 = Date.now();
  const { from } = await app.tenant(orgId, WORKER, (ctx) => ledger.requestPosBackfill(ctx, { connectionId, months }));
  const total: IngestTotals = { fetched: 0, created: 0, changed: 0, unchanged: 0, skipped: 0, seconds: 0, failed: [] };
  for (const stream of [ledger.POS_BACKFILL_STREAM, ledger.POS_STREAM] as const) {
    for (let round = 0; round < 100_000; round++) {
      let r: ledger.IngestResult;
      try {
        r = await ledger.ingestConnection(app, { orgId, connectionId, stream, pageSize, maxPages: 50 });
      } catch (e) {
        // Sales the ledger refused: named, never dropped. Anything else is a real failure.
        if (isAppError(e) && e.code === 'conflict') {
          total.failed.push(...(((e.details as { externalRefs?: string[] } | undefined)?.externalRefs ?? ['(unnamed)']) as string[]));
          break;
        }
        throw e;
      }
      total.fetched += r.fetched;
      total.created += r.created;
      total.changed += r.changed;
      total.unchanged += r.unchanged;
      total.skipped += r.skipped;
      if (r.status === 'partial') onProgress?.(`  ${stream}: ${num(total.fetched)} sales read so far`);
      if (r.status !== 'partial') break;
    }
  }
  total.seconds = Math.round((Date.now() - t0) / 100) / 10;
  return { ...total, from };
}

/** The provider's own list of sales changed in the window: one read-only call per page. */
async function readProvider(adapter: PosAdapter, handle: ConnectionHandle, args: { locationRef: string; since: Date; until: Date; pageSize: number }, cardValues: Set<string>): Promise<Map<string, ProviderSale>> {
  const out = new Map<string, ProviderSale>();
  let cursor: string | null = null;
  for (let page = 0; page < 1_000_000; page++) {
    const batch = await adapter.listTransactions(handle, { locationRef: args.locationRef, since: args.since, until: args.until, cursor, limit: args.pageSize });
    for (const t of batch.items) {
      for (const h of t.identityHints) if (h.kind === 'card_fingerprint' || h.kind === 'card_par') cardValues.add(h.value);
      collectCardValues(t.raw, cardValues);
      out.set(t.externalRef, {
        ref: t.externalRef,
        status: t.status,
        totalCents: t.totalCents,
        refundedCents: t.refundedCents,
        tender: t.tenderType ?? null,
        occurredAt: t.occurredAt,
        locationRef: t.locationRef ?? null,
        originatedHere: t.originatedHere === true,
      });
    }
    cursor = batch.nextCursor;
    if (!cursor) break;
  }
  return out;
}

interface LedgerSale {
  ref: string;
  status: TxnStatus;
  totalCents: number;
  refundedCents: number;
  tender: string | null;
  occurredAt: Date;
}

async function readLedger(ctx: Ctx, venueId: string, source: string): Promise<Map<string, LedgerSale>> {
  const rows = await ctx.db
    .selectFrom('transactions')
    .select(['external_ref', 'status', 'total_cents', 'refunded_cents', 'tender_type', 'occurred_at'])
    .where('venue_id', '=', venueId)
    .where('source', '=', source as never)
    .execute();
  return new Map(rows.map((r) => [r.external_ref, { ref: r.external_ref, status: r.status, totalCents: r.total_cents, refundedCents: r.refunded_cents, tender: r.tender_type, occurredAt: r.occurred_at }]));
}

/** Everything the ingest writes for this org, as one comparable fingerprint. */
async function ledgerFingerprint(ctx: Ctx): Promise<Record<string, string | number>> {
  const t = await sql<{ n: string; total: string; refunded: string; digest: string | null; touched: Date | null }>`
    select count(*) as n, coalesce(sum(total_cents), 0) as total, coalesce(sum(refunded_cents), 0) as refunded,
           md5(string_agg(source || ':' || external_ref || ':' || status || ':' || total_cents || ':' || refunded_cents || ':' || coalesce(customer_id::text, ''), ',' order by source, external_ref)) as digest,
           max(updated_at) as touched
    from transactions where org_id = ${ctx.orgId}`.execute(ctx.db);
  const l = await sql<{ n: string; total: string }>`select count(*) as n, coalesce(sum(total_cents), 0) as total from transaction_lines where org_id = ${ctx.orgId}`.execute(ctx.db);
  const c = await sql<{ customers: string; identities: string; attributions: string }>`
    select (select count(*) from customers where org_id = ${ctx.orgId}) as customers,
           (select count(*) from customer_identities where org_id = ${ctx.orgId}) as identities,
           (select count(*) from transaction_attributions where org_id = ${ctx.orgId}) as attributions`.execute(ctx.db);
  const row = t.rows[0]!;
  return {
    sales: Number(row.n),
    total_cents: Number(row.total),
    refunded_cents: Number(row.refunded),
    sales_digest: row.digest ?? '',
    last_changed: row.touched ? row.touched.toISOString() : '',
    lines: Number(l.rows[0]!.n),
    lines_total_cents: Number(l.rows[0]!.total),
    customers: Number(c.rows[0]!.customers),
    identities: Number(c.rows[0]!.identities),
    attributions: Number(c.rows[0]!.attributions),
  };
}

/**
 * Search every text and JSON column of the database for a raw card identifier. Two ways:
 * by KEY (a JSON column holding a fingerprint or payment-account-reference key at all), in SQL;
 * and by VALUE (any of the identifiers the provider returned during this run), by reading each
 * column and comparing here, so the identifiers are never sent to the database or written out.
 */
async function searchForCardIdentifiers(app: App, cardValues: Set<string>): Promise<{ hits: string[]; columns: number; values: number }> {
  const cols = await sql<{ table_name: string; column_name: string; data_type: string; udt_name: string }>`
    select c.table_name, c.column_name, c.data_type, c.udt_name
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.table_name <> 'schema_migrations'
      and (c.data_type in ('text', 'character varying', 'character', 'json', 'jsonb') or c.udt_name in ('citext', '_text', '_varchar', '_citext'))
    order by c.table_name, c.ordinal_position`.execute(app.db);
  const hits: string[] = [];
  let values = 0;
  const SPLIT = /["'\s,{}[\]()<>;|]+/;
  for (const col of cols.rows) {
    const ref = sql`${sql.table(col.table_name)}`;
    const column = sql.ref(col.column_name);
    if (col.data_type === 'json' || col.data_type === 'jsonb') {
      // The platform reads across orgs here on purpose: this is a check of the whole database.
      const keyed = await sql<{ n: string }>`select count(*) as n from ${ref} where ${column}::text ~* '"(fingerprint|payment_account_reference|par|card_fingerprint)"\\s*:'`.execute(app.db);
      if (Number(keyed.rows[0]!.n) > 0) hits.push(`${col.table_name}.${col.column_name}: ${num(Number(keyed.rows[0]!.n))} row(s) hold a card-identifier key`);
    }
    if (!cardValues.size) continue;
    let found = 0;
    await app.db.transaction().execute(async (trx) => {
      await sql`declare tz_scan no scroll cursor for select ${column}::text as v from ${ref} where ${column} is not null`.execute(trx);
      for (;;) {
        const batch = await sql<{ v: string }>`fetch 5000 from tz_scan`.execute(trx);
        if (!batch.rows.length) break;
        for (const r of batch.rows) {
          values++;
          if (cardValues.has(r.v)) found++;
          else if (r.v.length >= 6) for (const token of r.v.split(SPLIT)) if (token.length >= 6 && cardValues.has(token)) found++;
        }
      }
      await sql`close tz_scan`.execute(trx);
    });
    if (found) hits.push(`${col.table_name}.${col.column_name}: ${num(found)} raw card identifier(s) found`);
  }
  const unhashed = await sql<{ n: string }>`select count(*) as n from customer_identities where kind in ('card_fingerprint', 'card_par') and value !~ '^[0-9a-f]{64}$'`.execute(app.db);
  if (Number(unhashed.rows[0]!.n) > 0) hits.push(`customer_identities.value: ${num(Number(unhashed.rows[0]!.n))} card link(s) are not hashed`);
  return { hits, columns: cols.rows.length, values };
}

/** Other orgs (and an org that does not exist) look for this org's rows in every tenant table. */
async function isolationCheck(app: App, orgId: string): Promise<{ lines: string[]; leaks: string[]; tablesChecked: number; orgsProbed: number }> {
  const tables = (
    await sql<{ name: string; tag: string }>`
      select c.relname as name, coalesce(obj_description(c.oid, 'pg_class'), '') as tag
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
        and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped)
      order by 1`.execute(app.db)
  ).rows.filter((t) => !t.tag.includes('@platform'));
  // Platform lookup: which other orgs share this database. An org id that names no org at all is probed as well.
  const others = (await app.db.selectFrom('orgs').select(['id', 'slug']).where('id', '!=', orgId).orderBy('created_at').limit(5).execute()).map((o) => ({ id: o.id, label: `org "${o.slug}"` }));
  const probes = [...others, { id: '00000000-0000-4000-8000-00000000dead', label: 'an org id that names no org' }];
  const leaks: string[] = [];
  const lines: string[] = [];
  let tablesChecked = 0;
  const own = Number((await app.db.selectFrom('transactions').select((eb) => eb.fn.countAll<string>().as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow()).n);
  for (const probe of probes) {
    let seenRows = 0;
    await app.tenant(probe.id, { kind: 'worker', job: 'tenant-zero-leak-check' }, async (ctx) => {
      for (const t of tables) {
        const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(t.name)} where org_id = ${orgId}`.execute(ctx.db);
        tablesChecked++;
        if (r.rows[0]!.n > 0) {
          seenRows += r.rows[0]!.n;
          leaks.push(`${probe.label} can read ${num(r.rows[0]!.n)} row(s) of ${t.name}`);
        }
      }
      const orgRow = await sql<{ n: number }>`select count(*)::int as n from orgs where id = ${orgId}`.execute(ctx.db);
      if (orgRow.rows[0]!.n > 0) leaks.push(`${probe.label} can read the org row`);
    });
    try {
      await app.tenant(probe.id, { kind: 'worker', job: 'tenant-zero-leak-check' }, (ctx) => ctx.db.insertInto('customers').values({ org_id: orgId, first_name: 'Leak check' }).execute());
      leaks.push(`${probe.label} could write a customer into this org`);
      // It should never get here; if it did, take the row out again.
      await app.db.deleteFrom('customers').where('org_id', '=', orgId).where('first_name', '=', 'Leak check').execute();
    } catch (e) {
      if (!/row-level security/.test((e as Error).message)) throw e;
    }
    lines.push(`${probe.label}: ${seenRows ? `reads ${num(seenRows)} row(s)` : 'reads no row'} of this org across ${tables.length} tenant tables; a write into it is refused`);
  }
  const seenByOwner = await app.tenant(orgId, { kind: 'worker', job: 'tenant-zero-leak-check' }, async (ctx) => ({
    orgs: (await sql<{ id: string }>`select id from orgs`.execute(ctx.db)).rows.length,
    sales: (await sql<{ n: number }>`select count(*)::int as n from transactions`.execute(ctx.db)).rows[0]!.n,
  }));
  if (seenByOwner.orgs !== 1) leaks.push(`this org sees ${seenByOwner.orgs} orgs`);
  if (seenByOwner.sales !== own) leaks.push(`this org sees ${num(seenByOwner.sales)} sales with no filter; its own are ${num(own)}`);
  lines.push(`this org, with no filter of its own, sees ${num(seenByOwner.sales)} sales (its own: ${num(own)}) and ${seenByOwner.orgs} org`);
  return { lines, leaks, tablesChecked, orgsProbed: probes.length };
}

/** Run the acceptance checks for one org. Throws only for something that stops the run; a failed check is in the report. */
export async function tenantZeroAcceptance(app: App, opts: TenantZeroOptions): Promise<TenantZeroReport> {
  const months = opts.months ?? 16;
  const pageSize = opts.pageSize ?? 100;
  const say = opts.onProgress ?? (() => undefined);
  const checks: TenantZeroCheck[] = [];
  const add = (key: TenantZeroCheck['key'], title: string, ok: boolean, lines: string[]) => void checks.push({ key, title, ok, lines });

  // The operator names the org; it is looked up as the platform, before any tenant is known.
  const isId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opts.org);
  const org = await app.db.selectFrom('orgs').select(['id', 'slug', 'trading_name', 'timezone']).where(isId ? 'id' : 'slug', '=', opts.org).executeTakeFirst();
  if (!org) throw new Error(`No org "${opts.org}" in this database.`);

  const connections = (await app.tenant(org.id, WORKER, (ctx) => ledger.livePosConnections(ctx))).filter((c) => !opts.connectionId || c.id === opts.connectionId);
  if (!connections.length) throw new Error(`Org "${org.slug}" has no connected point of sale${opts.connectionId ? ' with that id' : ''}.`);
  if (connections.length > 1) throw new Error(`Org "${org.slug}" has ${connections.length} POS connections. Name one with --connection: ${connections.map((c) => c.id).join(', ')}`);
  const conn = connections[0]!;
  const plug = getPlug(conn.plugKey);
  const adapter = adapterFor(app, 'pos', conn.row);
  const venue = await app.tenant(org.id, WORKER, (ctx) => ctx.db.selectFrom('venues').select(['id', 'name', 'timezone']).where('id', '=', conn.venueId).executeTakeFirstOrThrow());

  // 0. Read-only towards the provider.
  const writeScopes = conn.row.scopes.filter((s) => /write/i.test(s));
  add(
    'connection',
    'The connection is read-only',
    plug.simulated === true || writeScopes.length === 0,
    [
      `${plug.name} at ${venue.name}, location ${conn.locationRef}; scopes: ${conn.row.scopes.join(', ') || '(none)'}`,
      writeScopes.length
        ? plug.simulated
          ? `The simulated POS holds ${writeScopes.join(', ')}: allowed for a simulator, not for a real provider.`
          : `It holds ${writeScopes.join(', ')}. Tenant zero is read-only: reconnect with read scopes only.`
        : 'It holds no write scope.',
      'This script calls the provider only to list sales.',
    ],
  );

  // 1. The back-fill, then the provider read for the same window.
  say(`Back-filling ${months} months from ${plug.name}…`);
  const first = await runIngest(app, org.id, conn.id, months, pageSize, say);
  const until = app.clock();
  add('backfill', 'The back-fill ran to the end', first.failed.length === 0, [
    `${num(first.fetched)} sales read, ${num(first.created)} recorded, ${num(first.changed)} updated, ${num(first.unchanged)} already there, ${num(first.skipped)} skipped, in ${first.seconds}s`,
    ...(first.failed.length ? [`${first.failed.length} sale(s) could not be recorded: ${first.failed.slice(0, 50).join(', ')}`] : []),
  ]);

  say('Reading the provider\'s own list for the same period…');
  const cardValues = new Set<string>();
  const handle = await resolveConnection(app, conn.row);
  const provider = await readProvider(adapter, handle, { locationRef: conn.locationRef, since: first.from, until, pageSize }, cardValues);
  const ledgerSales = await app.tenant(org.id, WORKER, (ctx) => readLedger(ctx, conn.venueId, adapter.source));

  // Sales this platform took itself are recorded by the ordering module under 'online-order'.
  const ownOrders = new Set(
    (await app.tenant(org.id, WORKER, (ctx) => ctx.db.selectFrom('transactions').select('external_ref').where('venue_id', '=', conn.venueId).where('source', '=', 'online-order').execute())).map((r) => r.external_ref),
  );
  const now = app.clock();
  const fromDay = localDate(first.from, venue.timezone);
  const toDay = localDate(until, venue.timezone);
  const inPeriod = (at: Date) => at >= first.from && at <= until;
  const when = (at: Date) => at.toISOString().slice(0, 16).replace('T', ' ');

  const missing: string[] = [];
  const different: string[] = [];
  const extra: string[] = [];
  const explained: string[] = [];
  const expected: ProviderSale[] = [];
  for (const p of provider.values()) {
    const l = ledgerSales.get(p.ref);
    if (p.locationRef && p.locationRef !== conn.locationRef) {
      explained.push(`${p.ref}  ${when(p.occurredAt)}Z  ${dollars(p.totalCents)}  not counted: it was taken at another location (${p.locationRef})`);
      continue;
    }
    if (p.originatedHere && (ownOrders.has(p.ref) || now.getTime() - p.occurredAt.getTime() < ledger.OWN_SALE_GRACE_MINUTES * 60_000)) {
      explained.push(`${p.ref}  ${when(p.occurredAt)}Z  ${dollars(p.totalCents)}  not counted: it was taken through this platform, which records its own sales`);
      continue;
    }
    if (p.status === 'voided' && !l) {
      explained.push(`${p.ref}  ${when(p.occurredAt)}Z  ${dollars(p.totalCents)}  not counted: it was cancelled before it was ever a sale`);
      continue;
    }
    expected.push(p);
    if (!l) missing.push(`${p.ref}  ${when(p.occurredAt)}Z  provider ${dollars(p.totalCents)} ${p.status}  ledger: absent`);
    else if (l.totalCents !== p.totalCents || l.refundedCents !== p.refundedCents || l.status !== p.status) {
      different.push(`${p.ref}  ${when(p.occurredAt)}Z  provider ${dollars(p.totalCents)} ${p.status} (refunded ${dollars(p.refundedCents)})  ledger ${dollars(l.totalCents)} ${l.status} (refunded ${dollars(l.refundedCents)})`);
    }
  }
  for (const l of ledgerSales.values()) {
    if (inPeriod(l.occurredAt) && !provider.has(l.ref)) extra.push(`${l.ref}  ${when(l.occurredAt)}Z  ledger ${dollars(l.totalCents)} ${l.status}  provider: absent`);
  }

  const isCard = (tender: string | null) => (tender ?? '').toLowerCase() === 'card';
  const sum = <T extends { status: TxnStatus; totalCents: number; refundedCents: number; tender: string | null; occurredAt: Date }>(xs: Iterable<T>) => {
    const out = { sales: 0, cardSales: 0, totalCents: 0, refundedCents: 0 };
    for (const x of xs) {
      if (!COUNTED.includes(x.status) || !inPeriod(x.occurredAt)) continue;
      out.sales++;
      if (isCard(x.tender)) out.cardSales++;
      out.totalCents += x.totalCents;
      out.refundedCents += x.refundedCents;
    }
    return out;
  };
  const providerTotals = sum(expected);
  const ledgerTotals = sum(ledgerSales.values());
  const gapCount = missing.length + different.length + extra.length;
  const totalsMatch = providerTotals.sales === ledgerTotals.sales && providerTotals.totalCents === ledgerTotals.totalCents && providerTotals.refundedCents === ledgerTotals.refundedCents && providerTotals.cardSales === ledgerTotals.cardSales;
  const tolerance = opts.expect?.tolerance ?? 0.02;
  const expectLines: string[] = [];
  let expectOk = true;
  const near = (actual: number, wanted: number) => Math.abs(actual - wanted) <= Math.abs(wanted) * tolerance;
  if (opts.expect?.cardCount !== undefined) {
    const ok = near(ledgerTotals.cardSales, opts.expect.cardCount);
    expectOk &&= ok;
    expectLines.push(`Known figure: about ${num(opts.expect.cardCount)} card sales. Ledger: ${num(ledgerTotals.cardSales)} (${ok ? 'within' : 'OUTSIDE'} ${pct(tolerance)}).`);
  }
  if (opts.expect?.totalCents !== undefined) {
    const ok = near(ledgerTotals.totalCents, opts.expect.totalCents);
    expectOk &&= ok;
    expectLines.push(`Known figure: about ${dollars(opts.expect.totalCents)}. Ledger: ${dollars(ledgerTotals.totalCents)} (${ok ? 'within' : 'OUTSIDE'} ${pct(tolerance)}).`);
  }
  const shown = (title: string, xs: string[], limit = GAP_LINES_SHOWN) => (xs.length ? [`${title} (${num(xs.length)}):`, ...xs.slice(0, limit).map((x) => `    ${x}`), ...(xs.length > limit ? [`    … and ${num(xs.length - limit)} more`] : [])] : []);
  const reasons = new Map<string, number>();
  for (const e of explained) {
    const reason = e.slice(e.indexOf('not counted: ') + 'not counted: '.length).replace(/ \(.*\)$/, '');
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  add('totals', `Ledger totals match ${plug.name} for ${fromDay} to ${toDay}`, totalsMatch && gapCount === 0 && expectOk, [
    `Provider: ${num(providerTotals.sales)} sales (${num(providerTotals.cardSales)} by card), ${dollars(providerTotals.totalCents)}, refunded ${dollars(providerTotals.refundedCents)}`,
    `Ledger:   ${num(ledgerTotals.sales)} sales (${num(ledgerTotals.cardSales)} by card), ${dollars(ledgerTotals.totalCents)}, refunded ${dollars(ledgerTotals.refundedCents)}`,
    `Difference: ${num(ledgerTotals.sales - providerTotals.sales)} sales, ${dollars(ledgerTotals.totalCents - providerTotals.totalCents)}`,
    ...expectLines,
    gapCount ? `${num(gapCount)} gap(s), each listed below.` : 'No gap: every sale the provider lists is in the ledger with the same amount, refund and status, and the ledger holds no other.',
    ...shown('At the provider, not in the ledger', missing),
    ...shown('In both, with different figures', different),
    ...shown('In the ledger, not at the provider', extra),
    ...[...reasons].map(([reason, n]) => `Left out on purpose, ${num(n)}: ${reason}.`),
    ...shown('Listed by the provider and left out on purpose', explained, EXPLAINED_LINES_SHOWN),
  ]);

  // 2. Ingest twice: nothing changes.
  say('Running the same ingest again…');
  const before = await app.tenant(org.id, WORKER, (ctx) => ledgerFingerprint(ctx));
  const second = await runIngest(app, org.id, conn.id, months, pageSize, say);
  const after = await app.tenant(org.id, WORKER, (ctx) => ledgerFingerprint(ctx));
  const changedKeys = Object.keys(before).filter((k) => before[k] !== after[k]);
  add('idempotent', 'Ingesting twice changes nothing', changedKeys.length === 0 && second.created === 0 && second.changed === 0 && second.failed.length === 0, [
    `Second run: ${num(second.fetched)} sales read, ${num(second.created)} recorded, ${num(second.changed)} updated, ${num(second.unchanged)} unchanged, in ${second.seconds}s`,
    `Before: ${num(Number(before.sales))} sales, ${dollars(Number(before.total_cents))}, ${num(Number(before.lines))} lines, ${num(Number(before.customers))} customers, ${num(Number(before.identities))} identities`,
    `After:  ${num(Number(after.sales))} sales, ${dollars(Number(after.total_cents))}, ${num(Number(after.lines))} lines, ${num(Number(after.customers))} customers, ${num(Number(after.identities))} identities`,
    changedKeys.length ? `Changed: ${changedKeys.join(', ')}` : 'Row counts, totals, the digest of every sale and the time of the last change are identical.',
  ]);

  // 3. Each weekday's share of revenue, through queryMetrics, against the provider's own sales.
  say('Working out each weekday\'s share of revenue…');
  await analytics.rollup(app, org.id);
  const query = (source: 'auto' | 'ledger') =>
    app.tenant(org.id, WORKER, (ctx) =>
      analytics.queryMetrics(ctx, { metrics: ['gross_sales', 'orders'], dimensions: ['day_of_week'], period: { from: fromDay, to: toDay }, filters: { venue: [conn.venueId], source: [adapter.source] }, source }),
    );
  const [auto, fromLedger] = [await query('auto'), await query('ledger')];
  const byDay = (r: analytics.MetricResult) => Object.fromEntries(WEEKDAYS.map((d) => [d, Number(r.rows.find((row) => row.dimensions.day_of_week === d)?.values.gross_sales ?? 0)])) as Record<string, number>;
  const measured = byDay(auto);
  const measuredLedger = byDay(fromLedger);
  // The oracle: the same sum made here from the provider's list, by the venue's own calendar day.
  const oracle: Record<string, number> = Object.fromEntries(WEEKDAYS.map((d) => [d, 0]));
  for (const p of expected) {
    if (!COUNTED.includes(p.status)) continue;
    const day = localDate(p.occurredAt, venue.timezone);
    if (day < fromDay || day > toDay) continue;
    oracle[WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]!]! += p.totalCents;
  }
  const grand = Object.values(measured).reduce((s, v) => s + v, 0);
  const share: Record<string, number> = Object.fromEntries(WEEKDAYS.map((d) => [d, grand ? measured[d]! / grand : 0]));
  const wrongDays = WEEKDAYS.filter((d) => measured[d] !== oracle[d] || measuredLedger[d] !== oracle[d]);
  const shareTolerance = opts.expect?.shareTolerance ?? 0.01;
  const shareLines: string[] = [];
  let shareOk = true;
  for (const [day, wanted] of Object.entries(opts.expect?.weekdayShare ?? {})) {
    const got = share[day.toLowerCase()];
    const ok = got !== undefined && Math.abs(got - wanted) <= shareTolerance;
    shareOk &&= ok;
    shareLines.push(`Known figure: ${day} is about ${pct(wanted)} of revenue. Measured: ${got === undefined ? 'no such weekday' : pct(got)} (${ok ? 'within' : 'OUTSIDE'} ${pct(shareTolerance)}).`);
  }
  add('weekday_share', 'Revenue by weekday through queryMetrics agrees with the provider to the cent', wrongDays.length === 0 && grand > 0 && shareOk, [
    `Period ${auto.period.from} to ${auto.period.to} (${auto.period.timezone}); read from ${auto.sources.map((s) => s.read_from).join(', ')} and, forced, from the ledger.`,
    ...WEEKDAYS.map((d) => `  ${d.padEnd(10)}${pct(share[d]!).padStart(8)}  ${dollars(measured[d]!).padStart(16)}${measured[d] === oracle[d] && measuredLedger[d] === oracle[d] ? '' : `   DIFFERS: provider ${dollars(oracle[d]!)}, ledger read ${dollars(measuredLedger[d]!)}`}`),
    `  ${'total'.padEnd(10)}${''.padStart(8)}  ${dollars(grand).padStart(16)}`,
    ...shareLines,
    ...(grand === 0 ? ['No revenue was measured for the period.'] : []),
  ]);

  // 4. No raw card identifier anywhere.
  say('Searching every text and JSON column for a raw card identifier…');
  const search = await searchForCardIdentifiers(app, cardValues);
  add('card_identifiers', 'No raw card identifier is stored anywhere', search.hits.length === 0, [
    `${num(search.columns)} text and JSON columns searched across the whole database${cardValues.size ? `; ${num(search.values)} values compared against the ${num(cardValues.size)} card identifiers the provider returned in this run` : ''}.`,
    cardValues.size ? 'The identifiers were held in this process only: none was sent to the database, logged or printed.' : 'The provider returned no card identifier in the period, so only the search by key could be made.',
    ...(search.hits.length ? search.hits.map((h) => `  FOUND  ${h}`) : ['None found, by key or by value. Card links, where a guest ticked the card box, are stored only as per-org hashes.']),
  ]);

  // 5. Isolation.
  say('Checking that no other org can read a row of this one…');
  const iso = await isolationCheck(app, org.id);
  add('isolation', 'No other org can read or write a row of this org', iso.leaks.length === 0, [...iso.lines, ...iso.leaks.map((l) => `  LEAK  ${l}`)]);

  const numbers: TenantZeroNumbers = {
    from: fromDay,
    to: toDay,
    provider: providerTotals,
    ledger: ledgerTotals,
    gaps: { missing: missing.length, different: different.length, extra: extra.length, explained: explained.length },
    firstRun: { fetched: first.fetched, created: first.created, changed: first.changed, unchanged: first.unchanged, skipped: first.skipped, seconds: first.seconds },
    secondRun: { fetched: second.fetched, created: second.created, changed: second.changed, unchanged: second.unchanged, skipped: second.skipped, seconds: second.seconds },
    weekdayShare: share,
    cardSearch: { columns: search.columns, values: search.values, identifiersKnown: cardValues.size, hits: search.hits.length },
    isolation: { tablesChecked: iso.tablesChecked, orgsProbed: iso.orgsProbed, leaks: iso.leaks.length },
  };
  const ok = checks.every((c) => c.ok);
  const text = [
    `TENANT ZERO ACCEPTANCE: ${org.trading_name} (${org.slug})`,
    `${plug.name} at ${venue.name}, ${fromDay} to ${toDay}, ${months} months. Run at ${until.toISOString()}.`,
    '',
    ...checks.flatMap((c, i) => [`${i}. ${c.ok ? 'PASS' : 'FAIL'}  ${c.title}`, ...c.lines.map((l) => `     ${l}`), '']),
    ok ? 'RESULT: PASS. Every check passed.' : `RESULT: FAIL. ${checks.filter((c) => !c.ok).length} of ${checks.length} checks failed: ${checks.filter((c) => !c.ok).map((c) => c.title).join('; ')}.`,
  ].join('\n');
  return { ok, checks, numbers, text };
}

// ── A simulated history, shaped like tenant zero's ──────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatedHistory {
  /** Card sales that count. */
  cardSales: number;
  cashSales: number;
  refunded: number;
  /** Rung up and cancelled before they completed: the provider lists them, the ledger never holds them. */
  voided: number;
  /** Made through this platform's application at the provider but with no order held here: counted like any other sale. */
  platformSales: number;
  customers: number;
}

/**
 * Ring up a history on the simulated POS that looks like a Saturday butcher: almost all of the
 * revenue on Saturdays, about $200 a sale, a share of named customers who come back, every card
 * sale carrying a fingerprint and a payment account reference, a few refunds, a few cancelled
 * payments. Deterministic for a seed.
 */
export function simulateHistory(
  pos: SimPosAdapter,
  args: { accountRef: string; locationRef: string; cardSales: number; months: number; now: Date; timezone: string; saturdayShare?: number; seed?: number },
): SimulatedHistory {
  const rand = rng(args.seed ?? 20260930);
  const today = localDate(args.now, args.timezone);
  const days = Math.max(14, Math.floor(args.months * 30.4) - 2);
  const saturdays: string[] = [];
  const otherDays: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(today, -i);
    (new Date(`${d}T12:00:00Z`).getUTCDay() === 6 ? saturdays : otherDays).push(d);
  }
  const satShare = args.saturdayShare ?? 0.959;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const cuts: Array<[string, number]> = [['Rib eye', 8900], ['Lamb shoulder', 6400], ['Pork belly', 4200], ['Beef mince 1kg', 2400], ['Chicken thigh 1kg', 1900], ['Scotch fillet', 7600], ['Sausages 500g', 1400], ['Brisket', 9800]];
  const customerPool = Math.max(10, Math.floor(args.cardSales * 0.55));
  const out: SimulatedHistory = { cardSales: 0, cashSales: 0, refunded: 0, voided: 0, platformSales: 0, customers: customerPool };
  const sale = (tender: 'card' | 'cash', extra: { status?: 'completed' | 'pending'; originatedHere?: boolean } = {}) => {
    const day = rand() < satShare ? pick(saturdays) : pick(otherDays);
    const minute = 7 * 60 + Math.floor(rand() * 8 * 60);
    const at = zonedTimeToUtc(day, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}`, args.timezone);
    const lines = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => {
      const [name, unitPriceCents] = pick(cuts);
      return { name, unitPriceCents, qty: 1 + Math.floor(rand() * 2), category: 'Butchery' };
    });
    const known = rand() < 0.4 ? Math.floor(rand() * customerPool) : null;
    return pos.createSale({
      accountRef: args.accountRef,
      locationRef: args.locationRef,
      at,
      lines,
      tender,
      channel: 'retail',
      ...(known !== null ? { customer: { email: `guest${known}@history.example`, firstName: `Guest${known % 50}`, lastName: `Number${known}` } } : {}),
      ...extra,
    });
  };
  for (let i = 0; i < args.cardSales; i++) {
    const p = sale('card');
    out.cardSales++;
    if (rand() < 0.01) {
      pos.refund(p.id, rand() < 0.5 ? undefined : Math.max(100, Math.floor(p.total_money.amount / 2)));
      out.refunded++;
    }
  }
  for (let i = 0; i < Math.round(args.cardSales * 0.02); i++) {
    sale('cash');
    out.cashSales++;
  }
  for (let i = 0; i < Math.max(1, Math.round(args.cardSales * 0.003)); i++) {
    pos.voidSale(sale('card', { status: 'pending' }).id);
    out.voided++;
  }
  for (let i = 0; i < Math.max(1, Math.round(args.cardSales * 0.002)); i++) {
    sale('card', { originatedHere: true });
    out.platformSales++;
  }
  return out;
}

// ── Command line ────────────────────────────────────────────────────────────

const SWITCHES = new Set(['create-simulated-org']);

function parseArgs(argv: string[]): { options: TenantZeroOptions; simulate: number | null; saturdayShare: number | undefined; createOrg: boolean } {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    if (SWITCHES.has(a.slice(2))) {
      flags.set(a.slice(2), ['yes']);
      continue;
    }
    // --name value, or --name=value (the value may itself hold an "=", as in saturday=0.959).
    const eq = a.indexOf('=');
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const one = (name: string): string | undefined => flags.get(name)?.at(-1);
  const number = (name: string): number | undefined => {
    const v = one(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
    return n;
  };
  const org = one('org');
  if (!org) throw new Error('Name the org: --org <slug or id>');
  const weekdayShare: Record<string, number> = {};
  for (const w of flags.get('expect-weekday') ?? []) {
    const [day, share] = w.split('=');
    if (!day || !WEEKDAYS.includes(day.toLowerCase() as (typeof WEEKDAYS)[number]) || !Number.isFinite(Number(share))) throw new Error('--expect-weekday takes e.g. saturday=0.959');
    weekdayShare[day.toLowerCase()] = Number(share);
  }
  const total = number('expect-total');
  return {
    options: {
      org,
      months: number('months') ?? 16,
      ...(one('connection') ? { connectionId: one('connection')! } : {}),
      expect: {
        ...(number('expect-card-count') !== undefined ? { cardCount: number('expect-card-count')! } : {}),
        ...(total !== undefined ? { totalCents: Math.round(total * 100) } : {}),
        ...(number('tolerance') !== undefined ? { tolerance: number('tolerance')! } : {}),
        ...(Object.keys(weekdayShare).length ? { weekdayShare } : {}),
        ...(number('share-tolerance') !== undefined ? { shareTolerance: number('share-tolerance')! } : {}),
      },
      onProgress: (l) => console.error(l),
    },
    simulate: number('simulate-history') ?? null,
    saturdayShare: number('simulate-saturday-share'),
    createOrg: flags.has('create-simulated-org'),
  };
}

async function main(): Promise<void> {
  const { options, simulate, saturdayShare, createOrg } = parseArgs(process.argv.slice(2));
  const { createRuntime } = await import('../packages/runtime/src/index');
  const { silentLogger } = await import('@ros/core');
  const runtime = createRuntime();
  // The report is the output; the app's own log lines would bury it.
  (runtime.app as { log: typeof silentLogger }).log = silentLogger;
  const app = runtime.app;
  let code = 1;
  try {
    if (createOrg) {
      if (!runtime.sim || app.config.env === 'production') throw new Error('--create-simulated-org needs simulated providers (ROS_ADAPTERS=sim or mixed), outside production.');
      const { tenancy } = await import('@ros/modules');
      const { simPosToken } = await import('@ros/adapters');
      const account = `simpos-acct-${options.org}`;
      // Provisioning, as the platform: a new org with one venue, then its POS connection as that org's worker.
      const made = await app.platform('tenant-zero: a simulated org to test on', (pctx) =>
        tenancy.createOrg(pctx, { slug: options.org, legalName: `${options.org} (simulated)`, tradingName: options.org, owner: { email: `owner@${options.org}.test`, firstName: 'Owner' }, venue: { name: `${options.org} shop` } }),
      );
      await app.tenant(made.orgId, WORKER, (ctx) =>
        ledger.connectPos(ctx, { plugKey: 'sim-pos', venueId: made.venueId, externalAccountId: account, locationRef: `simpos-loc-${options.org}`, credentials: { accessToken: simPosToken(account), webhookSecret: `whsec-${options.org}` }, backfillMonths: 0 }),
      );
      console.error(`Created org "${options.org}" with one venue connected to the simulated POS.`);
    }
    if (simulate !== null) {
      if (!runtime.sim) throw new Error('--simulate-history needs the simulated POS (ROS_ADAPTERS=sim or mixed).');
      const org = await app.db.selectFrom('orgs').select(['id']).where(/^[0-9a-f-]{36}$/i.test(options.org) ? 'id' : 'slug', '=', options.org).executeTakeFirst();
      if (!org) throw new Error(`No org "${options.org}" in this database.`);
      const conns = (await app.tenant(org.id, WORKER, (ctx) => ledger.livePosConnections(ctx))).filter((c) => !options.connectionId || c.id === options.connectionId);
      const conn = conns[0];
      if (!conn || conns.length > 1 || !getPlug(conn.plugKey).simulated) throw new Error('--simulate-history needs exactly one POS connection, to the simulated POS.');
      const venue = await app.tenant(org.id, WORKER, (ctx) => ctx.db.selectFrom('venues').select('timezone').where('id', '=', conn.venueId).executeTakeFirstOrThrow());
      const made = simulateHistory(runtime.sim.pos, { accountRef: conn.row.external_account_id, locationRef: conn.locationRef, cardSales: simulate, months: options.months ?? 16, now: app.clock(), timezone: venue.timezone, ...(saturdayShare !== undefined ? { saturdayShare } : {}) });
      console.error(`Simulated history: ${num(made.cardSales)} card sales, ${num(made.cashSales)} cash, ${num(made.refunded)} refunded, ${num(made.voided)} cancelled, ${num(made.platformSales)} taken through the platform.`);
    }
    const report = await tenantZeroAcceptance(app, options);
    console.log(report.text);
    code = report.ok ? 0 : 1;
  } catch (e) {
    console.error(`tenant-zero: ${(e as Error).message}`);
    code = 2;
  } finally {
    await app.db.destroy().catch(() => undefined);
  }
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
