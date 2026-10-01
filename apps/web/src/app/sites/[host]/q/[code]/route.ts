import { NextResponse } from 'next/server';
import { isAppError } from '@ros/core';
import { qr, tenancy } from '@ros/modules';
import { VISITOR_COOKIE } from '@/lib/cookies';
import { clientIp, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { siteActor } from '@/lib/site-api';
import { scopedHref } from '@/lib/site-scope';
import { TABLE_COOKIE, TABLE_COOKIE_HOURS, encodeTable, tableFromResolution } from '@/lib/site-table';

/**
 * A guest scanned a printed code: https://<host>/q/<code>. The qr module resolves it (counting
 * the scan, starting or refreshing the visitor session, recording qr.scanned); we keep the
 * session it returns, remember the table for the menu and order pages, and send the guest on.
 */
export const GET = route(async (req, { params }: { params: Promise<{ host: string; code: string }> }) => {
  const { host, code } = await params;
  const actor = await siteActor(req, host);
  const ua = req.headers.get('user-agent') ?? '';
  const deviceClass = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  let resolved: { r: qr.QrResolution; path: string };
  try {
    resolved = await app().tenant(
      actor.site.orgId,
      actor.principal,
      async (ctx) => {
        const r = await qr.resolveQrCode(ctx, { code: decodeURIComponent(code), sessionId: actor.visitorSessionId, referrer: req.headers.get('referer'), deviceClass });
        // On a group's own host, a venue's pages live under /at/<venue>.
        let base = '';
        if (!actor.site.venueId && (await tenancy.listPublicVenues(ctx)).length > 1) base = `/at/${(await tenancy.getVenue(ctx, r.venueId)).slug}`;
        const target = r.campaign?.offerId ? `/offer/${r.campaign.offerId}` : r.targetPath || '/menu';
        return { r, path: scopedHref(base, target) };
      },
      { ip: clientIp(req) },
    );
  } catch (e) {
    if (isAppError(e) && (e.code === 'not_found' || e.code === 'module_disabled' || e.code === 'invalid')) {
      return new NextResponse('That code was not found. Ask our staff for a menu.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    throw e;
  }

  const { r, path } = resolved;
  const res = new NextResponse(null, { status: 303, headers: { location: path, 'cache-control': 'no-store' } });
  const secure = app().config.scheme === 'https';
  // The session the qr module used, so the scan, the menu view and any order share one visit.
  res.cookies.set(VISITOR_COOKIE, r.sessionId, { sameSite: 'lax', path: '/', maxAge: 30 * 86_400, secure });
  if (r.kind !== 'campaign') {
    res.cookies.set(TABLE_COOKIE, encodeTable(tableFromResolution(r)), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: TABLE_COOKIE_HOURS * 3600, secure });
  }
  return res;
});
