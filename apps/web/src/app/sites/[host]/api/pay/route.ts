import { isAppError } from '@ros/core';
import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { siteActor } from '@/lib/site-api';

/**
 * Checkout, step two (ordering.payOrder). The body carries the order's tracking token and the
 * single-use token from the card fields, never a card number. The outcome is an answer, not an
 * error: paid, declined (try another card), or retry (the processor did not answer; the same
 * card again is charged at most once).
 */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const body = await readJson<{ trackingToken?: unknown; sourceToken?: unknown }>(req);
  try {
    const r = await ordering.payOrder(app(), { orgId: actor.site.orgId, principal: actor.principal, ip: actor.ip }, { trackingToken: String(body.trackingToken ?? ''), sourceToken: typeof body.sourceToken === 'string' ? body.sourceToken : undefined });
    if (r.status === 'declined') return { status: 'declined' as const, message: r.message };
    return { status: 'paid' as const, trackingToken: r.order.trackingToken, reference: r.order.reference };
  } catch (e) {
    if (isAppError(e) && e.code === 'provider_error') {
      return { status: 'retry' as const, message: 'We could not get an answer from the card processor. Try again with the same card: you will not be charged twice.' };
    }
    throw e;
  }
});
