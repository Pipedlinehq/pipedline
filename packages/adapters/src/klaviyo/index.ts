import type { ConnectionHandle, EspAdapter, EspProfile, EspSuppression } from '@ros/core';

/**
 * Klaviyo as a connected email platform (docs/modules/comms.md section 7): the venue's flows
 * stay in Klaviyo; we push profiles, consent and events, and pull suppressions back.
 *
 * Written against Klaviyo's reference as read on 2026-10-01 (developers.klaviyo.com), revision
 * 2026-07-15. NOT yet exercised against a live Klaviyo account.
 *
 *   POST /api/profile-import                          create or update a profile (201/200)
 *   POST /api/profile-subscription-bulk-create-jobs   subscribe (email/SMS marketing), max 1000 (202)
 *   POST /api/profile-subscription-bulk-delete-jobs   unsubscribe, max 100 (202). No list is sent,
 *                                                     so the unsubscribe is account-wide, which is
 *                                                     what "an unsubscribe anywhere is an
 *                                                     unsubscribe everywhere" means.
 *   POST /api/profile-suppression-bulk-create-jobs    suppress an email (bounce, manual), max 100 (202)
 *   POST /api/events                                  custom event, de-duplicated on unique_id (202)
 *   GET  /api/profiles?additional-fields[profile]=subscriptions&filter=…   suppressions since a time
 *
 * Connection credentials: `apiKey` (a private key with profiles:read/write, events:write,
 * subscriptions:write, lists:write). Connection config: `listId` (optional; the list new
 * subscribers join; without it Klaviyo's account default opt-in applies).
 */
export const KLAVIYO_KEY = 'klaviyo';
export const KLAVIYO_REVISION = '2026-07-15';
const BASE = 'https://a.klaviyo.com';

export interface KlaviyoOptions {
  fetch?: typeof fetch;
  revision?: string;
  timeoutMs?: number;
}

/** A Klaviyo call that did not succeed. Names the status and Klaviyo's error codes, never the key or a body. */
export class KlaviyoApiError extends Error {
  readonly status: number;
  readonly codes: string[];
  constructor(status: number, codes: string[], path: string) {
    super(`klaviyo: ${status} on ${path}${codes.length ? ` (${codes.join(', ')})` : ''}`);
    this.name = 'KlaviyoApiError';
    this.status = status;
    this.codes = codes;
  }
}

type Json = Record<string, unknown>;

async function call<T>(opts: KlaviyoOptions, conn: ConnectionHandle, method: 'GET' | 'POST', pathOrUrl: string, body?: unknown): Promise<T | null> {
  const key = conn.credentials.apiKey;
  if (!key) throw new KlaviyoApiError(401, ['no_api_key'], pathOrUrl);
  const url = pathOrUrl.startsWith('https://') ? new URL(pathOrUrl) : new URL(pathOrUrl, BASE);
  if (url.origin !== BASE) throw new Error('klaviyo: refusing to follow a link off a.klaviyo.com');
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${key}`,
        revision: opts.revision ?? KLAVIYO_REVISION,
        Accept: 'application/vnd.api+json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/vnd.api+json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(`klaviyo: request to ${url.pathname} did not complete (${(e as Error).name})`);
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const errors = ((parsed as { errors?: Array<{ code?: string }> } | null)?.errors ?? []).map((e) => e.code ?? 'error');
    throw new KlaviyoApiError(res.status, errors, url.pathname);
  }
  return parsed as T | null;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function createKlaviyoAdapter(opts: KlaviyoOptions = {}): EspAdapter {
  async function subscribe(conn: ConnectionHandle, profile: EspProfile): Promise<void> {
    const subs: Json = {};
    const at = profile.consentedAt ?? {};
    if (profile.consents.marketingEmail && profile.email) {
      subs.email = { marketing: { consent: 'SUBSCRIBED', ...(at.email ? { consented_at: iso(at.email) } : {}) } };
    }
    if (profile.consents.marketingSms && profile.phone) {
      subs.sms = { marketing: { consent: 'SUBSCRIBED', ...(at.sms ? { consented_at: iso(at.sms) } : {}) } };
    }
    if (!Object.keys(subs).length) return;
    // historical_import: the guest already ticked the box here, so no second confirmation is
    // sent. Klaviyo requires consented_at (in the past) for that; without it we let the
    // account's own opt-in setting apply.
    const historical = (!subs.email || !!at.email) && (!subs.sms || !!at.sms);
    const listId = typeof conn.config.listId === 'string' ? conn.config.listId : null;
    await call(opts, conn, 'POST', '/api/profile-subscription-bulk-create-jobs', {
      data: {
        type: 'profile-subscription-bulk-create-job',
        attributes: {
          profiles: {
            data: [
              {
                type: 'profile',
                attributes: {
                  ...(subs.email ? { email: profile.email } : {}),
                  ...(subs.sms ? { phone_number: profile.phone } : {}),
                  subscriptions: subs,
                },
              },
            ],
          },
          custom_source: 'Pipedline',
          historical_import: historical,
        },
        ...(listId ? { relationships: { list: { data: { type: 'list', id: listId } } } } : {}),
      },
    });
  }

  return {
    key: KLAVIYO_KEY,
    capabilities: { transactional: false, marketing: true, sms: true, flows: 'theirs', suppressionSync: 'both', engagementEvents: false },

    async upsertProfile(conn, profile) {
      await call(opts, conn, 'POST', '/api/profile-import', {
        data: {
          type: 'profile',
          attributes: {
            external_id: profile.externalId,
            ...(profile.email ? { email: profile.email } : {}),
            ...(profile.phone ? { phone_number: profile.phone } : {}),
            ...(profile.firstName ? { first_name: profile.firstName } : {}),
            ...(profile.lastName ? { last_name: profile.lastName } : {}),
            ...(profile.properties ? { properties: profile.properties } : {}),
          },
        },
      });
      // Consent cannot be set through profile-import; it has its own endpoint.
      await subscribe(conn, profile);
    },

    async trackEvent(conn, event) {
      const value = typeof event.properties.value === 'number' ? event.properties.value : undefined;
      const currency = typeof event.properties.currency === 'string' ? event.properties.currency : undefined;
      await call(opts, conn, 'POST', '/api/events', {
        data: {
          type: 'event',
          attributes: {
            properties: event.properties,
            time: iso(event.occurredAt),
            ...(value !== undefined ? { value } : {}),
            ...(currency ? { value_currency: currency } : {}),
            // "If the unique_id is repeated for the same profile and metric, only the first processed event will be recorded."
            unique_id: event.idempotencyKey,
            metric: { data: { type: 'metric', attributes: { name: event.name } } },
            profile: { data: { type: 'profile', attributes: { external_id: event.profileExternalId } } },
          },
        },
      });
    },

    async pullSuppressions(conn, since) {
      const out: EspSuppression[] = [];
      const reasons: Record<string, EspSuppression['reason']> = {
        UNSUBSCRIBE: 'unsubscribed',
        SPAM_COMPLAINT: 'complained',
        HARD_BOUNCE: 'bounced_hard',
        INVALID_EMAIL: 'bounced_hard',
        USER_SUPPRESSED: 'manual',
      };
      type Page = {
        data?: Array<{ attributes?: { email?: string | null; phone_number?: string | null; subscriptions?: Json } }>;
        links?: { next?: string | null };
      };
      const pages = async (filter: string, visit: (p: NonNullable<Page['data']>[number]) => void) => {
        let next: string | null = `/api/profiles?additional-fields[profile]=subscriptions&page[size]=100&filter=${encodeURIComponent(filter)}`;
        for (let i = 0; next && i < 200; i++) {
          const page: Page | null = await call<Page>(opts, conn, 'GET', next);
          for (const p of page?.data ?? []) visit(p);
          next = page?.links?.next ?? null;
        }
      };
      // Email: every suppression newer than `since`.
      await pages(`greater-than(subscriptions.email.marketing.suppression.timestamp,${iso(since)})`, (p) => {
        const email = p.attributes?.email;
        const sup = ((p.attributes?.subscriptions as { email?: { marketing?: { suppression?: Array<{ reason?: string; timestamp?: string }> } } } | undefined)?.email?.marketing?.suppression ?? []);
        for (const s of sup) {
          const at = s.timestamp ? new Date(s.timestamp) : null;
          if (!email || !at || at <= since) continue;
          out.push({ channel: 'email', value: email, reason: reasons[s.reason ?? ''] ?? 'manual', at });
        }
      });
      // SMS: Klaviyo offers no suppression filter for SMS, so profiles updated since are read
      // and an SMS marketing consent of UNSUBSCRIBED changed since then is taken as an opt-out.
      await pages(`greater-than(updated,${iso(since)})`, (p) => {
        const phone = p.attributes?.phone_number;
        const sms = (p.attributes?.subscriptions as { sms?: { marketing?: { consent?: string; last_updated?: string; consent_timestamp?: string } } } | undefined)?.sms?.marketing;
        const stamp = sms?.last_updated ?? sms?.consent_timestamp;
        const at = stamp ? new Date(stamp) : null;
        if (phone && sms?.consent === 'UNSUBSCRIBED' && at && at > since) out.push({ channel: 'sms', value: phone, reason: 'unsubscribed', at });
      });
      return out;
    },

    async pushSuppression(conn, s) {
      if (s.channel === 'email' && (s.reason === 'bounced_hard' || s.reason === 'manual')) {
        await call(opts, conn, 'POST', '/api/profile-suppression-bulk-create-jobs', {
          data: { type: 'profile-suppression-bulk-create-job', attributes: { profiles: { data: [{ type: 'profile', attributes: { email: s.value } }] } } },
        });
        return;
      }
      const subscriptions = s.channel === 'email' ? { email: { marketing: { consent: 'UNSUBSCRIBED' } } } : { sms: { marketing: { consent: 'UNSUBSCRIBED' } } };
      await call(opts, conn, 'POST', '/api/profile-subscription-bulk-delete-jobs', {
        data: {
          type: 'profile-subscription-bulk-delete-job',
          attributes: {
            profiles: {
              data: [{ type: 'profile', attributes: { ...(s.channel === 'email' ? { email: s.value } : { phone_number: s.value }), subscriptions } }],
            },
          },
        },
      });
    },
  };
}
