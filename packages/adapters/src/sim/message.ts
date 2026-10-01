import { randomUUID } from 'node:crypto';
import type { ConnectionHandle, MessageAdapter, MessageProviderEvent, OutboundMessage } from '@ros/core';
import { signedWebhook, simVerify } from './signing';

export interface SimSentMessage extends OutboundMessage {
  providerMessageId: string;
  accountRef: string | null;
  at: Date;
}

export interface SimMessageAdapter extends MessageAdapter {
  /** Everything "sent", in order. Tests and the development inbox read this. */
  readonly sent: SimSentMessage[];
  /** Make the next n sends fail, to exercise retries. */
  failNext(n: number, message?: string): void;
  /** The most recent message to an address. */
  lastTo(address: string): SimSentMessage | undefined;
  /** Build a signed webhook carrying provider events, as the real provider would post it. */
  webhook(secret: string, events: Array<Omit<MessageProviderEvent, 'eventId' | 'occurredAt'> & { eventId?: string; occurredAt?: Date }>): {
    rawBody: string;
    headers: Record<string, string>;
  };
  reset(): void;
}

/**
 * A sending provider that delivers nowhere. It honours idempotency keys the way a real one
 * does: the same key returns the same provider id and sends once.
 */
export function createSimMessageAdapter(opts: { key: string; channels: Array<'email' | 'sms'>; costCents?: number; clock?: () => Date }): SimMessageAdapter {
  const sent: SimSentMessage[] = [];
  const byKey = new Map<string, string>();
  let failures = 0;
  let failureMessage = 'simulated provider outage';
  const now = () => (opts.clock ? opts.clock() : new Date());

  return {
    key: opts.key,
    channels: opts.channels,
    sent,

    async send(conn: ConnectionHandle | null, msg: OutboundMessage) {
      if (!opts.channels.includes(msg.channel)) throw new Error(`${opts.key} cannot send ${msg.channel}`);
      if (failures > 0) {
        failures--;
        throw new Error(failureMessage);
      }
      const prior = byKey.get(msg.idempotencyKey);
      if (prior) return { providerMessageId: prior, costCents: opts.costCents };
      const providerMessageId = `sim_${opts.key}_${randomUUID()}`;
      byKey.set(msg.idempotencyKey, providerMessageId);
      sent.push({ ...msg, providerMessageId, accountRef: conn?.externalAccountId ?? null, at: now() });
      return { providerMessageId, costCents: opts.costCents };
    },

    verifyWebhook: simVerify,

    parseWebhook(rawBody) {
      const body = JSON.parse(rawBody) as { events?: Array<Record<string, unknown>> };
      return (body.events ?? []).map((e) => ({
        eventId: String(e.eventId),
        providerMessageId: (e.providerMessageId as string | null) ?? null,
        event: e.event as MessageProviderEvent['event'],
        occurredAt: new Date(String(e.occurredAt)),
        hardBounce: Boolean(e.hardBounce),
        accountRef: (e.accountRef as string | null) ?? null,
        address: (e.address as string | null) ?? null,
        metadata: (e.metadata as Record<string, unknown>) ?? {},
      }));
    },

    failNext(n, message) {
      failures = n;
      if (message) failureMessage = message;
    },

    lastTo(address) {
      const a = address.toLowerCase();
      for (let i = sent.length - 1; i >= 0; i--) if (sent[i]!.to.toLowerCase() === a) return sent[i];
      return undefined;
    },

    webhook(secret, events) {
      return signedWebhook(secret, {
        events: events.map((e) => ({ ...e, eventId: e.eventId ?? randomUUID(), occurredAt: (e.occurredAt ?? now()).toISOString() })),
      });
    },

    reset() {
      sent.length = 0;
      byKey.clear();
      failures = 0;
    },
  };
}
