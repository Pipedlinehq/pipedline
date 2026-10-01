import { type App, defineJob, defineSchedule, noPayload } from '@ros/core';
import { hubModule } from './module';

/**
 * Housekeeping. Confirmation notes are short-lived; their rows are kept a day past expiry (so a
 * reused note is still answered "already used" rather than "unknown") and then removed.
 */
const WORKER = { kind: 'worker' as const, job: 'hub.prune_confirmations' };
const KEEP_AFTER_EXPIRY_MS = 86_400_000;

/** Remove confirmation notes that expired more than a day ago. Safe to run twice. */
export async function pruneConfirmations(app: App, orgId: string): Promise<number> {
  const cutoff = new Date(app.clock().getTime() - KEEP_AFTER_EXPIRY_MS);
  const gone = await app.tenant(orgId, WORKER, (ctx) => ctx.db.deleteFrom('agent_confirmations').where('expires_at', '<', cutoff).returning('nonce').execute());
  return gone.length;
}

export const pruneConfirmationsJob = defineJob({
  kind: 'hub.prune_confirmations',
  schema: noPayload,
  maxAttempts: 3,
  async handler(app, job) {
    if (job.orgId) await pruneConfirmations(app, job.orgId);
  },
});

export const pruneConfirmationsSchedule = defineSchedule({
  key: 'hub.prune_confirmations',
  everyMinutes: 24 * 60,
  scope: 'org',
  job: pruneConfirmationsJob,
  payload: () => ({}),
  // Platform scheduler: reads outside a tenant to skip orgs that never switched the hub on.
  appliesTo: async (app, orgId) =>
    !!(await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', hubModule.key).where('enabled', '=', true).executeTakeFirst()),
});
