import { ordering } from '@ros/modules';
import { route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { siteActor } from '@/lib/site-api';

/** Pickup times with room: ASAP and the scheduled slots (ordering.getPickupSlots). */
export const GET = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const q = new URL(req.url).searchParams;
  const num = (k: string) => (q.get(k) === null ? undefined : Number(q.get(k)));
  return app().tenant(
    actor.site.orgId,
    actor.principal,
    (ctx) => ordering.getPickupSlots(ctx, { venueId: q.get('venueId') ?? '', date: q.get('date') ?? undefined, itemCount: num('itemCount'), prepMinutes: num('prepMinutes') }),
    { ip: actor.ip },
  );
});
