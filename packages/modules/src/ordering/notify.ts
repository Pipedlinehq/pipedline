import type { Ctx } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import type { OrderRow } from './rows';

type GuestTemplate = 'order.confirmed' | 'order.ready' | 'order.cancelled' | 'order.refunded';

/** The link in a confirmation: the venue's own site, with the order's unguessable token. */
export async function trackingUrl(ctx: Ctx, order: Pick<OrderRow, 'venue_id' | 'tracking_token'>): Promise<string> {
  const hosts = await ctx.db
    .selectFrom('domains')
    .select(['host', 'venue_id'])
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .where((eb) => eb.or([eb('venue_id', '=', order.venue_id), eb('venue_id', 'is', null)]))
    .execute();
  const host = hosts.find((h) => h.venue_id === order.venue_id)?.host ?? hosts[0]?.host ?? ctx.app.config.platformHost;
  return `${ctx.app.config.scheme}://${host}/order/${order.tracking_token ?? ''}`;
}

/**
 * Queue a transactional message to whoever placed the order: by email if they gave one, by SMS
 * if they gave only a phone number, and not at all if they gave neither. One message per order
 * per `what`, however many times this is reached.
 */
export async function notifyGuest(ctx: Ctx, order: OrderRow, templateKey: GuestTemplate, variables: Record<string, unknown>, what: string): Promise<void> {
  const channel = order.customer_email ? 'email' : order.customer_phone ? 'sms' : null;
  if (!channel) return;
  await queueMessage(ctx, {
    templateKey,
    channel,
    idempotencyKey: `order:${order.id}:${what}`,
    variables,
    customerId: order.customer_id,
    to: channel === 'email' ? order.customer_email : order.customer_phone,
    venueId: order.venue_id,
  });
}
