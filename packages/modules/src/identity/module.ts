import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

export const identityModule = defineModule({
  key: 'identity',
  name: 'Identity',
  description: 'Customers, the ways a customer is recognised, merges, consents, and the write-once acquisition stamp.',
  spine: true,
  dependsOn: [],
  tables: ['customers', 'customer_identities', 'customer_merges', 'customer_touchpoints', 'consents', 'consent_events', 'consent_wordings'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

export const customerCreated = defineEvent({
  name: 'customer.created',
  module: 'identity',
  description: 'A new customer record was created. Carries where they came from; never their contact details.',
  properties: z.object({
    acquisition_source: z.string(),
    via: z.string().describe('The surface that created the record: online-order, pos, loyalty, guest_login, import …'),
  }),
});

export const customerMerged = defineEvent({
  name: 'customer.merged',
  module: 'identity',
  description: 'Two customer records were found to be the same person and merged.',
  properties: z.object({ loser_customer_id: z.string(), reason: z.string() }),
});

export const consentChanged = defineEvent({
  name: 'consent.changed',
  module: 'identity',
  description: 'A guest granted or withdrew a consent.',
  properties: z.object({ purpose: z.string(), action: z.enum(['granted', 'revoked']), source: z.string() }),
});
