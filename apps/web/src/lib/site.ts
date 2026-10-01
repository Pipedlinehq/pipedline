import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import type { Ctx, Principal } from '@ros/core';
import { auth, tenancy } from '@ros/modules';
import { app } from './runtime';
import { GUEST_COOKIE, VISITOR_COOKIE, readCookie } from './cookies';

export interface Site {
  orgId: string;
  /** Set when this host is one venue's own site. */
  venueId: string | null;
  host: string;
  primaryHost: string;
}

/** Host → site. 404 when the host is unknown, unverified, or the org is closed. */
export const getSite = cache(async (rawHost: string): Promise<Site> => {
  const host = decodeURIComponent(rawHost);
  const resolved = await tenancy.resolveHost(app(), host);
  if (!resolved || resolved.orgStatus === 'closed') notFound();
  return { orgId: resolved.orgId, venueId: resolved.venueId, host: resolved.host, primaryHost: resolved.primaryHost };
});

/** Who the visitor is on this site: a signed-in guest of THIS org, or an anonymous visitor. */
export const getVisitor = cache(async (orgId: string): Promise<{ principal: Principal; visitorSessionId: string | null; customerId: string | null }> => {
  const visitorSessionId = await readCookie(VISITOR_COOKIE);
  const token = await readCookie(GUEST_COOKIE);
  if (token) {
    const who = await auth.authenticate(app(), token);
    // A guest session is only good at the org that issued it.
    if (who && who.orgId === orgId && who.principal.kind === 'guest') {
      return { principal: who.principal, visitorSessionId, customerId: who.principal.customerId };
    }
  }
  return { principal: { kind: 'anon', sessionId: visitorSessionId ?? undefined }, visitorSessionId, customerId: null };
});

/** Run a service function as the current visitor of a venue's site. */
export async function onSite<T>(host: string, fn: (ctx: Ctx, site: Site) => Promise<T>): Promise<T> {
  const site = await getSite(host);
  const { principal } = await getVisitor(site.orgId);
  const h = await headers();
  return app().tenant(site.orgId, principal, (ctx) => fn(ctx, site), { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() });
}

/**
 * A read that is the same for every visitor of a site (a published page), run as an anonymous
 * visitor of the org the host resolved to. It takes nothing from the request (no cookie, no
 * address), so its result may be cached per tenant. Anything that depends on who is asking goes
 * through onSite instead.
 */
export function onSitePublic<T>(site: Site, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return app().tenant(site.orgId, { kind: 'anon' }, fn);
}

/** The venue a site request is about: the host's own venue, else the org's first public venue. */
export async function siteVenueId(ctx: Ctx, site: Site, slug?: string | null): Promise<string> {
  if (site.venueId) return site.venueId;
  if (slug) return (await tenancy.getVenueBySlug(ctx, slug)).id;
  const venues = await tenancy.listPublicVenues(ctx);
  if (!venues.length) notFound();
  return venues[0]!.id;
}
