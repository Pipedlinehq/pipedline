import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { siteActor } from '@/lib/site-api';

/** The guest backs out before paying: the order is cancelled and its slot is free again. */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const body = await readJson<{ trackingToken?: unknown }>(req);
  await app().tenant(actor.site.orgId, actor.principal, (ctx) => ordering.cancelUnpaidOrder(ctx, String(body.trackingToken ?? '')), { ip: actor.ip });
  return { cancelled: true };
});
