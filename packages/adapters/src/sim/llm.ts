import type { LlmPort, LlmRequest, LlmResult, StoragePort } from '@ros/core';

export interface SimLlm extends LlmPort {
  /** Register the answer for a purpose. The function sees the request, so a test can assert what was sent. */
  respond<T>(purpose: string, fn: (req: LlmRequest<T>) => unknown): void;
  readonly calls: Array<{ purpose: string; orgId: string; system: string; input: string }>;
  reset(): void;
}

/**
 * A model that answers from a script. Output is still parsed through the caller's schema, so a
 * scripted answer of the wrong shape fails the same way a real model's would.
 */
export function createSimLlm(): SimLlm {
  const responders = new Map<string, (req: LlmRequest<any>) => unknown>();
  const calls: SimLlm['calls'] = [];
  return {
    calls,
    respond(purpose, fn) {
      responders.set(purpose, fn as (req: LlmRequest<any>) => unknown);
    },
    async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push({ purpose: req.purpose, orgId: req.orgId, system: req.system, input: req.input });
      const responder = responders.get(req.purpose);
      if (!responder) throw new Error(`No simulated model answer registered for purpose "${req.purpose}"`);
      const output = req.schema.parse(responder(req));
      return { output, model: 'sim', usage: { inputTokens: Math.ceil((req.system.length + req.input.length) / 4), outputTokens: 50 } };
    },
    reset() {
      responders.clear();
      calls.length = 0;
    },
  };
}

export interface SimStorage extends StoragePort {
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
}

export function createSimStorage(baseUrl = 'https://assets.sim.invalid'): SimStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async put({ orgId, key, body, contentType }) {
      const storageKey = `${orgId}/${key}`;
      objects.set(storageKey, { body, contentType });
      return { url: `${baseUrl}/${storageKey}`, storageKey };
    },
    async remove({ orgId, storageKey }) {
      if (!storageKey.startsWith(`${orgId}/`)) throw new Error('storage key belongs to another org');
      objects.delete(storageKey);
    },
  };
}
