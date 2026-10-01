import 'server-only';
import { NextResponse } from 'next/server';
import { type App, isAppError, rateLimit } from '@ros/core';
import { clientIp } from './http';
import { app } from './runtime';

/**
 * Provider webhooks (docs/THREAT_MODEL.md section 8). A route here:
 *
 *   - reads the body as raw text, because the signature is over those exact bytes;
 *   - hands the raw body, every header (lower-cased) and the full URL it was called at to the
 *     module's handler, which verifies the signature, de-duplicates and re-fetches;
 *   - has no session and no cross-site check: a provider has neither, and authenticates by
 *     signature alone;
 *   - limits each calling address, so a flood cannot reach the handler;
 *   - answers 2xx for processed, duplicate and ignored events, and otherwise the status of the
 *     AppError the handler threw: 401 for a bad signature (the provider stops), 404 for an
 *     endpoint that does not exist, 5xx for anything that should be retried.
 */
export interface WebhookCall {
  /** The provider-specific segment of the path: a plug key or an adapter key. Never from the body. */
  key: string;
  rawBody: string;
  headers: Record<string, string | undefined>;
  url: string;
  ip: string | undefined;
}

export type WebhookHandler = (app: App, call: WebhookCall) => Promise<unknown>;

/** Largest body accepted. Provider events are small; anything larger is refused before it is read in full. */
const MAX_BODY_BYTES = 1_000_000;
const PER_ADDRESS = { limit: 300, windowSeconds: 60 };

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function webhookRoute<K extends string>(kind: string, param: K, handler: WebhookHandler) {
  return async (req: Request, { params }: { params: Promise<Record<K, string>> }): Promise<Response> => {
    const a = app();
    const ip = clientIp(req);
    try {
      await rateLimit(a, `webhook:${kind}:ip:${ip ?? 'unknown'}`, PER_ADDRESS);
    } catch (e) {
      if (isAppError(e)) return json(429, { error: { code: e.code, message: e.message } });
      throw e;
    }
    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: { code: 'invalid', message: 'Too large.' } });
    const rawBody = await req.text();
    if (rawBody.length > MAX_BODY_BYTES) return json(413, { error: { code: 'invalid', message: 'Too large.' } });

    const key = (await params)[param];
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    try {
      const result = await handler(a, { key, rawBody, headers, url: req.url, ip });
      return json(200, { ok: true, result });
    } catch (e) {
      if (isAppError(e)) return json(e.status, { error: { code: e.code, message: e.message } });
      a.log.error('webhook handler failed', { kind, key, error: (e as Error)?.message });
      // Unknown failure: a 5xx makes the provider retry, and the claim was released by the handler.
      return json(500, { error: { code: 'internal', message: 'Not processed. Retry later.' } });
    }
  };
}
