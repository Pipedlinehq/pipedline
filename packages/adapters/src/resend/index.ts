import { createHmac } from 'node:crypto';
import {
  type ConnectionHandle,
  type DnsRecord,
  type DomainCheck,
  type DomainRegistration,
  type MessageAdapter,
  type MessageProviderEvent,
  type OutboundMessage,
  type SendingDomainPort,
  type WebhookVerifyArgs,
  safeEqual,
} from '@ros/core';

/**
 * Resend: email sending (ports/messaging.ts) and per-org sending domains (ports/hosting.ts).
 *
 * UNVERIFIED LIVE. Written from Resend's published documentation as read on 2026-10-01 and
 * tested only against payloads built from that documentation, with a stubbed fetch. It has
 * never been called against Resend.
 *
 * Endpoints used (resend.com/docs/api-reference):
 *   POST   https://api.resend.com/emails              send; `Idempotency-Key` header (max 256 chars, kept 24 h)
 *   POST   https://api.resend.com/domains             { name } → { id, status, records[] }
 *   GET    https://api.resend.com/domains             list (limit ≤ 100, `after` cursor, `has_more`)
 *   GET    https://api.resend.com/domains/{id}        { status, records[] }
 *   POST   https://api.resend.com/domains/{id}/verify asks Resend to look for the records now
 *   DELETE https://api.resend.com/domains/{id}
 *   All with `Authorization: Bearer <api key>`.
 *
 * Webhooks are signed by Svix (resend.com/docs/dashboard/webhooks/verify-webhooks-requests,
 * docs.svix.com/receiving/verifying-payloads/how-manual): headers `svix-id`, `svix-timestamp`,
 * `svix-signature`; HMAC-SHA256 over `${id}.${timestamp}.${body}` keyed with the base64-decoded
 * part of the `whsec_…` secret, base64 output; the header carries space-separated `v1,<sig>`.
 *
 * Not confirmed by the pages read:
 *   - the payloads of email.opened, email.complained, email.failed and email.suppressed (only
 *     delivered, bounced and clicked examples were read); they are assumed to share the
 *     envelope `{ type, created_at, data: { email_id } }`
 *   - the error Resend answers when a domain already exists (any refusal to create is followed
 *     by a search of the account's domains by name)
 *   - whether domain creation honours `Idempotency-Key` (it is not sent)
 *   - the timestamp tolerance: five minutes is the Svix library's default, not stated on the page
 *   - the error body: read as `{ name, message }`
 */
export const RESEND_KEY = 'resend';
const BASE = 'https://api.resend.com';
export const RESEND_TIMESTAMP_TOLERANCE_SECONDS = 300;

export interface ResendOptions {
  /** The platform's API key. Marketing for an org goes out through the same account, on that org's verified domain. */
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  clock?: () => Date;
  apiBase?: string;
}

/** A Resend call that did not succeed. Names the status and Resend's error name only: never the key or the message body. */
export class ResendApiError extends Error {
  readonly status: number;
  readonly errorName: string;
  constructor(status: number, errorName: string, path: string) {
    super(`resend: ${status} on ${path} (${errorName})`);
    this.name = 'ResendApiError';
    this.status = status;
    this.errorName = errorName;
  }
}

interface ResendCall {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function resendCall<T>(opts: ResendOptions, req: ResendCall): Promise<T> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(new URL(req.path, opts.apiBase ?? BASE), {
      method: req.method,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: 'application/json',
        ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...req.headers,
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(`resend: request to ${req.path} did not complete (${(e as Error).name})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const name = (parsed as { name?: unknown } | null)?.name;
    throw new ResendApiError(res.status, typeof name === 'string' ? name : 'unknown_error', req.path);
  }
  return (parsed ?? {}) as T;
}

// ── webhook signature ────────────────────────────────────────────────────────────────────────

/** The `v1` signature Svix puts on a message: base64 HMAC-SHA256 of `${id}.${timestamp}.${body}`. */
export function svixSignature(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret, 'base64');
  return createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
}

const header = (headers: Record<string, string | undefined>, name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];

export function verifyResendWebhook(args: WebhookVerifyArgs, now: Date = new Date()): boolean {
  const id = header(args.headers, 'svix-id');
  const timestamp = header(args.headers, 'svix-timestamp');
  const given = header(args.headers, 'svix-signature');
  if (!id || !timestamp || !given || !args.signingSecret || !args.rawBody) return false;
  const at = Number(timestamp);
  if (!Number.isFinite(at) || Math.abs(now.getTime() / 1000 - at) > RESEND_TIMESTAMP_TOLERANCE_SECONDS) return false;
  const expected = svixSignature(args.signingSecret, id, timestamp, args.rawBody);
  // Several signatures may be listed while a secret is being rotated; any `v1` match passes.
  return given.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    return version === 'v1' && !!sig && safeEqual(sig, expected);
  });
}

// ── webhook events ───────────────────────────────────────────────────────────────────────────

const EVENT: Record<string, MessageProviderEvent['event']> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  // Resend held the email back because the address is on its own suppression list.
  'email.suppressed': 'failed',
};

interface ResendWebhook {
  type?: unknown;
  created_at?: unknown;
  data?: { email_id?: unknown; bounce?: { type?: unknown; subType?: unknown }; click?: { link?: unknown; timestamp?: unknown } };
}

/**
 * One Resend webhook is one event. Events about anything but an email we sent (domains,
 * contacts, inbound mail, delivery delays) are ignored. The event id is built from the email,
 * the event type and its time, because the body carries no id of its own (Svix's is in a
 * header) and a click or open can legitimately happen more than once.
 */
export function parseResendWebhook(rawBody: string): MessageProviderEvent[] {
  let body: ResendWebhook;
  try {
    body = JSON.parse(rawBody) as ResendWebhook;
  } catch {
    return [];
  }
  const event = typeof body?.type === 'string' ? EVENT[body.type] : undefined;
  const emailId = body?.data?.email_id;
  if (!event || typeof emailId !== 'string' || !emailId) return [];
  const createdAt = typeof body.created_at === 'string' ? body.created_at : '';
  const clickedAt = typeof body.data?.click?.timestamp === 'string' ? body.data.click.timestamp : '';
  const occurredAt = new Date(clickedAt || createdAt);
  if (Number.isNaN(occurredAt.getTime())) return [];
  const bounce = body.data?.bounce;
  const metadata: Record<string, unknown> = { type: body.type };
  if (bounce) Object.assign(metadata, { bounceType: bounce.type ?? null, bounceSubType: bounce.subType ?? null });
  if (typeof body.data?.click?.link === 'string') metadata.link = body.data.click.link;
  return [
    {
      eventId: `${emailId}:${String(body.type)}:${clickedAt || createdAt}`,
      providerMessageId: emailId,
      event,
      occurredAt,
      // "Permanent": the mail server refused the address for good. "Temporary" bounces are not suppressed.
      hardBounce: event === 'bounced' && bounce?.type === 'Permanent',
      metadata,
    },
  ];
}

// ── sending ──────────────────────────────────────────────────────────────────────────────────

/** `Name <address>`, with anything that could break out of the display name removed. */
export function resendFrom(from: OutboundMessage['from']): string {
  if (!from.email) throw new Error('resend: a from address is required');
  const name = (from.name ?? '').replace(/[\r\n"<>]/g, '').trim();
  return name ? `${name} <${from.email}>` : from.email;
}

export function createResendMessageAdapter(opts: ResendOptions): MessageAdapter {
  const now = () => (opts.clock ? opts.clock() : new Date());
  return {
    key: RESEND_KEY,
    channels: ['email'],

    async send(_conn: ConnectionHandle | null, msg: OutboundMessage) {
      if (msg.channel !== 'email') throw new Error('resend cannot send sms');
      if (!msg.subject) throw new Error('resend: an email needs a subject');
      const headers: Record<string, string> = {};
      if (msg.unsubscribeUrl) {
        // One-click unsubscribe (RFC 8058), which mailbox providers require of bulk senders.
        headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      const res = await resendCall<{ id?: string }>(opts, {
        method: 'POST',
        path: '/emails',
        headers: { 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) },
        body: {
          from: resendFrom(msg.from),
          to: [msg.to],
          subject: msg.subject,
          text: msg.body,
          ...(msg.html ? { html: msg.html } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        },
      });
      if (!res.id) throw new Error('resend: the send was accepted without an id');
      return { providerMessageId: res.id };
    },

    verifyWebhook: (args) => verifyResendWebhook(args, now()),
    parseWebhook: parseResendWebhook,
  };
}

// ── sending domains ──────────────────────────────────────────────────────────────────────────

interface ResendRecord {
  record?: string;
  name?: string;
  type?: string;
  value?: string;
  status?: string;
  priority?: number;
}

interface ResendDomain {
  id: string;
  name: string;
  status?: string;
  records?: ResendRecord[];
}

const DNS_TYPES = new Set<DnsRecord['type']>(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);

export function resendRecords(records: ResendRecord[] | undefined): DnsRecord[] {
  const out: DnsRecord[] = [];
  for (const r of records ?? []) {
    if (!r.name || !r.value || !DNS_TYPES.has(r.type as DnsRecord['type'])) continue;
    out.push({ type: r.type as DnsRecord['type'], name: r.name, value: r.value, ...(typeof r.priority === 'number' ? { priority: r.priority } : {}) });
  }
  return out;
}

const WHY: Record<string, string> = {
  not_started: 'The DNS records have not been checked yet.',
  pending: 'The email provider is still looking for the DNS records.',
  failed: 'The DNS records were not found within 72 hours. Check them at the registrar and try again.',
  temporary_failure: 'A DNS record that was there before can no longer be found.',
  partially_verified: 'Some of the DNS records have been found, but not all of them yet.',
  partially_failed: 'Some of the DNS records could not be found.',
};

/** Only Resend's own `verified` counts. Every other status, including ones this code does not know, is unverified. */
function checkOf(d: ResendDomain): DomainCheck {
  const records = resendRecords(d.records);
  if (d.status === 'verified') return { verified: true, records };
  return { verified: false, records, reason: WHY[d.status ?? ''] ?? 'The email provider has not confirmed the DNS records yet.' };
}

export function createResendSendingDomains(opts: ResendOptions): SendingDomainPort {
  async function findByName(domain: string): Promise<ResendDomain | null> {
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await resendCall<{ data?: ResendDomain[]; has_more?: boolean }>(opts, { method: 'GET', path: `/domains?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}` });
      const hit = (res.data ?? []).find((d) => d.name.toLowerCase() === domain.toLowerCase());
      if (hit) return hit;
      const last = res.data?.at(-1)?.id;
      if (!res.has_more || !last) return null;
      after = last;
    }
    return null;
  }

  const get = (id: string) => resendCall<ResendDomain>(opts, { method: 'GET', path: `/domains/${encodeURIComponent(id)}` });

  return {
    key: RESEND_KEY,

    /**
     * Resend's create is not documented as idempotent, so a retry is made safe here: a domain
     * the account already holds is returned as it stands rather than created twice.
     */
    async createDomain({ domain }): Promise<DomainRegistration> {
      let d: ResendDomain;
      try {
        d = await resendCall<ResendDomain>(opts, { method: 'POST', path: '/domains', body: { name: domain } });
      } catch (e) {
        if (!(e instanceof ResendApiError) || e.status < 400 || e.status >= 500 || e.status === 401 || e.status === 429) throw e;
        const existing = await findByName(domain);
        if (!existing) throw e;
        d = await get(existing.id);
      }
      return { providerDomainId: d.id, records: resendRecords(d.records), verified: d.status === 'verified' };
    },

    async checkDomain({ domain, providerDomainId }): Promise<DomainCheck> {
      let d: ResendDomain;
      try {
        d = await get(providerDomainId);
      } catch (e) {
        if (e instanceof ResendApiError && e.status === 404) return { verified: false, records: [], reason: 'That domain is not registered with the email provider.' };
        throw e;
      }
      if (d.name.toLowerCase() !== domain.toLowerCase()) return { verified: false, records: [], reason: 'That domain is not registered with the email provider.' };
      if (d.status === 'verified') return checkOf(d);
      // Ask Resend to look again now; its answer arrives on a later check.
      await resendCall(opts, { method: 'POST', path: `/domains/${encodeURIComponent(providerDomainId)}/verify` });
      return checkOf(await get(providerDomainId));
    },

    async removeDomain({ domain, providerDomainId }): Promise<void> {
      const id = providerDomainId ?? (await findByName(domain))?.id;
      if (!id) return;
      try {
        await resendCall(opts, { method: 'DELETE', path: `/domains/${encodeURIComponent(id)}` });
      } catch (e) {
        if (e instanceof ResendApiError && e.status === 404) return;
        throw e;
      }
    },
  };
}

/** Read-only: the account's domains. Used by scripts/smoke-live.ts to prove the key works. */
export async function resendListDomains(opts: ResendOptions): Promise<Array<{ name: string; status: string }>> {
  const res = await resendCall<{ data?: ResendDomain[] }>(opts, { method: 'GET', path: '/domains?limit=100' });
  return (res.data ?? []).map((d) => ({ name: d.name, status: d.status ?? 'unknown' }));
}
