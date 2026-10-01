import { cookies } from 'next/headers';
import { rateLimit } from '@ros/core';
import { events } from '@ros/modules';
import { clientIp, readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { getSite, getVisitor } from '@/lib/site';
import { VISITOR_COOKIE } from '@/lib/cookies';

/** The analytics beacon. Only events declared browser-sendable are stored; the rest are dropped. */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const site = await getSite((await params).host);
  const ip = clientIp(req) ?? 'unknown';
  await rateLimit(app(), `collect:${site.orgId}:${ip}`, { limit: 240, windowSeconds: 60 });
  const sessionId = (await cookies()).get(VISITOR_COOKIE)?.value;
  if (!sessionId) return { accepted: 0, dropped: 0 };
  const body = await readJson<{ events?: unknown }>(req);
  const { principal } = await getVisitor(site.orgId);
  return app().tenant(site.orgId, principal, (ctx) => events.collect(ctx, { sessionId, venueId: site.venueId, events: body.events as never }), { ip });
});
