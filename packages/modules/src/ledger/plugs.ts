import { definePlug } from '@ros/core';

/**
 * The point-of-sale plugs. A connection to one of these belongs to a single venue and carries
 * the provider's location in `config.locationRef`; that pairing is the only thing that decides
 * which venue a sale lands in (docs/modules/pos-adapters.md).
 *
 * Credentials a POS connection holds (sealed in the secret store, never on the row):
 *   accessToken     what the adapter calls the provider with
 *   webhookSecret   what the provider signs its webhooks with
 */
export const simPosPlug = definePlug({
  key: 'sim-pos',
  name: 'Simulated POS',
  description: 'A point of sale that exists only in memory. For development, tests and the fixture venues.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { pos: 'sim-pos' },
  auth: 'none',
  scopes: ['transactions:read', 'orders:write'],
  venueScoped: true,
  simulated: true,
});

/** Scopes are Square's own OAuth permission names, so what the owner approves is what Square shows them. */
export const SQUARE_READ_SCOPES = ['MERCHANT_PROFILE_READ', 'PAYMENTS_READ', 'ORDERS_READ'];
export const SQUARE_WRITE_SCOPES = ['PAYMENTS_WRITE', 'ORDERS_WRITE'];

export const squarePlug = definePlug({
  key: 'square',
  name: 'Square',
  description: 'Sales, line items and refunds from Square, online card payments, and online orders sent to the Square POS.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { pos: 'square', payment: 'square' },
  auth: 'oauth',
  // Least scope per connection: a venue that only wants its sales read is connected with SQUARE_READ_SCOPES.
  scopes: [...SQUARE_READ_SCOPES, ...SQUARE_WRITE_SCOPES],
  venueScoped: true,
});
