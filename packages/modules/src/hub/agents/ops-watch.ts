import { z } from 'zod';
import { type App, deadJobSummary, defineJob, defineSchedule } from '@ros/core';
import { defineHostedAgent } from '../hosted';
import { type ActionResult, AgentToolError, type HostedRun, type HostedRunOutcome, hostedCaller, runHostedAgent } from '../runner';
import { agentOnAnywhere } from './weekly-digest';

/**
 * The operations watch: every quarter hour, per venue, it reads `ops_status` (the same tool an
 * assistant has) and writes a short note of what needs someone: a connected service that has
 * stopped working, orders flagged for staff, paid orders nobody has accepted, a venue that is
 * mid-service with no sale recorded when it usually has some, and background work that ran out
 * of attempts. No model is involved anywhere: the note is the findings, in order.
 *
 * Where a tool exists for what a finding needs, it proposes the action: a paid order left
 * waiting is proposed for acceptance (`order_decide`). That tool moves a guest's order and can
 * refund, so it is marked sensitive and the proposal always waits for a person; this agent's
 * ceiling is supervised in any case. The other findings have no tool behind them and are
 * reported only.
 */
export const opsWatchAgent = defineHostedAgent({
  key: 'ops_watch',
  name: 'Operations watch',
  description: 'Watches each venue for things that need someone: a service that stopped working, orders waiting or flagged, no sales when there usually are, and failed background work.',
  templateVersion: '1',
  ceiling: 'supervised',
  scopes: ['ops:read', 'orders:write'],
  role: 'manager',
});

/** The most actions one run proposes. The rest are in the note and come up again next time. */
export const OPS_WATCH_MAX_PROPOSALS = 5;

const opsShape = z.object({
  venue: z.string(),
  local_time: z.string(),
  findings: z.array(z.string()),
  connections: z.array(z.object({ service: z.string(), status: z.string() })),
  flagged_orders: z.array(z.object({ reference: z.string() })),
  waiting_orders: z.array(z.object({ reference: z.string(), waiting_minutes: z.number() })),
  trading: z.object({ quiet: z.boolean(), sales_today: z.number(), mid_service: z.boolean() }),
});

export interface OpsWatchOutput {
  venue: string;
  findings: string[];
  counts: { unhealthy_connections: number; flagged_orders: number; waiting_orders: number; quiet: boolean; dead_jobs: number };
  proposed: Array<{ order: string; status: ActionResult['status']; approvalId: string | null }>;
}

/** One venue's watch. `deadJobs` is the organisation's, read once by the job and given to each venue's run. */
export function opsWatchBody(deadJobs: { dead: number; kinds: string[] }) {
  return async (run: HostedRun): Promise<{ status?: 'succeeded' | 'skipped'; summary: string; output: OpsWatchOutput }> => {
    const status = opsShape.parse(await run.read('ops_status', {}));
    const findings = [...status.findings];
    if (deadJobs.dead > 0) {
      findings.push(`${deadJobs.dead} background ${deadJobs.dead === 1 ? 'task has' : 'tasks have'} failed for good (${deadJobs.kinds.slice(0, 5).join(', ')}). The platform team can see why; nothing more will be tried without them.`);
    }

    // Act where a tool exists: a paid order left waiting is proposed for acceptance.
    const proposed: OpsWatchOutput['proposed'] = [];
    for (const order of status.waiting_orders.slice(0, OPS_WATCH_MAX_PROPOSALS)) {
      const r = await run.act('order_decide', { order: order.reference, decision: 'accept' });
      proposed.push({ order: order.reference, status: r.status, approvalId: 'approvalId' in r ? r.approvalId : null });
      // At the cap nothing further can be proposed today; the note still lists every order.
      if (r.status === 'capped') break;
    }

    const queued = proposed.filter((p) => p.status === 'queued').length;
    const waiting = proposed.filter((p) => p.status === 'waiting').length;
    const would = proposed.filter((p) => p.status === 'shadow').length;
    const tail = [
      queued ? `Asked a manager to approve accepting ${queued} waiting ${queued === 1 ? 'order' : 'orders'}.` : '',
      waiting ? `${waiting} ${waiting === 1 ? 'proposal is' : 'proposals are'} already waiting for a manager.` : '',
      would ? `Shadow: would have asked a manager to accept ${would} waiting ${would === 1 ? 'order' : 'orders'}; nothing was queued.` : '',
      proposed.some((p) => p.status === 'capped') ? 'The day\'s limit on agent actions has been reached, so nothing more was proposed.' : '',
    ].filter(Boolean);

    return {
      summary: findings.length ? `${status.venue}, ${status.local_time.slice(11)}: ${[...findings, ...tail].join(' ')}` : `${status.venue}, ${status.local_time.slice(11)}: nothing needs attention.`,
      output: {
        venue: status.venue,
        findings,
        counts: {
          unhealthy_connections: status.connections.filter((c) => c.status === 'unhealthy').length,
          flagged_orders: status.flagged_orders.length,
          waiting_orders: status.waiting_orders.length,
          quiet: status.trading.quiet,
          dead_jobs: deadJobs.dead,
        },
        proposed,
      },
    };
  };
}

/** Watch every venue of one organisation where the agent is switched on. One run record per venue. */
export async function runOpsWatch(app: App, args: { orgId: string; trigger: string }): Promise<HostedRunOutcome[]> {
  const hc = await hostedCaller(app, { orgId: args.orgId, agent: opsWatchAgent });
  if (!hc) return [];
  // Platform read for this organisation's own jobs: core owns the jobs table and reports counts and kinds, never payloads.
  const dead = (await deadJobSummary(app, [args.orgId]))[0];
  const deadJobs = { dead: dead?.dead ?? 0, kinds: dead?.kinds ?? [] };
  const out: HostedRunOutcome[] = [];
  for (const venue of hc.caller.venues) {
    try {
      out.push(await runHostedAgent(app, { orgId: args.orgId, agent: opsWatchAgent, venueId: venue.id, trigger: args.trigger }, opsWatchBody(deadJobs)));
    } catch (e) {
      // One venue's failure must not stop the others being watched.
      if (!(e instanceof AgentToolError)) app.log.error('ops_watch: a venue could not be watched', { orgId: args.orgId, venueId: venue.id, error: (e as Error).message?.slice(0, 200) });
    }
  }
  return out;
}

export const opsWatchJob = defineJob({
  kind: 'hub.ops_watch',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 2,
  async handler(app, job) {
    if (!job.orgId) throw new Error('hub.ops_watch needs an org');
    await runOpsWatch(app, { orgId: job.orgId, trigger: `schedule:hub.ops_watch:${job.payload.bucket}` });
  },
});

export const opsWatchSchedule = defineSchedule({
  key: 'hub.ops_watch',
  everyMinutes: 15,
  scope: 'org',
  job: opsWatchJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: (app, orgId) => agentOnAnywhere(app, orgId, opsWatchAgent.key),
});
