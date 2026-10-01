import type { AdsAdapter, AdsConversion, ConnectionHandle } from '@ros/core';

/**
 * Meta Conversions API: server-side Purchase events, only for guests who hold the
 * `ad_platform_sharing` consent. The module hashes
 * email and phone before they reach this adapter; this adapter refuses anything that does not
 * look like a SHA-256 hex digest, so a raw address cannot slip through.
 *
 * Written against Meta's docs as read on 2026-10-01 (developers.facebook.com/docs/marketing-api/
 * conversions-api): Graph API v26.0 (released 2026-07-29). NOT yet exercised against a live
 * dataset.
 *
 *   POST https://graph.facebook.com/v26.0/{DATASET_OR_PIXEL_ID}/events
 *   body: { data: [event…], access_token, test_event_code? }     up to 1,000 events a request
 *   event: event_name, event_time (unix seconds), action_source, event_id,
 *          user_data { em: [sha256], ph: [sha256] }, custom_data { currency, value, order_id }
 *
 * - One invalid event rejects the whole batch, and an event_time older than 7 days rejects the
 *   whole request (physical_store: upload within 62 days). The module sends one sale a call.
 * - `website` events require `client_user_agent` and `event_source_url`. A sale taken online is
 *   recorded server-side with no browser user agent, so it is sent with action_source `other`
 *   until the ordering flow captures one; `physical_store` is sent as such.
 * - Refunds: Meta documents no negative or refund event; nothing is sent for one.
 *
 * Connection: externalAccountId = the dataset (or pixel) id. Credentials: `accessToken`
 * (a system-user token). Config: `testEventCode` (optional, for Events Manager's test tab).
 */
export const META_CAPI_KEY = 'meta-capi';
export const META_GRAPH_VERSION = 'v26.0';

export interface MetaCapiOptions {
  fetch?: typeof fetch;
  version?: string;
  timeoutMs?: number;
}

export class MetaApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null) {
    super(`meta-capi: ${status}${code !== null ? ` (code ${code})` : ''}`);
    this.name = 'MetaApiError';
    this.status = status;
    this.code = code;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;

export function metaEvent(c: AdsConversion): Record<string, unknown> {
  for (const h of [c.hashedEmail, c.hashedPhone]) {
    if (h && !SHA256.test(h)) throw new Error('meta-capi: identifiers must be SHA-256 hex digests');
  }
  const user_data: Record<string, string[]> = {};
  if (c.hashedEmail) user_data.em = [c.hashedEmail];
  if (c.hashedPhone) user_data.ph = [c.hashedPhone];
  if (!Object.keys(user_data).length) throw new Error('meta-capi: a conversion needs a hashed email or phone');
  return {
    event_name: c.eventName,
    event_time: Math.floor(c.occurredAt.getTime() / 1000),
    event_id: c.eventId,
    action_source: c.source === 'physical_store' ? 'physical_store' : 'other',
    user_data,
    custom_data: {
      ...(c.currency ? { currency: c.currency.toUpperCase() } : {}),
      ...(c.valueCents !== undefined ? { value: c.valueCents / 100 } : {}),
      ...(c.orderId ? { order_id: c.orderId } : {}),
    },
  };
}

export function createMetaCapiAdapter(opts: MetaCapiOptions = {}): AdsAdapter {
  return {
    key: META_CAPI_KEY,
    async sendConversions(conn: ConnectionHandle, conversions: AdsConversion[]) {
      const token = conn.credentials.accessToken;
      if (!token) throw new MetaApiError(401, null);
      if (!/^\d+$/.test(conn.externalAccountId)) throw new Error('meta-capi: the dataset id must be numeric');
      if (conversions.length > 1000) throw new Error('meta-capi: at most 1,000 events a request');
      const testCode = typeof conn.config.testEventCode === 'string' ? conn.config.testEventCode : null;
      const url = `https://graph.facebook.com/${opts.version ?? META_GRAPH_VERSION}/${conn.externalAccountId}/events`;
      // Built before the call, so a refused identifier never reaches the network.
      const body = JSON.stringify({ data: conversions.map(metaEvent), access_token: token, ...(testCode ? { test_event_code: testCode } : {}) });
      let res: Response;
      try {
        res = await (opts.fetch ?? fetch)(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          // The token goes in the body, not the URL, so it never lands in an access log.
          body,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (e) {
        throw new Error(`meta-capi: request did not complete (${(e as Error).name})`);
      }
      const parsed = (await res.json().catch(() => null)) as { events_received?: number; error?: { code?: number } } | null;
      if (!res.ok) throw new MetaApiError(res.status, parsed?.error?.code ?? null);
      return { accepted: typeof parsed?.events_received === 'number' ? parsed.events_received : conversions.length };
    },
  };
}
