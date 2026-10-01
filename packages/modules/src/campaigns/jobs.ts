import { z } from 'zod';
import { type App, defineJob, defineSchedule } from '@ros/core';
import { expireApprovals } from '../approvals/index';
import { campaignsModule } from './module';
import { flowRunJob } from './flows';

/** A scheduler check, outside any tenant transaction: is the module on at any of this org's venues? */
async function campaignsOnSomewhere(app: App, orgId: string): Promise<boolean> {
  const row = await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', campaignsModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  return !!row;
}

/** Every hour: enrol lapsed guests and birthdays, then each flow acts by its mode at each venue. */
export const flowRunSchedule = defineSchedule({
  key: 'campaigns.flow_run',
  everyMinutes: 60,
  scope: 'org',
  job: flowRunJob,
  payload: ({ bucket }) => ({ trigger: `schedule:${bucket.toISOString()}` }),
  appliesTo: campaignsOnSomewhere,
});

/**
 * Approvals past their deadline lapse, and their handlers run (a flow batch: nothing is sent; a
 * campaign: back to draft). The approvals module offers the function; nothing else schedules it.
 */
export const expireApprovalsJob = defineJob({
  kind: 'campaigns.expire_approvals',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('campaigns.expire_approvals needs an org');
    await app.tenant(job.orgId, { kind: 'worker', job: 'campaigns.expire_approvals' }, (ctx) => expireApprovals(ctx));
  },
});

export const expireApprovalsSchedule = defineSchedule({
  key: 'campaigns.expire_approvals',
  everyMinutes: 15,
  scope: 'org',
  job: expireApprovalsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  // Every org: approvals come from reviews and hosted agents too, not only campaigns.
});
