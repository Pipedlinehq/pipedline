import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainJobs } from '@ros/core';
import { createResendMessageAdapter, createTwilioMessageAdapter, svixSignature, twilioSignature } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { comms } from '@ros/modules';

/**
 * The real Resend and Twilio adapters wired the way ROS_ADAPTERS=live wires them, driven
 * through comms: the outbox sends, the provider's signed webhook comes back, the database is
 * read. The providers themselves are a stubbed fetch answering as their documentation says.
 */
const RESEND_SECRET = 'whsec_c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0';
const TWILIO_SID = 'AC' + '0123456789abcdef0123456789abcdef';
const TWILIO_TOKEN = 'twilio-test-auth-token-12345';
const TWILIO_URL = 'https://console.rosplatform.test/webhooks/messages/twilio';
const RESEND_URL = 'https://console.rosplatform.test/webhooks/messages/resend';
const WORKER = { kind: 'worker' as const, job: 'test' };

describe('live sending adapters through comms', () => {
  const t = useTestEnv();
  const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let n = 0;
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw = String(init?.body ?? '');
    const isResend = url.startsWith('https://api.resend.com');
    sent.push({ url, headers, body: isResend ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)) });
    n++;
    const body = isResend ? { id: `re-email-${n}` } : { sid: `SM${String(n).padStart(32, '0')}`, status: 'queued', price: null };
    return new Response(JSON.stringify(body), { status: isResend ? 200 : 201, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  let before: typeof t.app.config.comms;
  beforeAll(() => {
    t.app.adapters.register('message', createResendMessageAdapter({ apiKey: 're_test', fetch, clock: t.clock }));
    t.app.adapters.register('message', createTwilioMessageAdapter({ accountSid: TWILIO_SID, authToken: TWILIO_TOKEN, statusCallbackUrl: TWILIO_URL, webhookUrl: TWILIO_URL, fetch, clock: t.clock }));
    before = { ...t.app.config.comms, webhookSecrets: { ...t.app.config.comms.webhookSecrets } };
    Object.assign(t.app.config.comms, { emailAdapter: 'resend', smsAdapter: 'twilio' });
    Object.assign(t.app.config.comms.webhookSecrets, { resend: RESEND_SECRET, twilio: TWILIO_TOKEN });
  });
  afterAll(() => {
    Object.assign(t.app.config.comms, before);
  });

  const message = (id: string) => t.db.selectFrom('messages').select(['id', 'status', 'provider', 'provider_message_id', 'to_address', 'error']).where('id', '=', id).executeTakeFirstOrThrow();
  const suppressions = (orgId: string, value: string) => t.db.selectFrom('suppressions').select(['channel', 'reason']).where('org_id', '=', orgId).where('value', '=', value).execute();

  async function sendEmail(to: string, key: string) {
    const { diner } = t.fixture;
    await t.app.tenant(diner.orgId, WORKER, (ctx) => comms.queueMessage(ctx, { templateKey: 'generic.notice', channel: 'email', to, idempotencyKey: key, variables: { subject: 'Table ready', body: 'Your table is ready.' } }));
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const row = await t.db.selectFrom('messages').select('id').where('org_id', '=', diner.orgId).where('idempotency_key', '=', key).executeTakeFirstOrThrow();
    return message(row.id);
  }

  async function sendSms(to: string, key: string) {
    const { diner } = t.fixture;
    await t.app.tenant(diner.orgId, WORKER, (ctx) =>
      comms.queueMessage(ctx, { templateKey: 'delivery.dispatched', channel: 'sms', to, idempotencyKey: key, variables: { first_name: 'Sam', venue_name: 'Oak Diner', reference: 'A41', eta_line: 'About 20 minutes.', tracking_url: 'https://track.example/x' } }),
    );
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const row = await t.db.selectFrom('messages').select('id').where('org_id', '=', diner.orgId).where('idempotency_key', '=', key).executeTakeFirstOrThrow();
    return message(row.id);
  }

  function resendWebhook(type: string, emailId: string, extra: Record<string, unknown> = {}, svixId = `msg_${type}_${emailId}`) {
    const rawBody = JSON.stringify({ type, created_at: t.clock().toISOString(), data: { email_id: emailId, created_at: t.clock().toISOString(), to: ['x'], ...extra } });
    const ts = String(Math.floor(t.clock().getTime() / 1000));
    return { adapterKey: 'resend', rawBody, url: RESEND_URL, headers: { 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': `v1,${svixSignature(RESEND_SECRET, svixId, ts, rawBody)}` } };
  }

  function twilioWebhook(params: Record<string, string>, url = TWILIO_URL) {
    const rawBody = new URLSearchParams(params).toString();
    return { adapterKey: 'twilio', rawBody, url, headers: { 'x-twilio-signature': twilioSignature(TWILIO_TOKEN, TWILIO_URL, Object.entries(params)) } };
  }

  it('an email goes out through Resend once, keyed, from the platform sending domain, and is recorded as sent', async () => {
    sent.length = 0;
    const m = await sendEmail('guest-live@example.com', 'live-test:email-1');
    expect(m).toMatchObject({ status: 'sent', provider: 'resend', to_address: 'guest-live@example.com' });
    expect(m.provider_message_id).toMatch(/^re-email-\d+$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.resend.com/emails');
    expect(sent[0]!.headers['Idempotency-Key']).toBe(`msg:${m.id}`);
    expect(sent[0]!.body.to).toEqual(['guest-live@example.com']);
    expect(sent[0]!.body.subject).toBe('Table ready');
    expect(sent[0]!.body.from).toMatch(/<oak-diner@mail\.rosplatform\.test>$/);
    expect(sent[0]!.body.text).toContain('Your table is ready.');
    // Nothing reached the simulator.
    expect(t.sim.email.sent.filter((s) => s.to === 'guest-live@example.com')).toEqual([]);
    // Draining again sends nothing more.
    await drainJobs(t.app, { kinds: ['comms.send'] });
    expect(sent).toHaveLength(1);
  });

  it('a signed delivered webhook marks the message delivered; a replay has no second effect; a bad signature is refused', async () => {
    const m = await sendEmail('guest-delivered@example.com', 'live-test:email-2');
    const hook = resendWebhook('email.delivered', m.provider_message_id!);
    expect(await comms.handleMessageWebhook(t.app, hook)).toEqual({ applied: 1, duplicates: 0, unmatched: 0 });
    expect((await message(m.id)).status).toBe('delivered');
    expect(await comms.handleMessageWebhook(t.app, hook)).toEqual({ applied: 0, duplicates: 1, unmatched: 0 });
    const events = await t.db.selectFrom('message_events').select('event').where('message_id', '=', m.id).execute();
    expect(events.map((e) => e.event).sort()).toEqual(['delivered', 'sent']);

    const tampered = { ...hook, rawBody: hook.rawBody.replace('email.delivered', 'email.bounced') };
    await expect(comms.handleMessageWebhook(t.app, tampered)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(comms.handleMessageWebhook(t.app, { ...hook, headers: { ...hook.headers, 'svix-signature': 'v1,AAAA' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    // Signed, but with the simulator's secret rather than Resend's.
    await expect(comms.handleMessageWebhook(t.app, { ...hook, adapterKey: 'sim-email' })).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a permanent bounce suppresses the address; a temporary one does not; a complaint opts the address out', async () => {
    const { diner } = t.fixture;
    const hard = await sendEmail('hard-bounce@example.com', 'live-test:email-3');
    await comms.handleMessageWebhook(t.app, resendWebhook('email.bounced', hard.provider_message_id!, { bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } }));
    expect((await message(hard.id)).status).toBe('bounced');
    expect(await suppressions(diner.orgId, 'hard-bounce@example.com')).toEqual([{ channel: 'email', reason: 'bounced_hard' }]);

    const soft = await sendEmail('soft-bounce@example.com', 'live-test:email-4');
    await comms.handleMessageWebhook(t.app, resendWebhook('email.bounced', soft.provider_message_id!, { bounce: { type: 'Temporary', subType: 'MailboxFull', message: 'full' } }));
    expect((await message(soft.id)).status).toBe('bounced');
    expect(await suppressions(diner.orgId, 'soft-bounce@example.com')).toEqual([]);

    const spam = await sendEmail('complainer@example.com', 'live-test:email-5');
    await comms.handleMessageWebhook(t.app, resendWebhook('email.complained', spam.provider_message_id!));
    expect(await suppressions(diner.orgId, 'complainer@example.com')).toEqual([{ channel: 'email', reason: 'complained' }]);

    // A suppressed address is not sent to again.
    const count = sent.length;
    const again = await sendEmail('hard-bounce@example.com', 'live-test:email-6');
    expect(again.status).toBe('suppressed');
    expect(sent).toHaveLength(count);
  });

  it('an event for an email this platform did not send is acknowledged and ignored', async () => {
    expect(await comms.handleMessageWebhook(t.app, resendWebhook('email.delivered', 'not-ours'))).toEqual({ applied: 0, duplicates: 0, unmatched: 1 });
    expect(await comms.handleMessageWebhook(t.app, resendWebhook('domain.updated', 'd1'))).toEqual({ applied: 0, duplicates: 0, unmatched: 0 });
  });

  it('an SMS goes out through Twilio with the status callback, and a signed callback marks it delivered', async () => {
    sent.length = 0;
    const m = await sendSms('+61412000111', 'live-test:sms-1');
    expect(m).toMatchObject({ status: 'sent', provider: 'twilio' });
    expect(sent[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`);
    expect(sent[0]!.body).toMatchObject({ To: m.to_address, From: 'ROS', StatusCallback: TWILIO_URL });
    expect(sent[0]!.body.Body).toContain('order A41');
    expect(t.sim.sms.sent.filter((s) => s.to === m.to_address)).toEqual([]);

    const params = { AccountSid: TWILIO_SID, MessageSid: m.provider_message_id!, SmsSid: m.provider_message_id!, MessageStatus: 'delivered', SmsStatus: 'delivered', To: m.to_address, From: 'ROS', ApiVersion: '2010-04-01' };
    // The app sees an internal URL behind the proxy; the signature is checked against the pinned public one.
    expect(await comms.handleMessageWebhook(t.app, twilioWebhook(params, 'http://10.0.0.7:3000/webhooks/messages/twilio'))).toEqual({ applied: 1, duplicates: 0, unmatched: 0 });
    expect((await message(m.id)).status).toBe('delivered');
    expect(await comms.handleMessageWebhook(t.app, twilioWebhook(params))).toEqual({ applied: 0, duplicates: 1, unmatched: 0 });

    const forged = twilioWebhook({ ...params, MessageStatus: 'undelivered', SmsStatus: 'undelivered' });
    forged.headers['x-twilio-signature'] = twilioSignature('wrong-token', TWILIO_URL, Object.entries(params));
    await expect(comms.handleMessageWebhook(t.app, forged)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('a text that fails because the guest opted out at Twilio (21610) opts them out here, in the org that sent it', async () => {
    const { diner, group } = t.fixture;
    const m = await sendSms('+61412000222', 'live-test:sms-2');
    const params = { AccountSid: TWILIO_SID, MessageSid: m.provider_message_id!, MessageStatus: 'failed', ErrorCode: '21610', To: m.to_address, From: 'ROS' };
    expect(await comms.handleMessageWebhook(t.app, twilioWebhook(params))).toEqual({ applied: 1, duplicates: 0, unmatched: 0 });
    expect(await suppressions(diner.orgId, m.to_address)).toEqual([{ channel: 'sms', reason: 'unsubscribed' }]);
    expect(await suppressions(group.orgId, m.to_address)).toEqual([]);
  });

  it('a number that can never take a text is suppressed as a hard bounce', async () => {
    const { diner } = t.fixture;
    const m = await sendSms('+61412000333', 'live-test:sms-3');
    await comms.handleMessageWebhook(t.app, twilioWebhook({ AccountSid: TWILIO_SID, MessageSid: m.provider_message_id!, MessageStatus: 'undelivered', ErrorCode: '30006', To: m.to_address, From: 'ROS' }));
    expect((await message(m.id)).status).toBe('bounced');
    expect(await suppressions(diner.orgId, m.to_address)).toEqual([{ channel: 'sms', reason: 'bounced_hard' }]);
  });

  it('KNOWN GAP: an inbound STOP on the shared platform number names no org, so it is acknowledged but not applied', async () => {
    // Twilio itself blocks further texts to that number, and the 21610 that results is applied
    // (the test above). What is missing is recording the opt-out before the next send is tried.
    const params = { AccountSid: TWILIO_SID, MessageSid: 'SMinbound0000000000000000000000001', From: '+61412000444', To: '+61480000000', Body: 'STOP', OptOutType: 'STOP' };
    expect(await comms.handleMessageWebhook(t.app, twilioWebhook(params))).toEqual({ applied: 0, duplicates: 0, unmatched: 1 });
    expect(await t.db.selectFrom('suppressions').select('id').where('value', '=', '+61412000444').execute()).toEqual([]);
  });
});
