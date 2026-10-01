import type { ConnectionHandle, WebhookVerifyArgs } from './connection';

/** docs/modules/comms.md — sending is rented infrastructure behind one port. */
export interface OutboundMessage {
  idempotencyKey: string;
  channel: 'email' | 'sms';
  kind: 'transactional' | 'marketing';
  to: string;
  from: { email?: string; name?: string; smsSenderId?: string };
  subject?: string | null;
  /** Plain text. Always present. */
  body: string;
  /** The same content as HTML, for email. */
  html?: string | null;
  /** Marketing email must carry these (Spam Act 2003). */
  unsubscribeUrl?: string | null;
}

export interface MessageProviderEvent {
  eventId: string;
  /** Null for an inbound opt-out (a guest replying STOP), which names no message. */
  providerMessageId: string | null;
  /** For an inbound opt-out: the provider account it arrived on and the address that sent it. */
  accountRef?: string | null;
  address?: string | null;
  event: 'sent' | 'delivered' | 'opened' | 'clicked' | 'bounced' | 'complained' | 'unsubscribed' | 'failed';
  occurredAt: Date;
  hardBounce?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MessageAdapter {
  key: string;
  channels: Array<'email' | 'sms'>;
  /** conn is null when sending on the platform's own transactional identity. */
  send(conn: ConnectionHandle | null, msg: OutboundMessage): Promise<{ providerMessageId: string; costCents?: number }>;
  verifyWebhook(args: WebhookVerifyArgs): boolean;
  parseWebhook(rawBody: string): MessageProviderEvent[];
}

/** docs/modules/comms.md section 7 — a venue keeps its own email platform (the "connected" tier). */
export interface EspProfile {
  externalId: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  consents: { marketingEmail: boolean; marketingSms: boolean };
  /** When each consent was given here, for platforms that record consent provenance. */
  consentedAt?: { email?: Date | null; sms?: Date | null };
  properties?: Record<string, string | number | boolean | null>;
}

export interface EspSuppression {
  channel: 'email' | 'sms';
  value: string;
  reason: 'unsubscribed' | 'bounced_hard' | 'complained' | 'manual';
  at: Date;
}

export interface EspAdapter {
  key: string;
  capabilities: {
    transactional: boolean;
    marketing: boolean;
    sms: boolean;
    flows: 'ours' | 'theirs';
    suppressionSync: 'push' | 'pull' | 'both';
    engagementEvents: boolean;
  };
  upsertProfile(conn: ConnectionHandle, profile: EspProfile): Promise<void>;
  trackEvent(
    conn: ConnectionHandle,
    event: { profileExternalId: string; name: string; occurredAt: Date; properties: Record<string, unknown>; idempotencyKey: string },
  ): Promise<void>;
  pullSuppressions(conn: ConnectionHandle, since: Date): Promise<EspSuppression[]>;
  pushSuppression?(conn: ConnectionHandle, s: EspSuppression): Promise<void>;
  verifyWebhook?(args: WebhookVerifyArgs): boolean;
  parseWebhook?(rawBody: string): MessageProviderEvent[];
}
