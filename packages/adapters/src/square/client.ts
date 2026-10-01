import { createHash } from 'node:crypto';
import type { ConnectionHandle } from '@ros/core';
import { withoutCardIdentifiers } from './map';
import type { SquareError } from './types';

/** The Square API version this adapter was written against (the `Square-Version` header). */
export const SQUARE_API_VERSION = '2026-09-16';

const BASE_URLS = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
} as const;

export interface SquareClientOptions {
  /** Injected in tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  apiVersion?: string;
  timeoutMs?: number;
}

/**
 * A Square call that did not succeed. The message names the HTTP status and Square's error
 * codes only: never the token, never a request body, never Square's free-text detail.
 */
export class SquareApiError extends Error {
  readonly status: number;
  readonly errors: SquareError[];
  /** The parsed response with card identifiers removed, for callers that need more than the codes. */
  readonly body: unknown;

  constructor(status: number, errors: SquareError[], path: string, body: unknown = null) {
    const codes = errors.map((e) => `${e.category ?? 'ERROR'}/${e.code ?? 'UNKNOWN'}`).join(', ') || 'no error body';
    super(`square: ${status} on ${path} (${codes})`);
    this.name = 'SquareApiError';
    this.status = status;
    this.errors = errors;
    this.body = withoutCardIdentifiers(body);
  }

  has(category: string): boolean {
    return this.errors.some((e) => e.category === category);
  }
}

export function squareEnvironment(conn: ConnectionHandle): 'sandbox' | 'production' {
  return conn.config.environment === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Square caps idempotency keys (45 characters on payments and refunds, 192 on orders). A
 * longer key is replaced by a digest of itself, so the same key always maps to the same value.
 */
export function squareIdempotencyKey(key: string, max: number): string {
  return key.length <= max ? key : createHash('sha256').update(key).digest('hex').slice(0, max);
}

export interface SquareRequest {
  method: 'GET' | 'POST' | 'PUT';
  /** Path under the host, e.g. "/v2/payments". Ids in it must already be URL-encoded. */
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
}

/** One authenticated JSON call to Square for a connection. Throws SquareApiError on any non-2xx or `errors` answer. */
export async function squareCall<T>(opts: SquareClientOptions, conn: ConnectionHandle, req: SquareRequest): Promise<T> {
  const token = conn.credentials.accessToken;
  if (!token) throw new SquareApiError(401, [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED' }], req.path);
  const url = new URL(req.path, BASE_URLS[squareEnvironment(conn)]);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Square-Version': opts.apiVersion ?? SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    // A network failure or a timeout. The cause's own message can echo the URL, which is safe, but nothing more is passed on.
    throw new Error(`square: request to ${req.path} did not complete (${(e as Error).name})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  const errors = (parsed as { errors?: SquareError[] } | null)?.errors;
  if (!res.ok || (Array.isArray(errors) && errors.length)) {
    throw new SquareApiError(res.status, Array.isArray(errors) ? errors : [], req.path, parsed);
  }
  return (parsed ?? {}) as T;
}
