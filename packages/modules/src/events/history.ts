import { z } from 'zod';
import { type Ctx, requireStaff, sql } from '@ros/core';

/**
 * One record's own events from the activity stream, for the timeline on its page (docs/CONSOLE_IA.md
 * section 9, wave 1). An order's events carry `order_id` in their properties and a booking's
 * `booking_id`; a guest's carry `customer_id` on the row. Newest first. Any staff role at the
 * venue; the page has already shown them the record through its own service.
 */
export const listEntityEventsInput = z
  .object({
    venueId: z.string().uuid(),
    entityType: z.enum(['order', 'booking', 'customer']),
    entityId: z.string().uuid(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

export interface EntityEventView {
  id: string;
  name: string;
  occurredAt: Date;
  source: string;
  properties: Record<string, unknown>;
}

export async function listEntityEvents(ctx: Ctx, raw: z.input<typeof listEntityEventsInput>): Promise<EntityEventView[]> {
  const input = listEntityEventsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  let q = ctx.db.selectFrom('events').select(['id', 'name', 'occurred_at', 'source', 'properties']).orderBy('occurred_at', 'desc').orderBy('id', 'desc').limit(input.limit);
  if (input.entityType === 'customer') q = q.where('customer_id', '=', input.entityId);
  else q = q.where(sql<string>`properties->>${input.entityType === 'order' ? 'order_id' : 'booking_id'}`, '=', input.entityId);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    occurredAt: r.occurred_at,
    source: r.source,
    properties: (r.properties && typeof r.properties === 'object' && !Array.isArray(r.properties) ? r.properties : {}) as Record<string, unknown>,
  }));
}
