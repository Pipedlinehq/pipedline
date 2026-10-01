import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { asDevice } from '@/lib/ops-device';

export const dynamic = 'force-dynamic';

/**
 * POST /kitchen/api/events { events: [{ ticketId, event, key, occurredAt }] }: taps from the
 * screen, live or replayed after an outage. Each carries its own idempotency key, so sending
 * the same batch twice records each tap once. Answers per key.
 */
export const POST = route(async (req) => {
  const body = await readJson<{ events?: unknown }>(req);
  const results = await asDevice(req, (ctx) => ordering.recordTicketEvents(ctx, { events: body.events as never }));
  return { results };
});
