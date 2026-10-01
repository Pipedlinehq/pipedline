import { cookies } from 'next/headers';
import { rateLimit } from '@ros/core';
import { events } from '@ros/modules';
import { clientIp, readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { getSite, getVisitor } from '@/lib/site';
import { VISITOR_COOKIE } from '@/lib/cookies';

/**
 * Start or refresh the visitor's first-party session. The browser sends where it landed and
 * any campaign parameters; the server decides the session id and everything else.
 */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const site = await getSite((await params).host);
  const ip = clientIp(req) ?? 'unknown';
  await rateLimit(app(), `session:${site.orgId}:${ip}`, { limit: 120, windowSeconds: 60 });
  const body = await readJson<Record<string, unknown>>(req);
  const jar = await cookies();
  let sessionId = jar.get(VISITOR_COOKIE)?.value ?? null;
  if (!sessionId || !/^[0-9a-f-]{36}$/.test(sessionId)) sessionId = crypto.randomUUID();
  const str = (k: string, max: number) => (typeof body[k] === 'string' && (body[k] as string).length <= max ? (body[k] as string) : null);

  const { principal } = await getVisitor(site.orgId);
  const result = await app().tenant(
    site.orgId,
    principal,
    (ctx) =>
      events.touchSession(ctx, {
        sessionId: sessionId!,
        venueId: site.venueId,
        landingPath: str('path', 500) ?? '/',
        referrer: str('referrer', 1000),
        utmSource: str('utm_source', 100),
        utmMedium: str('utm_medium', 100),
        utmCampaign: str('utm_campaign', 200),
        utmContent: str('utm_content', 200),
        creatorId: str('creator', 100),
        campaignId: str('campaign', 100),
        code: str('code', 60),
        deviceClass: ['mobile', 'tablet', 'desktop'].includes(String(body.device)) ? (body.device as 'mobile' | 'tablet' | 'desktop') : null,
      }),
    { ip },
  );
  // Host-only and readable by the page's own script: it is an analytics id, not a login.
  jar.set(VISITOR_COOKIE, sessionId, { sameSite: 'lax', path: '/', maxAge: 30 * 86_400, secure: app().config.scheme === 'https' });
  return { sessionId, created: result.created };
});
