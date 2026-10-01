import { z } from 'zod';
import { sql } from 'kysely';
import type { App, Ctx, PlatformCtx } from './app';
import { json } from './json';
import { keyedRegistry, register } from './registry';

/**
 * Background work on Postgres. A job is enqueued in the same transaction as the change that
 * caused it (the outbox pattern), and a worker claims due jobs with SKIP LOCKED.
 *
 * A handler receives the App, not a transaction: it opens short tenant transactions around any
 * provider call (read and mark → call → record), and must be safe to run more than once.
 */
export interface JobRun<P> {
  id: string;
  orgId: string | null;
  payload: P;
  attempt: number;
}

export interface JobDef<P = unknown> {
  kind: string;
  schema: z.ZodType<P>;
  payloadVersion?: number;
  maxAttempts?: number;
  /** Seconds to wait before attempt n+1. Default: 30s, 2m, 8m, 32m … capped at 6h. */
  backoffSeconds?: (attempt: number) => number;
  handler(app: App, job: JobRun<P>): Promise<void>;
}

const registry = keyedRegistry<JobDef<any>>('jobs');

export function defineJob<P>(def: JobDef<P>): JobDef<P> {
  return register(registry, def.kind, def, 'Job');
}

export function listJobDefs(): JobDef<any>[] {
  return [...registry.values()];
}

export interface EnqueueOptions {
  runAt?: Date;
  /** Two enqueues with the same key (per org and kind) produce one job. */
  key?: string;
}

/** Enqueue a job for this org, in this transaction. */
export async function enqueue<P>(ctx: Ctx, def: JobDef<P>, payload: P, opts: EnqueueOptions = {}): Promise<void> {
  const parsed = def.schema.parse(payload);
  await ctx.db
    .insertInto('jobs')
    .values({
      org_id: ctx.orgId,
      kind: def.kind,
      payload: json(parsed),
      payload_version: def.payloadVersion ?? 1,
      run_at: opts.runAt ?? ctx.now(),
      max_attempts: def.maxAttempts ?? 8,
      idempotency_key: opts.key ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

/** Enqueue from platform code, for one org or (orgId null) for the platform itself. */
export async function enqueuePlatform<P>(
  pctx: PlatformCtx | App,
  def: JobDef<P>,
  orgId: string | null,
  payload: P,
  opts: EnqueueOptions = {},
): Promise<void> {
  const parsed = def.schema.parse(payload);
  const db = pctx.db;
  const now = 'clock' in pctx ? pctx.clock() : pctx.now();
  await db
    .insertInto('jobs')
    .values({
      org_id: orgId,
      kind: def.kind,
      payload: json(parsed),
      payload_version: def.payloadVersion ?? 1,
      run_at: opts.runAt ?? now,
      max_attempts: def.maxAttempts ?? 8,
      idempotency_key: opts.key ?? null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

const defaultBackoff = (attempt: number) => Math.min(30 * 4 ** (attempt - 1), 6 * 3600);

export interface RunJobsOptions {
  limit?: number;
  kinds?: string[];
  workerId?: string;
  /** A job left running longer than this belonged to a worker that died; it is queued again. Default 10 minutes. */
  reclaimAfterMinutes?: number;
}

export interface RunJobsResult {
  ran: number;
  succeeded: number;
  failed: number;
  dead: number;
}

/** Claim and run jobs that are due by the app clock. Returns when the claimed batch is finished. */
export async function runDueJobs(app: App, opts: RunJobsOptions = {}): Promise<RunJobsResult> {
  const now = app.clock();
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const limit = opts.limit ?? 25;

  // A worker that crashed mid-job leaves it 'running' for ever. Handlers are safe to run twice,
  // so after a generous wait the job goes back in the queue (or is parked if it is out of attempts).
  const stale = new Date(now.getTime() - (opts.reclaimAfterMinutes ?? 10) * 60_000);
  await app.db
    .updateTable('jobs')
    .set((eb) => ({
      status: eb.case().when(eb.ref('attempts'), '>=', eb.ref('max_attempts')).then(sql<'dead'>`'dead'::job_status`).else(sql<'queued'>`'queued'::job_status`).end(),
      locked_at: null,
      locked_by: null,
      last_error: 'worker stopped before the job finished',
    }))
    .where('status', '=', 'running')
    .where('locked_at', '<', stale)
    .execute();

  const claimed = await app.db.transaction().execute(async (trx) => {
    let due = trx
      .selectFrom('jobs')
      .select('id')
      .where('status', '=', 'queued')
      .where('run_at', '<=', now)
      .orderBy('run_at')
      .limit(limit)
      .forUpdate()
      .skipLocked();
    if (opts.kinds?.length) due = due.where('kind', 'in', opts.kinds);
    const ids = (await due.execute()).map((r) => r.id);
    if (!ids.length) return [];
    return trx
      .updateTable('jobs')
      .set({ status: 'running', locked_at: now, locked_by: workerId, attempts: sql`attempts + 1` })
      .where('id', 'in', ids)
      .returning(['id', 'org_id', 'kind', 'payload', 'attempts', 'max_attempts'])
      .execute();
  });

  const result: RunJobsResult = { ran: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const row of claimed) {
    result.ran++;
    const def = registry.get(row.kind);
    try {
      if (!def) throw new Error(`No handler registered for job kind ${row.kind}`);
      const payload = def.schema.parse(row.payload);
      await def.handler(app, { id: row.id, orgId: row.org_id, payload, attempt: row.attempts });
      await app.db
        .updateTable('jobs')
        .set({ status: 'succeeded', finished_at: app.clock(), last_error: null, locked_at: null, locked_by: null })
        .where('id', '=', row.id)
        .execute();
      result.succeeded++;
    } catch (e) {
      const message = (e as Error).message?.slice(0, 2000) ?? 'unknown error';
      const isDead = row.attempts >= row.max_attempts;
      const backoff = (def?.backoffSeconds ?? defaultBackoff)(row.attempts);
      await app.db
        .updateTable('jobs')
        .set({
          status: isDead ? 'dead' : 'queued',
          run_at: isDead ? now : new Date(app.clock().getTime() + backoff * 1000),
          last_error: message,
          finished_at: isDead ? app.clock() : null,
          locked_at: null,
          locked_by: null,
        })
        .where('id', '=', row.id)
        .execute();
      if (isDead) result.dead++;
      else result.failed++;
      app.log.error('job failed', { kind: row.kind, jobId: row.id, orgId: row.org_id, attempt: row.attempts, dead: isDead, error: message });
    }
  }
  return result;
}

/** Run until nothing is due. For tests and one-shot scripts; a real worker loops on runDueJobs. */
export async function drainJobs(app: App, opts: RunJobsOptions & { maxRounds?: number } = {}): Promise<RunJobsResult> {
  const total: RunJobsResult = { ran: 0, succeeded: 0, failed: 0, dead: 0 };
  for (let round = 0; round < (opts.maxRounds ?? 50); round++) {
    const r = await runDueJobs(app, opts);
    total.ran += r.ran;
    total.succeeded += r.succeeded;
    total.failed += r.failed;
    total.dead += r.dead;
    if (r.ran === 0) break;
  }
  return total;
}

export const noPayload = z.object({});

export interface DeadJobSummary {
  /** null = platform jobs that belong to no org. */
  orgId: string | null;
  dead: number;
  lastDeadAt: Date | null;
  kinds: string[];
}

/**
 * Jobs that ran out of attempts, per org, for the platform's tenant-health view
 * (docs/ARCHITECTURE.md section 7). Platform code only: it reads across orgs by design, and
 * returns counts and job kinds, never payloads.
 */
export async function deadJobSummary(app: App, orgIds?: string[]): Promise<DeadJobSummary[]> {
  if (orgIds && !orgIds.length) return [];
  let q = app.db
    .selectFrom('jobs')
    .select((eb) => ['org_id', eb.fn.countAll<number>().as('dead'), eb.fn.max('finished_at').as('last_dead_at'), sql<string[]>`array_agg(distinct kind)`.as('kinds')])
    .where('status', '=', 'dead')
    .groupBy('org_id');
  if (orgIds) q = q.where('org_id', 'in', orgIds);
  const rows = await q.execute();
  return rows.map((r) => ({ orgId: r.org_id, dead: Number(r.dead), lastDeadAt: r.last_dead_at, kinds: r.kinds ?? [] }));
}
