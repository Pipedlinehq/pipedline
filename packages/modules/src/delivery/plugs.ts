import { definePlug } from '@ros/core';

/**
 * The courier plugs (docs/modules/delivery.md part A). A connection belongs to the org or to one
 * venue; the venue lists the plugs it uses, preferred first, in `providers`.
 *
 * What a courier connection holds (sealed in the secret store, never on the row):
 *   Uber Direct      credentials.clientId, clientSecret, webhookSecret (the webhook signing key);
 *                    externalAccountId = the Direct customer id
 *   DoorDash Drive   credentials.developerId, keyId, signingSecret, webhookSecret (the exact
 *                    Authorization header value configured for the webhook endpoint)
 *   config.environment 'sandbox' | 'production'; config.webhookUrl pins the signed URL behind a proxy
 */
export const uberDirectPlug = definePlug({
  key: 'uber-direct',
  name: 'Uber Direct',
  description: 'Uber couriers for orders placed on the venue\'s own site. Quotes, dispatch, tracking and proof of delivery.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { courier: 'uber-direct' },
  auth: 'api_key',
  scopes: ['eats.deliveries'],
  venueScoped: false,
});

export const doordashDrivePlug = definePlug({
  key: 'doordash-drive',
  name: 'DoorDash Drive',
  description: 'DoorDash couriers for orders placed on the venue\'s own site. Quotes, dispatch, tracking and proof of delivery.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { courier: 'doordash-drive' },
  auth: 'api_key',
  scopes: ['drive'],
  venueScoped: false,
});
