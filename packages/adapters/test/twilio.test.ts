import { describe, expect, it } from 'vitest';
import type { OutboundMessage } from '@ros/core';
import { TwilioApiError, createTwilioMessageAdapter, parseTwilioWebhook, twilioGetAccount, twilioSignature, verifyTwilioWebhook } from '../src/twilio/index';
import { stubFetch } from './stub-fetch';

/**
 * The Twilio adapter against shapes copied from Twilio's documentation (read 2026-10-01).
 * These prove the adapter does what the documentation describes. They do not prove Twilio
 * behaves as documented: the adapter has never been called against Twilio.
 */
const SID = 'AC' + '0123456789abcdef0123456789abcdef';
const TOKEN = 'twilio-test-auth-token-12345';
const URL_ = 'https://console.example.test/webhooks/messages/twilio';
const MSG_SID = 'SM0123456789abcdef0123456789abcdef';

const sms = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  idempotencyKey: 'msg:1',
  channel: 'sms',
  kind: 'transactional',
  to: '+61412345678',
  from: { smsSenderId: 'ROS' },
  body: 'Your code is 123456',
  ...over,
});

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

describe('Twilio: sending (documented shapes, unverified against Twilio)', () => {
  it('posts a form to the account Messages resource with basic auth and the status callback', async () => {
    const r = stubFetch(() => ({ status: 201, body: { sid: MSG_SID, status: 'queued', price: null, account_sid: SID } }));
    const adapter = createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN, statusCallbackUrl: URL_, fetch: r.fetch });
    const sent = await adapter.send(null, sms());

    expect(sent).toEqual({ providerMessageId: MSG_SID });
    const call = r.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`);
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(call.body).toEqual({ To: '+61412345678', Body: 'Your code is 123456', From: 'ROS', StatusCallback: URL_ });
  });

  it('sends transactional texts through the Messaging Service when one is configured, marketing as the org sender', async () => {
    const r = stubFetch(() => ({ status: 201, body: { sid: MSG_SID } }));
    const adapter = createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN, messagingServiceSid: 'MG0123456789abcdef0123456789abcdef', fetch: r.fetch });
    await adapter.send(null, sms());
    await adapter.send(null, sms({ kind: 'marketing', from: { smsSenderId: 'OAKDINER' } }));
    await adapter.send(null, sms({ kind: 'marketing', from: {} }));
    expect(r.calls[0]!.body).toEqual({ To: '+61412345678', Body: 'Your code is 123456', MessagingServiceSid: 'MG0123456789abcdef0123456789abcdef' });
    expect(r.calls[1]!.body.From).toBe('OAKDINER');
    expect(r.calls[1]!.body.MessagingServiceSid).toBeUndefined();
    expect(r.calls[2]!.body.MessagingServiceSid).toBe('MG0123456789abcdef0123456789abcdef');
  });

  it('refuses email and a message with no sender without calling Twilio', async () => {
    const r = stubFetch(() => ({ body: { sid: MSG_SID } }));
    const adapter = createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN, fetch: r.fetch });
    await expect(adapter.send(null, sms({ channel: 'email' }))).rejects.toThrow(/cannot send email/);
    await expect(adapter.send(null, sms({ from: {} }))).rejects.toThrow(/no sender/);
    expect(r.calls).toHaveLength(0);
  });

  it('reports a failure by status and Twilio code only: no token, no account SID, no message text', async () => {
    const r = stubFetch(() => ({ status: 400, body: { code: 21610, message: `Attempt to send to unsubscribed recipient ${TOKEN}`, status: 400 } }));
    const err = await createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN, fetch: r.fetch })
      .send(null, sms())
      .catch((e) => e);
    expect(err).toBeInstanceOf(TwilioApiError);
    expect(err.code).toBe('21610');
    expect(err.message).toBe('twilio: 400 on /2010-04-01/Accounts/{AccountSid}/Messages.json (code 21610)');
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain(SID);
  });
});

describe('Twilio: webhook signature', () => {
  // A status callback with the parameters Twilio documents. The expected signatures were
  // computed OUTSIDE this codebase, following Twilio's written steps by hand:
  //   printf '%s' "<url><name><value>… sorted by name" | openssl dgst -sha1 -hmac "<auth token>" -binary | base64
  const STATUS = { AccountSid: SID, ApiVersion: '2010-04-01', From: '+61480000000', MessageSid: MSG_SID, MessageStatus: 'delivered', SmsSid: MSG_SID, SmsStatus: 'delivered', To: '+61412345678' };
  const STATUS_SIG = 'neqiWR4/N55+s2QTDwH0JROU2xE=';
  const INBOUND = { AccountSid: SID, Body: 'Stop ', From: '+61412345678', MessageSid: 'SMfedcba9876543210fedcba9876543210', OptOutType: 'STOP', To: '+61480000000' };
  const INBOUND_SIG = 'evvwDy37V5oKxmWo9jKT1XP0+Ok=';

  it('computes the independently derived signature, whatever order the parameters arrive in', () => {
    expect(twilioSignature(TOKEN, URL_, Object.entries(STATUS))).toBe(STATUS_SIG);
    expect(twilioSignature(TOKEN, URL_, Object.entries(STATUS).reverse())).toBe(STATUS_SIG);
    expect(twilioSignature(TOKEN, URL_, Object.entries(INBOUND))).toBe(INBOUND_SIG);
  });

  it('accepts a correctly signed form body (with + and space encoded as a browser form would)', () => {
    const rawBody = form(STATUS);
    expect(rawBody).toContain('From=%2B61480000000');
    expect(verifyTwilioWebhook({ rawBody, url: URL_, signingSecret: TOKEN, headers: { 'x-twilio-signature': STATUS_SIG } })).toBe(true);
    expect(verifyTwilioWebhook({ rawBody: form(INBOUND), url: URL_, signingSecret: TOKEN, headers: { 'X-Twilio-Signature': INBOUND_SIG } })).toBe(true);
  });

  it('rejects a changed parameter, an added parameter, another URL, another token and a missing header', () => {
    const ok = { rawBody: form(STATUS), url: URL_, signingSecret: TOKEN, headers: { 'x-twilio-signature': STATUS_SIG } };
    expect(verifyTwilioWebhook({ ...ok, rawBody: form({ ...STATUS, MessageStatus: 'failed' }) })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, rawBody: form({ ...STATUS, Extra: '1' }) })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, url: `${URL_}/` })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, url: URL_.replace('https', 'http') })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, signingSecret: 'another-token' })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, signingSecret: '' })).toBe(false);
    expect(verifyTwilioWebhook({ ...ok, headers: {} })).toBe(false);
  });

  it('checks against the pinned public URL when the app sees a different one behind a proxy', () => {
    const adapter = createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN, webhookUrl: URL_ });
    expect(adapter.verifyWebhook({ rawBody: form(STATUS), url: 'http://10.0.0.7:3000/webhooks/messages/twilio', signingSecret: TOKEN, headers: { 'x-twilio-signature': STATUS_SIG } })).toBe(true);
    const unpinned = createTwilioMessageAdapter({ accountSid: SID, authToken: TOKEN });
    expect(unpinned.verifyWebhook({ rawBody: form(STATUS), url: 'http://10.0.0.7:3000/webhooks/messages/twilio', signingSecret: TOKEN, headers: { 'x-twilio-signature': STATUS_SIG } })).toBe(false);
  });
});

describe('Twilio: webhook events', () => {
  const at = new Date('2026-10-01T03:00:00.000Z');
  const status = (MessageStatus: string, extra: Record<string, string> = {}) => form({ AccountSid: SID, From: '+61480000000', To: '+61412345678', MessageSid: MSG_SID, SmsSid: MSG_SID, MessageStatus, SmsStatus: MessageStatus, ...extra });

  it('maps delivered and sent', () => {
    expect(parseTwilioWebhook(status('delivered'), at)).toEqual([
      { eventId: `${MSG_SID}:delivered`, providerMessageId: MSG_SID, event: 'delivered', occurredAt: at, hardBounce: false, metadata: { status: 'delivered' } },
    ]);
    expect(parseTwilioWebhook(status('sent'), at)[0]!.event).toBe('sent');
  });

  it('maps undelivered to a bounce: hard only for a number that can never take a text', () => {
    const unknownHandset = parseTwilioWebhook(status('undelivered', { ErrorCode: '30005' }), at)[0]!;
    expect(unknownHandset).toMatchObject({ event: 'bounced', hardBounce: true, metadata: { status: 'undelivered', errorCode: '30005' } });
    expect(parseTwilioWebhook(status('undelivered', { ErrorCode: '30006' }), at)[0]!.hardBounce).toBe(true);
    expect(parseTwilioWebhook(status('undelivered', { ErrorCode: '30003' }), at)[0]!).toMatchObject({ event: 'bounced', hardBounce: false });
    expect(parseTwilioWebhook(status('undelivered'), at)[0]!).toMatchObject({ event: 'bounced', hardBounce: false });
  });

  it('maps failed, and treats 21610 (recipient opted out) as an unsubscribe for the message that hit it', () => {
    expect(parseTwilioWebhook(status('failed', { ErrorCode: '30008' }), at)[0]!).toMatchObject({ event: 'failed', providerMessageId: MSG_SID });
    expect(parseTwilioWebhook(status('failed', { ErrorCode: '21610' }), at)[0]!).toMatchObject({ event: 'unsubscribed', providerMessageId: MSG_SID });
    expect(parseTwilioWebhook(status('undelivered', { ErrorCode: '21610' }), at)[0]!).toMatchObject({ event: 'unsubscribed', providerMessageId: MSG_SID });
  });

  it('ignores the statuses that say nothing yet, and gives each status its own event id', () => {
    for (const s of ['queued', 'accepted', 'sending', 'scheduled', 'read', 'canceled']) expect(parseTwilioWebhook(status(s), at), s).toEqual([]);
    expect(parseTwilioWebhook(status('sent'), at)[0]!.eventId).not.toBe(parseTwilioWebhook(status('delivered'), at)[0]!.eventId);
    expect(parseTwilioWebhook(status('delivered'), at)[0]!.eventId).toBe(parseTwilioWebhook(status('delivered'), new Date())[0]!.eventId);
  });

  const inbound = (Body: string, extra: Record<string, string> = {}) => form({ AccountSid: SID, MessageSid: 'SMfedcba9876543210fedcba9876543210', SmsSid: 'SMfedcba9876543210fedcba9876543210', From: '+61412345678', To: '+61480000000', Body, NumMedia: '0', ...extra });

  it('an inbound STOP is an opt-out naming the account and the sender, and no message', () => {
    expect(parseTwilioWebhook(inbound('STOP', { OptOutType: 'STOP', MessagingServiceSid: 'MG0123456789abcdef0123456789abcdef' }), at)).toEqual([
      {
        eventId: 'SMfedcba9876543210fedcba9876543210:stop',
        providerMessageId: null,
        accountRef: SID,
        address: '+61412345678',
        event: 'unsubscribed',
        occurredAt: at,
        metadata: { to: '+61480000000', messagingServiceSid: 'MG0123456789abcdef0123456789abcdef' },
      },
    ]);
  });

  it('without OptOutType, the default stop words count, in any case and with stray spaces', () => {
    for (const word of ['stop', ' Stop ', 'UNSUBSCRIBE', 'end', 'Quit', 'STOPALL', 'revoke', 'optout', 'cancel']) {
      expect(parseTwilioWebhook(inbound(word), at)[0]?.event, word).toBe('unsubscribed');
    }
  });

  it('other inbound texts are ignored: a sentence containing "stop", HELP, START, and whatever OptOutType says is not STOP', () => {
    expect(parseTwilioWebhook(inbound('please stop by at 6'), at)).toEqual([]);
    expect(parseTwilioWebhook(inbound('HELP', { OptOutType: 'HELP' }), at)).toEqual([]);
    expect(parseTwilioWebhook(inbound('START', { OptOutType: 'START' }), at)).toEqual([]);
    // Twilio decides when Advanced Opt-Out is on: a custom keyword list there may not treat "CANCEL" as a stop.
    expect(parseTwilioWebhook(inbound('CANCEL', { OptOutType: 'HELP' }), at)).toEqual([]);
    expect(parseTwilioWebhook(inbound('thanks!', { SmsStatus: 'received' }), at)).toEqual([]);
    expect(parseTwilioWebhook(inbound('STOP', { SmsStatus: 'received' }), at)[0]!.event).toBe('unsubscribed');
  });

  it('ignores a body with no message sid', () => {
    expect(parseTwilioWebhook('', at)).toEqual([]);
    expect(parseTwilioWebhook(form({ Body: 'STOP', From: '+61412345678' }), at)).toEqual([]);
  });
});

describe('Twilio: smoke read', () => {
  it('fetches the account with a GET and nothing else', async () => {
    const r = stubFetch(() => ({ body: { sid: SID, friendly_name: 'ROS', status: 'active', type: 'Full' } }));
    expect(await twilioGetAccount({ accountSid: SID, authToken: TOKEN, fetch: r.fetch })).toEqual({ friendlyName: 'ROS', status: 'active', type: 'Full' });
    expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /2010-04-01/Accounts/${SID}.json`]);
  });
});
