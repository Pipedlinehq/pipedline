import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/** Onboarding is platform work with no per-venue settings. */
export const onboardingConfig = z.object({});
export type OnboardingConfig = z.infer<typeof onboardingConfig>;

export const onboardingModule = defineModule({
  key: 'onboarding',
  name: 'Onboarding',
  description: 'Intake, automated provisioning, menu import, go-live checks, tenant health.',
  spine: true,
  dependsOn: ['tenancy'],
  tables: ['onboardings', 'provisioning_steps', 'onboarding_touches', 'menu_imports', 'support_access'],
  configSchema: onboardingConfig,
  configVersion: 1,
  defaultConfig: onboardingConfig.parse({}),
});

export const orgProvisioned = defineEvent({
  name: 'org.provisioned',
  module: 'onboarding',
  description: 'Automated provisioning finished everything it can do for a new org; what remains waits on the venue or on go-live.',
  properties: z.object({ onboarding_id: z.string(), steps_done: z.number().int(), steps_blocked: z.number().int() }),
});

export const orgWentLive = defineEvent({
  name: 'org.went_live',
  module: 'onboarding',
  description: 'The go-live checklist passed and the org and its venues were switched to live.',
  properties: z.object({
    onboarding_id: z.string(),
    /** Hours from "sold" to live: the number docs/ONBOARDING.md says decides whether this business works. */
    hours_to_live: z.number(),
    manual_touch_minutes: z.number().int(),
  }),
});

export const orgClosed = defineEvent({
  name: 'org.closed',
  module: 'onboarding',
  description: 'The org left the platform: its custom domains were removed and its connections revoked.',
  properties: z.object({ domains_removed: z.number().int(), connections_revoked: z.number().int() }),
});
