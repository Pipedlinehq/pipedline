import { delivery } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { pick, siteActor } from '@/lib/site-api';

/**
 * Is this address delivered to, and for how much (delivery.quoteDelivery)? The answer is a saved
 * quote whose id goes into the cart; the fee the guest pays is worked out again by the server
 * from its own price of the cart when the order is made.
 */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const body = await readJson<Record<string, unknown>>(req);
  const input = pick(body, ['venueId', 'address', 'notes', 'subtotalCents', 'containsAlcohol', 'readyAt'] as const);
  return delivery.quoteDelivery(app(), { orgId: actor.site.orgId, principal: actor.principal, ip: actor.ip }, input as never);
});
