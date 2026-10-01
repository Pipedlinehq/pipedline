export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { tenancy, website } from '@ros/modules';
import { route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { getSite } from '@/lib/site';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The sitemap of this host: its published pages at the canonical address, plus, on a group's
 * org-level host, each venue's own pages under /at/<venue>.
 */
export const GET = route(async (_req, { params }: { params: Promise<{ host: string }> }) => {
  const site = await getSite((await params).host);
  const entries = await app().tenant(site.orgId, { kind: 'anon' }, async (ctx) => {
    const own = await website.getSitemap(ctx, { venueId: site.venueId });
    if (site.venueId) return own;
    const venues = await tenancy.listPublicVenues(ctx);
    if (venues.length < 2) return own;
    const more: website.SitemapEntry[] = [];
    for (const v of venues) {
      try {
        for (const e of await website.getSitemap(ctx, { venueId: v.id })) {
          const path = `/at/${v.slug}${e.path === '/' ? '' : e.path}`;
          more.push({ ...e, path, loc: `${new URL(e.loc).origin}${path}`, priority: Math.max(0.1, e.priority - 0.1) });
        }
      } catch {
        // The website is off at this venue: it has no pages to list.
      }
    }
    return [...own, ...more.filter((m) => !own.some((o) => o.loc === m.loc))];
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `  <url><loc>${esc(e.loc)}</loc>${e.lastModified ? `<lastmod>${e.lastModified.toISOString()}</lastmod>` : ''}<priority>${e.priority.toFixed(1)}</priority></url>`)
    .join('\n')}\n</urlset>\n`;
  return new NextResponse(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
});
