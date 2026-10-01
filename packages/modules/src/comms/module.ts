import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

export const commsModule = defineModule({
  key: 'comms',
  name: 'Comms',
  description: 'The outbox: email and SMS, templates, sending identities, suppression, delivery events.',
  spine: true,
  dependsOn: ['identity'],
  tables: ['messages', 'message_events', 'sending_identities', 'suppressions', 'templates', 'esp_sync_state', 'esp_sync_profiles', 'ad_conversions'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Org-level comms settings (orgs.settings.comms). */
export const commsSettings = z.object({
  /** Marketing SMS is never sent outside this venue-local window. */
  smsQuietHours: z.object({ start: HHMM, end: HHMM }).default({ start: '20:00', end: '09:00' }),
  dailyMarketingEmailCap: z.number().int().min(0).default(2000),
  dailyMarketingSmsCap: z.number().int().min(0).default(500),
  replyToEmail: z.string().email().nullable().default(null),
  /** Shown at the foot of every marketing message (Spam Act 2003: identify the sender). */
  senderAddressLine: z.string().max(300).nullable().default(null),
});
export type CommsSettings = z.infer<typeof commsSettings>;
export const defaultCommsSettings: CommsSettings = commsSettings.parse({});

const messageProps = z.object({
  message_id: z.string(),
  channel: z.enum(['email', 'sms']),
  kind: z.enum(['transactional', 'marketing']),
  template_key: z.string(),
  campaign_id: z.string().nullable().optional(),
  flow_id: z.string().nullable().optional(),
});

export const messageSent = defineEvent({ name: 'message.sent', module: 'comms', description: 'A message left for the provider.', properties: messageProps });
export const messageDelivered = defineEvent({ name: 'message.delivered', module: 'comms', description: 'The provider confirmed delivery.', properties: messageProps });
export const messageOpened = defineEvent({ name: 'message.opened', module: 'comms', description: 'An email was opened (as far as the provider can tell).', properties: messageProps });
export const messageClicked = defineEvent({ name: 'message.clicked', module: 'comms', description: 'A link in a message was clicked.', properties: messageProps });
export const messageBounced = defineEvent({ name: 'message.bounced', module: 'comms', description: 'The message could not be delivered.', properties: messageProps });
export const messageUnsubscribed = defineEvent({
  name: 'message.unsubscribed',
  module: 'comms',
  description: 'The guest opted out through a link, a STOP reply, or a complaint.',
  properties: messageProps.extend({ via: z.string() }),
});
export const messageSuppressed = defineEvent({
  name: 'message.suppressed',
  module: 'comms',
  description: 'A message was not sent because the guest has not agreed to it or the address is suppressed.',
  properties: messageProps.extend({ reason: z.string() }),
});
