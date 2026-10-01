import { z } from 'zod';
import { assertModule, defineTool, formatMoney, localParts, requireStaff } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { deliveryModule } from './module';
import { IN_FLIGHT } from './rows';

/**
 * How delivery is going at a venue: what is on the road now, what went wrong lately, and what
 * couriers cost against what guests paid. Read only; no addresses, no guest names.
 */
export const deliveriesSummaryTool = defineTool({
  name: 'deliveries_summary',
  module: 'delivery',
  title: 'Deliveries',
  description:
    'First-party deliveries at the venue: those on the road now with their courier status and expected arrival, how many were delivered or failed over the period, and courier fees against the delivery fees guests paid.',
  effect: 'read',
  scope: 'orders:read',
  venueScoped: true,
  input: z.object({ days: z.number().int().min(1).max(90).default(7).describe('How many days back the totals cover') }),
  output: z.object({
    on_the_road: z.array(z.object({ delivery_id: z.string(), status: z.string(), provider: z.string(), expected_at: z.string().nullable(), area: z.string() })),
    period_days: z.number().int(),
    delivered: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
    courier_fees: z.string(),
    guest_fees: z.string(),
    cancellation_fees: z.string(),
    average_minutes_to_deliver: z.number().int().nullable(),
    recent_problems: z.array(z.object({ delivery_id: z.string(), status: z.string(), reason: z.string().nullable(), at: z.string() })),
  }),
  async run({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    requireStaff(ctx, { venueId: venue.id, minRole: 'read_only' });
    await assertModule(ctx, venue.id, deliveryModule);
    const org = await getOrg(ctx);
    const since = new Date(ctx.now().getTime() - input.days * 86_400_000);
    const local = (d: Date | null) => (d ? `${localParts(d, venue.timezone).date} ${localParts(d, venue.timezone).time.slice(0, 5)}` : null);
    const live = await ctx.db.selectFrom('deliveries').selectAll().where('venue_id', '=', venue.id).where('status', 'in', IN_FLIGHT).orderBy('dropoff_eta').limit(50).execute();
    const period = await ctx.db.selectFrom('deliveries').selectAll().where('venue_id', '=', venue.id).where('order_id', 'is not', null).where('created_at', '>=', since).execute();
    const done = period.filter((d) => d.status === 'delivered');
    const minutes = done.filter((d) => d.requested_at && d.delivered_at).map((d) => (d.delivered_at!.getTime() - d.requested_at!.getTime()) / 60_000);
    const booked = period.filter((d) => d.requested_at);
    const sum = (f: (d: (typeof period)[number]) => number, rows = period) => rows.reduce((s, d) => s + f(d), 0);
    const area = (a: unknown) => {
      const x = (a ?? {}) as { suburb?: string };
      return x.suburb ?? '';
    };
    return {
      on_the_road: live.map((d) => ({ delivery_id: d.id, status: d.status, provider: d.provider, expected_at: local(d.dropoff_eta), area: area(d.dropoff_address) })),
      period_days: input.days,
      delivered: done.length,
      failed: period.filter((d) => d.status === 'failed' || d.status === 'returned').length,
      cancelled: period.filter((d) => d.status === 'cancelled').length,
      courier_fees: formatMoney(sum((d) => d.courier_fee_cents, booked), org.currency),
      guest_fees: formatMoney(sum((d) => d.customer_fee_cents), org.currency),
      cancellation_fees: formatMoney(sum((d) => d.cancellation_fee_cents), org.currency),
      average_minutes_to_deliver: minutes.length ? Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length) : null,
      recent_problems: period
        .filter((d) => d.status === 'failed' || d.status === 'returned' || d.status === 'cancelled')
        .slice(0, 10)
        .map((d) => ({ delivery_id: d.id, status: d.status, reason: d.failure_reason, at: local(d.updated_at)! })),
    };
  },
});
