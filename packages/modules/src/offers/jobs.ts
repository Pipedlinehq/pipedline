import { z } from 'zod';
import { type App, defineJob, defineSchedule } from '@ros/core';
import { expireCodes } from './codes';
import { offersModule } from './module';

const WORKER = { kind: 'worker' as const, job: 'offers' };

export const expireCodesJob = defineJob({
  kind: 'offers.expire_codes',
  schema: z.object({ bucket: z.string() }),
  async handler(app, job) {
    if (!job.orgId) throw new Error('offers.expire_codes needs an org');
    await app.tenant(job.orgId, WORKER, (ctx) => expireCodes(ctx));
  },
});

/** A scheduler check, outside any tenant transaction: are offers on at any of this org's venues? */
async function offersOnSomewhere(app: App, orgId: string): Promise<boolean> {
  const row = await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', offersModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  return !!row;
}

export const expireCodesSchedule = defineSchedule({
  key: 'offers.expire_codes',
  everyMinutes: 60,
  scope: 'org',
  job: expireCodesJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: offersOnSomewhere,
});
