import { z } from 'zod';
import type { RawBuilder } from 'kysely';
import { type App, type Ctx, AppError, audit, defineJob, enqueue, forbidden, invalid, json, localParts, notFound, requireOwner, requireStaff, sql, track, visibleVenueIds, zonedTimeToUtc } from '@ros/core';
import { requestApproval } from '../approvals/index';
import { queueMessage } from '../comms/outbox';
import { isSuppressed } from '../comms/suppression';
import { renderTemplate } from '../comms/templates';
import { type AgentMode, type HostedAgentDef, agentMode, finishAgentRun, listAgentRuns, startAgentRun, stricterMode } from '../hub/hosted';
import { hasConsent } from '../identity/consents';
import { issueCode } from '../offers/codes';
import { getOffer } from '../offers/definitions';
import { getOrg } from '../tenancy/orgs';
import { FLOW_AGENTS, flowEnrolled, flowExited, flowStepQueued } from './module';
import { compileFrame, homeVenueSql, reachableSql } from './segments';
import { assertCampaignsOnSomewhere, campaignVenueIds, getCampaignsSettings, primaryVenueId } from './settings';
import { CAMPAIGN_TEMPLATE_KEY, FLOW_TEMPLATE_KEYS } from './templates';

/**
 * Lifecycle flows: welcome, post-purchase, win-back, VIP and birthday (PIPELINE-CATALOG D2).
 *
 *   enrol      the ledger hook (a first sale, the VIP threshold), the consent hook (a guest just
 *              agreed to marketing) and the hourly run (lapsed guests, birthdays) put guests in
 *   decide     the hourly run finds, per venue, who is due a step now, at most a wave of them
 *   act        by the flow's mode (docs/modules/hub.md section 8):
 *                shadow      record who would get what, with a sample of the copy; send nothing
 *                supervised  one approval per batch; approved → the batch is queued
 *                autonomous  queue directly, inside the flow's daily cap (welcome only, no offer)
 *   exit       a purchase ends win-back and post-purchase; an opt-out ends everything
 *
 * Every step is idempotent: the message's key names the enrolment, its cycle and the step, the
 * guest's code is their one live code for the offer, and the step advances in the same
 * transaction as the queue. Replaying a run, a job or an approval sends nothing twice.
 */

export const FLOW_KEYS = ['welcome', 'post_purchase', 'winback', 'vip', 'birthday'] as const;
export type FlowKey = (typeof FLOW_KEYS)[number];
const FLOW_NAMES: Record<FlowKey, string> = { welcome: 'Welcome', post_purchase: 'Post-purchase', winback: 'Win-back', vip: 'VIP', birthday: 'Birthday' };

// ── Versioned templates (docs/DEPLOYMENT.md section 9: pinned per org, rollback is re-pinning) ──

export interface FlowStep {
  templateKey: string;
  /** Days after the previous step. The first step's timing comes from how the guest was enrolled. */
  afterDays: number;
  /** The guest's own code for the flow's offer goes in this message, when the flow has one. */
  offer: boolean;
}

export interface FlowTemplate {
  version: string;
  steps: FlowStep[];
  /** A purchase after enrolment ends the flow. */
  exitOnPurchase: boolean;
  /** Whether a guest who finished (or left) may be enrolled again later. */
  reenrol: 'never' | 'cooldown' | 'yearly';
}

export const FLOW_TEMPLATES: Record<FlowKey, Record<string, FlowTemplate>> = {
  welcome: { '1.0.0': { version: '1.0.0', steps: [{ templateKey: FLOW_TEMPLATE_KEYS.welcome, afterDays: 0, offer: true }], exitOnPurchase: false, reenrol: 'never' } },
  post_purchase: { '1.0.0': { version: '1.0.0', steps: [{ templateKey: FLOW_TEMPLATE_KEYS.post_purchase, afterDays: 0, offer: true }], exitOnPurchase: true, reenrol: 'never' } },
  winback: {
    '1.0.0': { version: '1.0.0', steps: [{ templateKey: FLOW_TEMPLATE_KEYS.winback, afterDays: 0, offer: true }], exitOnPurchase: true, reenrol: 'cooldown' },
    // 1.1.0 adds a reminder a week later to a guest who has still not been in.
    '1.1.0': {
      version: '1.1.0',
      steps: [
        { templateKey: FLOW_TEMPLATE_KEYS.winback, afterDays: 0, offer: true },
        { templateKey: FLOW_TEMPLATE_KEYS.winback_reminder, afterDays: 7, offer: true },
      ],
      exitOnPurchase: true,
      reenrol: 'cooldown',
    },
  },
  vip: { '1.0.0': { version: '1.0.0', steps: [{ templateKey: FLOW_TEMPLATE_KEYS.vip, afterDays: 0, offer: true }], exitOnPurchase: false, reenrol: 'never' } },
  birthday: { '1.0.0': { version: '1.0.0', steps: [{ templateKey: FLOW_TEMPLATE_KEYS.birthday, afterDays: 0, offer: true }], exitOnPurchase: false, reenrol: 'yearly' } },
};

/** What a new org is pinned to: the first version of each flow. Moving up is an owner's choice. */
export const INITIAL_FLOW_VERSION: Record<FlowKey, string> = { welcome: '1.0.0', post_purchase: '1.0.0', winback: '1.0.0', vip: '1.0.0', birthday: '1.0.0' };

// ── Config (flows.config) ────────────────────────────────────────────────────

export const flowConfig = z.object({
  channel: z.enum(['email', 'sms']).default('email'),
  /** At most this many guests per venue per run: a cold list warms up in waves, never one blast. */
  waveSize: z.number().int().min(1).max(5000).default(200),
  /** Autonomous only: at most this many messages from this flow per venue per venue-local day. */
  dailyCap: z.number().int().min(1).max(50_000).default(300),
  /** A step this many days overdue (waiting on approvals that never came) is dropped, not sent late. */
  staleAfterDays: z.number().int().min(1).max(90).default(14),
  welcomeDelayMinutes: z.number().int().min(0).max(10_080).default(10),
  /** One venue we measured took a median 49 days to a second visit; the nudge goes at day 21. */
  postPurchaseDays: z.number().int().min(1).max(180).default(21),
  winbackLapsedDays: z.number().int().min(14).max(730).default(60),
  /** Guests gone longer than this are not written to at all. */
  winbackMaxLapsedDays: z.number().int().min(30).max(1825).default(540),
  winbackCooldownDays: z.number().int().min(30).max(730).default(120),
  vipOrders: z.number().int().min(2).max(500).default(5),
  birthdayDaysBefore: z.number().int().min(0).max(31).default(7),
  /** The venue's own words for the first message. {{first_name}}, {{venue_name}} and {{offer_line}} are filled in. */
  copy: z
    .object({ subject: z.string().trim().min(1).max(200).optional(), body: z.string().trim().min(1).max(2000).optional() })
    .default({}),
});
export type FlowConfig = z.infer<typeof flowConfig>;

export interface FlowRow {
  id: string;
  key: FlowKey;
  name: string;
  mode: AgentMode;
  templateVersion: string;
  config: FlowConfig;
  offerId: string | null;
}

const FLOW_COLS = ['id', 'key', 'name', 'mode', 'template_version', 'config', 'offer_id'] as const;
function flowRow(r: { id: string; key: string; name: string; mode: AgentMode; template_version: string; config: unknown; offer_id: string | null }): FlowRow {
  const parsed = flowConfig.safeParse(r.config ?? {});
  return { id: r.id, key: r.key as FlowKey, name: r.name, mode: r.mode, templateVersion: r.template_version, config: parsed.success ? parsed.data : flowConfig.parse({}), offerId: r.offer_id };
}

export function flowTemplate(flow: Pick<FlowRow, 'key' | 'templateVersion'>): FlowTemplate {
  const t = FLOW_TEMPLATES[flow.key]?.[flow.templateVersion];
  if (!t) throw new Error(`Flow ${flow.key} has no template version ${flow.templateVersion}`);
  return t;
}

const RANK: Record<AgentMode, number> = { off: 0, shadow: 1, supervised: 2, autonomous: 3 };

/** The hosted agent behind a flow, carrying the org's pinned template version for its run records. */
export function flowAgent(flow: Pick<FlowRow, 'key' | 'templateVersion'>): HostedAgentDef {
  return { ...FLOW_AGENTS[flow.key], templateVersion: flow.templateVersion };
}

/**
 * The level a flow really runs at: the org's setting, never above the agent's ceiling, and
 * never above supervised when the flow gives away an offer (money-touching actions stay
 * supervised: docs/modules/hub.md section 8).
 */
export function effectiveMode(flow: Pick<FlowRow, 'key' | 'mode' | 'offerId'>): AgentMode {
  const ceiling: AgentMode = flow.offerId ? 'supervised' : FLOW_AGENTS[flow.key].ceiling;
  return RANK[flow.mode] > RANK[ceiling] ? ceiling : flow.mode;
}

/**
 * The level a flow runs at AT ONE VENUE: the stricter of the org's setting for the flow
 * (`effectiveMode`) and what that venue's own assistant settings allow its agent (the hub's
 * `hosted_agents` and `autonomy_level_per_agent`, read by `agentMode`). A venue that has not
 * switched the flow's agent on runs it at nothing, whatever the org's flow says; one that has
 * switched it on without raising it runs it in shadow.
 */
export async function effectiveModeAt(ctx: Ctx, flow: Pick<FlowRow, 'key' | 'mode' | 'offerId'>, venueId: string): Promise<AgentMode> {
  return stricterMode(effectiveMode(flow), await agentMode(ctx, venueId, FLOW_AGENTS[flow.key]));
}

// ── Reading and setting flows (console) ─────────────────────────────────────

/** Create the org's five flows, in shadow, pinned to their first template version. Idempotent. */
export async function ensureFlows(ctx: Ctx): Promise<void> {
  for (const key of FLOW_KEYS) {
    await ctx.db
      .insertInto('flows')
      .values({ org_id: ctx.orgId, key, name: FLOW_NAMES[key], mode: 'shadow', template_version: INITIAL_FLOW_VERSION[key], config: json({}), created_at: ctx.now(), updated_at: ctx.now() })
      .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
      .execute();
  }
}

export async function loadFlow(ctx: Ctx, key: string): Promise<FlowRow> {
  if (!(FLOW_KEYS as readonly string[]).includes(key)) throw notFound('Flow not found');
  const r = await ctx.db.selectFrom('flows').select(FLOW_COLS).where('key', '=', key).executeTakeFirst();
  if (!r) throw notFound('Flow not found');
  return flowRow(r);
}

async function loadFlowById(ctx: Ctx, id: string): Promise<FlowRow | null> {
  const r = await ctx.db.selectFrom('flows').select(FLOW_COLS).where('id', '=', id).executeTakeFirst();
  return r ? flowRow(r) : null;
}

export interface FlowView {
  id: string;
  key: FlowKey;
  name: string;
  /** What the org set. */
  mode: AgentMode;
  /** What the org's setting comes to after the agent's ceiling and the offer rule. A venue may hold it lower: see `venueModes`. */
  effectiveMode: AgentMode;
  /** What it actually runs at, at each venue with campaigns on that the caller can see: the stricter of `effectiveMode` and the venue's own setting for the flow's agent. */
  venueModes: Array<{ venueId: string; mode: AgentMode }>;
  /** The highest level this flow could be set to right now. */
  ceiling: AgentMode;
  templateVersion: string;
  availableVersions: string[];
  config: FlowConfig;
  offerId: string | null;
  steps: number;
  enrolments: { active: number; dueNow: number; completed: number; exited: number };
  lastRun: { at: Date; mode: string; status: string; summary: string | null } | null;
}

/** The flows with their mode, template, config, enrolment counts and last run, for the console. A manager. */
export async function listFlows(ctx: Ctx): Promise<FlowView[]> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  await ensureFlows(ctx);
  const rows = (await ctx.db.selectFrom('flows').select(FLOW_COLS).execute()).map(flowRow);
  const counts = await ctx.db
    .selectFrom('flow_enrollments')
    .select((eb) => [
      'flow_id',
      eb.fn.countAll<number>().filterWhere('status', '=', 'active').as('active'),
      eb.fn.countAll<number>().filterWhere((w) => w.and([w('status', '=', 'active'), w('next_at', '<=', ctx.now())])).as('due'),
      eb.fn.countAll<number>().filterWhere('status', '=', 'completed').as('completed'),
      eb.fn.countAll<number>().filterWhere('status', '=', 'exited').as('exited'),
    ])
    .groupBy('flow_id')
    .execute();
  const visible = visibleVenueIds(ctx);
  const venues = (await campaignVenueIds(ctx)).filter((id) => !visible || visible.includes(id));
  const out: FlowView[] = [];
  for (const f of rows.sort((a, b) => FLOW_KEYS.indexOf(a.key) - FLOW_KEYS.indexOf(b.key))) {
    const c = counts.find((x) => x.flow_id === f.id);
    const runs = await listAgentRuns(ctx, { agentKey: FLOW_AGENTS[f.key].key, limit: 1 });
    out.push({
      id: f.id,
      key: f.key,
      name: f.name,
      mode: f.mode,
      effectiveMode: effectiveMode(f),
      venueModes: await Promise.all(venues.map(async (venueId) => ({ venueId, mode: await effectiveModeAt(ctx, f, venueId) }))),
      ceiling: f.offerId ? 'supervised' : FLOW_AGENTS[f.key].ceiling,
      templateVersion: f.templateVersion,
      availableVersions: Object.keys(FLOW_TEMPLATES[f.key]),
      config: f.config,
      offerId: f.offerId,
      steps: flowTemplate(f).steps.length,
      enrolments: { active: Number(c?.active ?? 0), dueNow: Number(c?.due ?? 0), completed: Number(c?.completed ?? 0), exited: Number(c?.exited ?? 0) },
      lastRun: runs[0] ? { at: runs[0].startedAt, mode: runs[0].mode, status: runs[0].status, summary: runs[0].summary } : null,
    });
  }
  return out;
}

export const setFlowModeInput = z.object({ flowKey: z.enum(FLOW_KEYS), mode: z.enum(['off', 'shadow', 'supervised', 'autonomous']) });

/**
 * The mode switch. Anyone at manager level may turn a flow down (off or shadow). Turning it up
 * to supervised or autonomous is an owner's decision, and never past the flow's ceiling.
 */
export async function setFlowMode(ctx: Ctx, raw: z.input<typeof setFlowModeInput>): Promise<FlowView> {
  const parsed = setFlowModeInput.safeParse(raw);
  if (!parsed.success) throw invalid('Choose a flow and a mode.', { issues: parsed.error.issues });
  const input = parsed.data;
  if (RANK[input.mode] >= RANK.supervised) requireOwner(ctx);
  else requireStaff(ctx, { minRole: 'manager' });
  if (ctx.principal.kind === 'agent' && RANK[input.mode] >= RANK.supervised) throw forbidden('Only a person can let a flow send to guests.');
  await assertCampaignsOnSomewhere(ctx);
  await ensureFlows(ctx);
  const flow = await loadFlow(ctx, input.flowKey);
  const ceiling = FLOW_AGENTS[flow.key].ceiling;
  if (RANK[input.mode] > RANK[ceiling]) throw invalid(`The ${flow.name} flow can go no further than ${ceiling}: a person approves each batch.`);
  if (input.mode === 'autonomous' && flow.offerId) throw invalid('A flow that gives away an offer stays supervised. Remove the offer to let it run by itself.');
  await ctx.db.updateTable('flows').set({ mode: input.mode, updated_at: ctx.now() }).where('id', '=', flow.id).execute();
  await audit(ctx, { action: 'flow.mode_set', entityType: 'flow', entityId: flow.id, before: { mode: flow.mode }, after: { mode: input.mode } });
  return (await listFlows(ctx)).find((f) => f.id === flow.id)!;
}

export const updateFlowInput = z.object({
  flowKey: z.enum(FLOW_KEYS),
  /** Partial: merged over what is stored, then validated as a whole. */
  config: z.record(z.string(), z.unknown()).optional(),
  /** The offer each guest gets a code for. null removes it. */
  offerId: z.string().uuid().nullish(),
});

/** Change a flow's timing, channel, wave size, cap, copy or offer. An owner: flows are org-wide. */
export async function updateFlow(ctx: Ctx, raw: z.input<typeof updateFlowInput>): Promise<FlowView> {
  const parsed = updateFlowInput.safeParse(raw);
  if (!parsed.success) throw invalid('That flow setting is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireOwner(ctx);
  await assertCampaignsOnSomewhere(ctx);
  await ensureFlows(ctx);
  const flow = await loadFlow(ctx, input.flowKey);
  const merged = flowConfig.safeParse({ ...flow.config, ...(input.config ?? {}) });
  if (!merged.success) throw invalid(merged.error.issues[0]?.message ?? 'That flow setting is not valid.', { issues: merged.error.issues });
  let offerId = flow.offerId;
  if (input.offerId !== undefined) {
    if (input.offerId) {
      const offer = await getOffer(ctx, input.offerId);
      if (!offer.isActive) throw invalid('That offer is switched off.');
    }
    offerId = input.offerId ?? null;
  }
  await ctx.db.updateTable('flows').set({ config: json(merged.data), offer_id: offerId, updated_at: ctx.now() }).where('id', '=', flow.id).execute();
  await audit(ctx, { action: 'flow.updated', entityType: 'flow', entityId: flow.id, before: { config: flow.config, offerId: flow.offerId }, after: { config: merged.data, offerId } });
  return (await listFlows(ctx)).find((f) => f.id === flow.id)!;
}

export const pinFlowTemplateInput = z.object({ flowKey: z.enum(FLOW_KEYS), version: z.string().regex(/^\d+\.\d+\.\d+$/) });

/** Pin a flow to a template version. Moving up, or rolling back, is an owner's decision. */
export async function pinFlowTemplate(ctx: Ctx, raw: z.input<typeof pinFlowTemplateInput>): Promise<FlowView> {
  const parsed = pinFlowTemplateInput.safeParse(raw);
  if (!parsed.success) throw invalid('Choose a flow and a version.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireOwner(ctx);
  await assertCampaignsOnSomewhere(ctx);
  await ensureFlows(ctx);
  const flow = await loadFlow(ctx, input.flowKey);
  if (!FLOW_TEMPLATES[flow.key][input.version]) throw invalid(`There is no version ${input.version} of the ${flow.name} flow.`);
  await ctx.db.updateTable('flows').set({ template_version: input.version, updated_at: ctx.now() }).where('id', '=', flow.id).execute();
  await audit(ctx, { action: 'flow.template_pinned', entityType: 'flow', entityId: flow.id, before: { version: flow.templateVersion }, after: { version: input.version } });
  return (await listFlows(ctx)).find((f) => f.id === flow.id)!;
}

// ── Enrolment ─────────────────────────────────────────────────────────────────

/** Whether a guest can be sent marketing on a channel: an address, the consent, no suppression. */
export async function reachable(ctx: Ctx, customerId: string, channel: 'email' | 'sms'): Promise<boolean> {
  const c = await ctx.db.selectFrom('customers').select(['primary_email', 'primary_phone', 'status']).where('id', '=', customerId).executeTakeFirst();
  const address = channel === 'email' ? c?.primary_email : c?.primary_phone;
  if (!c || c.status !== 'active' || !address) return false;
  if (!(await hasConsent(ctx, customerId, channel === 'email' ? 'marketing_email' : 'marketing_sms'))) return false;
  return !(await isSuppressed(ctx, channel, address));
}

/** A guest's home venue for flows that are not about one sale. */
export async function homeVenueOf(ctx: Ctx, customerId: string): Promise<string> {
  const frame = await compileFrame(ctx);
  const r = await sql<{ v: string }>`
    select ${homeVenueSql(frame)} as v from customers c
    left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
    where c.id = ${customerId}`.execute(ctx.db);
  return r.rows[0]?.v ?? frame.primaryVenueId;
}

/** The org's flows, if it has any. Hooks use this to return quietly for an org without campaigns. */
export async function flowsByKey(ctx: Ctx): Promise<Map<FlowKey, FlowRow>> {
  const rows = await ctx.db.selectFrom('flows').select(FLOW_COLS).execute();
  return new Map(rows.map((r) => [r.key as FlowKey, flowRow(r)]));
}

/**
 * Put a guest in a flow. Returns false when they are already in it, or were in it and the
 * flow's template does not let them in again yet. Internal: hooks and the scheduled run.
 */
export async function enrol(ctx: Ctx, flow: FlowRow, a: { customerId: string; venueId: string; nextAt: Date; context?: Record<string, unknown> }): Promise<boolean> {
  if (flow.mode === 'off') return false;
  const tpl = flowTemplate(flow);
  const now = ctx.now();
  const existing = await ctx.db
    .selectFrom('flow_enrollments')
    .select(['id', 'status', 'enrolled_at', 'cycle', 'context'])
    .where('flow_id', '=', flow.id)
    .where('customer_id', '=', a.customerId)
    .forUpdate()
    .executeTakeFirst();
  const context = a.context ?? {};
  let cycle = 1;
  if (existing) {
    if (existing.status === 'active') return false;
    if (tpl.reenrol === 'never') return false;
    if (tpl.reenrol === 'cooldown' && existing.enrolled_at.getTime() > now.getTime() - flow.config.winbackCooldownDays * 86_400_000) return false;
    if (tpl.reenrol === 'yearly' && (existing.context as Record<string, unknown>)?.year === context.year) return false;
    cycle = existing.cycle + 1;
    await ctx.db
      .updateTable('flow_enrollments')
      .set({ status: 'active', step: 0, cycle, venue_id: a.venueId, next_at: a.nextAt, enrolled_at: now, completed_at: null, context: json(context) })
      .where('id', '=', existing.id)
      .execute();
  } else {
    const r = await ctx.db
      .insertInto('flow_enrollments')
      .values({ org_id: ctx.orgId, flow_id: flow.id, customer_id: a.customerId, venue_id: a.venueId, step: 0, cycle: 1, status: 'active', next_at: a.nextAt, enrolled_at: now, context: json(context) })
      .onConflict((oc) => oc.columns(['flow_id', 'customer_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (!r) return false;
  }
  await track(ctx, flowEnrolled, { flow_id: flow.id, flow_key: flow.key, cycle }, { customerId: a.customerId, venueId: a.venueId });
  return true;
}

export type ExitReason = 'purchase' | 'unsubscribed' | 'no_consent' | 'stale' | 'erased';

/** End active enrolments. Returns how many ended. */
export async function exitEnrolments(ctx: Ctx, where: { customerId: string; flowIds?: string[]; enrolledBefore?: Date }, reason: ExitReason): Promise<number> {
  let q = ctx.db
    .updateTable('flow_enrollments')
    .set((eb) => ({ status: 'exited', next_at: null, completed_at: ctx.now(), context: sql`${eb.ref('context')} || ${json({ exit: reason })}::jsonb` }))
    .where('customer_id', '=', where.customerId)
    .where('status', '=', 'active');
  if (where.flowIds) {
    if (!where.flowIds.length) return 0;
    q = q.where('flow_id', 'in', where.flowIds);
  }
  if (where.enrolledBefore) q = q.where('enrolled_at', '<=', where.enrolledBefore);
  const rows = await q.returning(['flow_id', 'venue_id']).execute();
  if (!rows.length) return 0;
  const flows = await flowsByKey(ctx);
  const byId = new Map([...flows.values()].map((f) => [f.id, f]));
  for (const r of rows) {
    const f = byId.get(r.flow_id);
    if (f) await track(ctx, flowExited, { flow_id: f.id, flow_key: f.key, reason }, { customerId: where.customerId, venueId: r.venue_id });
  }
  return rows.length;
}

/** Guests who have gone quiet: their last counted sale is past the lapse and inside the limit. */
async function enrolLapsed(ctx: Ctx, flow: FlowRow): Promise<number> {
  const c = flow.config;
  const now = ctx.now();
  const r = await sql<{ customer_id: string; venue_id: string }>`
    with a_last as (
      select t.customer_id, max(t.occurred_at) as last_at,
             (array_agg(t.venue_id order by t.occurred_at desc))[1] as venue_id
      from transactions t
      where t.org_id = ${ctx.orgId} and t.customer_id is not null and t.status in ('completed', 'partially_refunded')
      group by t.customer_id
    )
    select l.customer_id, l.venue_id
    from a_last l
    join customers c on c.id = l.customer_id and c.status = 'active'
    where l.last_at < ${new Date(now.getTime() - c.winbackLapsedDays * 86_400_000)}
      and l.last_at >= ${new Date(now.getTime() - c.winbackMaxLapsedDays * 86_400_000)}
      and ${reachableSql(c.channel)}
      and not exists (
        select 1 from flow_enrollments e
        where e.flow_id = ${flow.id} and e.customer_id = l.customer_id
          and (e.status = 'active' or e.enrolled_at > ${new Date(now.getTime() - c.winbackCooldownDays * 86_400_000)})
      )
    order by l.last_at desc
    limit 5000`.execute(ctx.db);
  let n = 0;
  for (const row of r.rows) if (await enrol(ctx, flow, { customerId: row.customer_id, venueId: row.venue_id, nextAt: now })) n++;
  return n;
}

/** Guests whose birthday falls in the coming days, once a year. */
async function enrolBirthdays(ctx: Ctx, flow: FlowRow): Promise<number> {
  const frame = await compileFrame(ctx);
  const r = await sql<{ customer_id: string; venue_id: string; year: number }>`
    select c.id as customer_id, ${homeVenueSql(frame)} as venue_id, extract(year from b.next_birthday)::int as year
    from customers c
    left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
    cross join lateral (
      select (c.birthday + make_interval(years => (extract(year from ${frame.today}::date) - extract(year from c.birthday))::int))::date as next_birthday
    ) b
    where c.org_id = ${ctx.orgId} and c.status = 'active' and c.birthday is not null
      and b.next_birthday between ${frame.today}::date and ${frame.today}::date + ${flow.config.birthdayDaysBefore}::int
      and ${reachableSql(flow.config.channel)}
      and not exists (
        select 1 from flow_enrollments e
        where e.flow_id = ${flow.id} and e.customer_id = c.id
          and (e.status = 'active' or e.context->>'year' = extract(year from b.next_birthday)::int::text)
      )
    limit 5000`.execute(ctx.db);
  let n = 0;
  for (const row of r.rows) if (await enrol(ctx, flow, { customerId: row.customer_id, venueId: row.venue_id, nextAt: ctx.now(), context: { year: row.year } })) n++;
  return n;
}

// ── One step for one guest ────────────────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function longDate(at: Date, timezone: string): string {
  const p = localParts(at, timezone);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** Where a guest claims a code, on the org's own site. Empty until a domain is live. */
export async function claimUrl(ctx: Ctx, code: string): Promise<string> {
  const r = await ctx.db
    .selectFrom('domains')
    .select('host')
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .orderBy('venue_id', (ob) => ob.asc().nullsFirst())
    .executeTakeFirst();
  return r ? `${ctx.app.config.scheme}://${r.host}/claim/${encodeURIComponent(code)}` : '';
}

/** The guest's own code in plain words, for the message. Empty when the flow has no offer or none could be issued. */
export async function offerLineFor(ctx: Ctx, a: { offerId: string; customerId: string; source: string; channel: 'email' | 'sms' }): Promise<{ line: string; code: string | null }> {
  let issued;
  try {
    issued = await issueCode(ctx, { offerId: a.offerId, customerId: a.customerId, source: a.source });
  } catch (e) {
    // Offers switched off, the offer ended, or a once-only offer the guest has had: the message goes without it.
    if (e instanceof AppError) return { line: '', code: null };
    throw e;
  }
  const org = await getOrg(ctx);
  const code = issued.code;
  const until = longDate(code.expiresAt, org.timezone);
  if (a.channel === 'sms') return { line: `Your code ${code.code}: ${code.summary}, until ${until}.`, code: code.code };
  const url = await claimUrl(ctx, code.code);
  return {
    line: `Your own code is ${code.code}: ${code.summary}. It works once, until ${until}. Show it at the counter or use it when you order online.${url ? `\n\nClaim it here: ${url}` : ''}`,
    code: code.code,
  };
}

/** Fill the venue's own flow copy. Only these three names are filled; anything else is left as written. */
function fillCopy(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(first_name|venue_name|offer_line)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

interface Rendered {
  templateKey: string;
  variables: Record<string, string>;
}

/** Which template and variables a step goes out with: the venue's own copy for the first step, else the flow's template. */
function stepMessage(flow: FlowRow, tpl: FlowTemplate, step: number, vars: { first_name: string; venue_name: string; offer_line: string }, defaultSubject: string): Rendered {
  const s = tpl.steps[step]!;
  const copy = flow.config.copy;
  if (step === 0 && copy.body) {
    return { templateKey: CAMPAIGN_TEMPLATE_KEY, variables: { subject: fillCopy(copy.subject ?? defaultSubject, vars), body: fillCopy(copy.body, vars) } };
  }
  return { templateKey: s.templateKey, variables: vars };
}

async function venueName(ctx: Ctx, venueId: string): Promise<string> {
  const v = await ctx.db.selectFrom('venues').select('name').where('id', '=', venueId).executeTakeFirst();
  return v?.name ?? (await getOrg(ctx)).tradingName;
}

export type StepOutcome = 'queued' | 'suppressed' | 'skipped';

/**
 * Carry out one step for one enrolment: issue the guest's code when the step carries the offer,
 * queue the message (comms enforces consent and suppression now and again at send), advance.
 * Only acts when the enrolment is still active at the step and cycle the caller saw.
 */
export async function processStep(ctx: Ctx, flow: FlowRow, expect: { enrollmentId: string; step: number; cycle: number }, mode: 'supervised' | 'autonomous'): Promise<StepOutcome> {
  const e = await ctx.db
    .selectFrom('flow_enrollments')
    .select(['id', 'customer_id', 'venue_id', 'step', 'cycle', 'status'])
    .where('id', '=', expect.enrollmentId)
    .where('flow_id', '=', flow.id)
    .forUpdate()
    .executeTakeFirst();
  if (!e || e.status !== 'active' || e.step !== expect.step || e.cycle !== expect.cycle) return 'skipped';
  const tpl = flowTemplate(flow);
  const step = tpl.steps[e.step];
  const now = ctx.now();
  if (!step) {
    await ctx.db.updateTable('flow_enrollments').set({ status: 'completed', completed_at: now, next_at: null }).where('id', '=', e.id).execute();
    return 'skipped';
  }
  const venueId = e.venue_id ?? (await primaryVenueId(ctx));
  const channel = flow.config.channel;
  const customer = await ctx.db.selectFrom('customers').select('first_name').where('id', '=', e.customer_id).executeTakeFirst();

  const offer = step.offer && flow.offerId ? await offerLineFor(ctx, { offerId: flow.offerId, customerId: e.customer_id, source: `flow:${flow.key}`, channel }) : { line: '', code: null };
  const vars = { first_name: customer?.first_name ?? 'there', venue_name: await venueName(ctx, venueId), offer_line: offer.line };
  const msg = stepMessage(flow, tpl, e.step, vars, FLOW_NAMES[flow.key]);
  const q = await queueMessage(ctx, {
    templateKey: msg.templateKey,
    channel,
    customerId: e.customer_id,
    venueId,
    flowId: flow.id,
    idempotencyKey: `flow:${e.id}:c${e.cycle}:s${e.step}`,
    variables: msg.variables,
  });

  const next = tpl.steps[e.step + 1];
  if (next) {
    await ctx.db
      .updateTable('flow_enrollments')
      .set({ step: e.step + 1, next_at: new Date(now.getTime() + next.afterDays * 86_400_000) })
      .where('id', '=', e.id)
      .execute();
  } else {
    await ctx.db.updateTable('flow_enrollments').set({ status: 'completed', completed_at: now, next_at: null }).where('id', '=', e.id).execute();
  }
  await track(ctx, flowStepQueued, { flow_id: flow.id, flow_key: flow.key, step: e.step, mode, with_offer: !!offer.code }, { customerId: e.customer_id, venueId });
  return q.status;
}

// ── The run: decide, then act by mode ─────────────────────────────────────────

interface DueRow {
  id: string;
  customer_id: string;
  step: number;
  cycle: number;
  first_name: string | null;
}

/** Drop what waited too long, drop who can no longer be reached, and return who is due now (at most `limit`). */
async function dueAtVenue(ctx: Ctx, flow: FlowRow, venueId: string, limit: number): Promise<{ due: DueRow[]; totalDue: number; stale: number; unreachable: number }> {
  const now = ctx.now();
  const staleBefore = new Date(now.getTime() - flow.config.staleAfterDays * 86_400_000);
  const base = (q: RawBuilder<unknown>) => sql`
    select e.id, e.customer_id, e.step, e.cycle, c.first_name
    from flow_enrollments e join customers c on c.id = e.customer_id
    where e.org_id = ${ctx.orgId} and e.flow_id = ${flow.id} and e.venue_id = ${venueId}
      and e.status = 'active' and e.next_at <= ${now} and ${q}`;

  const staleRows = await sql<{ customer_id: string }>`${base(sql`e.next_at < ${staleBefore}`)}`.execute(ctx.db);
  for (const r of staleRows.rows) await exitEnrolments(ctx, { customerId: r.customer_id, flowIds: [flow.id] }, 'stale');
  const gone = await sql<{ customer_id: string }>`${base(sql`not ${reachableSql(flow.config.channel)}`)}`.execute(ctx.db);
  for (const r of gone.rows) await exitEnrolments(ctx, { customerId: r.customer_id, flowIds: [flow.id] }, 'no_consent');

  const total = await sql<{ n: number }>`select count(*)::int as n from (${base(sql`true`)}) x`.execute(ctx.db);
  const due = limit > 0 ? (await sql<DueRow>`${base(sql`true`)} order by e.next_at, e.id limit ${limit}`.execute(ctx.db)).rows : [];
  return { due, totalDue: total.rows[0]!.n, stale: staleRows.rows.length, unreachable: gone.rows.length };
}

export interface SampleMessage {
  /** First name only. */
  firstName: string;
  subject: string | null;
  body: string;
}

/** What the first few guests would receive, rendered with first names only and a placeholder for the code. */
async function sampleCopy(ctx: Ctx, flow: FlowRow, venueId: string, due: DueRow[], offerSummary: string | null): Promise<SampleMessage[]> {
  const tpl = flowTemplate(flow);
  const org = await getOrg(ctx);
  const vname = await venueName(ctx, venueId);
  const out: SampleMessage[] = [];
  for (const d of due.slice(0, 3)) {
    const step = tpl.steps[d.step];
    if (!step) continue;
    const vars = {
      first_name: d.first_name ?? 'there',
      venue_name: vname,
      offer_line: step.offer && offerSummary ? `[Their own code goes here: ${offerSummary}.]` : '',
    };
    const msg = stepMessage(flow, tpl, d.step, vars, FLOW_NAMES[flow.key]);
    const { rendered } = await renderTemplate(ctx, msg.templateKey, flow.config.channel, msg.variables, { orgName: org.tradingName });
    out.push({ firstName: vars.first_name, subject: rendered.subject, body: rendered.text });
  }
  return out;
}

async function messagesToday(ctx: Ctx, flowId: string, venueId: string): Promise<number> {
  const org = await getOrg(ctx);
  const dayStart = zonedTimeToUtc(localParts(ctx.now(), org.timezone).date, '00:00:00', org.timezone);
  const r = await ctx.db
    .selectFrom('messages')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('flow_id', '=', flowId)
    .where('venue_id', '=', venueId)
    .where('status', '!=', 'suppressed')
    .where('queued_at', '>=', dayStart)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export const FLOW_BATCH_APPROVAL = 'campaigns.flow_batch';

export interface FlowBatchPayload {
  flowId: string;
  flowKey: FlowKey;
  venueId: string;
  channel: 'email' | 'sms';
  templateVersion: string;
  withOffer: boolean;
  count: number;
  entries: Array<{ id: string; step: number; cycle: number }>;
  sample: SampleMessage[];
}

export interface VenueRunResult {
  venueId: string;
  mode: AgentMode;
  runId: string;
  due: number;
  acted: number;
  approvalId: string | null;
}

/** One flow at one venue, as one hosted-agent run. Internal: the scheduled job. */
export async function runFlowAtVenue(ctx: Ctx, flow: FlowRow, venueId: string, trigger: string): Promise<VenueRunResult> {
  const mode = await effectiveModeAt(ctx, flow, venueId);
  // Off here (the org's flow, or this venue's own setting for its agent): nothing runs and nothing is recorded.
  if (mode === 'off') return { venueId, mode, runId: '', due: 0, acted: 0, approvalId: null };
  const channelWord = flow.config.channel === 'email' ? 'email' : 'SMS';
  const vname = await venueName(ctx, venueId);
  const runId = await startAgentRun(ctx, { agent: flowAgent(flow), venueId, mode, trigger });
  const offer = flow.offerId ? await getOffer(ctx, flow.offerId).catch(() => null) : null;
  const offerSummary = offer?.isActive ? offer.summary : null;

  let limit = flow.config.waveSize;
  let capLeft: number | null = null;
  if (mode === 'autonomous') {
    capLeft = Math.max(0, flow.config.dailyCap - (await messagesToday(ctx, flow.id, venueId)));
    limit = Math.min(limit, capLeft);
  }
  const { due, totalDue, stale, unreachable } = await dueAtVenue(ctx, flow, venueId, limit);
  const base = { venueId, mode, templateVersion: flow.templateVersion, channel: flow.config.channel, due: totalDue, exited: { stale, noConsent: unreachable }, withOffer: !!offerSummary };
  const result = (acted: number, approvalId: string | null = null): VenueRunResult => ({ venueId, mode, runId, due: totalDue, acted, approvalId });

  if (mode === 'shadow') {
    const sample = await sampleCopy(ctx, flow, venueId, due, offerSummary);
    await finishAgentRun(ctx, runId, {
      status: 'succeeded',
      summary: due.length
        ? `Shadow: would send the ${flow.name} ${channelWord} to ${due.length} ${due.length === 1 ? 'guest' : 'guests'} at ${vname}${offerSummary ? `, each with their own code (${offerSummary})` : ''}.${totalDue > due.length ? ` ${totalDue - due.length} more are due and would go in later waves.` : ''} Nothing was sent.`
        : `Shadow: nobody is due the ${flow.name} ${channelWord} at ${vname}. Nothing was sent.`,
      output: { ...base, wouldSend: due.length, sample },
    });
    return result(0);
  }

  if (mode === 'supervised') {
    const pending = await ctx.db
      .selectFrom('approvals')
      .select(['id', 'created_at'])
      .where('kind', '=', FLOW_BATCH_APPROVAL)
      .where('subject_type', '=', 'flow_batch')
      .where('subject_id', '=', `${flow.id}:${venueId}`)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (pending) {
      await finishAgentRun(ctx, runId, { status: 'skipped', summary: `Waiting for a manager to approve the ${flow.name} batch for ${vname}. No new batch until that one is decided.`, output: { ...base, approvalId: pending.id } });
      return result(0, pending.id);
    }
    if (!due.length) {
      await finishAgentRun(ctx, runId, { status: 'succeeded', summary: `Nobody is due the ${flow.name} ${channelWord} at ${vname}.`, output: { ...base, batch: 0 } });
      return result(0);
    }
    const sample = await sampleCopy(ctx, flow, venueId, due, offerSummary);
    const settings = await getCampaignsSettings(ctx);
    const payload: FlowBatchPayload = {
      flowId: flow.id,
      flowKey: flow.key,
      venueId,
      channel: flow.config.channel,
      templateVersion: flow.templateVersion,
      withOffer: !!offerSummary,
      count: due.length,
      entries: due.map((d) => ({ id: d.id, step: d.step, cycle: d.cycle })),
      sample,
    };
    const approval = await requestApproval(ctx, {
      kind: FLOW_BATCH_APPROVAL,
      subjectType: 'flow_batch',
      subjectId: `${flow.id}:${venueId}`,
      venueId,
      summary: `Send the ${flow.name} ${channelWord} to ${due.length} ${due.length === 1 ? 'guest' : 'guests'} of ${vname}${offerSummary ? `, each with their own code (${offerSummary})` : ''}. Nothing goes until you approve; anyone who opts out before it goes is skipped.`,
      payload,
      expiresAt: new Date(ctx.now().getTime() + settings.approvalTtlHours * 3_600_000),
    });
    await finishAgentRun(ctx, runId, { status: 'succeeded', summary: `Asked a manager to approve the ${flow.name} ${channelWord} to ${due.length} guests at ${vname}.`, output: { ...base, batch: due.length, approvalId: approval.id, sample } });
    return result(0, approval.id);
  }

  if (mode === 'autonomous') {
    let queued = 0;
    let suppressed = 0;
    for (const d of due) {
      const o = await processStep(ctx, flow, { enrollmentId: d.id, step: d.step, cycle: d.cycle }, 'autonomous');
      if (o === 'queued') queued++;
      else if (o === 'suppressed') suppressed++;
    }
    await finishAgentRun(ctx, runId, {
      status: 'succeeded',
      summary: `Queued the ${flow.name} ${channelWord} for ${queued} ${queued === 1 ? 'guest' : 'guests'} at ${vname}${suppressed ? ` (${suppressed} not sent: no consent or opted out)` : ''}.${capLeft !== null && totalDue > due.length ? ` ${totalDue - due.length} more wait for the next run or tomorrow's cap.` : ''}`,
      output: { ...base, queued, suppressed, dailyCapLeft: capLeft === null ? null : capLeft - queued },
    });
    return result(queued);
  }

  await finishAgentRun(ctx, runId, { status: 'skipped', summary: `The ${flow.name} flow is off.`, output: base });
  return result(0);
}

const WORKER = { kind: 'worker' as const, job: 'campaigns.flows' };

/**
 * Run the org's flows: enrol lapsed guests and birthdays, then act per venue where the module
 * is on. Each venue is its own transaction and its own agent run. Safe to run twice.
 */
export async function runFlows(app: App, orgId: string, opts: { flowKey?: FlowKey; trigger: string }): Promise<VenueRunResult[]> {
  const flows = await app.tenant(orgId, WORKER, async (ctx) => {
    if (!(await campaignVenueIds(ctx)).length) return [];
    await ensureFlows(ctx);
    const all = [...(await flowsByKey(ctx)).values()].filter((f) => f.mode !== 'off' && (!opts.flowKey || f.key === opts.flowKey));
    for (const f of all) {
      if (f.key === 'winback') await enrolLapsed(ctx, f);
      if (f.key === 'birthday') await enrolBirthdays(ctx, f);
    }
    return all;
  });
  const out: VenueRunResult[] = [];
  for (const flow of flows) {
    const venues = await app.tenant(orgId, WORKER, (ctx) => campaignVenueIds(ctx));
    for (const venueId of venues) {
      out.push(
        await app.tenant(orgId, WORKER, async (ctx) => {
          // Re-read: the mode or config may have changed since the run began.
          const fresh = await loadFlowById(ctx, flow.id);
          if (!fresh || fresh.mode === 'off') return { venueId, mode: 'off' as const, runId: '', due: 0, acted: 0, approvalId: null };
          return runFlowAtVenue(ctx, fresh, venueId, opts.trigger);
        }),
      );
    }
  }
  return out;
}

/** An approved batch, queued by a worker. Nothing goes if the flow was turned down or the module off since. */
export async function sendFlowBatch(ctx: Ctx, approvalId: string): Promise<{ queued: number; suppressed: number; skipped: number }> {
  const out = { queued: 0, suppressed: 0, skipped: 0 };
  const a = await ctx.db.selectFrom('approvals').select(['id', 'kind', 'status', 'payload', 'venue_id']).where('id', '=', approvalId).executeTakeFirst();
  if (!a || a.kind !== FLOW_BATCH_APPROVAL || a.status !== 'approved') return out;
  const p = a.payload as unknown as FlowBatchPayload;
  const flow = await loadFlowById(ctx, p.flowId);
  // Turned down since the batch was approved, for the org or at this venue: nothing goes.
  if (!flow || RANK[await effectiveModeAt(ctx, flow, p.venueId)] < RANK.supervised) return { ...out, skipped: p.entries.length };
  if (!(await campaignVenueIds(ctx)).includes(p.venueId)) return { ...out, skipped: p.entries.length };
  const runId = await startAgentRun(ctx, { agent: flowAgent(flow), venueId: p.venueId, mode: 'supervised', trigger: `approval:${approvalId}` });
  for (const e of p.entries) {
    const o = await processStep(ctx, flow, { enrollmentId: e.id, step: e.step, cycle: e.cycle }, 'supervised');
    out[o]++;
  }
  await finishAgentRun(ctx, runId, {
    status: 'succeeded',
    summary: `Approved batch: queued the ${flow.name} message for ${out.queued} guests${out.suppressed ? `, ${out.suppressed} not sent (no consent or opted out)` : ''}${out.skipped ? `, ${out.skipped} skipped (already sent, left the flow, or opted out)` : ''}.`,
    output: { approvalId, ...out },
  });
  return out;
}

export const flowRunJob = defineJob({
  kind: 'campaigns.flow_run',
  schema: z.object({ flowKey: z.enum(FLOW_KEYS).optional(), trigger: z.string().max(120) }),
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('campaigns.flow_run needs an org');
    await runFlows(app, job.orgId, job.payload);
  },
});

export const flowBatchSendJob = defineJob({
  kind: 'campaigns.flow_batch_send',
  schema: z.object({ approvalId: z.string().uuid() }),
  maxAttempts: 6,
  async handler(app, job) {
    if (!job.orgId) throw new Error('campaigns.flow_batch_send needs an org');
    await app.tenant(job.orgId, { kind: 'worker', job: 'campaigns.flow_batch_send' }, (ctx) => sendFlowBatch(ctx, job.payload.approvalId));
  },
});

/** Run a flow now rather than waiting for the hour. A manager; it does what the flow's mode allows, nothing more. */
export async function runFlowNow(ctx: Ctx, raw: { flowKey: FlowKey }): Promise<{ queued: true }> {
  const input = z.object({ flowKey: z.enum(FLOW_KEYS) }).parse(raw);
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  await enqueue(ctx, flowRunJob, { flowKey: input.flowKey, trigger: 'manual' }, { key: `flow-now:${input.flowKey}:${ctx.now().toISOString().slice(0, 16)}` });
  return { queued: true };
}
