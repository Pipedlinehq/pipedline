import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';
import { defineHostedAgent } from '../hub/hosted';

/**
 * Campaigns: segments, lifecycle flows and one-off campaigns. Per-venue switch only; what an org tunes lives in its org settings
 * (`campaignsSettings`) and on each flow row (`flows.config`).
 */
export const campaignsConfig = z.object({});
export type CampaignsConfig = z.infer<typeof campaignsConfig>;

export const campaignsModule = defineModule({
  key: 'campaigns',
  name: 'Campaigns',
  description: 'Segments, lifecycle flows (welcome, post-purchase, win-back, VIP, birthday) and one-off campaigns.',
  dependsOn: [],
  tables: ['segments', 'flows', 'flow_enrollments', 'campaigns'],
  configSchema: campaignsConfig,
  configVersion: 1,
  defaultConfig: campaignsConfig.parse({}),
});

/** Org-level settings, stored under orgs.settings.campaigns. */
export const campaignsSettings = z.object({
  /** A one-off campaign is queued at most this many messages at a time, so a cold list warms up. */
  campaignWaveSize: z.number().int().min(10).max(20_000).default(500),
  /** How long to wait between waves of a one-off campaign. */
  waveIntervalMinutes: z.number().int().min(5).max(1440).default(60),
  /** How long a batch or a campaign waits for a manager before it lapses and nothing is sent. */
  approvalTtlHours: z.number().int().min(1).max(336).default(48),
  /** An order within this many days of a message is recorded as a touch from that message. */
  attributionWindowDays: z.number().int().min(1).max(30).default(7),
});
export type CampaignsSettings = z.infer<typeof campaignsSettings>;
export const defaultCampaignsSettings: CampaignsSettings = campaignsSettings.parse({});
export const CAMPAIGNS_SETTINGS_NAMESPACE = 'campaigns';

// ── Events ────────────────────────────────────────────────────────────────

export const campaignDrafted = defineEvent({
  name: 'campaign.drafted',
  module: 'campaigns',
  description: 'A one-off campaign was drafted, by staff or by an assistant. Nothing is sent from a draft.',
  properties: z.object({ campaign_id: z.string(), channel: z.enum(['email', 'sms']), by: z.enum(['staff', 'agent']), audience_count: z.number().int() }),
});

export const campaignSubmitted = defineEvent({
  name: 'campaign.submitted',
  module: 'campaigns',
  description: 'A campaign was put in front of a manager for approval to send.',
  properties: z.object({ campaign_id: z.string(), approval_id: z.string(), audience_count: z.number().int() }),
});

export const campaignWaveQueued = defineEvent({
  name: 'campaign.wave_queued',
  module: 'campaigns',
  description: 'One wave of an approved campaign was put in the outbox.',
  properties: z.object({ campaign_id: z.string(), wave: z.number().int(), queued: z.number().int(), suppressed: z.number().int(), remaining: z.number().int() }),
});

export const campaignSent = defineEvent({
  name: 'campaign.sent',
  module: 'campaigns',
  description: 'Every wave of a campaign has been queued.',
  properties: z.object({ campaign_id: z.string(), queued: z.number().int(), suppressed: z.number().int(), waves: z.number().int() }),
});

export const flowEnrolled = defineEvent({
  name: 'flow.enrolled',
  module: 'campaigns',
  description: 'A guest entered a lifecycle flow (welcome, post-purchase, win-back, VIP, birthday).',
  properties: z.object({ flow_id: z.string(), flow_key: z.string(), cycle: z.number().int() }),
});

export const flowExited = defineEvent({
  name: 'flow.exited',
  module: 'campaigns',
  description: 'A guest left a lifecycle flow before its last step: they bought again, opted out, could not be reached, or waited too long.',
  properties: z.object({ flow_id: z.string(), flow_key: z.string(), reason: z.enum(['purchase', 'unsubscribed', 'no_consent', 'stale', 'erased']) }),
});

export const flowStepQueued = defineEvent({
  name: 'flow.step_queued',
  module: 'campaigns',
  description: 'A lifecycle flow step was put in the outbox for one guest.',
  properties: z.object({ flow_id: z.string(), flow_key: z.string(), step: z.number().int(), mode: z.enum(['supervised', 'autonomous']), with_offer: z.boolean() }),
});

// ── Hosted agents: one per flow (docs/modules/hub.md section 8) ─────────────

/**
 * The ceilings. Sending marketing to guests needs a person until trust is earned, so every flow
 * starts in shadow and none may go past supervised, with one exception: the welcome message. It
 * goes once, to a guest who has just this minute asked to hear from the venue, and it is what
 * they expect. Even then, a flow that carries an offer (a discount is money) is held at
 * supervised whatever its ceiling (flows.ts effectiveMode).
 */
export const FLOW_AGENTS = {
  welcome: defineHostedAgent({ key: 'flow_welcome', name: 'Welcome flow', description: 'Welcomes a guest who has just agreed to hear from the venue.', templateVersion: '1.0.0', ceiling: 'autonomous' }),
  post_purchase: defineHostedAgent({ key: 'flow_post_purchase', name: 'Post-purchase flow', description: 'Invites a first-time guest back about three weeks after their first visit.', templateVersion: '1.0.0', ceiling: 'supervised' }),
  winback: defineHostedAgent({ key: 'flow_winback', name: 'Win-back flow', description: 'Asks a guest who has gone quiet to come back.', templateVersion: '1.1.0', ceiling: 'supervised' }),
  vip: defineHostedAgent({ key: 'flow_vip', name: 'VIP flow', description: 'Thanks a regular when they reach the VIP threshold.', templateVersion: '1.0.0', ceiling: 'supervised' }),
  birthday: defineHostedAgent({ key: 'flow_birthday', name: 'Birthday flow', description: 'Sends a birthday note in the week before a guest\'s birthday.', templateVersion: '1.0.0', ceiling: 'supervised' }),
} as const;
