import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { cache } from 'react';
import { website } from '@ros/modules';
import { onSite } from '@/lib/site';
import { cachedPage } from '@/lib/site-cache';
import { type SiteScope, canonicalUrl, loadScope, optional, scopedHref } from '@/lib/site-scope';
import { type TableContext, readTable } from '@/lib/site-table';
import { JsonLd } from './chrome';
import { TrackOnMount } from './client-bits';
import { loadMenu, type PageLike, PageView } from './page-view';

/** The route files under app/sites/[host] (and /at/[venue]) are thin: the pages live here, once. */

export type SearchParams = Record<string, string | string[] | undefined>;

/** A published page of this scope, or null. A draft, or a page at a venue with the website off, is null. */
export const loadPage = cache(async (scope: SiteScope, rawSlug: string): Promise<website.PublicPage | null> => {
  // The module's own rule for an address, applied first so an arbitrary one never becomes a cache key.
  const slug = rawSlug.trim().toLowerCase().replace(/^\/+|\/+$/g, '') || 'home';
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  return optional(cachedPage(scope.site, scope.pagesVenueId, slug));
});

export function pageMetadata(scope: SiteScope, opts: { title?: string | null; description?: string | null; path: string; ogImage?: string | null; noindex?: boolean }): Metadata {
  const siteName = scope.basePath && scope.venue ? scope.venue.name : scope.view.org.name;
  const title = opts.title ?? siteName;
  const url = canonicalUrl(scope, opts.path);
  const verification = scope.view.config.integrations.googleSiteVerification;
  return {
    title,
    description: opts.description ?? undefined,
    alternates: { canonical: url },
    openGraph: {
      title,
      description: opts.description ?? undefined,
      url,
      siteName,
      type: 'website',
      locale: 'en_AU',
      images: opts.ogImage ? [{ url: opts.ogImage }] : undefined,
    },
    robots: opts.noindex ? { index: false, follow: false } : undefined,
    verification: verification ? { google: verification } : undefined,
  };
}

function titleFor(scope: SiteScope, page: website.PublicPage): string {
  const siteName = scope.basePath && scope.venue ? scope.venue.name : scope.view.org.name;
  if (page.seo.title) return page.seo.title;
  return page.slug === 'home' ? siteName : `${page.title} | ${siteName}`;
}

export function dietFrom(sp: SearchParams): string[] {
  const raw = sp.diet;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return [...new Set(list.map((d) => d.toLowerCase().slice(0, 30)).filter((d) => /^[a-z0-9_-]+$/.test(d)))].slice(0, 8);
}

// ── Home ────────────────────────────────────────────────────────────────────

export async function homeMetadata(host: string, venueSlug: string | null): Promise<Metadata> {
  const scope = await loadScope(host, venueSlug);
  const page = await loadPage(scope, 'home');
  return pageMetadata(scope, { title: page ? titleFor(scope, page) : null, description: page?.seo.description, path: '/', ogImage: page?.seo.ogImageUrl });
}

export async function HomeRoute({ host, venueSlug, searchParams }: { host: string; venueSlug: string | null; searchParams: SearchParams }) {
  const scope = await loadScope(host, venueSlug);
  const page = await loadPage(scope, 'home');
  const fallback: PageLike = { slug: 'home', title: scope.view.org.name, blocks: [] };
  return (
    <>
      <PageView scope={scope} page={page ?? fallback} diet={dietFrom(searchParams)} path={scopedHref(scope.basePath, '/')} table={null} />
      {!scope.venue ? (
        <section aria-labelledby="locations-h" className="mx-auto max-w-6xl px-4 py-[var(--s-section)] sm:px-6">
          <h2 id="locations-h" className="s-heading mb-6">
            Choose a location
          </h2>
          <ul className="grid gap-4 md:grid-cols-3">
            {scope.view.venues.map((v) => (
              <li key={v.id}>
                <Link href={`/at/${v.slug}`} className="s-card flex h-full flex-col gap-2 p-6 no-underline hover:border-[var(--brand-color-text)]">
                  <span className="s-heading text-2xl">{v.name}</span>
                  <span>{[v.addressLine1, v.suburb].filter(Boolean).join(', ')}</span>
                  <span className="s-link mt-auto pt-3 font-semibold">Menu, hours and ordering</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

// ── Content pages and old addresses ─────────────────────────────────────────

export async function contentMetadata(host: string, venueSlug: string | null, path: string[]): Promise<Metadata> {
  if (path.length !== 1) return {};
  const scope = await loadScope(host, venueSlug);
  const page = await loadPage(scope, path[0]!);
  if (!page) return {};
  return pageMetadata(scope, { title: titleFor(scope, page), description: page.seo.description, path: `/${page.slug}`, ogImage: page.seo.ogImageUrl });
}

export async function ContentRoute({ host, venueSlug, path, searchParams }: { host: string; venueSlug: string | null; path: string[]; searchParams: SearchParams }) {
  const scope = await loadScope(host, venueSlug);
  const slug = path.length === 1 ? decodeURIComponent(path[0]!) : null;
  const page = slug && slug !== 'home' ? await loadPage(scope, slug) : null;
  if (page) {
    return <PageView scope={scope} page={page} diet={dietFrom(searchParams)} path={scopedHref(scope.basePath, `/${page.slug}`)} table={null} />;
  }
  // No page here: an address from the venue's old site may have moved (the redirect map), else 404.
  const oldPath = `${scope.basePath ? '' : ''}/${path.map((p) => decodeURIComponent(p)).join('/')}`;
  const moved = scope.basePath ? null : await optional(onSite(scope.host, (ctx) => website.resolveRedirect(ctx, { path: oldPath })));
  if (moved) {
    if (moved.statusCode === 301 || moved.statusCode === 308) permanentRedirect(moved.to);
    redirect(moved.to);
  }
  notFound();
}

// ── The menu ────────────────────────────────────────────────────────────────

export async function menuMetadata(host: string, venueSlug: string | null): Promise<Metadata> {
  const scope = await loadScope(host, venueSlug);
  const page = await loadPage(scope, 'menu');
  const name = scope.venue?.name ?? scope.view.org.name;
  return pageMetadata(scope, { title: page ? titleFor(scope, page) : `Menu | ${name}`, description: page?.seo.description ?? `The menu at ${name}: dishes, prices, dietary options and allergens.`, path: '/menu' });
}

export function TableBanner({ table, scope }: { table: TableContext; scope: SiteScope }) {
  const where = table.label ? `${table.kind === 'counter' ? '' : 'Table '}${table.label}${table.area ? `, ${table.area}` : ''}` : null;
  return (
    <div className="s-primary-bg" role="region" aria-label="Your table">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <p className="font-semibold" data-table-label={table.label ?? ''}>
          {where ? `You are at ${where}.` : 'You are viewing our in-venue menu.'}{' '}
          <span className="font-normal">{table.canOrder ? 'Order and pay from your phone; we bring it to you.' : 'Ask our staff when you are ready to order.'}</span>
        </p>
        {table.canOrder ? (
          <Link href={scopedHref(scope.basePath, '/order')} className="s-btn">
            Order from {where ? where.split(',')[0] : 'here'}
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export async function MenuRoute({ host, venueSlug, searchParams }: { host: string; venueSlug: string | null; searchParams: SearchParams }) {
  const scope = await loadScope(host, venueSlug);
  const table = await readTable(scope.venue?.id);
  const page = await loadPage(scope, 'menu');
  const hasMenuBlock = page?.blocks.some((b) => b.type === 'menu');
  const blocks: website.Block[] = page && hasMenuBlock ? page.blocks.map((b) => (b.type === 'menu' ? { ...b, display: 'full' as const } : b)) : [website.menuBlock.parse({ type: 'menu', id: 'menu', heading: 'Menu', display: 'full' }), ...(page?.blocks ?? [])];
  const menuData = await loadMenu(scope, table);
  const path = scopedHref(scope.basePath, '/menu');
  return (
    <>
      {table ? <TableBanner table={table} scope={scope} /> : null}
      {scope.venue ? <TrackOnMount name="menu.viewed" properties={{ surface: table ? 'qr' : 'site', table_label: table?.label ?? null }} /> : null}
      {menuData && menuData.menus.length ? <JsonLd doc={website.menuJsonLd(menuData, { url: canonicalUrl(scope, '/menu'), name: `${scope.venue!.name} menu` })} /> : null}
      <PageView scope={scope} page={{ slug: 'menu', title: page?.title ?? 'Menu', blocks }} diet={dietFrom(searchParams)} path={path} table={table} menuData={menuData} />
    </>
  );
}
