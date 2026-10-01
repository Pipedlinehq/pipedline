import { createHmac } from 'node:crypto';
import { type ConnectionHandle, type MessageAdapter, type MessageProviderEvent, type OutboundMessage, type WebhookVerifyArgs, safeEqual } from '@ros/core';

/**
 * Twilio Programmable Messaging: SMS sending (ports/messaging.ts).
 *
 * UNVERIFIED LIVE. Written from Twilio's published documentation as read on 2026-10-01 and
 * tested only against payloads built from that documentation, with a stubbed fetch. It has
 * never been called against Twilio.
 *
 * Endpoints used:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *        form-encoded To, Body, From | MessagingServiceSid, StatusCallback; HTTP Basic auth
 *        (twilio.com/docs/messaging/api/message-resource)
 *   GET  https://api.twilio.com/2010-04-01/Accounts/{AccountSid}.json   (smoke check only)
 *
 * Webhooks (one URL for both kinds, form-encoded POST, header `X-Twilio-Signature`):
 *   - status callbacks: MessageSid, MessageStatus, ErrorCode, AccountSid, To, From
 *     (twilio.com/docs/messaging/guides/track-outbound-message-status)
 *   - inbound messages: MessageSid, AccountSid, From, To, Body, and OptOutType
 *     (STOP | START | HELP) when the number sits in a Messaging Service with Advanced Opt-Out
 *     (twilio.com/docs/messaging/guides/webhook-request, …/tutorials/advanced-opt-out)
 *   Signature: base64 HMAC-SHA1, keyed with the account's Auth Token, over the full URL
 *   followed by every POST parameter, sorted by name, as name+value with no separators
 *   (twilio.com/docs/usage/webhooks/webhooks-security).
 *
 * Things to know:
 *   - Twilio has NO idempotency key on message creation. The caller's once() wrapper is what
 *     stops a retry sending twice; a crash between Twilio accepting and us recording can
 *     still, rarely, send a second SMS.
 *   - A callback carries no timestamp and no event id: the event id is MessageSid + status,
 *     and the time is the time it was received.
 *   - The price is not known when a message is queued, so no cost is reported.
 *
 * Not confirmed by the pages read:
 *   - the JSON error body of the REST API (read as `{ code, message }`)
 *   - whether error 21610 (recipient has opted out) arrives on the create call or in a status
 *     callback. In a callback it becomes an opt-out for the org that sent the message; on the
 *     create call it is only a TwilioApiError with code 21610, which the sender retries and fails
 *   - what Twilio does with our webhook route's JSON `200` answer to an INBOUND message. Twilio
 *     expects TwiML or an empty body there; check the Twilio debugger on the first inbound text.
 */
export const TWILIO_KEY = 'twilio';
export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';
const BASE = 'https://api.twilio.com';

/** Twilio's default English opt-out words (advanced-opt-out page), for numbers where OptOutType is not sent. */
export const TWILIO_STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'END', 'QUIT', 'STOPALL', 'REVOKE', 'OPTOUT', 'CANCEL'];
/** 21610: "Attempt to send to unsubscribed recipient". */
const OPTED_OUT = '21610';
/** 30005 "Unknown destination handset", 30006 "Landline or unreachable carrier": the number will never take an SMS. */
const DEAD_NUMBER = new Set(['30005', '30006']);

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Send through this Messaging Service (its sender pool, its opt-out handling) rather than a bare number. */
  messagingServiceSid?: string;
  /** Where Twilio posts delivery status. The same public URL inbound messages are pointed at. */
  statusCallbackUrl?: string;
  /**
   * The public URL Twilio calls, exactly as configured there. Twilio signs the URL; behind a
   * proxy the URL the app sees can differ, so the signature is checked against this when set.
   */
  webhookUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clock?: () => Date;
  apiBase?: string;
}

export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, path: string) {
    super(`twilio: ${status} on ${path} (code ${code})`);
    this.name = 'TwilioApiError';
    this.status = status;
    this.code = code;
  }
}

async function twilioCall<T>(opts: TwilioOptions, method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<T> {
  const safePath = path.replace(opts.accountSid, '{AccountSid}');
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(new URL(path, opts.apiBase ?? BASE), {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64')}`,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? form.toString() : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(`twilio: request to ${safePath} did not complete (${(e as Error).name})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const code = (parsed as { code?: unknown } | null)?.code;
    throw new TwilioApiError(res.status, code === undefined || code === null ? 'unknown' : String(code), safePath);
  }
  return (parsed ?? {}) as T;
}

/** The value Twilio puts in `X-Twilio-Signature` for a form-encoded POST. */
export function twilioSignature(authToken: string, url: string, params: Array<[string, string]>): string {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHmac('sha1', authToken).update(url + sorted.map(([k, v]) => k + v).join('')).digest('base64');
}

const formOf = (rawBody: string): Array<[string, string]> => [...new URLSearchParams(rawBody).entries()];

export function verifyTwilioWebhook(args: WebhookVerifyArgs, pinnedUrl?: string): boolean {
  const given = Object.entries(args.headers).find(([k]) => k.toLowerCase() === TWILIO_SIGNATURE_HEADER)?.[1];
  if (!given || !args.signingSecret) return false;
  return safeEqual(given, twilioSignature(args.signingSecret, pinnedUrl ?? args.url, formOf(args.rawBody)));
}

/**
 * A status callback becomes a delivery event for the message it names. An inbound message
 * becomes an opt-out only when it is a STOP; any other inbound text is ignored (START is too:
 * opting back in is the guest's to do through the venue, where consent is recorded).
 */
export function parseTwilioWebhook(rawBody: string, receivedAt: Date = new Date()): MessageProviderEvent[] {
  const p = new Map(formOf(rawBody));
  const sid = p.get('MessageSid') ?? p.get('SmsSid');
  if (!sid) return [];
  const status = p.get('MessageStatus') ?? p.get('SmsStatus');

  // An inbound message's own status is "received"; anything else is a callback about a message we sent.
  if (status && status !== 'received' && status !== 'receiving') {
    const code = p.get('ErrorCode') ?? null;
    let event: MessageProviderEvent['event'] | null = null;
    if (status === 'delivered') event = 'delivered';
    else if (status === 'sent') event = 'sent';
    else if (status === 'undelivered') event = code === OPTED_OUT ? 'unsubscribed' : 'bounced';
    else if (status === 'failed') event = code === OPTED_OUT ? 'unsubscribed' : 'failed';
    if (!event) return [];
    return [
      {
        eventId: `${sid}:${status}`,
        providerMessageId: sid,
        event,
        occurredAt: receivedAt,
        hardBounce: event === 'bounced' && code !== null && DEAD_NUMBER.has(code),
        metadata: { status, ...(code ? { errorCode: code } : {}) },
      },
    ];
  }

  const from = p.get('From');
  if (!from || !p.has('Body')) return [];
  const optOut = p.get('OptOutType');
  const word = (p.get('Body') ?? '').trim().toUpperCase();
  const stop = optOut ? optOut.toUpperCase() === 'STOP' : TWILIO_STOP_WORDS.includes(word);
  if (!stop) return [];
  return [
    {
      eventId: `${sid}:stop`,
      providerMessageId: null,
      accountRef: p.get('AccountSid') ?? null,
      address: from,
      event: 'unsubscribed',
      occurredAt: receivedAt,
      metadata: { to: p.get('To') ?? null, messagingServiceSid: p.get('MessagingServiceSid') ?? null },
    },
  ];
}

export function createTwilioMessageAdapter(opts: TwilioOptions): MessageAdapter {
  const now = () => (opts.clock ? opts.clock() : new Date());
  return {
    key: TWILIO_KEY,
    channels: ['sms'],

    async send(_conn: ConnectionHandle | null, msg: OutboundMessage) {
      if (msg.channel !== 'sms') throw new Error('twilio cannot send email');
      const form = new URLSearchParams();
      form.set('To', msg.to);
      form.set('Body', msg.body);
      // Transactional texts go out through the platform's Messaging Service when there is one;
      // marketing goes out as the org's own registered sender.
      const sender = msg.from.smsSenderId;
      if (opts.messagingServiceSid && (msg.kind === 'transactional' || !sender)) form.set('MessagingServiceSid', opts.messagingServiceSid);
      else if (sender) form.set('From', sender);
      else throw new Error('twilio: no sender is configured');
      if (opts.statusCallbackUrl) form.set('StatusCallback', opts.statusCallbackUrl);
      const res = await twilioCall<{ sid?: string }>(opts, 'POST', `/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`, form);
      if (!res.sid) throw new Error('twilio: the message was accepted without a sid');
      return { providerMessageId: res.sid };
    },

    verifyWebhook: (args) => verifyTwilioWebhook(args, opts.webhookUrl),
    parseWebhook: (rawBody) => parseTwilioWebhook(rawBody, now()),
  };
}

/** Read-only: the account itself. Used by scripts/smoke-live.ts to prove the credentials work. */
export async function twilioGetAccount(opts: TwilioOptions): Promise<{ friendlyName: string; status: string; type: string }> {
  const a = await twilioCall<{ friendly_name?: string; status?: string; type?: string }>(opts, 'GET', `/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}.json`);
  return { friendlyName: a.friendly_name ?? '', status: a.status ?? 'unknown', type: a.type ?? 'unknown' };
}
