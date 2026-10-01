export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { website } from '@ros/modules';
import { requestHost, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { getSite } from '@/lib/site';

/** robots.txt for the host it was asked on: only a live org's primary host is indexable. */
export const GET = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const site = await getSite((await params).host);
  const rules = await app().tenant(site.orgId, { kind: 'anon' }, (ctx) => website.getRobots(ctx, { venueId: site.venueId, host: requestHost(req) || site.host }));
  return new NextResponse(website.robotsTxt(rules), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
});
