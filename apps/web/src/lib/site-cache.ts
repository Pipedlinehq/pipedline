import 'server-only';
import { unstable_cache } from 'next/cache';
import { website } from '@ros/modules';
import { type Site, onSitePublic } from './site';
import { siteGeneration } from './site-revalidate';

/**
 * What is cached on a venue's site, and what is not.
 *
 * Cached, per tenant, by tag: the content of a published page (website.getPage). Every way that
 * content changes goes through the website module, which revalidates `org:<id>` after commit
 * (site-revalidate.ts), so a publish busts that organisation's pages and no other's, and the
 * read that follows a publish in this process is always fresh.
 *
 * Not cached, read on every request:
 *   - who the visitor is (signed-in guest, the table they scanned): cookies;
 *   - open or closed right now, today's hours and exceptions: the clock, the venue's zone;
 *   - the menu: an item is 86'd from the kitchen screen, the POS, an assistant or a timer, and a
 *     guest must never be shown a dish that has run out as available;
 *   - brand, navigation, hours and which features are on (website.getSite): changed by tenancy,
 *     the module switches and onboarding, in the worker as well as here, with no signal to this
 *     process.
 * So the page is still rendered per request; only the page content read is taken from the cache.
 *
 * The cache lives in this process (Next's default handler). A publish from another process (the
 * worker during onboarding, a second web instance) cannot reach it, so entries also expire by
 * time. A shared cache handler would remove that limit; none is configured.
 */
const TTL_SECONDS = Math.max(1, Number(process.env.ROS_SITE_CACHE_SECONDS ?? 300) || 300);
/** Nothing cached by an earlier process is trusted: the default handler also keeps entries on disk. */
const EPOCH = process.env.ROS_SITE_CACHE_EPOCH ?? `${process.pid}-${Date.now()}`;

/** A published page of a site, from the cache. A missing page, a draft and a switched-off website throw (not cached). */
export async function cachedPage(site: Site, venueId: string | null, slug: string): Promise<website.PublicPage> {
  const read = unstable_cache(
    () => onSitePublic(site, (ctx) => website.getPage(ctx, { venueId, slug })),
    // The org's generation moves on with every change to its site (site-revalidate.ts), so an
    // entry stored before a publish is never the answer after it.
    ['site-page', EPOCH, site.orgId, String(siteGeneration(site.orgId)), venueId ?? 'org', slug],
    { tags: [website.cacheTags.org(site.orgId)], revalidate: TTL_SECONDS },
  );
  const page = await read();
  // A cache hit comes back as JSON: dates are strings again.
  return { ...page, publishedAt: page.publishedAt ? new Date(page.publishedAt) : null };
}
