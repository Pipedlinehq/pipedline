import { delivery } from '@ros/modules';
import { webhookRoute } from '@/lib/ops-webhooks';

export const dynamic = 'force-dynamic';

/**
 * POST /webhooks/couriers/<plug>: a courier service says a delivery moved (e.g.
 * /webhooks/couriers/uber-direct, /webhooks/couriers/sim-courier-a). The plug comes from the
 * path. delivery.handleCourierWebhook verifies the signature on the raw body with the
 * delivery's own connection secret, claims the event, and re-fetches the delivery from the
 * courier before recording anything.
 */
export const POST = webhookRoute('couriers', 'plug', (app, call) => delivery.handleCourierWebhook(app, { plugKey: call.key, rawBody: call.rawBody, headers: call.headers, url: call.url }));
