import { NextResponse } from 'next/server';
import { AppError } from '@ros/core';
import { identity } from '@ros/modules';
import { route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { siteActor } from '@/lib/site-api';

/** "Download my data": everything held about the signed-in guest at this venue, as a JSON file. */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  if (!actor.customerId) throw new AppError('unauthenticated', 'Sign in to download your data.');
  const customerId = actor.customerId;
  const data = await app().tenant(actor.site.orgId, actor.principal, (ctx) => identity.exportCustomer(ctx, customerId), { ip: actor.ip });
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="my-data-${actor.site.host.replace(/[^a-z0-9.-]/g, '')}.json"`,
      'cache-control': 'no-store',
    },
  });
});
