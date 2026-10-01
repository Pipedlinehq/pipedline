import { z } from 'zod';
import { type App, type Ctx, type Principal, defineJob, defineSchedule, enqueue, enqueuePlatform, invalid, isAppError, json, notFound, sql, track, keyedRegistry, register } from '@ros/core';
import { type Intake, type OnboardingOrigin, intakeProgress, parseIntake } from './intake';
import { orgProvisioned } from './module';
import { PROVISIONER, requirePlatformAdmin } from './platform';

/**
 * Provisioning (docs/ONBOARDING.md section 3): one job, driven off the completed intake, made
 * of steps. Every step is idempotent and its status is recorded, so a failed step is retried
 * on its own, a finished one is never redone, and a step waiting on the venue (DNS, mostly)
 * says so without holding up the rest. Modules add their own steps to the registry.
 */
export type StepOutcome =
  | { status: 'done'; result?: Record<string, unknown> }
  /** Nothing to do for this org (no custom domain asked for, no staff listed). */
  | { status: 'skipped'; reason: string }
  /** Waiting on something outside the platform. Say what, in words the venue can act on. */
  | { status: 'blocked'; blockedOn: string; result?: Record<string, unknown> };

export interface ProvisioningState {
  onboardingId: string;
  /** Null only until the step that creates the org has run. */
  orgId: string | null;
  /** Who opened the onboarding. A self-serve one has a draft intake: no address, hours or services yet. */
  origin: OnboardingOrigin;
  intake: Intake;
  /** What each finished step recorded, by step key. */
  results: Record<string, Record<string, unknown>>;
  /** What this step recorded on an earlier run (a blocked step keeps its provider ids here). */
  previous: Record<string, unknown> | null;
  /** 1 on the first run of this step. */
  attempt: number;
}

export interface ProvisioningStepDef {
  key: string;
  /** Steps run in this order; ties run in key order. */
  order: number;
  /** Shown on the status board. */
  label?: string;
  /** Keys of steps that must be finished (done or skipped) before this one is tried. */
  blockedOn?: string[];
  /**
   * Modules this step sets up. When one of them is switched on later (a self-serve venue adds
   * its plugins one at a time), a run that was skipped is done again: see requeueStepsForModule.
   */
  modules?: string[];
  /**
   * Do the step. Open short tenant transactions around provider calls, never across them. Must
   * be safe to run again after a crash at any point. Throwing records the step as failed.
   */
  run(app: App, state: ProvisioningState): Promise<StepOutcome>;
}

const registry = keyedRegistry<ProvisioningStepDef>('onboarding.provisioningSteps');

/** Add a step to every provisioning run. A module registers its own (menu import, floor plan, loyalty defaults …). */
export function registerProvisioningStep(def: ProvisioningStepDef): ProvisioningStepDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.key)) throw new Error(`Provisioning step ${def.key} must be snake_case`);
  return register(registry, def.key, def, 'Provisioning step');
}

export function listProvisioningSteps(): ProvisioningStepDef[] {
  return [...registry.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** For tests that register a step of their own. */
export function unregisterProvisioningStep(key: string): void {
  registry.delete(key);
}

/** After this many failed runs a step waits for a person (retryProvisioningStep). */
export const MAX_STEP_ATTEMPTS = 6;
/** A step left "running" this long is taken to have died with its worker. */
const RUNNING_TIMEOUT_MS = 10 * 60_000;

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'skipped';

export interface StepView {
  key: string;
  label: string;
  status: StepStatus;
  attempts: number;
  /** For a blocked step: what it is waiting on. For a pending one: the step it is waiting behind. */
  blockedOn: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ProvisioningRun {
  onboardingId: string;
  orgId: string | null;
  status: string;
  steps: StepView[];
}

const STEP_COLS = ['id', 'step', 'status', 'attempts', 'blocked_on', 'error', 'result', 'started_at', 'finished_at'] as const;

const labelOf = (key: string) => registry.get(key)?.label ?? key.replace(/_/g, ' ');

export function stepView(r: { step: string; status: string; attempts: number; blocked_on: string | null; error: string | null; result: unknown; started_at: Date | null; finished_at: Date | null }): StepView {
  return {
    key: r.step,
    label: labelOf(r.step),
    status: r.status as StepStatus,
    attempts: r.attempts,
    blockedOn: r.blocked_on,
    error: r.error,
    result: (r.result ?? null) as Record<string, unknown> | null,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** Where an onboarding stands given its steps. 'live' is set by go-live and never changed here. */
function statusFor(all: StepView[]): 'provisioning' | 'stalled' | 'review' {
  // A pending row for a step no module registers any more will never run; it does not hold the onboarding open.
  const steps = all.filter((s) => s.status !== 'pending' || registry.has(s.key));
  if (steps.some((s) => s.status === 'failed' && s.attempts >= MAX_STEP_ATTEMPTS)) return 'stalled';
  // A step held behind one that is waiting on the venue is itself waiting on the venue.
  const waiting = new Set(steps.filter((s) => s.status === 'blocked').map((s) => s.key));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of steps) {
      if (s.status === 'pending' && !waiting.has(s.key) && (registry.get(s.key)?.blockedOn ?? []).some((dep) => waiting.has(dep))) {
        waiting.add(s.key);
        grew = true;
      }
    }
  }
  if (steps.some((s) => s.status === 'failed' || s.status === 'running' || (s.status === 'pending' && !waiting.has(s.key)))) return 'provisioning';
  // Everything is done, skipped, or waiting on the venue: nothing more the machine can do now.
  return 'review';
}

/**
 * Run every step that can run now. Platform code, called by the job: it reads and writes the
 * onboarding outside any tenant (an onboarding has no org until its first step creates one),
 * and each step opens its own tenant transactions for the org's data.
 */
export async function runProvisioning(app: App, onboardingId: string): Promise<ProvisioningRun> {
  const onboarding = await app.db.selectFrom('onboardings').select(['id', 'org_id', 'status', 'intake', 'origin']).where('id', '=', onboardingId).executeTakeFirst();
  if (!onboarding) throw notFound('Onboarding not found');
  const intake = parseIntake(onboarding.intake, onboarding.origin);
  const defs = listProvisioningSteps();

  if (onboarding.status === 'intake') await app.db.updateTable('onboardings').set({ status: 'provisioning' }).where('id', '=', onboardingId).execute();
  if (defs.length) {
    await app.db
      .insertInto('provisioning_steps')
      .values(defs.map((d) => ({ org_id: onboarding.org_id, onboarding_id: onboardingId, step: d.key, status: 'pending' })))
      .onConflict((oc) => oc.columns(['onboarding_id', 'step']).doNothing())
      .execute();
  }

  let orgId = onboarding.org_id;
  const results: Record<string, Record<string, unknown>> = {};
  const loadSteps = () => app.db.selectFrom('provisioning_steps').select(STEP_COLS).where('onboarding_id', '=', onboardingId).execute();

  for (const def of defs) {
    const rows = await loadSteps();
    const byKey = new Map(rows.map((r) => [r.step, r]));
    for (const r of rows) if (r.status === 'done' || r.status === 'skipped') results[r.step] = (r.result ?? {}) as Record<string, unknown>;
    const row = byKey.get(def.key);
    if (!row || row.status === 'done' || row.status === 'skipped') continue;
    if (row.status === 'failed' && row.attempts >= MAX_STEP_ATTEMPTS) continue;

    const waitingOn = (def.blockedOn ?? []).find((dep) => {
      const d = byKey.get(dep);
      return !d || (d.status !== 'done' && d.status !== 'skipped');
    });
    if (waitingOn) {
      if (row.status !== 'running') {
        await app.db
          .updateTable('provisioning_steps')
          .set({ status: 'pending', blocked_on: `Waits for "${labelOf(waitingOn)}" to finish.` })
          .where('id', '=', row.id)
          .execute();
      }
      continue;
    }

    // Claim the step. Two workers running the same onboarding do not run the same step twice.
    const now = app.clock();
    const claimed = await app.db
      .updateTable('provisioning_steps')
      .set({ status: 'running', attempts: sql<number>`attempts + 1`, started_at: now, finished_at: null, error: null, blocked_on: null })
      .where('id', '=', row.id)
      .where((eb) =>
        eb.or([eb('status', 'in', ['pending', 'failed', 'blocked']), eb.and([eb('status', '=', 'running'), eb('started_at', '<', new Date(now.getTime() - RUNNING_TIMEOUT_MS))])]),
      )
      .returning(['id', 'attempts', 'result'])
      .executeTakeFirst();
    if (!claimed) continue;

    const previous = (claimed.result ?? null) as Record<string, unknown> | null;
    try {
      const outcome = await def.run(app, { onboardingId, orgId, origin: onboarding.origin, intake, results, previous, attempt: claimed.attempts });
      if (outcome.status === 'done') {
        const result = outcome.result ?? {};
        await app.db.updateTable('provisioning_steps').set({ status: 'done', result: json(result), finished_at: app.clock(), blocked_on: null, error: null }).where('id', '=', row.id).execute();
        results[def.key] = result;
      } else if (outcome.status === 'skipped') {
        const result = { reason: outcome.reason };
        await app.db.updateTable('provisioning_steps').set({ status: 'skipped', result: json(result), finished_at: app.clock(), blocked_on: null, error: null }).where('id', '=', row.id).execute();
        results[def.key] = result;
      } else {
        // Waiting is not failing: a poll that finds the venue has not added its DNS records yet does not count as an attempt.
        await app.db
          .updateTable('provisioning_steps')
          .set({ status: 'blocked', blocked_on: outcome.blockedOn.slice(0, 500), result: json({ ...(previous ?? {}), ...(outcome.result ?? {}) }), attempts: sql<number>`greatest(attempts - 1, 0)`, error: null })
          .where('id', '=', row.id)
          .execute();
      }
    } catch (e) {
      const message = isAppError(e) ? e.message : ((e as Error).message ?? 'unknown error');
      await app.db.updateTable('provisioning_steps').set({ status: 'failed', error: message.slice(0, 1000), finished_at: app.clock() }).where('id', '=', row.id).execute();
      app.log.error('provisioning step failed', { onboardingId, orgId, step: def.key, attempt: claimed.attempts, error: message });
    }

    // The first step creates the org; later steps and the step rows themselves belong to it from then on.
    if (!orgId) orgId = (await app.db.selectFrom('onboardings').select('org_id').where('id', '=', onboardingId).executeTakeFirstOrThrow()).org_id;
  }

  const steps = (await loadSteps()).map(stepView).sort((a, b) => (registry.get(a.key)?.order ?? 1e9) - (registry.get(b.key)?.order ?? 1e9) || a.key.localeCompare(b.key));
  const current = await app.db.selectFrom('onboardings').select(['status', 'org_id']).where('id', '=', onboardingId).executeTakeFirstOrThrow();
  let status = current.status;
  if (status !== 'live') {
    const next = statusFor(steps);
    if (next !== status) {
      await app.db.updateTable('onboardings').set({ status: next }).where('id', '=', onboardingId).execute();
      if (next === 'review' && current.org_id) {
        await app.tenant(current.org_id, PROVISIONER, (ctx) =>
          track(ctx, orgProvisioned, { onboarding_id: onboardingId, steps_done: steps.filter((s) => s.status === 'done').length, steps_blocked: steps.filter((s) => s.status === 'blocked').length }),
        );
      }
    }
    status = next;
  }
  return { onboardingId, orgId: current.org_id, status, steps };
}

export const provisionJob = defineJob({
  kind: 'onboarding.provision',
  schema: z.object({ onboardingId: z.string().uuid() }),
  maxAttempts: 3,
  async handler(app, job) {
    // A failed step is recorded on the step, where the status board shows it; the poll retries it.
    await runProvisioning(app, job.payload.onboardingId);
  },
});

/** Every ten minutes: re-run any onboarding with a step that is pending, failed (and not exhausted) or waiting on the venue. */
export const pollProvisioningJob = defineJob({
  kind: 'onboarding.poll',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 2,
  async handler(app, job) {
    // A scheduler's view across orgs: ids only.
    const due = await app.db
      .selectFrom('provisioning_steps as s')
      .innerJoin('onboardings as o', 'o.id', 's.onboarding_id')
      .select(['o.id', 'o.org_id'])
      .where('o.status', 'in', ['provisioning', 'review', 'live'])
      .where((eb) => eb.or([eb('s.status', 'in', ['pending', 'blocked', 'running']), eb.and([eb('s.status', '=', 'failed'), eb('s.attempts', '<', MAX_STEP_ATTEMPTS)])]))
      .groupBy(['o.id', 'o.org_id'])
      .execute();
    for (const o of due) {
      await enqueuePlatform(app, provisionJob, o.org_id, { onboardingId: o.id }, { key: `poll:${o.id}:${job.payload.bucket}` });
    }
  },
});

export const provisioningSchedule = defineSchedule({
  key: 'onboarding.poll',
  everyMinutes: 10,
  scope: 'platform',
  job: pollProvisioningJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
});

/** Start provisioning for a finished intake. Refuses, saying what is missing, while the intake is incomplete. */
export async function startProvisioning(app: App, actor: Principal, input: { onboardingId: string }): Promise<{ onboardingId: string; status: string }> {
  await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.onboardingId).success) throw notFound('Onboarding not found');
  const row = await app.db.selectFrom('onboardings').select(['id', 'org_id', 'status', 'intake']).where('id', '=', input.onboardingId).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  const progress = intakeProgress(row.intake);
  if (!progress.complete) {
    throw invalid(`The intake is not finished: ${progress.stillNeeded.map((s) => s.label).join(', ')}.`, { stillNeeded: progress.stillNeeded });
  }
  const status = row.status === 'intake' ? 'provisioning' : row.status;
  if (status !== row.status) await app.db.updateTable('onboardings').set({ status }).where('id', '=', row.id).execute();
  await enqueuePlatform(app, provisionJob, row.org_id, { onboardingId: row.id }, { key: `start:${row.id}:${app.clock().toISOString()}` });
  return { onboardingId: row.id, status };
}

/** Put an exhausted or failed step back in the queue, after a person has fixed what stopped it. */
export async function retryProvisioningStep(app: App, actor: Principal, input: { onboardingId: string; step: string }): Promise<void> {
  await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.onboardingId).success) throw notFound('Onboarding not found');
  const row = await app.db
    .updateTable('provisioning_steps')
    .set({ status: 'pending', attempts: 0, error: null, blocked_on: null })
    .where('onboarding_id', '=', input.onboardingId)
    .where('step', '=', input.step)
    .where('status', 'in', ['failed', 'blocked'])
    .returning(['id', 'org_id'])
    .executeTakeFirst();
  if (!row) throw notFound('That step is not waiting to be retried.');
  await app.db.updateTable('onboardings').set({ status: 'provisioning' }).where('id', '=', input.onboardingId).where('status', '=', 'stalled').execute();
  await enqueuePlatform(app, provisionJob, row.org_id, { onboardingId: input.onboardingId }, { key: `retry:${input.onboardingId}:${input.step}:${app.clock().toISOString()}` });
}

/**
 * A module was switched on at a venue after provisioning ran. Any step that sets that module up
 * and was skipped at the time (the module was off, so there was nothing to do) is put back in
 * the queue, in the transaction that switched the module on. Steps that already ran are left
 * alone: every step is safe to run again, but a finished one is never redone.
 */
export async function requeueStepsForModule(ctx: Ctx, moduleKey: string): Promise<string[]> {
  const keys = listProvisioningSteps()
    .filter((d) => d.modules?.includes(moduleKey))
    .map((d) => d.key);
  if (!keys.length) return [];
  const onboarding = await ctx.db.selectFrom('onboardings').select('id').executeTakeFirst();
  if (!onboarding) return [];
  const reset = await ctx.db
    .updateTable('provisioning_steps')
    .set({ status: 'pending', attempts: 0, error: null, blocked_on: null, result: null, finished_at: null })
    .where('onboarding_id', '=', onboarding.id)
    .where('step', 'in', keys)
    .where('status', '=', 'skipped')
    .returning('step')
    .execute();
  if (!reset.length) return [];
  await enqueue(ctx, provisionJob, { onboardingId: onboarding.id }, { key: `module:${onboarding.id}:${moduleKey}:${ctx.now().toISOString()}` });
  return reset.map((r) => r.step);
}
