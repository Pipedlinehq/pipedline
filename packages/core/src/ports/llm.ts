import type { z } from 'zod';

/**
 * The runtime model boundary. One bounded,
 * schema-validated generation with no tools. Callers pass the minimum: aggregates and first
 * names, never contact details or card identifiers (docs/THREAT_MODEL.md section 7).
 */
export interface LlmRequest<T> {
  /** Why this call is being made; appears in usage records. */
  purpose: string;
  orgId: string;
  system: string;
  input: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** 'fast' for extraction and classification, 'quality' for guest-facing drafting. */
  tier?: 'fast' | 'quality';
}

export interface LlmResult<T> {
  output: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface LlmPort {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export interface StoragePort {
  put(args: { orgId: string; key: string; body: Buffer; contentType: string }): Promise<{ url: string; storageKey: string }>;
  remove(args: { orgId: string; storageKey: string }): Promise<void>;
}
