import { z } from 'zod';
import { type App, type Principal, deadJobSummary, notFound } from '@ros/core';
import { requirePlatformAdmin } from './platform';

/**
 * Per-tenant health (docs/ARCHITECTURE.md section 7, docs/DEPLOYMENT.md section 10): the last
 * successful sync of each connection, the comms queue, dead jobs and failed provisioning
 * steps. "The site is broken" has to be answerable per org, and a ring promotion reads this.
 */
export interface TenantHealth {
  orgId: string;
  slug: string;
  name: string;
  status: 'onboarding' | 'live' | 'paused' | 'closed';
  connections: Array<{ id: string; plugKey: string; venueId: string | null; status: string; lastOkAt: Date | null; lastError: string | null }>;
  queue: {
    /** Messages due now and not yet sent. Messages scheduled for later are not a backlog. */
    depth: number;
    oldestQueuedAt: Date | null;
    oldestAgeMinutes: number | null;
  };
  deadJobs: { count: number; lastAt: Date | null; kinds: string[] };
  failedProvisioningSteps: Array<{ step: string; error: string | null; attempts: number }>;
  /** Plain statements of what is wrong. Empty when healthy. */
  problems: string[];
  healthy: boolean;
}

/** A queued message older than this is a backlog, not a queue. */
export const QUEUE_STALE_MINUTES = 15;

async function load(app: App, orgIds: string[] | null): Promise<TenantHealth[]> {
  // Platform reads across orgs, by design: this is the platform's own view of its tenants.
  let orgQ = app.db.selectFrom('orgs').select(['id', 'slug', 'trading_name', 'status']).orderBy('trading_name');
  if (orgIds) orgQ = orgQ.where('id', 'in', orgIds);
  const orgs = await orgQ.execute();
  if (!orgs.length) return [];
  const ids = orgs.map((o) => o.id);
  const now = app.clock();

  const connections = await app.db
    .selectFrom('connections')
    .select(['id', 'org_id', 'plug_key', 'venue_id', 'status', 'last_ok_at', 'last_error'])
    .where('org_id', 'in', ids)
    .where('status', '!=', 'revoked')
    .orderBy('plug_key')
    .execute();
  const queues = await app.db
    .selectFrom('messages')
    .select((eb) => ['org_id', eb.fn.countAll<number>().as('depth'), eb.fn.min('queued_at').as('oldest')])
    .where('org_id', 'in', ids)
    .where('status', 'in', ['queued', 'sending'])
    .where((eb) => eb.or([eb('next_attempt_at', 'is', null), eb('next_attempt_at', '<=', now)]))
    .groupBy('org_id')
    .execute();
  const dead = await deadJobSummary(app, ids);
  const failedSteps = await app.db.selectFrom('provisioning_steps').select(['org_id', 'step', 'error', 'attempts']).where('org_id', 'in', ids).where('status', '=', 'failed').execute();

  return orgs.map((o) => {
    const conns = connections.filter((c) => c.org_id === o.id);
    const q = queues.find((x) => x.org_id === o.id);
    const d = dead.find((x) => x.orgId === o.id);
    const steps = failedSteps.filter((s) => s.org_id === o.id);
    const oldest = q?.oldest ?? null;
    const oldestAge = oldest ? Math.floor((now.getTime() - oldest.getTime()) / 60_000) : null;

    const problems: string[] = [];
    for (const c of conns) {
      if (c.status === 'unhealthy') problems.push(`${c.plug_key} is unhealthy${c.last_error ? `: ${c.last_error}` : ''}.`);
      if (c.status === 'pending') problems.push(`${c.plug_key} has not finished connecting.`);
    }
    if (oldestAge !== null && oldestAge >= QUEUE_STALE_MINUTES) problems.push(`${Number(q!.depth)} messages are waiting; the oldest has waited ${oldestAge} minutes.`);
    if (d?.dead) problems.push(`${d.dead} background ${d.dead === 1 ? 'job has' : 'jobs have'} failed for good (${d.kinds.join(', ')}).`);
    for (const s of steps) problems.push(`Provisioning step "${s.step}" failed${s.error ? `: ${s.error}` : ''}.`);

    return {
      orgId: o.id,
      slug: o.slug,
      name: o.trading_name,
      status: o.status,
      connections: conns.map((c) => ({ id: c.id, plugKey: c.plug_key, venueId: c.venue_id, status: c.status, lastOkAt: c.last_ok_at, lastError: c.last_error })),
      queue: { depth: Number(q?.depth ?? 0), oldestQueuedAt: oldest, oldestAgeMinutes: oldestAge },
      deadJobs: { count: d?.dead ?? 0, lastAt: d?.lastDeadAt ?? null, kinds: d?.kinds ?? [] },
      failedProvisioningSteps: steps.map((s) => ({ step: s.step, error: s.error, attempts: s.attempts })),
      problems,
      healthy: problems.length === 0,
    };
  });
}

/** One org's health. Platform admins only. */
export async function getTenantHealth(app: App, actor: Principal, input: { orgId: string }): Promise<TenantHealth> {
  await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.orgId).success) throw notFound('Organisation not found');
  const [health] = await load(app, [input.orgId]);
  if (!health) throw notFound('Organisation not found');
  return health;
}

/** Every org's health, for the platform admin. Closed orgs are left out unless asked for. */
export async function listTenantHealth(app: App, actor: Principal, input: { includeClosed?: boolean; onlyUnhealthy?: boolean } = {}): Promise<TenantHealth[]> {
  await requirePlatformAdmin(app, actor);
  let all = await load(app, null);
  if (!input.includeClosed) all = all.filter((h) => h.status !== 'closed');
  if (input.onlyUnhealthy) all = all.filter((h) => !h.healthy);
  return all;
}
