import { z } from 'zod';
import { type Ctx, addDays, defineJob, defineSchedule, enqueue, localDate, noPayload, requireOwner } from '@ros/core';
import { computeBenchmarks } from './benchmarks';
import { buildDigest } from './digest';
import { weekStart } from './period';
import { backfill, rollup } from './rollup';
import { resolveScope } from './scope';

/**
 * Background work. Every handler is safe to run twice: roll-ups merge, a digest is one row per
 * period, the bands replace their own window.
 */
const WORKER = { kind: 'worker' as const, job: 'analytics' };

export const rollupJob = defineJob({
  kind: 'analytics.rollup',
  schema: z.object({ mode: z.enum(['incremental', 'reconcile']).default('incremental') }),
  maxAttempts: 5,
  async handler(app, job) {
    if (!job.orgId) throw new Error('analytics.rollup needs an org');
    await rollup(app, job.orgId, { mode: job.payload.mode });
  },
});

export const backfillJob = defineJob({
  kind: 'analytics.backfill',
  schema: z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (!job.orgId) throw new Error('analytics.backfill needs an org');
    await backfill(app, job.orgId, job.payload);
  },
});

/**
 * Builds the digest of the last complete week for the org and, when it has more than one
 * venue, for each venue. It runs every hour and does nothing once the week's digests exist, so
 * each org gets its digest in the first hour after its own week ends, in its own time zone.
 */
export const weeklyDigestJob = defineJob({
  kind: 'analytics.weekly_digest',
  schema: noPayload,
  maxAttempts: 5,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('analytics.weekly_digest needs an org');
    // The facts should be level before a digest reads them; if they are not, it reads the ledger.
    await rollup(app, orgId);
    await app.tenant(orgId, WORKER, async (ctx) => {
      const scope = await resolveScope(ctx);
      const targets: Array<string | null> = scope.venues.length > 1 ? [null, ...scope.venueIds] : [null];
      for (const venueId of targets) {
        const tz = venueId ? scope.venues.find((v) => v.id === venueId)!.timezone : scope.timezone;
        const weekFrom = addDays(weekStart(localDate(ctx.now(), tz)), -7);
        let q = ctx.db.selectFrom('insight_digests').select('id').where('org_id', '=', orgId).where('period', '=', 'week').where('period_start', '=', weekFrom);
        q = venueId ? q.where('venue_id', '=', venueId) : q.where('venue_id', 'is', null);
        if (await q.executeTakeFirst()) continue;
        await buildDigest(ctx, { period: 'week', date: weekFrom, ...(venueId ? { venueId } : {}) });
      }
    });
  },
});

export const benchmarksJob = defineJob({
  kind: 'analytics.benchmarks',
  schema: noPayload,
  maxAttempts: 3,
  async handler(app) {
    await computeBenchmarks(app);
  },
});

export const rollupSchedule = defineSchedule({
  key: 'analytics.rollup',
  everyMinutes: 15,
  scope: 'org',
  job: rollupJob,
  payload: () => ({ mode: 'incremental' as const }),
});

export const reconcileSchedule = defineSchedule({
  key: 'analytics.reconcile',
  everyMinutes: 1440,
  scope: 'org',
  job: rollupJob,
  payload: () => ({ mode: 'reconcile' as const }),
});

export const weeklyDigestSchedule = defineSchedule({
  key: 'analytics.weekly_digest',
  everyMinutes: 60,
  scope: 'org',
  job: weeklyDigestJob,
  payload: () => ({}),
});

export const benchmarksSchedule = defineSchedule({
  key: 'analytics.benchmarks',
  everyMinutes: 1440,
  scope: 'platform',
  job: benchmarksJob,
  payload: () => ({}),
});

/** Owner: rebuild this org's analytics from the ledger (after an import, or when something looks wrong). Queues the work. */
export async function requestBackfill(ctx: Ctx, opts: { from?: string; to?: string } = {}): Promise<{ queued: true }> {
  const payload = backfillJob.schema.parse(opts);
  requireOwner(ctx);
  await enqueue(ctx, backfillJob, payload, { key: `backfill:${payload.from ?? 'start'}:${payload.to ?? 'now'}:${ctx.now().toISOString().slice(0, 13)}` });
  return { queued: true };
}
