import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { type Ctx, isAppError } from '@ros/core';
import { tenancy, website } from '@ros/modules';
import { type Site, getVisitor, onSite } from './site';

/**
 * The scope a venue-site page renders in: which org (from the host), which venue's menu and
 * ordering it is about, and which pages, brand and navigation apply.
 *
 *   - a venue's own host:         the venue, its pages and brand
 *   - a single-venue org's host:  the org's pages, the only venue's menu
 *   - a group's org-level host:   the org's pages and a venue picker; /at/<venue>/… is one
 *                                 venue's pages, menu and brand (with its override) on the same host
 *
 * The org never comes from anything the browser sends: only the host and a venue slug looked
 * up inside that org.
 */
export interface SiteScope {
  host: string;
  site: Site;
  view: website.SiteView;
  /** The venue whose menu, hours and ordering this scope serves. Null on a group's org-level pages. */
  venue: tenancy.VenueView | null;
  /** '' at the host root, '/at/<slug>' for one venue on a group's org-level site. */
  basePath: string;
  /** The venue whose own pages this scope reads (null = the org-level pages). */
  pagesVenueId: string | null;
  /** Whether the scope's venue is trading at this moment (by the app clock). Null without a venue. */
  openNow: boolean | null;
  /** The app clock's time, ISO. Server-rendered so a moved clock (tests, fixtures) is respected. */
  now: string;
  signedIn: boolean;
}

/** A service error that means "there is nothing here" becomes the page's 404. */
export function notFoundOnMissing(e: unknown): never {
  if (isAppError(e) && (e.code === 'not_found' || e.code === 'module_disabled')) notFound();
  throw e;
}

/** Run a service function as the site's visitor, turning not-found and module-off into a 404. */
export async function siteCall<T>(host: string, fn: (ctx: Ctx, site: Site) => Promise<T>): Promise<T> {
  try {
    return await onSite(host, fn);
  } catch (e) {
    return notFoundOnMissing(e);
  }
}

/** Run a service function and give null (rather than a 404) when its module is off or the thing is missing. */
export async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isAppError(e) && (e.code === 'not_found' || e.code === 'module_disabled')) return null;
    throw e;
  }
}

export const loadScope = cache(async (rawHost: string, venueSlug: string | null = null): Promise<SiteScope> => {
  const host = decodeURIComponent(rawHost);
  return siteCall(host, async (ctx, site) => {
    let venueId = site.venueId;
    if (venueSlug !== null) {
      // /at/<venue> exists only on an org-level host, and only for this org's public venues.
      if (site.venueId || !/^[a-z0-9-]{1,60}$/.test(venueSlug)) notFound();
      venueId = (await tenancy.getVenueBySlug(ctx, venueSlug)).id;
    }
    const view = await website.getSite(ctx, { venueId });
    if (venueId && !view.venues.some((v) => v.id === venueId) && !site.venueId) notFound();
    const venue = view.venue;
    const now = ctx.now();
    const openNow = venue ? await tenancy.isOpenAt(ctx, venue.id, now) : null;
    const { customerId } = await getVisitor(site.orgId);
    return {
      host,
      site,
      view,
      venue,
      basePath: venueSlug ? `/at/${venueSlug}` : '',
      pagesVenueId: venueId,
      openNow,
      now: now.toISOString(),
      signedIn: customerId !== null,
    };
  });
});

/** Paths that belong to the whole org, not to one venue: never prefixed with /at/<venue>. */
const ORG_WIDE = /^\/(account|claim|offer|q|u|api)(\/|$|\?|#)|^\/order\/t\//;

/** A link inside a scope: /menu on a group's venue pages is /at/<venue>/menu. Off-site links pass through. */
export function scopedHref(basePath: string, href: string): string {
  if (!basePath || !href.startsWith('/') || href.startsWith('//') || ORG_WIDE.test(href)) return href;
  if (href === '/') return basePath;
  if (href.startsWith('/#')) return `${basePath}${href.slice(1)}`;
  return `${basePath}${href}`;
}

/** The absolute canonical address of a path in a scope. */
export function canonicalUrl(scope: SiteScope, path: string): string {
  return `${scope.view.canonicalBase}${scopedHref(scope.basePath, path)}`;
}
