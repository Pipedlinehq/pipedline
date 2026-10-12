import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

export const identityModule = defineModule({
  key: 'identity',
  name: 'Guests',
  description: 'Customers, the ways a customer is recognised, merges, consents, and the write-once acquisition stamp.',
  spine: true,
  dependsOn: [],
  manifest: {
    name: 'Guests',
    purpose: 'One record per guest however they reach the venue (online order, booking, loyalty, the till), with the consents they have given and where they first came from.',
    category: 'guests',
    kind: 'module',
    needs: ['Nothing: it is part of every venue.'],
    reads: ['guest records', 'consents'],
    writes: ['guest records', 'consents', 'merges of duplicate records'],
    consent: 'Consent is given by the guest, never ticked by staff. A guest can ask for everything held about them, or for it to be erased.',
  },
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
