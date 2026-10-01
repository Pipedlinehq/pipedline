import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AppError, type LlmPort, type LlmRequest, type LlmResult } from '@ros/core';
import type { z } from 'zod';

/**
 * The real model behind the runtime model boundary:
 * the official Anthropic SDK, one bounded generation per call, structured output, NO tools.
 *
 *   - Model ids come from config (`models.fast`, `models.quality`), never from a call site.
 *   - The answer is constrained with structured outputs (`output_config.format`) AND then
 *     validated against the caller's own zod schema. A mismatch is asked again once, as a
 *     fresh request that says what was wrong; a second mismatch throws.
 *   - Before every request the org's daily token budget is checked; after it, usage is
 *     recorded (including an answer that did not fit, since it was paid for).
 *   - The request never carries `tools`, `tool_choice`, `mcp_servers` or a container. What a
 *     caller passes as `input` is data for the model to read; the model can do nothing with it
 *     except answer in the shape asked for, and that answer is only ever a proposal.
 *   - A refusal, a truncated answer or an API error throws; nothing is guessed.
 */

export type LlmTier = 'fast' | 'quality';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicLlmConfig {
  /** Model id per tier. From configuration: ROS_LLM_MODEL_FAST / ROS_LLM_MODEL_QUALITY. */
  models: Record<LlmTier, string>;
  /** Effort per tier (output_config.effort). */
  effort?: Partial<Record<LlmTier, Effort>>;
  /** Server-side refusal fallback (beta `server-side-fallback-2026-07-01`, `fallbacks: "default"`). Claude API only. */
  fallbacks?: boolean;
  /** Default output ceiling when a caller gives none. */
  defaultMaxTokens?: number;
  /** Where the org's budget is read and its usage written. */
  usage: LlmUsageStore;
}

/** Defaults: the current Opus for quality, the current Sonnet for fast (claude-api skill, 2026-09-25). */
export const DEFAULT_MODELS: Record<LlmTier, string> = { quality: 'claude-opus-5-5', fast: 'claude-sonnet-5-5' };
const DEFAULT_EFFORT: Record<LlmTier, Effort> = { quality: 'medium', fast: 'low' };

export interface LlmUsageEntry {
  orgId: string;
  purpose: string;
  model: string;
  tier: LlmTier;
  inputTokens: number;
  outputTokens: number;
  outcome: 'ok' | 'invalid' | 'refused' | 'truncated';
}

export interface LlmUsageStore {
  /** Tokens the org has used today (its own calendar day) and its daily cap; null is no cap. */
  standing(orgId: string): Promise<{ used: number; budget: number | null }>;
  record(entry: LlmUsageEntry): Promise<void>;
}

/** The slice of the SDK client this adapter calls, so a test can stand in for it. */
export interface MessagesClient {
  beta: { messages: { create(params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Beta.Messages.BetaMessage> } };
}

/** Thrown when a request would take the org past its daily budget. The message is shown to people. */
export class LlmBudgetExceeded extends AppError {
  constructor() {
    super('rate_limited', 'The daily allowance for automated drafting and extraction is used up. Try again tomorrow, or ask for the allowance to be raised.');
  }
}

/** Parameters that must never reach the model: the adapter gives it nothing to act with. */
const FORBIDDEN_PARAMS = ['tools', 'tool_choice', 'mcp_servers', 'container'] as const;

const estimateTokens = (s: string) => Math.ceil(s.length / 3.5);

export function createAnthropicLlm(client: MessagesClient, cfg: AnthropicLlmConfig): LlmPort & { readonly models: Record<LlmTier, string> } {
  const maxDefault = cfg.defaultMaxTokens ?? 16_000;

  async function ask<T>(req: LlmRequest<T>, tier: LlmTier, input: string): Promise<{ text: string; model: string; inputTokens: number; outputTokens: number }> {
    const maxTokens = req.maxTokens ?? maxDefault;
    // The budget is checked before the call, with what this call could cost at most.
    const standing = await cfg.usage.standing(req.orgId);
    if (standing.budget !== null && standing.used + estimateTokens(req.system + input) + maxTokens > standing.budget) throw new LlmBudgetExceeded();

    const params: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
      model: cfg.models[tier],
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: input }],
      output_config: { effort: cfg.effort?.[tier] ?? DEFAULT_EFFORT[tier], format: zodOutputFormat(req.schema as z.ZodType) },
      ...(cfg.fallbacks === false ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    };
    for (const k of FORBIDDEN_PARAMS) if (k in params) throw new Error(`llm: ${k} must never be sent`);

    const res = await client.beta.messages.create(params);
    const usage = { inputTokens: res.usage.input_tokens ?? 0, outputTokens: res.usage.output_tokens ?? 0 };
    const text = res.content
      .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const base = { orgId: req.orgId, purpose: req.purpose, model: res.model, tier };
    if (res.stop_reason === 'refusal') {
      await cfg.usage.record({ ...base, ...usage, outcome: 'refused' });
      throw new AppError('provider_error', 'The model declined to answer this request.');
    }
    if (res.stop_reason === 'max_tokens') {
      await cfg.usage.record({ ...base, ...usage, outcome: 'truncated' });
      throw new AppError('provider_error', 'The answer was too long and was cut off. Try a smaller piece.');
    }
    return { text, model: res.model, ...usage };
  }

  return {
    models: cfg.models,
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      const tier: LlmTier = req.tier ?? 'fast';
      let input = req.input;
      let spentIn = 0;
      let spentOut = 0;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const got = await ask(req, tier, input);
        spentIn += got.inputTokens;
        spentOut += got.outputTokens;
        let issues: string;
        try {
          const checked = req.schema.safeParse(JSON.parse(got.text));
          if (checked.success) {
            await cfg.usage.record({ orgId: req.orgId, purpose: req.purpose, model: got.model, tier, inputTokens: got.inputTokens, outputTokens: got.outputTokens, outcome: 'ok' });
            return { output: checked.data, model: got.model, usage: { inputTokens: spentIn, outputTokens: spentOut } };
          }
          issues = checked.error.issues.slice(0, 8).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
        } catch {
          issues = 'the answer was not JSON';
        }
        await cfg.usage.record({ orgId: req.orgId, purpose: req.purpose, model: got.model, tier, inputTokens: got.inputTokens, outputTokens: got.outputTokens, outcome: 'invalid' });
        // One more try, as a fresh request that says what was wrong. Nothing of the first answer is replayed.
        input = `${req.input}\n\n(An earlier answer to this did not fit the required shape: ${issues}. Answer again, following the shape exactly.)`;
      }
      throw new AppError('provider_error', 'The model did not answer in the required shape. Nothing was used.');
    },
  };
}

/** Build the adapter from the environment. Null when ANTHROPIC_API_KEY is not set. */
export function anthropicLlmFromEnv(usage: LlmUsageStore, env: NodeJS.ProcessEnv = process.env): (LlmPort & { readonly models: Record<LlmTier, string> }) | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 120_000 });
  return createAnthropicLlm(client as unknown as MessagesClient, {
    models: { fast: env.ROS_LLM_MODEL_FAST || DEFAULT_MODELS.fast, quality: env.ROS_LLM_MODEL_QUALITY || DEFAULT_MODELS.quality },
    fallbacks: env.ROS_LLM_FALLBACKS !== 'off',
    usage,
  });
}

/**
 * Read-only: list one model, which proves the key is accepted without generating anything.
 * Used by scripts/smoke-live.ts.
 */
export async function anthropicCheckKey(apiKey: string, opts: { fetch?: typeof fetch } = {}): Promise<{ models: number }> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  const page = await client.models.list({ limit: 1 });
  return { models: page.data.length };
}
