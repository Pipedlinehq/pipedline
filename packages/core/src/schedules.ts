import type { App } from './app';
import type { JobDef } from './jobs';
import { keyedRegistry, register } from './registry';

/**
 * Recurring work. A schedule names a job to enqueue every N minutes, once per org or once for
 * the platform. The worker calls tickSchedules() on a timer; enqueues are idempotent per time
 * bucket, so two workers, or a tick that runs twice, still produce one job.
 */
export interface ScheduleDef<P = unknown> {
  key: string;
  everyMinutes: number;
  scope: 'org' | 'platform';
  job: JobDef<P>;
  /** The payload for one run. `bucket` is the start of the time window this run covers. */
  payload(args: { orgId: string | null; bucket: Date }): P;
  /** Skip orgs for which this returns false (e.g. the module is off everywhere). Optional. */
  appliesTo?(app: App, orgId: string): Promise<boolean>;
}

const registry = keyedRegistry<ScheduleDef<any>>('schedules');

export function defineSchedule<P>(def: ScheduleDef<P>): ScheduleDef<P> {
  if (def.everyMinutes < 1) throw new Error('A schedule runs at most once a minute');
  return register(registry, def.key, def, 'Schedule');
}

export function listScheduleDefs(): ScheduleDef<any>[] {
  return [...registry.values()];
}

export async function tickSchedules(app: App, opts: { only?: string[] } = {}): Promise<{ enqueued: number }> {
  const now = app.clock();
  const rows: Array<{ org_id: string | null; kind: string; payload: string; payload_version: number; run_at: Date; max_attempts: number; idempotency_key: string }> = [];
  let orgIds: string[] | null = null;
  for (const def of registry.values()) {
    if (opts.only && !opts.only.includes(def.key)) continue;
    const span = def.everyMinutes * 60_000;
    const bucket = new Date(Math.floor(now.getTime() / span) * span);
    const key = `sched:${def.key}:${bucket.toISOString()}`;
    const row = (orgId: string | null) => ({
      org_id: orgId,
      kind: def.job.kind,
      payload: JSON.stringify(def.job.schema.parse(def.payload({ orgId, bucket }))),
      payload_version: def.job.payloadVersion ?? 1,
      run_at: now,
      max_attempts: def.job.maxAttempts ?? 8,
      idempotency_key: key,
    });
    if (def.scope === 'platform') {
      rows.push(row(null));
      continue;
    }
    orgIds ??= (await app.db.selectFrom('orgs').select('id').where('status', 'in', ['onboarding', 'live']).execute()).map((o) => o.id);
    // A bucket already enqueued for an org needs no second look: skip its appliesTo check too.
    const done = new Set(
      (await app.db.selectFrom('jobs').select('org_id').where('kind', '=', def.job.kind).where('idempotency_key', '=', key).execute()).map((r) => r.org_id),
    );
    for (const orgId of orgIds) {
      if (done.has(orgId)) continue;
      if (def.appliesTo && !(await def.appliesTo(app, orgId))) continue;
      rows.push(row(orgId));
    }
  }
  // One statement per thousand jobs rather than one per job: the tick must stay well inside its interval at hundreds of orgs.
  let enqueued = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const inserted = await app.db
      .insertInto('jobs')
      .values(rows.slice(i, i + 1000))
      .onConflict((oc) => oc.doNothing())
      .returning('id')
      .execute();
    enqueued += inserted.length;
  }
  return { enqueued };
}
