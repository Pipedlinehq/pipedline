import { z } from 'zod';
import {
  type AgentPrincipal,
  type App,
  AppError,
  type Ctx,
  ROLE_RANK,
  type StaffPrincipal,
  type StaffRole,
  type ToolDef,
  type WriteTool,
  audit,
  conflict,
  getModuleDef,
  getTool,
  requireOwner,
  localDate,
  sha256Hex,
  sql,
  staffOf,
  zonedTimeToUtc,
} from '@ros/core';
import { type Approval, listApprovals, onApprovalDecided, requestApproval } from '../approvals/index';
import { type Asking, type NoteStore, type ToolOutcome, runTool } from './calls';
import { type ConfirmState, argsDigest, questionDigest } from './confirm';
import { loadPlugOffers, runPlugTool } from './gateway';
import { type AgentMode, type AgentRunResult, type HostedAgentDef, MODE_RANK, finishAgentRun, getHostedAgent, startAgentRun, stricterMode } from './hosted';
import { type KeyVenue, type ResolvedAgentKey, hubStates } from './keys';
import { getOrgSettings, setOrgSettings } from '../tenancy/orgs';
import { HOSTED_SETTINGS_NAMESPACE, HUB_SETTINGS_NAMESPACE, type HostedAgentSettings, hostedAgentSettings, hubOrgSettings } from './module';
import { type OfferedTool, offeredTools, resolveVenue } from './offer';
import { knownScopes, scopeAllowed } from './scopes';

/**
 * The hosted-agent runner (docs/modules/hub.md section 8). A scheduled agent acts through the
 * same tool catalogue a person's assistant uses: the same offer rules (scope, the venue's
 * settings, the module switch, the role), the same `runTool` / `runPlugTool`, the same
 * allowlisted output and the same `agent_calls` record. What differs is who is asked.
 *
 *   - AN AGENT IS CODE. Its body is an ordinary function: it decides what to read and what to
 *     propose with `if` and arithmetic. A model appears only in `run.generate`, a bounded,
 *     schema-validated step with no tools, a fixed number of them per run, and whatever it
 *     returns is checked by the agent's own code before it is used.
 *   - A READ is one call of the tool (`run.read`).
 *   - A CHANGE (`run.act`) always starts as the tool's own question, built in a transaction that
 *     is rolled back. What happens to the question depends on the level the venue set:
 *       shadow       it is written to the run record as "would have"; nothing is queued or changed
 *       supervised   it waits in the approvals queue, one approval per proposed action. When a
 *                    person approves, the question is built again from what is true at that
 *                    moment and the change is made only if it still reads the same, in the same
 *                    transaction as the approval
 *       autonomous   it is made straight away, but only by an agent whose ceiling is autonomous
 *                    and only for a tool not marked `sensitive`; a sensitive one waits for a
 *                    person whatever the level
 *   - A DAILY CAP per organisation on proposed and made changes, all agents together.
 *   - No change at a connected service: a plug's read tools are offered to an agent, its write
 *     tools are not.
 */

/** A hosted agent acts as itself: this is the staff id of nobody. */
export const HOSTED_STAFF_ID = '00000000-0000-0000-0000-000000000000';
export const HOSTED_ACTION_APPROVAL = 'hub.agent_action';
/** A change a person rejected is not proposed again for this long. */
export const REPROPOSE_AFTER_HOURS = 24;
/** The most model steps one run may take. An agent that needs more is the wrong shape. */
export const MAX_MODEL_STEPS_PER_RUN = 4;

const RESOLVER = { kind: 'worker' as const, job: 'hub.hosted_agent' };

export function hostedKeyId(agentKey: string): string {
  return `hosted:${agentKey}`;
}

function capMode(wanted: AgentMode, ceiling: AgentMode): AgentMode {
  return MODE_RANK[wanted] > MODE_RANK[ceiling] ? ceiling : wanted;
}

export interface HostedCaller {
  caller: ResolvedAgentKey;
  /** The level the agent runs at, per venue it is switched on at. */
  modes: Map<string, Exclude<AgentMode, 'off'>>;
  /** How many venues the organisation has (open ones), so "everywhere" can be told from "some". */
  orgVenueCount: number;
  timezone: string;
  settings: HostedAgentSettings;
}

const HOSTED_DEFAULTS = hostedAgentSettings.parse({});

export async function getHostedAgentSettings(ctx: Ctx): Promise<HostedAgentSettings> {
  return getOrgSettings(ctx, HOSTED_SETTINGS_NAMESPACE, hostedAgentSettings, HOSTED_DEFAULTS);
}

/** An owner sets the organisation's daily cap on hosted-agent actions and how long a proposal waits. */
export async function setHostedAgentSettings(ctx: Ctx, patch: Partial<HostedAgentSettings>): Promise<HostedAgentSettings> {
  requireOwner(ctx);
  return setOrgSettings(ctx, HOSTED_SETTINGS_NAMESPACE, hostedAgentSettings, { ...(await getHostedAgentSettings(ctx)), ...patch });
}

/**
 * Who a hosted agent is, right now, for one organisation: built fresh for every run from the
 * venues' own settings, as a key is built fresh for every request. Null when the agent is
 * switched on nowhere (or not at the venue named), or the organisation is not trading.
 *
 * `as` puts a person behind the agent: the manager who approved what it proposed. The change is
 * then made with that person's roles, held to the agent's own venues and never above its role.
 */
export async function hostedCaller(
  app: App,
  args: { orgId: string; agent: HostedAgentDef; runId?: string | null; venueId?: string | null; as?: StaffPrincipal | null },
): Promise<HostedCaller | null> {
  return app.tenant(args.orgId, RESOLVER, (ctx) => hostedCallerIn(ctx, args));
}

/** The same, inside a transaction that is already open for the organisation. */
export async function hostedCallerIn(
  ctx: Ctx,
  args: { agent: HostedAgentDef; runId?: string | null; venueId?: string | null; as?: StaffPrincipal | null },
): Promise<HostedCaller | null> {
  const { agent } = args;
  const app = ctx.app;
  const org = await ctx.db.selectFrom('orgs').select(['trading_name', 'status', 'settings', 'timezone']).where('id', '=', ctx.orgId).executeTakeFirst();
  if (!org || (org.status !== 'live' && org.status !== 'onboarding')) return null;
  const all = (await ctx.db.selectFrom('venues').select(['id', 'slug', 'name', 'suburb', 'timezone', 'status']).where('org_id', '=', ctx.orgId).orderBy('name').orderBy('id').execute()).filter((v) => v.status !== 'closed');
  const states = await hubStates(ctx, all.map((v) => v.id));

  const modes = new Map<string, Exclude<AgentMode, 'off'>>();
  for (const v of all) {
    if (args.venueId && v.id !== args.venueId) continue;
    const state = states.get(v.id)!;
    // The same rule as agentMode(): off unless the hub is on here and the venue switched this agent on.
    if (!state.enabled || !state.config.hosted_agents.includes(agent.key)) continue;
    const mode = capMode(state.config.autonomy_level_per_agent[agent.key] ?? 'shadow', agent.ceiling);
    if (mode !== 'off') modes.set(v.id, mode);
  }
  if (!modes.size) return null;

  const on = all.filter((v) => modes.has(v.id));
  const modules = await ctx.db.selectFrom('venue_modules').select(['venue_id', 'module_key']).where('venue_id', 'in', on.map((v) => v.id)).where('enabled', '=', true).execute();
  const role: StaffRole = agent.role ?? 'manager';
  const person = args.as ?? null;
  const venues: KeyVenue[] = [];
  for (const v of on) {
    let roleHere = role;
    if (person) {
      // Behind a person: only where that person has a role, and with the lower of the two.
      const theirs = person.venueRoles[v.id];
      if (!theirs) continue;
      if (ROLE_RANK[theirs] < ROLE_RANK[role]) roleHere = theirs;
    }
    const rowsOn = new Set(modules.filter((m) => m.venue_id === v.id).map((m) => m.module_key));
    const modulesOn = [...rowsOn].filter((key) => {
      try {
        return getModuleDef(key).dependsOn.every((dep) => getModuleDef(dep).spine || rowsOn.has(dep));
      } catch {
        return false;
      }
    });
    venues.push({ id: v.id, slug: v.slug, name: v.name, suburb: v.suburb, timezone: v.timezone, role: roleHere, config: states.get(v.id)!.config, modulesOn });
  }
  if (!venues.length) return null;

  const venueRoles: Record<string, StaffRole> = {};
  for (const v of venues) venueRoles[v.id] = v.role;
  const known = new Set(knownScopes(app));
  const scopes = (agent.scopes ?? []).filter((s) => known.has(s) && venues.some((v) => scopeAllowed(s, v.config)));
  const stored = ((org.settings ?? {}) as Record<string, unknown>)[HUB_SETTINGS_NAMESPACE];
  const limits = hubOrgSettings.safeParse(stored ?? {});
  const hosted = hostedAgentSettings.safeParse(((org.settings ?? {}) as Record<string, unknown>)[HOSTED_SETTINGS_NAMESPACE] ?? {});

  const principal: AgentPrincipal = {
    kind: 'agent',
    keyId: hostedKeyId(agent.key),
    // Never an owner, whoever approved: an agent's reach is the venues it is switched on at.
    staff: { kind: 'staff', staffId: person?.staffId ?? HOSTED_STAFF_ID, userId: person?.userId ?? HOSTED_STAFF_ID, isOwner: false, venueRoles },
    scopes,
    venueIds: venues.map((v) => v.id),
    canWrite: true,
    audience: 'assistant',
  };
  return {
    caller: {
      orgId: ctx.orgId,
      orgName: org.trading_name,
      keyId: principal.keyId,
      keyName: agent.name,
      principal,
      venues,
      limits: limits.success ? limits.data : hubOrgSettings.parse({}),
      audience: 'assistant',
      kind: 'key',
      hosted: { agentKey: agent.key, runId: args.runId ?? null },
    },
    modes,
    orgVenueCount: all.length,
    timezone: org.timezone,
    settings: hosted.success ? hosted.data : HOSTED_DEFAULTS,
  };
}

// ── What a run may do ───────────────────────────────────────────────────────

/** A tool said no, was not on offer, or broke. `message` is the tool's own words, written for a person. */
export class AgentToolError extends Error {
  constructor(
    readonly tool: string,
    readonly reason: 'not_offered' | 'refused',
    message: string,
  ) {
    super(message);
    this.name = 'AgentToolError';
  }
}

/** A model step's output failed the agent's own check. Nothing built from it may be used. */
export class ModelStepRejected extends Error {
  constructor(
    readonly purpose: string,
    readonly problems: string[],
  ) {
    super(`The model's answer for ${purpose} was rejected: ${problems.slice(0, 5).join('; ')}`);
    this.name = 'ModelStepRejected';
  }
}

export type ActionResult =
  /** Shadow: this is what it would have asked. Nothing was queued or changed. */
  | { status: 'shadow'; tool: string; question: string }
  /** Waiting for a person in the approvals queue. */
  | { status: 'queued'; tool: string; question: string; approvalId: string }
  /** The same action is already waiting for a person; nothing new was queued. */
  | { status: 'waiting'; tool: string; approvalId: string }
  /** A person rejected this same action recently; it is not proposed again yet. */
  | { status: 'declined'; tool: string; approvalId: string }
  /** Made, by an autonomous agent, with a tool that is not sensitive. */
  | { status: 'done'; tool: string; question: string; output: Record<string, unknown> }
  /** The organisation's actions for the day are used up. */
  | { status: 'capped'; tool: string; cap: number }
  /** The tool is not on offer to this agent here, or it said no. */
  | { status: 'refused'; tool: string; message: string };

export interface ModelStep<T> {
  /** Why the model is called; appears in usage records. */
  purpose: string;
  system: string;
  /** Serialised as JSON. Aggregates and first names only: never a contact detail or a card. */
  input: unknown;
  schema: z.ZodType<T>;
  maxTokens?: number;
  tier?: 'fast' | 'quality';
  /** The agent's own check of the answer, in code. Any problem returned rejects the step. */
  check?: (output: T) => string[];
}

export interface HostedRun {
  readonly app: App;
  readonly orgId: string;
  readonly agent: HostedAgentDef;
  readonly runId: string;
  /** The level this run acts at: the venue's own, or the strictest of the venues it covers. */
  readonly mode: Exclude<AgentMode, 'off'>;
  /** The venue the run is for, or null for a run that covers every venue the agent is on at. */
  readonly venueId: string | null;
  /** The venues the agent is switched on at (and, for a venue run, only that one). */
  readonly venues: KeyVenue[];
  /** True when those are all of the organisation's venues. */
  readonly everywhere: boolean;
  readonly timezone: string;
  readonly trigger: string;
  now(): Date;
  /** Call a read tool, the venue's own or a connected service's (`<namespace>__<tool>`). Throws AgentToolError. */
  read<T = Record<string, unknown>>(tool: string, args?: Record<string, unknown>): Promise<T>;
  /** Propose a change, or make it, by the level this run acts at. Never throws for a refusal. */
  act(tool: string, args?: Record<string, unknown>): Promise<ActionResult>;
  /** One bounded model step. Throws ModelStepRejected when the agent's own check fails. */
  generate<T>(step: ModelStep<T>): Promise<T>;
  /** Everything `act` returned in this run, in order. */
  readonly actions: ActionResult[];
}

export interface HostedRunOutcome {
  status: 'succeeded' | 'failed' | 'skipped';
  mode: AgentMode;
  runId: string | null;
  summary: string;
  output?: unknown;
  actions: ActionResult[];
}

const YES = { confirm: { action: 'accept', content: { confirm: true } } };

/** Notes kept for the length of one run: a hosted agent has no access key to tie a row to. */
function runNotes(): NoteStore {
  const held = new Map<string, { tool: string; args: string; asked: string; spent: boolean }>();
  return {
    async record(_ctx, q) {
      held.set(q.nonce, { tool: q.tool, args: q.argsDigest, asked: q.questionDigest, spent: false });
    },
    async standing(_ctx, state) {
      const n = held.get(state.nonce);
      if (!n || n.tool !== state.tool || n.args !== state.args || n.asked !== state.asked) return 'unknown';
      return n.spent ? 'spent' : 'good';
    },
    async spend(_ctx, nonce) {
      const n = held.get(nonce);
      if (!n || n.spent) return false;
      n.spent = true;
      return true;
    },
  };
}

/** The start of the organisation's own calendar day. */
function dayStart(now: Date, timezone: string): Date {
  return zonedTimeToUtc(localDate(now, timezone), '00:00:00', timezone);
}

/**
 * Changes the hosted agents have proposed or made for this organisation today: every question a
 * write tool put for an agent that was not in shadow. One per action, whether it then waited
 * for a person or was made at once.
 */
export async function hostedActionsToday(ctx: Ctx, timezone: string): Promise<number> {
  const since = dayStart(ctx.now(), timezone);
  const r = await sql<{ n: number }>`
    select count(*)::int as n
    from agent_calls c join agent_runs r on r.id = c.agent_run_id
    where c.org_id = ${ctx.orgId} and c.actor_kind = 'hosted_agent' and c.effect = 'write' and c.outcome = 'asked'
      and c.occurred_at >= ${since} and r.mode <> 'shadow'`.execute(ctx.db);
  return r.rows[0]!.n;
}

/** What identifies one proposed action: the agent, the tool, the venue and the arguments. */
export function actionSubject(agentKey: string, tool: string, venueId: string | null, args: unknown): string {
  return `${agentKey}:${sha256Hex(`${venueId ?? ''}\0${argsDigest(tool, args)}`).slice(0, 40)}`;
}

const actionPayload = z.object({
  agent: z.string(),
  runId: z.string().uuid().nullable(),
  tool: z.string(),
  /** The tool's own arguments, without the venue. */
  input: z.record(z.string(), z.unknown()),
  venueId: z.string().uuid().nullable(),
  /** The digest of the question the approver is shown. */
  asked: z.string(),
  question: z.string(),
});
export type HostedActionPayload = z.infer<typeof actionPayload>;

async function insertCall(ctx: Ctx, call: { agentKey: string; runId: string | null; tool: string; outcome: string }): Promise<void> {
  await ctx.db
    .insertInto('agent_calls')
    .values({
      org_id: ctx.orgId,
      key_id: null,
      actor_kind: 'hosted_agent',
      hosted_agent_key: call.agentKey,
      agent_run_id: call.runId,
      plug_key: 'os',
      tool: call.tool,
      effect: 'write',
      outcome: call.outcome,
      occurred_at: ctx.now(),
    })
    .execute();
}

const failed = (outcome: ToolOutcome): string => (outcome.ok ? '' : outcome.message);

function buildRun(app: App, hc: HostedCaller, base: { agent: HostedAgentDef; runId: string; venueId: string | null; mode: Exclude<AgentMode, 'off'>; trigger: string }, usage: { tokensIn: number; tokensOut: number; steps: number }): HostedRun {
  const { caller } = hc;
  const { agent, runId, venueId, mode } = base;
  const actions: ActionResult[] = [];
  const notes = runNotes();
  const here = venueId ? caller.venues.find((v) => v.id === venueId) : undefined;

  /** A tool that acts on one venue is given the run's venue when the agent sees several. */
  const withVenue = (offered: OfferedTool, args: Record<string, unknown>): Record<string, unknown> => (offered.takesVenue && here && args.venue === undefined ? { ...args, venue: here.slug } : args);
  const find = (name: string, effect: 'read' | 'write'): OfferedTool | undefined => offeredTools(caller, { canAsk: true }).find((o) => o.tool.name === name && o.tool.effect === effect);

  const run: HostedRun = {
    app,
    orgId: caller.orgId,
    agent,
    runId,
    mode,
    venueId,
    venues: caller.venues,
    everywhere: caller.venues.length === hc.orgVenueCount,
    timezone: hc.timezone,
    trigger: base.trigger,
    actions,
    now: () => app.clock(),

    async read<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      if (tool.includes('__')) {
        // A connected service's tool. Reads only: `canAsk: false` withholds every write.
        const namespace = tool.slice(0, tool.indexOf('__'));
        const { offers } = await loadPlugOffers(app, caller, { canAsk: false, only: namespace });
        const offer = offers.find((o) => o.tools.some((t) => t.name === tool));
        const plugTool = offer?.tools.find((t) => t.name === tool);
        if (!offer || !plugTool || plugTool.effect !== 'read') throw new AgentToolError(tool, 'not_offered', `${tool} is not offered to ${agent.name} here.`);
        const out = await runPlugTool(app, caller, offer, plugTool, args);
        if (!out.ok) throw new AgentToolError(tool, 'refused', out.message);
        return out.output as T;
      }
      const offered = find(tool, 'read');
      if (!offered) throw new AgentToolError(tool, 'not_offered', `${tool} is not offered to ${agent.name} here.`);
      const out = await runTool(app, caller, offered, withVenue(offered, args));
      if (!out.ok) throw new AgentToolError(tool, 'refused', out.message);
      return out.output as T;
    },

    async act(tool: string, rawArgs: Record<string, unknown> = {}): Promise<ActionResult> {
      const done = (r: ActionResult): ActionResult => {
        actions.push(r);
        return r;
      };
      const offered = find(tool, 'write');
      if (!offered) return done({ status: 'refused', tool, message: `${tool} is not offered to ${agent.name} here.` });
      const args = withVenue(offered, rawArgs);
      const subject = actionSubject(agent.key, tool, venueId, args);

      if (mode !== 'shadow') {
        // Bookkeeping in the organisation's own transaction, as the worker the run is.
        const standing = await app.tenant(caller.orgId, RESOLVER, async (ctx) => {
          const pending = (await listApprovals(ctx, { status: 'pending', kind: HOSTED_ACTION_APPROVAL })).find((a) => a.subjectId === subject);
          if (pending) return { waiting: pending.id };
          const since = new Date(ctx.now().getTime() - REPROPOSE_AFTER_HOURS * 3_600_000);
          const rejected = (await listApprovals(ctx, { status: 'rejected', kind: HOSTED_ACTION_APPROVAL })).find((a) => a.subjectId === subject && (a.decidedAt ?? a.createdAt) > since);
          if (rejected) return { declined: rejected.id };
          return { used: await hostedActionsToday(ctx, hc.timezone) };
        });
        if ('waiting' in standing) return done({ status: 'waiting', tool, approvalId: standing.waiting! });
        if ('declined' in standing) return done({ status: 'declined', tool, approvalId: standing.declined! });
        const cap = hc.settings.actions_per_day;
        if (standing.used >= cap) {
          await app.tenant(caller.orgId, RESOLVER, (ctx) => insertCall(ctx, { agentKey: agent.key, runId, tool, outcome: 'capped' }));
          return done({ status: 'capped', tool, cap });
        }
      }

      // The first half, exactly as for an assistant: the tool's own question, nothing changed.
      let minted: ConfirmState | undefined;
      const asking: Asking = {
        canAsk: true,
        notes,
        mint: async (state) => {
          minted = state;
          return state.nonce;
        },
      };
      const first = await runTool(app, caller, offered, args, asking);
      if (first.ok || !first.ask || !minted) return done({ status: 'refused', tool, message: failed(first) || 'The tool did not say what it would do.' });
      const question = first.ask.question;
      const state: ConfirmState = minted;

      if (mode === 'shadow') return done({ status: 'shadow', tool, question });

      const sensitive = (offered.tool as WriteTool<unknown, unknown>).sensitive === true;
      if (mode === 'autonomous' && agent.ceiling === 'autonomous' && !sensitive) {
        // Nobody to ask and nobody needed: the same second half, the question rebuilt and compared.
        const second = await runTool(app, caller, offered, args, { ...asking, inputResponses: YES, state });
        if (!second.ok) return done({ status: 'refused', tool, message: second.message });
        return done({ status: 'done', tool, question, output: second.output });
      }

      // A person decides. One approval per proposed action.
      const { venue: _venue, ...own } = args;
      // The venue the tool acted on, resolved exactly as the call itself resolved it.
      const toolVenue = resolveVenue(caller, offered, args.venue)?.id ?? null;
      const payload: HostedActionPayload = { agent: agent.key, runId, tool, input: offered.takesVenue ? own : args, venueId: toolVenue, asked: state.asked, question };
      const approval = await app.tenant(caller.orgId, caller.principal, (ctx) =>
        requestApproval(ctx, {
          kind: HOSTED_ACTION_APPROVAL,
          subjectType: 'agent_action',
          subjectId: subject,
          venueId: toolVenue ?? venueId,
          summary: `${agent.name} proposes: ${question}`.slice(0, 2000),
          payload,
          expiresAt: new Date(ctx.now().getTime() + hc.settings.approval_ttl_hours * 3_600_000),
        }),
      );
      return done({ status: 'queued', tool, question, approvalId: approval.id });
    },

    async generate<T>(step: ModelStep<T>): Promise<T> {
      if (usage.steps >= MAX_MODEL_STEPS_PER_RUN) throw new Error(`${agent.key} asked for more than ${MAX_MODEL_STEPS_PER_RUN} model steps in one run`);
      usage.steps++;
      const result = await app.adapters.llm.generate({
        purpose: step.purpose,
        orgId: caller.orgId,
        system: step.system,
        input: JSON.stringify(step.input),
        schema: step.schema,
        tier: step.tier ?? 'fast',
        maxTokens: step.maxTokens ?? 600,
      });
      usage.tokensIn += result.usage.inputTokens;
      usage.tokensOut += result.usage.outputTokens;
      const problems = step.check ? step.check(result.output) : [];
      if (problems.length) throw new ModelStepRejected(step.purpose, problems);
      return result.output;
    },
  };
  return run;
}

export interface HostedAgentBody {
  (run: HostedRun): Promise<{ status?: 'succeeded' | 'skipped'; summary: string; output?: unknown }>;
}

/**
 * One run of a hosted agent for an organisation: for one venue, or (no venue named) for every
 * venue the agent is switched on at, at the strictest of their levels. Records the run, hands
 * the body its tools, and records how it ended. The body is called outside any transaction, so
 * a model step or a connected service is never called inside one. Safe to run twice only as far
 * as the body is: `act` de-duplicates a proposal that is already waiting.
 */
export async function runHostedAgent(app: App, args: { orgId: string; agent: HostedAgentDef; venueId?: string | null; trigger: string }, body: HostedAgentBody): Promise<HostedRunOutcome> {
  const { agent } = args;
  const venueId = args.venueId ?? null;
  const setup = await app.tenant(args.orgId, RESOLVER, async (ctx) => {
    const hc = await hostedCallerIn(ctx, { agent, venueId });
    if (!hc) return null;
    const mode = [...hc.modes.values()].reduce<AgentMode>((a, b) => stricterMode(a, b), 'autonomous') as Exclude<AgentMode, 'off'>;
    const runId = await startAgentRun(ctx, { agent, venueId, mode, trigger: args.trigger });
    hc.caller.hosted = { agentKey: agent.key, runId };
    return { hc, mode, runId };
  });
  if (!setup) return { status: 'skipped', mode: 'off', runId: null, summary: `${agent.name} is switched off here.`, actions: [] };

  const usage = { tokensIn: 0, tokensOut: 0, steps: 0 };
  const run = buildRun(app, setup.hc, { agent, runId: setup.runId, venueId, mode: setup.mode, trigger: args.trigger }, usage);
  let result: AgentRunResult;
  try {
    const r = await body(run);
    result = { status: r.status ?? 'succeeded', summary: r.summary, output: { ...((r.output ?? {}) as object), actions: run.actions } };
  } catch (e) {
    const message = e instanceof AppError || e instanceof AgentToolError || e instanceof ModelStepRejected ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
    app.log.error('hosted agent run failed', { agent: agent.key, orgId: args.orgId, venueId, runId: setup.runId, error: message.slice(0, 300) });
    result = { status: 'failed', summary: `${agent.name} could not finish. Nothing it had not already recorded was sent or changed.`, error: message, output: { actions: run.actions, ...(e instanceof ModelStepRejected ? { rejected: e.problems } : {}) } };
  }
  result.tokensIn = usage.steps ? usage.tokensIn : undefined;
  result.tokensOut = usage.steps ? usage.tokensOut : undefined;
  await app.tenant(args.orgId, RESOLVER, (ctx) => finishAgentRun(ctx, setup.runId, result));
  return { status: result.status, mode: setup.mode, runId: setup.runId, summary: result.summary, output: result.output, actions: run.actions };
}

// ── A person's decision on a proposed action ────────────────────────────────

const CHANGED = 'Nothing was changed. Something about this changed after it was proposed, so it no longer reads as it did. Reject this request; the agent will propose it again as it is now if it still applies.';
const WITHDRAWN = 'Nothing was changed. This agent has been switched off or turned back to shadow here since it proposed this, or the tool is no longer available to it. Reject this request.';

/**
 * Approved: build the question again from what is true now, as the agent with the approver
 * behind it, and make the change only if it reads as the approver was shown. Everything happens
 * in the deciding transaction, so the approval and the change commit together or not at all; a
 * throw leaves the approval pending and tells the person why.
 */
onApprovalDecided(HOSTED_ACTION_APPROVAL, async (ctx: Ctx, approval: Approval, decision) => {
  const parsed = actionPayload.safeParse(approval.payload);
  if (!parsed.success) {
    if (decision === 'approved') throw conflict(WITHDRAWN);
    return;
  }
  const p = parsed.data;
  if (decision !== 'approved') {
    await insertCall(ctx, { agentKey: p.agent, runId: p.runId, tool: p.tool, outcome: decision === 'rejected' ? 'declined' : 'expired' });
    return;
  }

  const agent = getHostedAgent(p.agent);
  const tool: ToolDef | undefined = getTool(p.tool);
  if (!agent || !tool || tool.effect !== 'write') throw conflict(WITHDRAWN);
  const person = staffOf(ctx);
  const hc = await hostedCallerIn(ctx, { agent, runId: p.runId, venueId: p.venueId, as: ctx.principal.kind === 'staff' ? person : null });
  if (!hc) throw conflict(WITHDRAWN);
  // The level now, not the level then: turned down since, and the proposal is void.
  const modeNow = [...hc.modes.values()].reduce<AgentMode>((a, b) => stricterMode(a, b), 'autonomous');
  if (MODE_RANK[modeNow] < MODE_RANK.supervised) throw conflict(WITHDRAWN);
  const offered = offeredTools(hc.caller, { canAsk: true }).find((o) => o.tool.name === tool.name && o.tool.effect === 'write');
  if (!offered || (p.venueId && !offered.venues.some((v) => v.id === p.venueId))) throw conflict(WITHDRAWN);

  // The same transaction, acting as the agent: the role checks behind the tool see the approver's roles.
  const actx: Ctx = { ...ctx, principal: hc.caller.principal, now: ctx.now, afterCommit: ctx.afterCommit };
  const input: unknown = tool.input.parse(p.input);
  const proposal = await tool.propose({ ctx: actx, venueId: p.venueId }, input);
  if (questionDigest(proposal.question) !== p.asked) throw conflict(CHANGED);
  const out = tool.output.safeParse(await proposal.commit());
  if (!out.success) {
    ctx.app.log.error('hosted action: the tool output did not match its shape', { tool: tool.name, issues: out.error.issues.slice(0, 5).map((i) => i.path.join('.')) });
    throw conflict('Nothing was changed. The venue system could not answer just now. Try again in a moment.');
  }
  await insertCall(ctx, { agentKey: p.agent, runId: p.runId, tool: p.tool, outcome: 'confirmed' });
  await audit(ctx, { action: 'agent.action_approved', entityType: 'approval', entityId: approval.id, venueId: p.venueId, after: { agent: p.agent, tool: p.tool } });
});
