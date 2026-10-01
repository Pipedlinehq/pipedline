import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@ros/core';
import { ResendApiError, createResendMessageAdapter, createResendSendingDomains, parseResendWebhook, resendFrom, resendListDomains, svixSignature, verifyResendWebhook } from '../src/resend/index';
import { stubFetch } from './stub-fetch';

/**
 * The Resend adapter against payloads copied from Resend's documentation (read 2026-10-01).
 * These prove the adapter does what the documentation describes. They do not prove Resend
 * behaves as documented: the adapter has never been called against Resend.
 */
const API_KEY = 're_test_key_never_real';
const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  idempotencyKey: 'msg:0b0e4c0e-6f0a-4f6e-9a57-0f6c1c3d9a11',
  channel: 'email',
  kind: 'transactional',
  to: 'guest@example.com',
  from: { email: 'oak-diner@mail.rosplatform.test', name: 'Oak Diner' },
  subject: 'Your order is ready',
  body: 'Order 41 is ready to collect.',
  html: '<p>Order 41 is ready to collect.</p>',
  ...over,
});

// docs: resend.com/docs/api-reference/domains/get-domain
const DOMAIN = {
  object: 'domain',
  id: 'd91cd9bd-1176-453e-8fc1-35364d380206',
  name: 'example.com',
  status: 'not_started',
  created_at: '2026-04-26 20:21:26.347412+00',
  region: 'us-east-1',
  records: [
    { record: 'SPF', name: 'send', type: 'MX', ttl: 'Auto', status: 'not_started', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
    { record: 'SPF', name: 'send', value: '"v=spf1 include:amazonses.com ~all"', type: 'TXT', ttl: 'Auto', status: 'not_started' },
    { record: 'DKIM', name: 'resend._domainkey', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84', type: 'TXT', status: 'not_started', ttl: 'Auto' },
  ],
};

describe('Resend: sending (documented shapes, unverified against Resend)', () => {
  it('posts the email with the bearer key and the idempotency key, and returns the id', async () => {
    const r = stubFetch(() => ({ body: { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' } }));
    const adapter = createResendMessageAdapter({ apiKey: API_KEY, fetch: r.fetch });
    const sent = await adapter.send(null, msg());

    expect(sent).toEqual({ providerMessageId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe('https://api.resend.com/emails');
    expect(call.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call.headers['idempotency-key']).toBe('msg:0b0e4c0e-6f0a-4f6e-9a57-0f6c1c3d9a11');
    expect(call.body).toEqual({
      from: 'Oak Diner <oak-diner@mail.rosplatform.test>',
      to: ['guest@example.com'],
      subject: 'Your order is ready',
      text: 'Order 41 is ready to collect.',
      html: '<p>Order 41 is ready to collect.</p>',
    });
  });

  it('adds one-click unsubscribe headers to marketing email', async () => {
    const r = stubFetch(() => ({ body: { id: 'e1' } }));
    await createResendMessageAdapter({ apiKey: API_KEY, fetch: r.fetch }).send(null, msg({ kind: 'marketing', unsubscribeUrl: 'https://oak-diner.tables.test/u/tok' }));
    expect(r.calls[0]!.body.headers).toEqual({ 'List-Unsubscribe': '<https://oak-diner.tables.test/u/tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  });

  it('caps the idempotency key at the documented 256 characters', async () => {
    const r = stubFetch(() => ({ body: { id: 'e1' } }));
    await createResendMessageAdapter({ apiKey: API_KEY, fetch: r.fetch }).send(null, msg({ idempotencyKey: 'k'.repeat(300) }));
    expect(r.calls[0]!.headers['idempotency-key']).toHaveLength(256);
  });

  it('refuses sms, a missing subject and a missing from address without calling Resend', async () => {
    const r = stubFetch(() => ({ body: { id: 'e1' } }));
    const adapter = createResendMessageAdapter({ apiKey: API_KEY, fetch: r.fetch });
    await expect(adapter.send(null, msg({ channel: 'sms' }))).rejects.toThrow(/cannot send sms/);
    await expect(adapter.send(null, msg({ subject: null }))).rejects.toThrow(/subject/);
    await expect(adapter.send(null, msg({ from: {} }))).rejects.toThrow(/from address/);
    expect(r.calls).toHaveLength(0);
  });

  it('keeps a display name from breaking out of the from header', () => {
    expect(resendFrom({ email: 'a@b.test', name: 'Evil" <x@y.test>\r\nBcc: z@z.test' })).toBe('Evil x@y.testBcc: z@z.test <a@b.test>');
    expect(resendFrom({ email: 'a@b.test' })).toBe('a@b.test');
  });

  it('reports a failure by status and error name only: never the key, never the message body', async () => {
    const r = stubFetch(() => ({ status: 429, body: { name: 'rate_limit_exceeded', message: `Too many requests for ${API_KEY}` } }));
    const err = await createResendMessageAdapter({ apiKey: API_KEY, fetch: r.fetch })
      .send(null, msg())
      .catch((e) => e);
    expect(err).toBeInstanceOf(ResendApiError);
    expect(err.status).toBe(429);
    expect(err.errorName).toBe('rate_limit_exceeded');
    expect(err.message).toBe('resend: 429 on /emails (rate_limit_exceeded)');
    expect(err.message).not.toContain(API_KEY);
    expect(err.message).not.toContain('Order 41');
  });

  it('turns a network failure into an error that names the path only', async () => {
    const fetch = (async () => {
      throw new TypeError(`connect failed with ${API_KEY}`);
    }) as unknown as typeof globalThis.fetch;
    const err = await createResendMessageAdapter({ apiKey: API_KEY, fetch })
      .send(null, msg())
      .catch((e) => e);
    expect(err.message).toBe('resend: request to /emails did not complete (TypeError)');
  });
});

describe('Resend: webhook signature (Svix)', () => {
  // The worked example on docs.svix.com/receiving/verifying-payloads/how-manual. The expected
  // signature is the one printed there, and was recomputed with `openssl dgst -sha256 -mac HMAC`
  // outside this codebase: it does not come from the function under test.
  const SECRET = 'whsec_plJ3nmyCDGBKInavdOK15jsl';
  const ID = 'msg_loFOjxBNrRLzqYUf';
  const TS = '1731705121';
  const BODY = '{"event_type":"ping","data":{"success":true}}';
  const SIG = 'rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=';
  const at = new Date(Number(TS) * 1000 + 30_000);
  const args = (over: Record<string, string | undefined> = {}, rawBody = BODY) => ({
    rawBody,
    url: 'https://console.example.test/webhooks/messages/resend',
    signingSecret: SECRET,
    headers: { 'svix-id': ID, 'svix-timestamp': TS, 'svix-signature': `v1,${SIG}`, ...over },
  });

  it('computes the documented signature for the documented example', () => {
    expect(svixSignature(SECRET, ID, TS, BODY)).toBe(SIG);
  });

  it('accepts the documented example', () => {
    expect(verifyResendWebhook(args(), at)).toBe(true);
  });

  it('accepts when the right signature is one of several (secret rotation)', () => {
    expect(verifyResendWebhook(args({ 'svix-signature': `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= v1,${SIG}` }), at)).toBe(true);
  });

  it('rejects a changed body, a changed id, a wrong secret, another version and missing headers', () => {
    expect(verifyResendWebhook(args({}, BODY.replace('true', 'false')), at)).toBe(false);
    expect(verifyResendWebhook(args({ 'svix-id': 'msg_other' }), at)).toBe(false);
    expect(verifyResendWebhook({ ...args(), signingSecret: 'whsec_b3RoZXJzZWNyZXRvdGhlcnNlY3JldA==' }, at)).toBe(false);
    expect(verifyResendWebhook(args({ 'svix-signature': `v2,${SIG}` }), at)).toBe(false);
    expect(verifyResendWebhook(args({ 'svix-signature': undefined }), at)).toBe(false);
    expect(verifyResendWebhook(args({ 'svix-timestamp': undefined }), at)).toBe(false);
    expect(verifyResendWebhook({ ...args(), signingSecret: '' }, at)).toBe(false);
  });

  it('rejects a correctly signed message replayed outside the five-minute window', () => {
    expect(verifyResendWebhook(args(), new Date(Number(TS) * 1000 + 301_000))).toBe(false);
    expect(verifyResendWebhook(args(), new Date(Number(TS) * 1000 - 301_000))).toBe(false);
    expect(verifyResendWebhook(args(), new Date(Number(TS) * 1000 + 299_000))).toBe(true);
  });

  it('the adapter verifies with its own clock', () => {
    const adapter = createResendMessageAdapter({ apiKey: API_KEY, clock: () => at });
    expect(adapter.verifyWebhook(args())).toBe(true);
    const late = createResendMessageAdapter({ apiKey: API_KEY, clock: () => new Date(at.getTime() + 3_600_000) });
    expect(late.verifyWebhook(args())).toBe(false);
  });
});

describe('Resend: webhook events', () => {
  // The data envelope of resend.com/docs/webhooks/emails/{delivered,bounced,clicked}.
  const data = {
    broadcast_id: '8b146471-e88e-4322-86af-016cd36fd216',
    created_at: '2026-11-22T23:41:11.894Z',
    email_id: '56761188-7520-42d8-8898-ff6fc54ce618',
    message_id: '<111-222-333@email.example.com>',
    from: 'Acme <onboarding@resend.dev>',
    to: ['delivered@resend.dev'],
    subject: 'Sending this example',
    tags: { category: 'confirm_email' },
  };
  const event = (type: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type, created_at: '2026-11-22T23:41:12.126Z', data: { ...data, ...extra } });

  it('parses delivered', () => {
    expect(parseResendWebhook(event('email.delivered'))).toEqual([
      {
        eventId: '56761188-7520-42d8-8898-ff6fc54ce618:email.delivered:2026-11-22T23:41:12.126Z',
        providerMessageId: '56761188-7520-42d8-8898-ff6fc54ce618',
        event: 'delivered',
        occurredAt: new Date('2026-11-22T23:41:12.126Z'),
        hardBounce: false,
        metadata: { type: 'email.delivered' },
      },
    ]);
  });

  it('parses a permanent bounce as a hard bounce and a temporary one as not', () => {
    const hard = parseResendWebhook(event('email.bounced', { bounce: { message: 'The recipient is on the suppression list.', subType: 'Suppressed', type: 'Permanent' } }))[0]!;
    expect(hard.event).toBe('bounced');
    expect(hard.hardBounce).toBe(true);
    expect(hard.metadata).toEqual({ type: 'email.bounced', bounceType: 'Permanent', bounceSubType: 'Suppressed' });
    const soft = parseResendWebhook(event('email.bounced', { bounce: { message: 'Mailbox full', subType: 'MailboxFull', type: 'Temporary' } }))[0]!;
    expect(soft.event).toBe('bounced');
    expect(soft.hardBounce).toBe(false);
  });

  it('parses complained, opened and failed', () => {
    expect(parseResendWebhook(event('email.complained'))[0]!.event).toBe('complained');
    expect(parseResendWebhook(event('email.opened'))[0]!.event).toBe('opened');
    expect(parseResendWebhook(event('email.failed'))[0]!.event).toBe('failed');
    expect(parseResendWebhook(event('email.sent'))[0]!.event).toBe('sent');
  });

  it('parses a click with its own time and link, so two clicks are two events', () => {
    const click = (timestamp: string) => ({ click: { ipAddress: '122.115.53.11', link: 'https://resend.com', timestamp, userAgent: 'Mozilla/5.0' } });
    const a = parseResendWebhook(event('email.clicked', click('2026-11-24T05:00:57.163Z')))[0]!;
    const b = parseResendWebhook(event('email.clicked', click('2026-11-24T05:03:00.000Z')))[0]!;
    expect(a.event).toBe('clicked');
    expect(a.occurredAt).toEqual(new Date('2026-11-24T05:00:57.163Z'));
    expect(a.metadata).toEqual({ type: 'email.clicked', link: 'https://resend.com' });
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('gives a redelivery of the same event the same id', () => {
    expect(parseResendWebhook(event('email.delivered'))[0]!.eventId).toBe(parseResendWebhook(event('email.delivered'))[0]!.eventId);
  });

  it('ignores events that are not about an email we sent, and anything malformed', () => {
    expect(parseResendWebhook(JSON.stringify({ type: 'domain.updated', created_at: '2026-11-22T23:41:12.126Z', data: { id: 'd1' } }))).toEqual([]);
    expect(parseResendWebhook(event('email.delivery_delayed'))).toEqual([]);
    expect(parseResendWebhook(event('email.received'))).toEqual([]);
    expect(parseResendWebhook(JSON.stringify({ type: 'email.delivered', created_at: 'not a date', data }))).toEqual([]);
    expect(parseResendWebhook(JSON.stringify({ type: 'email.delivered', created_at: '2026-11-22T23:41:12.126Z', data: {} }))).toEqual([]);
    expect(parseResendWebhook('not json')).toEqual([]);
    expect(parseResendWebhook('null')).toEqual([]);
  });
});

describe('Resend: sending domains', () => {
  const opts = (r: { fetch: typeof fetch }) => ({ apiKey: API_KEY, fetch: r.fetch });

  it('creates a domain and returns the DNS records the venue must add', async () => {
    const r = stubFetch((c) => (c.method === 'POST' && c.path === '/domains' ? { status: 201, body: DOMAIN } : undefined));
    const reg = await createResendSendingDomains(opts(r)).createDomain({ domain: 'example.com', idempotencyKey: 'onboarding:1:sending:example.com' });
    expect(r.calls[0]!.body).toEqual({ name: 'example.com' });
    expect(r.calls[0]!.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(reg).toEqual({
      providerDomainId: DOMAIN.id,
      verified: false,
      records: [
        { type: 'MX', name: 'send', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
        { type: 'TXT', name: 'send', value: '"v=spf1 include:amazonses.com ~all"' },
        { type: 'TXT', name: 'resend._domainkey', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDsc4Lh8xilsngyKEgN2S84' },
      ],
    });
  });

  it('a retry of a domain the account already holds returns that domain instead of failing', async () => {
    const r = stubFetch((c) => {
      if (c.method === 'POST' && c.path === '/domains') return { status: 403, body: { name: 'validation_error', message: 'already exists' } };
      if (c.method === 'GET' && c.path === '/domains') return { body: { object: 'list', has_more: false, data: [{ id: 'other', name: 'other.com', status: 'verified' }, { id: DOMAIN.id, name: 'Example.com', status: 'not_started' }] } };
      if (c.method === 'GET' && c.path === `/domains/${DOMAIN.id}`) return { body: DOMAIN };
      return undefined;
    });
    const reg = await createResendSendingDomains(opts(r)).createDomain({ domain: 'example.com', idempotencyKey: 'k' });
    expect(reg.providerDomainId).toBe(DOMAIN.id);
    expect(reg.records).toHaveLength(3);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /domains', 'GET /domains', `GET /domains/${DOMAIN.id}`]);
  });

  it('a refused create for a domain the account does not hold stays an error; a bad key is not retried as a search', async () => {
    const refused = stubFetch((c) => (c.method === 'POST' ? { status: 422, body: { name: 'validation_error' } } : { body: { object: 'list', has_more: false, data: [] } }));
    await expect(createResendSendingDomains(opts(refused)).createDomain({ domain: 'example.com', idempotencyKey: 'k' })).rejects.toThrow('resend: 422 on /domains (validation_error)');
    const badKey = stubFetch(() => ({ status: 401, body: { name: 'missing_api_key' } }));
    await expect(createResendSendingDomains(opts(badKey)).createDomain({ domain: 'example.com', idempotencyKey: 'k' })).rejects.toThrow(/401/);
    expect(badKey.calls).toHaveLength(1);
  });

  it('follows the list cursor to find a domain on a later page', async () => {
    const r = stubFetch((c) => {
      if (c.method === 'POST') return { status: 409, body: { name: 'validation_error' } };
      if (c.path === '/domains' && !c.url.searchParams.get('after')) return { body: { has_more: true, data: [{ id: 'a', name: 'a.com' }] } };
      if (c.path === '/domains' && c.url.searchParams.get('after') === 'a') return { body: { has_more: false, data: [{ id: DOMAIN.id, name: 'example.com' }] } };
      if (c.path === `/domains/${DOMAIN.id}`) return { body: DOMAIN };
      return undefined;
    });
    expect((await createResendSendingDomains(opts(r)).createDomain({ domain: 'example.com', idempotencyKey: 'k' })).providerDomainId).toBe(DOMAIN.id);
  });

  it('an unverified check asks Resend to look again and reports why it is not verified yet', async () => {
    let status = 'not_started';
    const r = stubFetch((c) => {
      if (c.method === 'GET' && c.path === `/domains/${DOMAIN.id}`) return { body: { ...DOMAIN, status } };
      if (c.method === 'POST' && c.path === `/domains/${DOMAIN.id}/verify`) {
        status = 'pending';
        return { body: { object: 'domain', id: DOMAIN.id } };
      }
      return undefined;
    });
    const check = await createResendSendingDomains(opts(r)).checkDomain({ domain: 'example.com', providerDomainId: DOMAIN.id });
    expect(check.verified).toBe(false);
    expect(check.reason).toBe('The email provider is still looking for the DNS records.');
    expect(check.records).toHaveLength(3);
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /domains/${DOMAIN.id}`, `POST /domains/${DOMAIN.id}/verify`, `GET /domains/${DOMAIN.id}`]);
  });

  it('only the status "verified" is verified: every other status, known or not, is not', async () => {
    for (const status of ['not_started', 'pending', 'failed', 'temporary_failure', 'partially_verified', 'partially_failed', 'something_new', undefined]) {
      const r = stubFetch((c) => (c.method === 'GET' ? { body: { ...DOMAIN, status } } : { body: {} }));
      const check = await createResendSendingDomains(opts(r)).checkDomain({ domain: 'example.com', providerDomainId: DOMAIN.id });
      expect(check.verified, String(status)).toBe(false);
      expect(check.reason, String(status)).toBeTruthy();
    }
    const ok = stubFetch(() => ({ body: { ...DOMAIN, status: 'verified' } }));
    expect(await createResendSendingDomains(opts(ok)).checkDomain({ domain: 'example.com', providerDomainId: DOMAIN.id })).toMatchObject({ verified: true });
    expect(ok.calls).toHaveLength(1); // a verified domain is not asked to verify again
  });

  it('a domain id that belongs to a different name, or to nothing, is not verified', async () => {
    const other = stubFetch(() => ({ body: { ...DOMAIN, name: 'someone-else.com', status: 'verified' } }));
    expect(await createResendSendingDomains(opts(other)).checkDomain({ domain: 'example.com', providerDomainId: DOMAIN.id })).toEqual({ verified: false, records: [], reason: 'That domain is not registered with the email provider.' });
    const gone = stubFetch(() => ({ status: 404, body: { name: 'not_found' } }));
    expect((await createResendSendingDomains(opts(gone)).checkDomain({ domain: 'example.com', providerDomainId: 'nope' })).verified).toBe(false);
  });

  it('removes a domain; an absent one is not an error; with no id it is found by name first', async () => {
    const r = stubFetch((c) => (c.method === 'DELETE' ? { body: { object: 'domain', id: DOMAIN.id, deleted: true } } : undefined));
    await createResendSendingDomains(opts(r)).removeDomain({ domain: 'example.com', providerDomainId: DOMAIN.id });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /domains/${DOMAIN.id}`]);

    const gone = stubFetch(() => ({ status: 404, body: { name: 'not_found' } }));
    await expect(createResendSendingDomains(opts(gone)).removeDomain({ domain: 'example.com', providerDomainId: 'nope' })).resolves.toBeUndefined();

    const byName = stubFetch((c) => (c.method === 'GET' ? { body: { has_more: false, data: [{ id: DOMAIN.id, name: 'example.com' }] } } : { body: { deleted: true } }));
    await createResendSendingDomains(opts(byName)).removeDomain({ domain: 'example.com', providerDomainId: null });
    expect(byName.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /domains', `DELETE /domains/${DOMAIN.id}`]);

    const nothing = stubFetch(() => ({ body: { has_more: false, data: [] } }));
    await createResendSendingDomains(opts(nothing)).removeDomain({ domain: 'example.com', providerDomainId: null });
    expect(nothing.calls.every((c) => c.method === 'GET')).toBe(true);

    const down = stubFetch(() => ({ status: 500, body: { name: 'application_error' } }));
    await expect(createResendSendingDomains(opts(down)).removeDomain({ domain: 'example.com', providerDomainId: DOMAIN.id })).rejects.toThrow(/500/);
  });

  it('the smoke read lists domains with a GET and nothing else', async () => {
    const r = stubFetch(() => ({ body: { object: 'list', has_more: false, data: [{ id: 'd', name: 'example.com', status: 'verified' }] } }));
    expect(await resendListDomains(opts(r))).toEqual([{ name: 'example.com', status: 'verified' }]);
    expect(r.calls.map((c) => c.method)).toEqual(['GET']);
  });
});
