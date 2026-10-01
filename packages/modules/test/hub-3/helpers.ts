import { type Principal, getModule, setModule } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { hub } from '@ros/modules';

export const WORKER: Principal = { kind: 'worker', job: 'test' };
export type Level = 'off' | 'shadow' | 'supervised' | 'autonomous';

/** Switch one hosted agent on at a venue at a level (or off), leaving the venue's other agents as they are. */
export async function setAgent(t: TestEnv, org: FixtureOrg, venueId: string, agentKey: string, level: Level): Promise<void> {
  await t.app.tenant(org.orgId, WORKER, async (ctx) => {
    const now = (await getModule(ctx, venueId, hub.hubModule)).config;
    const others = now.hosted_agents.filter((k) => k !== agentKey);
    const levels = { ...now.autonomy_level_per_agent };
    delete levels[agentKey];
    await setModule(ctx, hub.hubModule, {
      venueId,
      enabled: true,
      config: { hosted_agents: level === 'off' ? others : [...others, agentKey], autonomy_level_per_agent: level === 'off' ? levels : { ...levels, [agentKey]: level } },
    });
  });
}

export async function agentCalls(t: TestEnv, orgId: string, agentKey: string) {
  return t.db.selectFrom('agent_calls').select(['tool', 'effect', 'outcome', 'actor_kind', 'key_id', 'agent_run_id', 'plug_key']).where('org_id', '=', orgId).where('hosted_agent_key', '=', agentKey).orderBy('occurred_at').orderBy('id').execute();
}

export async function agentRuns(t: TestEnv, orgId: string, agentKey: string) {
  const rows = await t.db.selectFrom('agent_runs').select(['id', 'venue_id', 'mode', 'status', 'summary', 'output', 'error', 'trigger', 'tokens_in', 'tokens_out']).where('org_id', '=', orgId).where('agent_key', '=', agentKey).orderBy('started_at').orderBy('id').execute();
  return rows.map((r) => ({ ...r, output: r.output as unknown }));
}

export async function agentApprovals(t: TestEnv, orgId: string) {
  return t.db.selectFrom('approvals').select(['id', 'venue_id', 'status', 'summary', 'payload', 'subject_id', 'requested_by_kind', 'requested_by_id', 'expires_at']).where('org_id', '=', orgId).where('kind', '=', hub.HOSTED_ACTION_APPROVAL).orderBy('created_at').orderBy('id').execute();
}
