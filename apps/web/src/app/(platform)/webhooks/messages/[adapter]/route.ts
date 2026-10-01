import { notFound as notFoundError } from '@ros/core';
import { comms } from '@ros/modules';
import { webhookRoute } from '@/lib/ops-webhooks';

export const dynamic = 'force-dynamic';

/**
 * POST /webhooks/messages/<adapter>: delivery, bounce, complaint and opt-out (STOP) events from
 * an email or SMS provider (e.g. /webhooks/messages/sim-email). comms.handleMessageWebhook
 * verifies the signature on the raw body, de-duplicates by the provider's event id and applies
 * each event inside the org that sent the message: a hard bounce or a complaint suppresses the
 * address.
 */
export const POST = webhookRoute('messages', 'adapter', (app, call) => {
  if (!app.adapters.has('message', call.key)) throw notFoundError('Not found');
  return comms.handleMessageWebhook(app, { adapterKey: call.key, rawBody: call.rawBody, headers: call.headers, url: call.url });
});
