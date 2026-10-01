import { z } from 'zod';
import { type App, type Ctx, type Principal, invalid, notFound, requireOwner, sql } from '@ros/core';
import { plainText } from '../website/safe';
import { timeToLiveHours } from './golive';
import { intakeProgress } from './intake';
import { requirePlatformAdmin } from './platform';
import { type StepView, listProvisioningSteps, stepView } from './provisioning';

/**
 * The platform's status board (docs/ONBOARDING.md section 3): every in-flight onboarding and
 * what each is blocked on. At thirty concurrent onboardings this board is how the business is run.
 */
export interface OnboardingBoardRow {
  onboardingId: string;
  orgId: string | null;
  name: string;
  status: string;
  intake: { complete: boolean; percentComplete: number; stillNeeded: string[] };
  steps: StepView[];
  /** What this onboarding is waiting on right now, in plain words: missing intake, the venue's DNS, a failed step. */
  blockedOn: string[];
  manualTouchMinutes: number;
  soldAt: Date;
  liveAt: Date | null;
  /** Hours from sold to live. null while in flight. */
  timeToLiveHours: number | null;
  /** Hours since sold, for an onboarding still in flight. */
  hoursInFlight: number | null;
}

const COLS = ['id', 'org_id', 'status', 'intake', 'manual_touch_minutes', 'sold_at', 'live_at'] as const;
type Row = { id: string; org_id: string | null; status: string; intake: unknown; manual_touch_minutes: number; sold_at: Date; live_at: Date | null };
type StepRow = Parameters<typeof stepView>[0] & { onboarding_id: string };

function toRow(app: App, o: Row, stepRows: StepRow[]): OnboardingBoardRow {
  const order = new Map(listProvisioningSteps().map((d, i) => [d.key, i]));
  const steps = stepRows.map(stepView).sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
  const progress = intakeProgress(o.intake);
  const blockedOn: string[] = [];
  // An intake only holds things up until the org is live; after that it is history.
  if (o.status !== 'live' && !progress.complete) blockedOn.push(`Intake: ${progress.stillNeeded.map((s) => s.label).join(', ')}`);
  for (const s of steps) {
    if (s.status === 'blocked' && s.blockedOn) blockedOn.push(s.blockedOn);
    if (s.status === 'failed') blockedOn.push(`${s.label} failed: ${s.error ?? 'unknown error'}`);
  }
  const identity = ((o.intake ?? {}) as { identity?: { tradingName?: unknown } }).identity;
  return {
    onboardingId: o.id,
    orgId: o.org_id,
    name: typeof identity?.tradingName === 'string' ? identity.tradingName : 'Unnamed',
    status: o.status,
    intake: { complete: progress.complete, percentComplete: progress.percentComplete, stillNeeded: progress.stillNeeded.map((s) => s.label) },
    steps,
    blockedOn,
    manualTouchMinutes: o.manual_touch_minutes,
    soldAt: o.sold_at,
    liveAt: o.live_at,
    timeToLiveHours: timeToLiveHours(o),
    hoursInFlight: o.live_at ? null : Math.round(((app.clock().getTime() - o.sold_at.getTime()) / 3_600_000) * 10) / 10,
  };
}

const STEP_COLS = ['onboarding_id', 'step', 'status', 'attempts', 'blocked_on', 'error', 'result', 'started_at', 'finished_at'] as const;

/**
 * Every onboarding, oldest sale first. By default the in-flight ones, plus any that is live but
 * still has a step waiting (a custom domain that lands after go-live).
 */
export async function listOnboardings(app: App, actor: Principal, input: { includeFinished?: boolean } = {}): Promise<OnboardingBoardRow[]> {
  await requirePlatformAdmin(app, actor);
  // The platform's own view across orgs: this is what the board is for.
  const rows = await app.db.selectFrom('onboardings').select(COLS).orderBy('sold_at').execute();
  if (!rows.length) return [];
  const steps = await app.db.selectFrom('provisioning_steps').select(STEP_COLS).where('onboarding_id', 'in', rows.map((r) => r.id)).execute();
  const board = rows.map((o) => toRow(app, o, steps.filter((s) => s.onboarding_id === o.id)));
  return input.includeFinished ? board : board.filter((b) => b.status !== 'live' || b.blockedOn.length > 0);
}

export interface OnboardingDetail extends OnboardingBoardRow {
  touches: Array<{ minutes: number; note: string; adminUserId: string | null; recordedAt: Date }>;
}

export async function getOnboarding(app: App, actor: Principal, input: { onboardingId: string }): Promise<OnboardingDetail> {
  await requirePlatformAdmin(app, actor);
  if (!z.string().uuid().safeParse(input.onboardingId).success) throw notFound('Onboarding not found');
  const row = await app.db.selectFrom('onboardings').select(COLS).where('id', '=', input.onboardingId).executeTakeFirst();
  if (!row) throw notFound('Onboarding not found');
  const steps = await app.db.selectFrom('provisioning_steps').select(STEP_COLS).where('onboarding_id', '=', row.id).execute();
  const touches = await app.db.selectFrom('onboarding_touches').select(['minutes', 'note', 'admin_user_id', 'recorded_at']).where('onboarding_id', '=', row.id).orderBy('recorded_at').execute();
  return { ...toRow(app, row, steps), touches: touches.map((t) => ({ minutes: t.minutes, note: t.note, adminUserId: t.admin_user_id, recordedAt: t.recorded_at })) };
}

export const manualTouchInput = z.object({
  onboardingId: z.string().uuid(),
  minutes: z.number().int().min(1).max(8 * 60),
  /** What the time went on. This is what tells us which step to automate next. */
  note: plainText(500),
});

/**
 * Record hands-on time spent on an onboarding (docs/ONBOARDING.md section 5). Each entry is
 * kept; the running total is on the onboarding and is what the platform reads.
 */
export async function recordManualTouch(app: App, actor: Principal, raw: z.input<typeof manualTouchInput>): Promise<{ manualTouchMinutes: number }> {
  const { adminUserId } = await requirePlatformAdmin(app, actor);
  const parsed = manualTouchInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That entry is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  return app.platform('onboarding: manual touch', async (pctx) => {
    const updated = await pctx.db
      .updateTable('onboardings')
      .set({ manual_touch_minutes: sql<number>`manual_touch_minutes + ${input.minutes}` })
      .where('id', '=', input.onboardingId)
      .returning('manual_touch_minutes')
      .executeTakeFirst();
    if (!updated) throw notFound('Onboarding not found');
    await pctx.db.insertInto('onboarding_touches').values({ onboarding_id: input.onboardingId, admin_user_id: adminUserId, minutes: input.minutes, note: input.note, recorded_at: pctx.now() }).execute();
    return { manualTouchMinutes: updated.manual_touch_minutes };
  });
}

export interface OnboardingMetrics {
  live: number;
  inFlight: number;
  /** Median hours from sold to live, across orgs that are live. null when none are. */
  medianTimeToLiveHours: number | null;
  /** Mean hands-on minutes per onboarding that went live. */
  meanManualTouchMinutes: number | null;
}

/** The two numbers that decide whether this business works, across every onboarding. */
export async function onboardingMetrics(app: App, actor: Principal): Promise<OnboardingMetrics> {
  await requirePlatformAdmin(app, actor);
  const rows = await app.db.selectFrom('onboardings').select(['sold_at', 'live_at', 'manual_touch_minutes']).execute();
  const live = rows.filter((r) => r.live_at);
  const hours = live.map((r) => timeToLiveHours(r)!).sort((a, b) => a - b);
  const mid = Math.floor(hours.length / 2);
  return {
    live: live.length,
    inFlight: rows.length - live.length,
    medianTimeToLiveHours: hours.length ? (hours.length % 2 ? hours[mid]! : Math.round(((hours[mid - 1]! + hours[mid]!) / 2) * 10) / 10) : null,
    meanManualTouchMinutes: live.length ? Math.round(live.reduce((s, r) => s + r.manual_touch_minutes, 0) / live.length) : null,
  };
}

export interface OwnOnboardingView {
  status: string;
  liveAt: Date | null;
  /** Each step with what the venue needs to do about it, e.g. the DNS records to add. */
  steps: Array<{ key: string; label: string; status: string; waitingOn: string | null; records: unknown[] }>;
}

/** The owner's view of their own onboarding: where it stands and anything that is waiting on them. */
export async function getOwnOnboarding(ctx: Ctx): Promise<OwnOnboardingView | null> {
  requireOwner(ctx);
  const row = await ctx.db.selectFrom('onboardings').select(['id', 'status', 'live_at']).executeTakeFirst();
  if (!row) return null;
  const order = new Map(listProvisioningSteps().map((d, i) => [d.key, i]));
  const steps = (await ctx.db.selectFrom('provisioning_steps').select(STEP_COLS).where('onboarding_id', '=', row.id).execute())
    .map(stepView)
    .sort((a, b) => (order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9));
  return {
    status: row.status,
    liveAt: row.live_at,
    // Errors and internal results stay with the platform; the venue sees what it can act on.
    steps: steps.map((s) => ({
      key: s.key,
      label: s.label,
      status: s.status,
      waitingOn: s.status === 'blocked' ? s.blockedOn : null,
      records: s.status === 'blocked' && Array.isArray(s.result?.records) ? (s.result.records as unknown[]) : [],
    })),
  };
}
