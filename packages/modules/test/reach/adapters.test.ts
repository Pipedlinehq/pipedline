import { describe, expect, it } from 'vitest';
import type { ConnectionHandle } from '@ros/core';
import { KLAVIYO_REVISION, META_GRAPH_VERSION, createKlaviyoAdapter, createMetaCapiAdapter } from '@ros/adapters';

/**
 * The real adapters against a recorded fetch: the requests they would put on the wire, checked
 * against the shapes in the providers' published references. Not a live call.
 */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

function recorder(answer: (s: Seen) => { status: number; body?: unknown } = () => ({ status: 202 })) {
  const seen: Seen[] = [];
  const fetchFn = (async (input: URL | string, init?: RequestInit) => {
    const s: Seen = { url: String(input), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null };
    seen.push(s);
    const a = answer(s);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status });
  }) as typeof fetch;
  return { seen, fetchFn };
}

const conn = (over: Partial<ConnectionHandle> = {}): ConnectionHandle => ({
  id: 'c1',
  orgId: 'o1',
  venueId: null,
  plugKey: 'klaviyo',
  externalAccountId: 'AbC123',
  scopes: [],
  config: {},
  credentials: { apiKey: 'pk_secret_value' },
  ...over,
});

describe('reach: Klaviyo adapter requests', () => {
  it('upserts a profile, then subscribes with historical consent; the key only in the header', async () => {
    const { seen, fetchFn } = recorder();
    const k = createKlaviyoAdapter({ fetch: fetchFn });
    await k.upsertProfile(conn({ config: { listId: 'Y6nRLr' } }), {
      externalId: 'cust-1',
      email: 'a@example.com',
      phone: null,
      firstName: 'Ann',
      lastName: null,
      consents: { marketingEmail: true, marketingSms: false },
      consentedAt: { email: new Date('2026-09-01T00:00:00Z') },
      properties: { order_count: 3 },
    });
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(['POST /api/profile-import', 'POST /api/profile-subscription-bulk-create-jobs']);
    expect(seen[0]!.headers).toMatchObject({ Authorization: 'Klaviyo-API-Key pk_secret_value', revision: KLAVIYO_REVISION, 'Content-Type': 'application/vnd.api+json' });
    expect(seen[0]!.body.data).toEqual({ type: 'profile', attributes: { external_id: 'cust-1', email: 'a@example.com', first_name: 'Ann', properties: { order_count: 3 } } });
    const sub = seen[1]!.body.data;
    expect(sub.type).toBe('profile-subscription-bulk-create-job');
    expect(sub.attributes.historical_import).toBe(true);
    expect(sub.attributes.profiles.data[0].attributes).toEqual({ email: 'a@example.com', subscriptions: { email: { marketing: { consent: 'SUBSCRIBED', consented_at: '2026-09-01T00:00:00Z' } } } });
    expect(sub.relationships.list.data).toEqual({ type: 'list', id: 'Y6nRLr' });
    for (const s of seen) expect(s.url).not.toContain('pk_secret_value');
  });

  it('events carry unique_id; opt-outs go account-wide; bounces are suppressed', async () => {
    const { seen, fetchFn } = recorder();
    const k = createKlaviyoAdapter({ fetch: fetchFn });
    await k.trackEvent(conn(), { profileExternalId: 'cust-1', name: 'Placed Order', occurredAt: new Date('2026-09-30T02:00:00Z'), properties: { value: 59, currency: 'AUD' }, idempotencyKey: 'ros:txn:1' });
    await k.pushSuppression!(conn(), { channel: 'email', value: 'a@example.com', reason: 'unsubscribed', at: new Date() });
    await k.pushSuppression!(conn(), { channel: 'sms', value: '+61400111222', reason: 'unsubscribed', at: new Date() });
    await k.pushSuppression!(conn(), { channel: 'email', value: 'b@example.com', reason: 'bounced_hard', at: new Date() });
    expect(seen[0]!.body.data.attributes).toMatchObject({ unique_id: 'ros:txn:1', value: 59, value_currency: 'AUD', time: '2026-09-30T02:00:00Z', metric: { data: { type: 'metric', attributes: { name: 'Placed Order' } } }, profile: { data: { type: 'profile', attributes: { external_id: 'cust-1' } } } });
    expect(new URL(seen[1]!.url).pathname).toBe('/api/profile-subscription-bulk-delete-jobs');
    expect(seen[1]!.body.data.relationships).toBeUndefined();
    expect(seen[2]!.body.data.attributes.profiles.data[0].attributes).toEqual({ phone_number: '+61400111222', subscriptions: { sms: { marketing: { consent: 'UNSUBSCRIBED' } } } });
    expect(new URL(seen[3]!.url).pathname).toBe('/api/profile-suppression-bulk-create-jobs');
  });

  it('pulls suppressions since a time, following the next link, mapping reasons', async () => {
    let page = 0;
    const { seen, fetchFn } = recorder((s) => {
      const f = new URL(s.url).searchParams.get('filter') ?? '';
      if (f.startsWith('greater-than(subscriptions.email')) {
        page++;
        return page === 1
          ? { status: 200, body: { data: [{ attributes: { email: 'x@example.com', subscriptions: { email: { marketing: { suppression: [{ reason: 'UNSUBSCRIBE', timestamp: '2026-09-30T03:00:00Z' }] } } } } }], links: { next: 'https://a.klaviyo.com/api/profiles?page%5Bcursor%5D=abc' } } }
          : { status: 200, body: { data: [{ attributes: { email: 'y@example.com', subscriptions: { email: { marketing: { suppression: [{ reason: 'SPAM_COMPLAINT', timestamp: '2026-09-30T04:00:00Z' }] } } } } }], links: { next: null } } };
      }
      if (new URL(s.url).searchParams.has('page[cursor]')) {
        page++;
        return { status: 200, body: { data: [{ attributes: { email: 'y@example.com', subscriptions: { email: { marketing: { suppression: [{ reason: 'SPAM_COMPLAINT', timestamp: '2026-09-30T04:00:00Z' }] } } } } }], links: { next: null } } };
      }
      return { status: 200, body: { data: [{ attributes: { phone_number: '+61400999888', subscriptions: { sms: { marketing: { consent: 'UNSUBSCRIBED', last_updated: '2026-09-30T05:00:00Z' } } } } }], links: { next: null } } };
    });
    const k = createKlaviyoAdapter({ fetch: fetchFn });
    const out = await k.pullSuppressions(conn(), new Date('2026-09-30T00:00:00Z'));
    expect(out.map((s) => [s.channel, s.value, s.reason])).toEqual([
      ['email', 'x@example.com', 'unsubscribed'],
      ['email', 'y@example.com', 'complained'],
      ['sms', '+61400999888', 'unsubscribed'],
    ]);
    const first = new URL(seen[0]!.url);
    expect(first.searchParams.get('filter')).toBe('greater-than(subscriptions.email.marketing.suppression.timestamp,2026-09-30T00:00:00Z)');
    expect(first.searchParams.get('additional-fields[profile]')).toBe('subscriptions');
  });

  it('an error names the status and codes, never the key', async () => {
    const { fetchFn } = recorder(() => ({ status: 429, body: { errors: [{ code: 'throttled' }] } }));
    const k = createKlaviyoAdapter({ fetch: fetchFn });
    const e = await k.trackEvent(conn(), { profileExternalId: 'c', name: 'n', occurredAt: new Date(), properties: {}, idempotencyKey: 'k' }).then(() => new Error('no error'), (x: Error) => x);
    expect(String(e.message)).toMatch(/429.*throttled/);
    expect(String(e.message)).not.toContain('pk_secret_value');
  });
});

describe('reach: Meta Conversions API adapter requests', () => {
  const hash = 'a'.repeat(64);
  it('posts to the dataset with the token in the body, hashed identifiers only', async () => {
    const { seen, fetchFn } = recorder(() => ({ status: 200, body: { events_received: 1 } }));
    const m = createMetaCapiAdapter({ fetch: fetchFn });
    const r = await m.sendConversions(conn({ plugKey: 'meta-capi', externalAccountId: '123456', credentials: { accessToken: 'EAAtoken' }, config: { testEventCode: 'TEST1' } }), [
      { eventId: 'txn_1', eventName: 'Purchase', occurredAt: new Date('2026-09-30T02:00:00Z'), valueCents: 5950, currency: 'aud', hashedEmail: hash, hashedPhone: null, source: 'physical_store', orderId: 'o1' },
    ]);
    expect(r.accepted).toBe(1);
    expect(seen[0]!.url).toBe(`https://graph.facebook.com/${META_GRAPH_VERSION}/123456/events`);
    expect(seen[0]!.url).not.toContain('EAAtoken');
    expect(seen[0]!.body).toEqual({
      access_token: 'EAAtoken',
      test_event_code: 'TEST1',
      data: [{ event_name: 'Purchase', event_time: 1790733600, event_id: 'txn_1', action_source: 'physical_store', user_data: { em: [hash] }, custom_data: { currency: 'AUD', value: 59.5, order_id: 'o1' } }],
    });
  });

  it('refuses a raw email where a hash belongs', async () => {
    const { seen, fetchFn } = recorder();
    const m = createMetaCapiAdapter({ fetch: fetchFn });
    await expect(
      m.sendConversions(conn({ externalAccountId: '1', credentials: { accessToken: 't' } }), [{ eventId: 'e', eventName: 'Purchase', occurredAt: new Date(), hashedEmail: 'a@example.com', source: 'website' }]),
    ).rejects.toThrow(/SHA-256/);
    expect(seen).toHaveLength(0);
  });
});
