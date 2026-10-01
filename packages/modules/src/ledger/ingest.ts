import { z } from 'zod';
import { sql } from 'kysely';
import {
  type App,
  type CanonicalTransaction,
  type ConnectionHandle,
  type ConnectionRow,
  type Ctx,
  type PosAdapter,
  type TxnSource,
  AppError,
  adapterFor,
  audit,
  conflict,
  connect,
  defineJob,
  defineSchedule,
  enqueue,
  enqueuePlatform,
  getPlug,
  invalid,
  listPlugs,
  markConnectionHealth,
  notFound,
  requireStaff,
  resolveConnection,
  sha256Hex,
  visibleVenueIds,
} from '@ros/core';
import { recordTransaction } from './record';

/**
 * Getting sales from a connected POS into the ledger (docs/modules/pos-adapters.md).
 *
 * Two streams per connection, each with its own row in `ingest_cursors`:
 *
 *   transactions   the rolling sync. Each run reads everything that changed since the last run,
 *                  less an overlap, so a refund on an old sale and a sale the provider was slow
 *                  to list are both caught. `synced_through` is where the last run ended.
 *   backfill       history from before the connection, requested once for N months.
 *                  `synced_through` is how far back the ledger now goes.
 *
 * A run that is cut short leaves its window and the provider's page cursor in `cursor`, so the
 * next run carries on from that page. Every write goes through recordTransaction, which is
 * idempotent on (source, external ref): running anything here twice changes nothing.
 */
export const POS_STREAM = 'transactions';
export const POS_BACKFILL_STREAM = 'backfill';
export type PosStream = typeof POS_STREAM | typeof POS_BACKFILL_STREAM;

/** Providers list new and changed sales a little late; each poll re-reads this much. */
export const DEFAULT_OVERLAP_MINUTES = 10;
export const MAX_BACKFILL_MONTHS = 36;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 40;
const RECONCILE_EVERY_MINUTES = 15;

const WORKER = { kind: 'worker' as const, job: 'ledger.pos_ingest' };

const CONNECTION_COLUMNS = [
  'id',
  'org_id',
  'venue_id',
  'plug_key',
  'status',
  'scopes',
  'secret_ref',
  'external_account_id',
  'config',
  'connected_at',
  'last_ok_at',
  'last_error',
  'expires_at',
] as const;

/** What a POS connection's config must say. Anything else in it belongs to the adapter. */
const posConfig = z.looseObject({
  locationRef: z.string().min(1),
  overlapMinutes: z.number().int().min(0).max(1440).optional(),
});

export interface PosConnection {
  id: string;
  orgId: string;
  venueId: string;
  plugKey: string;
  /** The provider's location whose sales belong to this venue. */
  locationRef: string;
  overlapMinutes: number;
  row: ConnectionRow;
}

function posPlugKeys(): string[] {
  return listPlugs()
    .filter((p) => p.adapters.pos)
    .map((p) => p.key);
}

function toPosConnection(row: ConnectionRow): PosConnection | null {
  if (!row.venue_id || row.status === 'revoked' || row.status === 'pending') return null;
  if (!posPlugKeys().includes(row.plug_key)) return null;
  const config = posConfig.safeParse(row.config ?? {});
  if (!config.success) return null;
  return {
    id: row.id,
    orgId: row.org_id,
    venueId: row.venue_id,
    plugKey: row.plug_key,
    locationRef: config.data.locationRef,
    overlapMinutes: config.data.overlapMinutes ?? DEFAULT_OVERLAP_MINUTES,
    row,
  };
}

/** A live POS connection of this org, or null. Another org's id finds nothing: row-level security answers. */
export async function loadPosConnection(ctx: Ctx, connectionId: string): Promise<PosConnection | null> {
  const row = await ctx.db.selectFrom('connections').select(CONNECTION_COLUMNS).where('id', '=', connectionId).executeTakeFirst();
  return row ? toPosConnection(row) : null;
}

/**
 * A webhook arrives before we know whose it is: find the live POS connections for the account
 * it names. One merchant account can feed several venues (one connection per location), so
 * this returns them all. app.db, because no tenant is known yet; the caller proves which of
 * these it may act for by checking the signature against each connection's own secret.
 */
export async function findPosConnectionsByAccount(app: App, plugKey: string, externalAccountId: string): Promise<PosConnection[]> {
  const rows = await app.db
    .selectFrom('connections')
    .select(CONNECTION_COLUMNS)
    .where('plug_key', '=', plugKey)
    .where('external_account_id', '=', externalAccountId)
    .where('status', 'in', ['connected', 'unhealthy'])
    .orderBy('connected_at')
    .execute();
  return rows.map(toPosConnection).filter((c): c is PosConnection => c !== null);
}

export async function livePosConnections(ctx: Ctx): Promise<PosConnection[]> {
  const keys = posPlugKeys();
  if (!keys.length) return [];
  const rows = await ctx.db
    .selectFrom('connections')
    .select(CONNECTION_COLUMNS)
    .where('plug_key', 'in', keys)
    .where('status', 'in', ['connected', 'unhealthy'])
    .where('venue_id', 'is not', null)
    .orderBy('connected_at')
    .execute();
  return rows.map(toPosConnection).filter((c): c is PosConnection => c !== null);
}

// ── Recording one sale ───────────────────────────────────────────────────────

export type SaleOutcome = 'created' | 'changed' | 'unchanged' | 'skipped';

/**
 * Put one sale fetched from a POS into the ledger, for the venue its connection maps to.
 * Shared by the poll and the webhook path. Skipped, never written:
 *   - a sale at a location other than the connection's (it belongs to another venue, or none)
 *   - a sale this platform took itself (the module that took it has already recorded it)
 *   - a payment that was cancelled before it was ever a sale
 */
/** How long a sale made through our own application is given to arrive from the ordering module before ingest records it itself. Shorter than the poll's overlap, so the next poll sees it again. */
export const OWN_SALE_GRACE_MINUTES = 8;

export async function recordPosSale(ctx: Ctx, conn: Pick<PosConnection, 'venueId' | 'locationRef'>, source: TxnSource, txn: CanonicalTransaction): Promise<SaleOutcome> {
  if (txn.locationRef && txn.locationRef !== conn.locationRef) return 'skipped';
  if (txn.originatedHere) {
    // Made through this platform's own application at the provider. It is skipped only when we
    // really do hold it: the ordering module records its sale under source 'online-order' with
    // the provider's payment reference. One we have no record of (another tool using the same
    // application, or a crash before the order was recorded) is a real sale and is counted.
    const ours = await ctx.db.selectFrom('transactions').select('id').where('source', '=', 'online-order').where('external_ref', '=', txn.externalRef).executeTakeFirst();
    if (ours) return 'skipped';
    // A payment taken moments ago may still be on its way into the ledger; the next poll decides.
    if (ctx.now().getTime() - txn.occurredAt.getTime() < OWN_SALE_GRACE_MINUTES * 60_000) return 'skipped';
  }
  if (txn.status === 'voided') {
    const known = await ctx.db.selectFrom('transactions').select('id').where('source', '=', source).where('external_ref', '=', txn.externalRef).executeTakeFirst();
    if (!known) return 'skipped';
  }
  const r = await recordTransaction(ctx, txn.source === source ? txn : { ...txn, source }, { venueId: conn.venueId, via: 'pos' });
  return r.created ? 'created' : r.changed ? 'changed' : 'unchanged';
}

// ── One ingest run ───────────────────────────────────────────────────────────

export interface IngestResult {
  /** 'done': the window was read to its end. 'partial': cut short at the page limit, more to come. 'idle': nothing to do. */
  status: 'done' | 'partial' | 'idle';
  stream: PosStream;
  pages: number;
  fetched: number;
  created: number;
  changed: number;
  unchanged: number;
  skipped: number;
  /** The end of the window read, once it is complete (for a back-fill: its start). */
  syncedThrough: Date | null;
}

interface Window {
  since: Date;
  until: Date;
  /** The provider's page cursor within this window, or null at its start. */
  page: string | null;
}

function encodeWindow(w: Window): string {
  return JSON.stringify({ since: w.since.toISOString(), until: w.until.toISOString(), page: w.page });
}

function decodeWindow(stored: string | null | undefined): Window | null {
  if (!stored) return null;
  try {
    const v = JSON.parse(stored) as { since?: string; until?: string; page?: string | null };
    const since = new Date(v.since ?? '');
    const until = new Date(v.until ?? '');
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return null;
    return { since, until, page: typeof v.page === 'string' ? v.page : null };
  } catch {
    return null;
  }
}

async function saveProgress(ctx: Ctx, connectionId: string, stream: PosStream, window: Window | null): Promise<void> {
  const cursor = window ? encodeWindow(window) : null;
  await ctx.db
    .insertInto('ingest_cursors')
    .values({ org_id: ctx.orgId, connection_id: connectionId, stream, cursor, last_run_at: ctx.now(), updated_at: ctx.now() })
    .onConflict((oc) => oc.columns(['connection_id', 'stream']).doUpdateSet({ cursor, last_run_at: ctx.now(), updated_at: ctx.now() }))
    .execute();
}

async function saveCompletion(ctx: Ctx, connectionId: string, stream: PosStream, window: Window, count: number): Promise<void> {
  // The rolling sync only ever moves forward and a back-fill only ever reaches further back, so
  // two runs finishing out of order cannot undo each other.
  const through = stream === POS_STREAM ? window.until : window.since;
  const merged =
    stream === POS_STREAM
      ? sql<Date>`greatest(ingest_cursors.synced_through, ${through}::timestamptz)`
      : sql<Date>`least(ingest_cursors.synced_through, ${through}::timestamptz)`;
  await ctx.db
    .insertInto('ingest_cursors')
    .values({ org_id: ctx.orgId, connection_id: connectionId, stream, cursor: null, synced_through: through, last_run_at: ctx.now(), last_count: count, updated_at: ctx.now() })
    .onConflict((oc) =>
      oc.columns(['connection_id', 'stream']).doUpdateSet({ cursor: null, synced_through: merged, last_run_at: ctx.now(), last_count: count, updated_at: ctx.now() }),
    )
    .execute();
}

/** What is safe to keep of a provider failure: adapters build these messages and put no secret or card value in them. */
function providerMessage(e: unknown): string {
  return ((e as Error)?.message ?? 'unknown error').slice(0, 300);
}

function unreachable(e: unknown): AppError {
  if (e instanceof AppError && e.code === 'unavailable') return e;
  return new AppError('provider_error', 'The point of sale could not be reached. It will be tried again shortly.', { cause: providerMessage(e) });
}

export interface IngestArgs {
  orgId: string;
  connectionId: string;
  stream?: PosStream;
  pageSize?: number;
  /** Pages read before the run stops and leaves the rest for the next one. */
  maxPages?: number;
}

/**
 * Read one connection's sales from its POS into the ledger: page from the stored cursor, record
 * each page in its own short tenant transaction, advance the cursor, mark the connection's health.
 *
 * Not a service function: it takes the App because it calls the provider between transactions.
 * The org must come from the job row or the verified connection, never from a request.
 */
export async function ingestConnection(app: App, args: IngestArgs): Promise<IngestResult> {
  const stream = args.stream ?? POS_STREAM;
  const startedAt = app.clock();
  const result: IngestResult = { status: 'idle', stream, pages: 0, fetched: 0, created: 0, changed: 0, unchanged: 0, skipped: 0, syncedThrough: null };

  const state = await app.tenant(args.orgId, WORKER, async (ctx) => {
    const conn = await loadPosConnection(ctx, args.connectionId);
    if (!conn) return null;
    const cursor = await ctx.db.selectFrom('ingest_cursors').select(['cursor', 'synced_through']).where('connection_id', '=', conn.id).where('stream', '=', stream).executeTakeFirst();
    return { conn, cursor: cursor ?? null };
  });
  // Revoked, another org's, or not a POS: nothing to read, and not an error worth a retry.
  if (!state) return result;
  const { conn } = state;

  const resumed = decodeWindow(state.cursor?.cursor);
  let window: Window;
  if (resumed) window = resumed;
  else if (stream === POS_BACKFILL_STREAM) return result; // no back-fill has been asked for, or it has finished
  else {
    const from = state.cursor?.synced_through ?? conn.row.connected_at ?? startedAt;
    window = { since: new Date(from.getTime() - conn.overlapMinutes * 60_000), until: startedAt, page: null };
  }

  let adapter: PosAdapter;
  let handle: ConnectionHandle;
  try {
    adapter = adapterFor(app, 'pos', conn.row);
    handle = await resolveConnection(app, conn.row);
  } catch (e) {
    await markConnectionHealth(app, conn.id, { ok: false, error: providerMessage(e) });
    throw unreachable(e);
  }

  const limit = args.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES;
  const failed: string[] = [];

  for (;;) {
    let batch: { items: CanonicalTransaction[]; nextCursor: string | null };
    try {
      batch = await adapter.listTransactions(handle, { locationRef: conn.locationRef, since: window.since, until: window.until, cursor: window.page, limit });
    } catch (e) {
      await markConnectionHealth(app, conn.id, { ok: false, error: providerMessage(e) });
      // A page cursor we stored may simply have expired. Forget it, so the retry starts the
      // window again from its beginning rather than failing on the same cursor for ever.
      if (resumed && result.pages === 0 && window.page) {
        const restart = { ...window, page: null };
        await app.tenant(conn.orgId, WORKER, (ctx) => saveProgress(ctx, conn.id, stream, stream === POS_BACKFILL_STREAM ? restart : null));
      }
      throw unreachable(e);
    }

    result.pages++;
    result.fetched += batch.items.length;
    window = { ...window, page: batch.nextCursor };
    const counts = await recordPage(app, conn, adapter.source, batch.items, failed, batch.nextCursor ? { stream, window } : null);
    result.created += counts.created;
    result.changed += counts.changed;
    result.unchanged += counts.unchanged;
    result.skipped += counts.skipped;

    if (!batch.nextCursor) break;
    if (result.pages >= maxPages) {
      result.status = 'partial';
      break;
    }
  }

  // The provider answered, which is what connection health means.
  await markConnectionHealth(app, conn.id, { ok: true });

  if (failed.length) {
    // Nothing is rounded away: the window is not marked as read, so the next run fetches these
    // sales again, and the job fails loudly. Everything else in the window was recorded.
    await app.tenant(conn.orgId, WORKER, (ctx) => saveProgress(ctx, conn.id, stream, stream === POS_BACKFILL_STREAM ? { ...window, page: null } : null));
    throw new AppError('conflict', `${failed.length} sale(s) from the point of sale could not be recorded and will be tried again.`, { externalRefs: failed.slice(0, 20) });
  }

  // Cut short at the page limit: the window and its page cursor are stored, the next run carries on.
  if (result.status === 'partial') return result;

  await app.tenant(conn.orgId, WORKER, (ctx) => saveCompletion(ctx, conn.id, stream, window, result.fetched));
  result.status = 'done';
  result.syncedThrough = stream === POS_STREAM ? window.until : window.since;
  return result;
}

type Counts = Record<SaleOutcome, number>;

/** Record one page, and where the run has got to, in one short tenant transaction. */
async function recordPage(
  app: App,
  conn: PosConnection,
  source: TxnSource,
  items: CanonicalTransaction[],
  failed: string[],
  progress: { stream: PosStream; window: Window } | null,
): Promise<Counts> {
  try {
    return await app.tenant(conn.orgId, WORKER, async (ctx) => {
      const counts: Counts = { created: 0, changed: 0, unchanged: 0, skipped: 0 };
      for (const txn of items) counts[await recordPosSale(ctx, conn, source, txn)]++;
      if (progress) await saveProgress(ctx, conn.id, progress.stream, progress.window);
      return counts;
    });
  } catch {
    // One sale failed and took the page's transaction with it (a webhook recording the same
    // sale at the same moment, or a payload the ledger refuses). Go one sale at a time so the
    // rest of the page still lands, and name the ones that did not.
    const counts: Counts = { created: 0, changed: 0, unchanged: 0, skipped: 0 };
    for (const txn of items) {
      try {
        counts[await app.tenant(conn.orgId, WORKER, (ctx) => recordPosSale(ctx, conn, source, txn))]++;
      } catch (e) {
        failed.push(txn.externalRef);
        app.log.error('pos ingest: sale not recorded', { connectionId: conn.id, orgId: conn.orgId, externalRef: txn.externalRef, error: providerMessage(e) });
      }
    }
    if (progress) await app.tenant(conn.orgId, WORKER, (ctx) => saveProgress(ctx, conn.id, progress.stream, progress.window));
    return counts;
  }
}

// ── Jobs and the reconciliation schedule ─────────────────────────────────────

export const posIngestJob = defineJob({
  kind: 'ledger.pos_ingest',
  schema: z.object({
    connectionId: z.string().uuid(),
    stream: z.enum([POS_STREAM, POS_BACKFILL_STREAM]).default(POS_STREAM),
  }),
  // The reconciliation schedule asks again every few minutes, so a failed run need not retry for long.
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ledger.pos_ingest is an org job');
    const { connectionId, stream } = job.payload;
    const r = await ingestConnection(app, { orgId: job.orgId, connectionId, stream });
    if (r.status === 'partial') {
      // Keyed on this job, so a handler that runs twice still queues one continuation.
      await enqueuePlatform(app, posIngestJob, job.orgId, { connectionId, stream }, { key: `continue:${job.id}` });
    }
  },
});

export const posReconcileJob = defineJob({
  kind: 'ledger.pos_reconcile',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('ledger.pos_reconcile is an org job');
    // One ingest job per connection, so one POS being down never holds up another venue's sales.
    await app.tenant(orgId, WORKER, async (ctx) => {
      const conns = await livePosConnections(ctx);
      if (!conns.length) return;
      const backfilling = await ctx.db
        .selectFrom('ingest_cursors')
        .select('connection_id')
        .where('stream', '=', POS_BACKFILL_STREAM)
        .where('cursor', 'is not', null)
        .execute();
      const unfinished = new Set(backfilling.map((b) => b.connection_id));
      for (const conn of conns) {
        await enqueue(ctx, posIngestJob, { connectionId: conn.id, stream: POS_STREAM }, { key: `reconcile:${conn.id}:${job.payload.bucket}` });
        // A back-fill whose job died is picked up again here.
        if (unfinished.has(conn.id)) {
          await enqueue(ctx, posIngestJob, { connectionId: conn.id, stream: POS_BACKFILL_STREAM }, { key: `reconcile-backfill:${conn.id}:${job.payload.bucket}` });
        }
      }
    });
  },
});

/**
 * Webhooks get lost. Every connected POS is polled on a timer, unhealthy ones included (that
 * is how they recover), so a sale whose webhook never arrived is in the ledger within minutes.
 */
export const posReconcileSchedule = defineSchedule({
  key: 'ledger.pos_reconcile',
  everyMinutes: RECONCILE_EVERY_MINUTES,
  scope: 'org',
  job: posReconcileJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  async appliesTo(app, orgId) {
    const keys = posPlugKeys();
    if (!keys.length) return false;
    // app.db: the scheduler runs outside any tenant and asks only "does this org have a POS at all".
    const row = await app.db
      .selectFrom('connections')
      .select('id')
      .where('org_id', '=', orgId)
      .where('plug_key', 'in', keys)
      .where('status', 'in', ['connected', 'unhealthy'])
      .limit(1)
      .executeTakeFirst();
    return !!row;
  },
});

// ── Service functions: connect, back-fill, status ────────────────────────────

function monthsBefore(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

async function startBackfill(ctx: Ctx, conn: Pick<PosConnection, 'id'>, months: number): Promise<Date> {
  const until = ctx.now();
  let since = monthsBefore(until, months);
  const existing = await ctx.db.selectFrom('ingest_cursors').select('cursor').where('connection_id', '=', conn.id).where('stream', '=', POS_BACKFILL_STREAM).executeTakeFirst();
  // Asking again while one is running widens it; it never narrows what was already asked for.
  const running = decodeWindow(existing?.cursor);
  if (running && running.since < since) since = running.since;
  await saveProgress(ctx, conn.id, POS_BACKFILL_STREAM, { since, until, page: null });
  await enqueue(ctx, posIngestJob, { connectionId: conn.id, stream: POS_BACKFILL_STREAM }, { key: `backfill:${conn.id}:${sha256Hex(`${since.toISOString()}:${until.toISOString()}`).slice(0, 16)}` });
  return since;
}

const connectPosInput = z.object({
  plugKey: z.string().min(1),
  venueId: z.string().uuid(),
  /** The provider's merchant or account id. Webhooks are matched to the connection by it. */
  externalAccountId: z.string().min(1).max(200),
  /** The provider's location whose sales belong to this venue. */
  locationRef: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string()),
  scopes: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.date().nullable().optional(),
  /** History to fetch from before today. 0 = only sales from now on. */
  backfillMonths: z.number().int().min(0).max(MAX_BACKFILL_MONTHS).default(0),
});
export type ConnectPosInput = z.input<typeof connectPosInput>;

export interface PosConnectionView {
  id: string;
  venueId: string;
  plugKey: string;
  status: ConnectionRow['status'];
  externalAccountId: string;
  locationRef: string;
  connectedAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  /** Where the rolling sync has read up to. */
  syncedThrough: Date | null;
  lastRunAt: Date | null;
  /** The start of a back-fill still in progress, or null. */
  backfillingFrom: Date | null;
  /** How far back completed back-fills reach, or null if none has finished. */
  historyFrom: Date | null;
}

/**
 * Connect a venue to its point of sale, and optionally ask for its history. A manager of that
 * venue (or an owner) may do this; for anyone else the venue is not found.
 *
 * The caller has already completed the provider's sign-in and holds its tokens; the location
 * was chosen from `listPosLocations`. With no back-fill the ledger starts from now, and the
 * reconciliation schedule makes the first poll.
 */
export async function connectPos(ctx: Ctx, raw: ConnectPosInput): Promise<PosConnectionView> {
  const input = connectPosInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const plug = getPlug(input.plugKey);
  if (!plug.adapters.pos) throw invalid(`${plug.name} is not a point of sale.`);

  // One provider location feeds one venue: two venues claiming it would each think the sales theirs.
  const others = (await livePosConnections(ctx)).filter(
    (c) => c.plugKey === plug.key && c.row.external_account_id === input.externalAccountId && c.locationRef === input.locationRef && c.venueId !== input.venueId,
  );
  if (others.length) throw conflict('That location is already connected to another venue.');

  const before = await ctx.db
    .selectFrom('connections')
    .select(['id', 'config'])
    .where('plug_key', '=', plug.key)
    .where('external_account_id', '=', input.externalAccountId)
    .where('venue_id', '=', input.venueId)
    .executeTakeFirst();

  const row = await connect(ctx, {
    plugKey: plug.key,
    venueId: input.venueId,
    externalAccountId: input.externalAccountId,
    scopes: input.scopes,
    credentials: input.credentials,
    config: { ...(input.config ?? {}), locationRef: input.locationRef },
    expiresAt: input.expiresAt ?? null,
  });

  // A connection pointed at a different location starts again: the old cursors describe another till.
  const previousLocation = posConfig.safeParse(before?.config ?? {});
  if (before && (!previousLocation.success || previousLocation.data.locationRef !== input.locationRef)) {
    await ctx.db.deleteFrom('ingest_cursors').where('connection_id', '=', row.id).execute();
  }
  // The rolling sync starts at the moment of connection; anything earlier is the back-fill's.
  await ctx.db
    .insertInto('ingest_cursors')
    .values({ org_id: ctx.orgId, connection_id: row.id, stream: POS_STREAM, synced_through: ctx.now(), updated_at: ctx.now() })
    .onConflict((oc) => oc.columns(['connection_id', 'stream']).doNothing())
    .execute();

  if (input.backfillMonths > 0) await startBackfill(ctx, row, input.backfillMonths);
  return (await posConnectionViews(ctx, [row])).at(0)!;
}

const backfillInput = z.object({
  connectionId: z.string().uuid(),
  months: z.number().int().min(1).max(MAX_BACKFILL_MONTHS),
});

/** Fetch a connected POS's history from N months back. Safe to ask twice: the ledger is idempotent. */
export async function requestPosBackfill(ctx: Ctx, raw: z.input<typeof backfillInput>): Promise<{ connectionId: string; from: Date }> {
  const input = backfillInput.parse(raw);
  const conn = await loadPosConnection(ctx, input.connectionId);
  if (!conn) throw notFound('Connection not found');
  requireStaff(ctx, { venueId: conn.venueId, minRole: 'manager' });
  const from = await startBackfill(ctx, conn, input.months);
  await audit(ctx, { action: 'pos.backfill_requested', entityType: 'connection', entityId: conn.id, venueId: conn.venueId, after: { months: input.months, from: from.toISOString() } });
  return { connectionId: conn.id, from };
}

async function posConnectionViews(ctx: Ctx, rows: ConnectionRow[]): Promise<PosConnectionView[]> {
  if (!rows.length) return [];
  const cursors = await ctx.db
    .selectFrom('ingest_cursors')
    .select(['connection_id', 'stream', 'cursor', 'synced_through', 'last_run_at'])
    .where('connection_id', 'in', rows.map((r) => r.id))
    .execute();
  return rows.map((row) => {
    const rolling = cursors.find((c) => c.connection_id === row.id && c.stream === POS_STREAM);
    const backfill = cursors.find((c) => c.connection_id === row.id && c.stream === POS_BACKFILL_STREAM);
    const config = posConfig.safeParse(row.config ?? {});
    return {
      id: row.id,
      venueId: row.venue_id!,
      plugKey: row.plug_key,
      status: row.status,
      externalAccountId: row.external_account_id,
      locationRef: config.success ? config.data.locationRef : '',
      connectedAt: row.connected_at,
      lastOkAt: row.last_ok_at,
      lastError: row.last_error,
      syncedThrough: rolling?.synced_through ?? null,
      lastRunAt: rolling?.last_run_at ?? null,
      backfillingFrom: decodeWindow(backfill?.cursor)?.since ?? null,
      historyFrom: backfill?.synced_through ?? null,
    };
  });
}

/** The POS connections the caller may see, with how far each has synced. For the console's connection health view. */
export async function listPosConnections(ctx: Ctx, filter: { venueId?: string } = {}): Promise<PosConnectionView[]> {
  requireStaff(ctx, { venueId: filter.venueId, minRole: 'read_only' });
  const visible = visibleVenueIds(ctx);
  const rows = (await livePosConnections(ctx))
    .filter((c) => (filter.venueId ? c.venueId === filter.venueId : !visible || visible.includes(c.venueId)))
    .map((c) => c.row);
  return posConnectionViews(ctx, rows);
}

/**
 * The provider's locations for a set of credentials, so the person connecting can say which
 * one is this venue. Called after the provider's sign-in and before connectPos; it touches no
 * tenant data, and the credentials are used once and not kept.
 */
export async function listPosLocations(
  app: App,
  args: { plugKey: string; externalAccountId: string; credentials: Record<string, string>; config?: Record<string, unknown> },
): Promise<Array<{ ref: string; name: string; timezone?: string }>> {
  const plug = getPlug(args.plugKey);
  if (!plug.adapters.pos) throw invalid(`${plug.name} is not a point of sale.`);
  if (plug.simulated && app.config.env === 'production') throw notFound('That service is not in the catalogue.');
  const adapter = app.adapters.get('pos', plug.adapters.pos);
  try {
    return await adapter.listLocations({
      id: 'unconnected',
      orgId: 'unconnected',
      venueId: null,
      plugKey: plug.key,
      externalAccountId: args.externalAccountId,
      scopes: [],
      config: args.config ?? {},
      credentials: args.credentials,
    });
  } catch (e) {
    throw unreachable(e);
  }
}
