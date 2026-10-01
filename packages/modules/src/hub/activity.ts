import { z } from 'zod';
import { type Ctx, forbidden, requireStaff } from '@ros/core';

/**
 * Recent assistant activity for the console: which key called which tool, and how it went.
 * `agent_calls` never holds arguments or results, so neither does this.
 *
 * Manager and above, signed in. An owner sees every key's calls; anyone else sees the calls
 * made with their own keys, as they see only their own keys (listAgentKeys).
 */
export const listAgentCallsInput = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    keyId: z.string().uuid().optional(),
    before: z.date().optional(),
  })
  .strict();

export interface AgentCallView {
  id: string;
  keyId: string | null;
  keyName: string | null;
  keyPrefix: string | null;
  staffId: string | null;
  tool: string;
  plugKey: string;
  effect: string;
  outcome: string;
  durationMs: number | null;
  occurredAt: Date;
}

export async function listAgentCalls(ctx: Ctx, raw: z.input<typeof listAgentCallsInput> = {}): Promise<AgentCallView[]> {
  const input = listAgentCallsInput.parse(raw);
  if (ctx.principal.kind !== 'staff') throw forbidden('Assistant activity is read in the console, by a person.');
  const staff = ctx.principal;
  requireStaff(ctx, { minRole: 'manager' });
  let q = ctx.db
    .selectFrom('agent_calls as c')
    .leftJoin('agent_keys as k', 'k.id', 'c.key_id')
    .select(['c.id', 'c.key_id', 'k.name as key_name', 'k.key_prefix', 'k.staff_id', 'c.tool', 'c.plug_key', 'c.effect', 'c.outcome', 'c.duration_ms', 'c.occurred_at'])
    .orderBy('c.occurred_at', 'desc')
    .limit(input.limit);
  if (!staff.isOwner) q = q.where('k.staff_id', '=', staff.staffId);
  if (input.keyId) q = q.where('c.key_id', '=', input.keyId);
  if (input.before) q = q.where('c.occurred_at', '<', input.before);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    keyId: r.key_id,
    keyName: r.key_name,
    keyPrefix: r.key_prefix,
    staffId: r.staff_id,
    tool: r.tool,
    plugKey: r.plug_key,
    effect: r.effect,
    outcome: r.outcome,
    durationMs: r.duration_ms,
    occurredAt: r.occurred_at,
  }));
}
