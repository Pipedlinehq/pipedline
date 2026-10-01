import { ledger } from '@ros/modules';
import { webhookRoute } from '@/lib/ops-webhooks';

export const dynamic = 'force-dynamic';

/**
 * POST /webhooks/pos/<plug>: a point of sale says a sale changed (e.g. /webhooks/pos/square,
 * /webhooks/pos/sim-pos). The plug comes from the path, never the body. ledger.handlePosWebhook
 * verifies the signature with the matching connection's own secret, claims the event id so a
 * replay has no second effect, and re-fetches every sale it names from the provider.
 */
export const POST = webhookRoute('pos', 'plug', (app, call) => ledger.handlePosWebhook(app, { plugKey: call.key, rawBody: call.rawBody, headers: call.headers, url: call.url }));
