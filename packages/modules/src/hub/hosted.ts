import { type Ctx, type StaffRole, getModule, json, keyedRegistry, register, requireStaff, visibleVenueIds } from '@ros/core';
import { hubModule } from './module';

/**
 * Hosted agents: scheduled work that drafts or acts for a venue (win-back messages, review
 * replies, the weekly summary). docs/modules/hub.md section 8.
 *
 * An agent here is a deterministic pipeline with, at most, bounded model steps at its leaves.
 * What it is allowed to do on its own is a per-venue setting with three levels:
 *
 *   shadow       works out what it would do and records it; nothing leaves, nothing changes
 *   supervised   queues what it would do for a person's approval (the approvals module)
 *   autonomous   acts, within the agent's own ceiling
 *
 * An agent whose actions send to guests or move money declares `ceiling: 'supervised'` and can
 * never be set higher, whatever the venue's config says.
 */
export type AgentMode = 'off' | 'shadow' | 'supervised' | 'autonomous';
const RANK: Record<AgentMode, number> = { off: 0, shadow: 1, supervised: 2, autonomous: 3 };
export const MODE_RANK: Readonly<Record<AgentMode, number>> = RANK;

/** Of two levels, the one that lets the agent do less. */
export function stricterMode(a: AgentMode, b: AgentMode): AgentMode {
  return RANK[a] <= RANK[b] ? a : b;
}

export interface HostedAgentDef {
  key: string;
  name: string;
  description: string;
  /** Bumped when the agent's behaviour changes; recorded on every run (docs/DEPLOYMENT.md section 9). */
  templateVersion: string;
  /** The highest level this agent may ever run at. */
  ceiling: 'supervised' | 'autonomous';
  /**
   * The scopes the agent holds, as an access key would (hub/runner.ts). It is offered only the
   * tools those scopes unlock, and only at venues whose settings allow the scope. Default: none.
   */
  scopes?: string[];
  /** The role it acts with at a venue where it is switched on. Default manager; never an owner. */
  role?: StaffRole;
}

const agents = keyedRegistry<HostedAgentDef>('hub.hostedAgents');

export function defineHostedAgent(def: HostedAgentDef): HostedAgentDef {
  if (!/^[a-z][a-z0-9_]*$/.test(def.key)) throw new Error(`Hosted agent ${def.key} must be snake_case`);
  return register(agents, def.key, def, 'Hosted agent');
}

export function listHostedAgents(): HostedAgentDef[] {
  return [...agents.values()];
}

export function getHostedAgent(key: string): HostedAgentDef | undefined {
  return agents.get(key);
}

/**
 * The level an agent runs at for a venue right now. Off unless the hub is on at the venue and
 * the venue has switched this agent on; shadow unless the venue has raised it; never above the
 * agent's ceiling.
 */
export async function agentMode(ctx: Ctx, venueId: string, def: HostedAgentDef): Promise<AgentMode> {
  const state = await getModule(ctx, venueId, hubModule);
  if (!state.enabled || !state.config.hosted_agents.includes(def.key)) return 'off';
  const wanted: AgentMode = state.config.autonomy_level_per_agent[def.key] ?? 'shadow';
  return RANK[wanted] > RANK[def.ceiling] ? def.ceiling : wanted;
}

export interface AgentRunInput {
  agent: HostedAgentDef;
  venueId?: string | null;
  mode: AgentMode;
  /** What set it off: a schedule key, an event, 'manual'. */
  trigger: string;
}

export interface AgentRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  /** Plain words: what it did, or would have done. Shown in the console. */
  summary: string;
  /** Structured detail. No guest contact details: counts, ids of drafts and approvals. */
  output?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

/** Record the start of a run. Internal callers (jobs) only. */
export async function startAgentRun(ctx: Ctx, input: AgentRunInput): Promise<string> {
  const row = await ctx.db
    .insertInto('agent_runs')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId ?? null,
      agent_key: input.agent.key,
      template_version: input.agent.templateVersion,
      mode: input.mode,
      trigger: input.trigger,
      status: 'running',
      started_at: ctx.now(),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function finishAgentRun(ctx: Ctx, runId: string, result: AgentRunResult): Promise<void> {
  await ctx.db
    .updateTable('agent_runs')
    .set({
      status: result.status,
      summary: result.summary.slice(0, 2000),
      output: result.output === undefined ? null : json(result.output),
      error: result.error?.slice(0, 2000) ?? null,
      tokens_in: result.tokensIn ?? null,
      tokens_out: result.tokensOut ?? null,
      finished_at: ctx.now(),
    })
    .where('id', '=', runId)
    .execute();
}

export interface AgentRunView {
  id: string;
  venueId: string | null;
  agentKey: string;
  agentName: string;
  templateVersion: string;
  mode: AgentMode;
  trigger: string;
  status: string;
  summary: string | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** What the hosted agents have done, or would have done, for the console. */
export async function listAgentRuns(ctx: Ctx, filter: { venueId?: string; agentKey?: string; limit?: number } = {}): Promise<AgentRunView[]> {
  requireStaff(ctx, { venueId: filter.venueId, minRole: 'manager' });
  const visible = visibleVenueIds(ctx);
  let q = ctx.db
    .selectFrom('agent_runs')
    .select(['id', 'venue_id', 'agent_key', 'template_version', 'mode', 'trigger', 'status', 'summary', 'error', 'started_at', 'finished_at'])
    .orderBy('started_at', 'desc')
    .limit(Math.min(filter.limit ?? 50, 200));
  if (filter.venueId) q = q.where('venue_id', '=', filter.venueId);
  else if (visible) q = q.where((eb) => eb.or([eb('venue_id', 'is', null), ...(visible.length ? [eb('venue_id', 'in', visible)] : [])]));
  if (filter.agentKey) q = q.where('agent_key', '=', filter.agentKey);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    agentKey: r.agent_key,
    agentName: agents.get(r.agent_key)?.name ?? r.agent_key,
    templateVersion: r.template_version,
    mode: r.mode,
    trigger: r.trigger,
    status: r.status,
    summary: r.summary,
    error: r.error,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}
