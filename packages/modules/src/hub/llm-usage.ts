import { z } from 'zod';
import { type App, type Ctx, localDate, requireOwner, sql } from '@ros/core';
import { getOrgSettings, setOrgSettings } from '../tenancy/orgs';

/**
 * The model's budget and usage, per org. The real
 * model adapter (packages/adapters/src/anthropic) asks `standing` before every request and calls
 * `record` after it; the runtime wires this store in. Every figure is the org's own calendar day.
 *
 * Stored under orgs.settings.llm. The default budget is deliberately modest; an owner raises it.
 */
export const llmSettings = z.object({
  /** Tokens (in and out) the org may spend per day. null: no cap. */
  daily_token_budget: z.number().int().min(0).max(100_000_000).nullable().default(500_000),
});
export type LlmSettings = z.infer<typeof llmSettings>;
export const LLM_SETTINGS_NAMESPACE = 'llm';
const DEFAULTS = llmSettings.parse({});
const WORKER = { kind: 'worker' as const, job: 'hub.llm_usage' };

export async function getLlmSettings(ctx: Ctx): Promise<LlmSettings> {
  return getOrgSettings(ctx, LLM_SETTINGS_NAMESPACE, llmSettings, DEFAULTS);
}

/** An owner sets the org's daily allowance. */
export async function setLlmSettings(ctx: Ctx, patch: Partial<LlmSettings>): Promise<LlmSettings> {
  requireOwner(ctx);
  return setOrgSettings(ctx, LLM_SETTINGS_NAMESPACE, llmSettings, { ...(await getLlmSettings(ctx)), ...patch });
}

async function today(ctx: Ctx): Promise<string> {
  const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  return localDate(ctx.now(), org.timezone);
}

/** Tokens used today. */
export async function llmUsedToday(ctx: Ctx): Promise<number> {
  const day = await today(ctx);
  const r = await ctx.db
    .selectFrom('llm_usage')
    .select(sql<string>`coalesce(sum(input_tokens + output_tokens), 0)`.as('n'))
    .where('day', '=', day)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

export interface LlmUsageRecord {
  orgId: string;
  purpose: string;
  model: string;
  tier: string;
  inputTokens: number;
  outputTokens: number;
  outcome: string;
}

/**
 * The store the model adapter uses. Each call is its own short tenant transaction: the model
 * request itself is never made inside one. `app` is a getter because the adapter is built before
 * the App that owns the database.
 */
export function llmUsageStore(app: () => App) {
  return {
    async standing(orgId: string): Promise<{ used: number; budget: number | null }> {
      return app().tenant(orgId, WORKER, async (ctx) => ({ used: await llmUsedToday(ctx), budget: (await getLlmSettings(ctx)).daily_token_budget }));
    },
    async record(e: LlmUsageRecord): Promise<void> {
      await app().tenant(e.orgId, WORKER, async (ctx) => {
        await ctx.db
          .insertInto('llm_usage')
          .values({ org_id: ctx.orgId, day: await today(ctx), purpose: e.purpose.slice(0, 100), model: e.model.slice(0, 100), tier: e.tier, input_tokens: e.inputTokens, output_tokens: e.outputTokens, outcome: e.outcome, occurred_at: ctx.now() })
          .execute();
      });
    },
  };
}
