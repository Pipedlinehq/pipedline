import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type MessagesClient, LlmBudgetExceeded, anthropicLlmFromEnv, createAnthropicLlm } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { hub } from '@ros/modules';

/**
 * The real model adapter, with the Anthropic client stood in for (it cannot be run live here
 * without a key). What is checked is what the adapter sends and what it does with the answer:
 * config-chosen model ids, structured output, one retry on a shape mismatch, the org's daily
 * budget enforced BEFORE the request, usage recorded, and never a tool.
 */
type Params = Parameters<MessagesClient['beta']['messages']['create']>[0];

function stubClient(answers: Array<{ text?: string; stop?: string; inTokens?: number; outTokens?: number }>) {
  const sent: Params[] = [];
  const client: MessagesClient = {
    beta: {
      messages: {
        async create(params) {
          sent.push(params);
          const a = answers.shift();
          if (!a) throw new Error('no more stubbed answers');
          return {
            id: `msg_${sent.length}`,
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: a.text ?? '', citations: null }],
            stop_reason: a.stop ?? 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: a.inTokens ?? 100, output_tokens: a.outTokens ?? 20 },
          } as never;
        },
      },
    },
  };
  return { client, sent };
}

const schema = z.object({ dishes: z.array(z.object({ name: z.string().min(1), price_cents: z.number().int().min(0) })).min(1) });

describe('hub-2: the Anthropic model adapter', () => {
  const t = useTestEnv();
  const orgId = () => t.fixture.diner.orgId;
  const models = { fast: 'claude-sonnet-5-5', quality: 'claude-opus-5-5' };
  const usageRows = () => t.db.selectFrom('llm_usage').select(['purpose', 'model', 'tier', 'input_tokens', 'output_tokens', 'outcome']).where('org_id', '=', orgId()).orderBy('occurred_at').execute();

  it('sends no tools, the configured model for the tier, and a structured-output schema; the answer is validated', async () => {
    const { client, sent } = stubClient([{ text: JSON.stringify({ dishes: [{ name: 'Rump', price_cents: 4800 }] }) }]);
    const llm = createAnthropicLlm(client, { models, usage: hub.llmUsageStore(() => t.app) });
    const r = await llm.generate({ purpose: 'test.extract', orgId: orgId(), system: 'Extract.', input: 'Rump $48', schema, tier: 'quality' });
    expect(r).toEqual({ output: { dishes: [{ name: 'Rump', price_cents: 4800 }] }, model: 'claude-opus-5-5', usage: { inputTokens: 100, outputTokens: 20 } });
    expect(sent).toHaveLength(1);
    const p = sent[0]! as unknown as Record<string, unknown>;
    for (const k of ['tools', 'tool_choice', 'mcp_servers', 'container']) expect(k in p).toBe(false);
    expect(p.model).toBe('claude-opus-5-5');
    expect(p.system).toBe('Extract.');
    expect(p.messages).toEqual([{ role: 'user', content: 'Rump $48' }]);
    expect((p.output_config as { format: { type: string; schema: object } }).format.type).toBe('json_schema');
    expect((p.output_config as { effort: string }).effort).toBe('medium');
    expect(p.fallbacks).toBe('default');
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
    // The fast tier is the other configured model; nothing is hard-coded at the call site.
    const fast = stubClient([{ text: JSON.stringify({ dishes: [{ name: 'Fries', price_cents: 1100 }] }) }]);
    await createAnthropicLlm(fast.client, { models, usage: hub.llmUsageStore(() => t.app) }).generate({ purpose: 'test.extract', orgId: orgId(), system: 's', input: 'i', schema });
    expect(fast.sent[0]!.model).toBe('claude-sonnet-5-5');
    // Usage, read back.
    const rows = await usageRows();
    expect(rows.map((u) => [u.model, u.tier, u.outcome, u.input_tokens + u.output_tokens])).toEqual([
      ['claude-opus-5-5', 'quality', 'ok', 120],
      ['claude-sonnet-5-5', 'fast', 'ok', 120],
    ]);
  });

  it('an answer that does not fit is asked for once more, saying what was wrong; a second misfit throws', async () => {
    const { client, sent } = stubClient([{ text: JSON.stringify({ dishes: [{ name: '', price_cents: -4 }] }) }, { text: JSON.stringify({ dishes: [{ name: 'Rump', price_cents: 4800 }] }) }]);
    const llm = createAnthropicLlm(client, { models, usage: hub.llmUsageStore(() => t.app) });
    const r = await llm.generate({ purpose: 'test.retry', orgId: orgId(), system: 's', input: 'Rump $48', schema, tier: 'fast' });
    expect(r.output.dishes[0]!.name).toBe('Rump');
    expect(r.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
    expect(sent).toHaveLength(2);
    const second = (sent[1]!.messages[0] as { content: string }).content;
    expect(second).toMatch(/^Rump \$48\n\n\(An earlier answer to this did not fit the required shape: dishes\.0\.name/);
    // Nothing of the first answer is replayed.
    expect(sent[1]!.messages).toHaveLength(1);

    const bad = stubClient([{ text: 'not json at all' }, { text: JSON.stringify({ dishes: [] }) }]);
    await expect(createAnthropicLlm(bad.client, { models, usage: hub.llmUsageStore(() => t.app) }).generate({ purpose: 'test.retry', orgId: orgId(), system: 's', input: 'x', schema })).rejects.toMatchObject({ code: 'provider_error' });
    expect(bad.sent).toHaveLength(2);
    const outcomes = (await usageRows()).filter((u) => u.purpose === 'test.retry').map((u) => u.outcome);
    expect(outcomes).toEqual(['invalid', 'ok', 'invalid', 'invalid']);
  });

  it('a refusal or a cut-off answer throws and is recorded; nothing is guessed', async () => {
    const { client } = stubClient([{ text: '', stop: 'refusal' }, { text: '{"dishes":[', stop: 'max_tokens' }]);
    const llm = createAnthropicLlm(client, { models, usage: hub.llmUsageStore(() => t.app) });
    await expect(llm.generate({ purpose: 'test.refuse', orgId: orgId(), system: 's', input: 'x', schema })).rejects.toMatchObject({ code: 'provider_error', message: 'The model declined to answer this request.' });
    await expect(llm.generate({ purpose: 'test.refuse', orgId: orgId(), system: 's', input: 'x', schema })).rejects.toMatchObject({ code: 'provider_error' });
    expect((await usageRows()).filter((u) => u.purpose === 'test.refuse').map((u) => u.outcome)).toEqual(['refused', 'truncated']);
  });

  it('the org\'s daily budget is enforced before the request is made', async () => {
    const group = t.fixture.group;
    await t.app.tenant(group.orgId, await group.as('owner'), (ctx) => hub.setLlmSettings(ctx, { daily_token_budget: 20_000 }));
    await expect(t.app.tenant(group.orgId, await group.as('manager'), (ctx) => hub.setLlmSettings(ctx, { daily_token_budget: null }))).rejects.toMatchObject({ code: 'forbidden' });
    const { client, sent } = stubClient([{ text: JSON.stringify({ dishes: [{ name: 'A', price_cents: 1 }] }), inTokens: 3000, outTokens: 1000 }]);
    const llm = createAnthropicLlm(client, { models, usage: hub.llmUsageStore(() => t.app) });
    // 16,000 of output could be spent: within 20,000 the first time.
    await llm.generate({ purpose: 'test.budget', orgId: group.orgId, system: 's', input: 'x', schema });
    expect(sent).toHaveLength(1);
    // 4,000 used; another call could take it past 20,000: refused without asking the model.
    await expect(llm.generate({ purpose: 'test.budget', orgId: group.orgId, system: 's', input: 'x', schema })).rejects.toBeInstanceOf(LlmBudgetExceeded);
    expect(sent).toHaveLength(1);
    // A smaller ceiling fits.
    const small = stubClient([{ text: JSON.stringify({ dishes: [{ name: 'B', price_cents: 2 }] }) }]);
    await createAnthropicLlm(small.client, { models, usage: hub.llmUsageStore(() => t.app) }).generate({ purpose: 'test.budget', orgId: group.orgId, system: 's', input: 'x', schema, maxTokens: 2000 });
    expect(small.sent).toHaveLength(1);
    // Tomorrow, in the org's own zone, the allowance is fresh.
    t.clock.advanceDays(1);
    const next = stubClient([{ text: JSON.stringify({ dishes: [{ name: 'C', price_cents: 3 }] }) }]);
    await createAnthropicLlm(next.client, { models, usage: hub.llmUsageStore(() => t.app) }).generate({ purpose: 'test.budget', orgId: group.orgId, system: 's', input: 'x', schema });
    expect(next.sent).toHaveLength(1);
  });

  it('without ANTHROPIC_API_KEY there is no real adapter: the simulator stays', () => {
    expect(anthropicLlmFromEnv(hub.llmUsageStore(() => t.app), {})).toBeNull();
    const real = anthropicLlmFromEnv(hub.llmUsageStore(() => t.app), { ANTHROPIC_API_KEY: 'sk-test-not-used', ROS_LLM_MODEL_FAST: 'claude-haiku-4-5' });
    expect(real?.models).toEqual({ fast: 'claude-haiku-4-5', quality: 'claude-opus-5-5' });
  });
});
