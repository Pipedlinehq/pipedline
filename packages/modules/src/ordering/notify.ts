import type { Ctx } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import type { OrderRow } from './rows';

type GuestTemplate = 'order.confirmed' | 'order.ready' | 'order.cancelled' | 'order.refunded' | 'order.nudge' | 'order.pay_link';

/** The venue's primary verified host, or the platform's. */
async function siteHost(ctx: Ctx, venueId: string): Promise<string> {
  const hosts = await ctx.db
    .selectFrom('domains')
    .select(['host', 'venue_id'])
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .where((eb) => eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]))
    .execute();
  return hosts.find((h) => h.venue_id === venueId)?.host ?? hosts[0]?.host ?? ctx.app.config.platformHost;
}

/**
 * The link in a confirmation and in a pay link: the venue's own site, with the order's
 * unguessable token. The site serves it at /order/t/<token> (components/site/order-pages.tsx):
 * tracking, and the pay panel while the order waits for payment.
 */
export async function trackingUrl(ctx: Ctx, order: Pick<OrderRow, 'venue_id' | 'tracking_token'>): Promise<string> {
  return `${ctx.app.config.scheme}://${await siteHost(ctx, order.venue_id)}/order/t/${order.tracking_token ?? ''}`;
}

/** The venue's order page, for a guest starting again. */
export async function orderPageUrl(ctx: Ctx, venueId: string): Promise<string> {
  return `${ctx.app.config.scheme}://${await siteHost(ctx, venueId)}/order`;
}

/**
 * Queue a transactional message to whoever placed the order: by email if they gave one, by SMS
 * if they gave only a phone number, and not at all if they gave neither. One message per order
 * per `what`, however many times this is reached. Returns what the outbox did, or null when
 * there was no one to write to.
 */
export async function notifyGuest(ctx: Ctx, order: OrderRow, templateKey: GuestTemplate, variables: Record<string, unknown>, what: string): Promise<{ messageId: string; status: 'queued' | 'suppressed'; reason?: string; via: 'email' | 'sms' } | null> {
  const channel = order.customer_email ? 'email' : order.customer_phone ? 'sms' : null;
  if (!channel) return null;
  const r = await queueMessage(ctx, {
    templateKey,
    channel,
    idempotencyKey: `order:${order.id}:${what}`,
    variables,
    customerId: order.customer_id,
    to: channel === 'email' ? order.customer_email : order.customer_phone,
    venueId: order.venue_id,
  });
  return { ...r, via: channel };
}
