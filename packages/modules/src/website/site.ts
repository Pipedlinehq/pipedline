import { z } from 'zod';
import { type Ctx, addDays, getModule, listModuleDefs, localDate, notFound } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { type HourException, type TradingHour, getTradingHours, listHourExceptions } from '../tenancy/hours';
import { type VenueView, getVenue, listPublicVenues } from '../tenancy/venues';
import { type BrandView, getBrand } from './brand';
import { type WebsiteConfig, assertWebsite } from './module';
import { listPublishedPages } from './pages';
import { cacheTags } from './revalidate';
import { type NavItem, type SkeletonDef, type SkeletonKey, SKELETONS, defaultNav } from './skeletons';
import { type JsonLd, type RobotsRules, type SitemapEntry, buildSitemapEntries, restaurantJsonLd, robotsRules } from './structured';

export interface SiteView {
  org: { id: string; slug: string; name: string; status: 'onboarding' | 'live' | 'paused' | 'closed'; currency: string };
  /** 'venue' for one venue's own site; 'org' for the org-level site. */
  scope: 'org' | 'venue';
  /**
   * The venue this site is about: the one asked for, or the org's only public venue. null on a
   * group's org-level site, which lists `venues` instead.
   */
  venue: VenueView | null;
  /** Public venues with the website switched on, for a group's location list. */
  venues: VenueView[];
  /** The venue's weekly hours and its exceptions for the next 60 days. Empty when there is no single venue. */
  hours: TradingHour[];
  hourExceptions: HourException[];
  brand: BrandView;
  skeleton: SkeletonDef;
  config: WebsiteConfig;
  /** The navigation to draw: the venue's own, or the skeleton's default for the pages that exist. */
  nav: NavItem[];
  pages: Array<{ slug: string; title: string }>;
  /** Non-spine modules switched on at the venue, so the site can say plainly what is unavailable. */
  enabledModules: string[];
  /** scheme://primary-host, for canonical links, the sitemap and structured data. */
  canonicalBase: string;
  /** `Restaurant` structured data for the venue, ready for serializeJsonLd. null on a group's org-level site. */
  structuredData: JsonLd | null;
  cacheTags: string[];
}

export const getSiteInput = z.object({ venueId: z.string().uuid().nullish() });

async function primaryHost(ctx: Ctx, venueId: string | null): Promise<string | null> {
  const rows = await ctx.db.selectFrom('domains').select(['host', 'venue_id']).where('is_primary', '=', true).where('verified_at', 'is not', null).execute();
  return (venueId ? rows.find((r) => r.venue_id === venueId) : undefined)?.host ?? rows.find((r) => r.venue_id === null)?.host ?? rows[0]?.host ?? null;
}

async function canonicalBaseFor(ctx: Ctx, venueId: string | null, orgSlug: string): Promise<string> {
  const host = (await primaryHost(ctx, venueId)) ?? `${orgSlug}.${ctx.app.config.tenantRootDomain}`;
  return `${ctx.app.config.scheme}://${host}`;
}

/**
 * Everything the tenant site's layout renders from: brand, navigation, config, venue details
 * and hours. No role: the caller is a visitor inside the org the host resolved to. Nothing
 * here is personal data, so the result is safe to cache per tenant (use `cacheTags`).
 */
export async function getSite(ctx: Ctx, raw: z.input<typeof getSiteInput> = {}): Promise<SiteView> {
  const parsed = getSiteInput.safeParse(raw);
  if (!parsed.success) throw notFound('Site not found');
  const venueId = parsed.data.venueId ?? null;
  const scope = await assertWebsite(ctx, venueId);

  const org = await getOrg(ctx);
  const venues = (await listPublicVenues(ctx)).filter((v) => scope.venueIds.includes(v.id));
  const venue = venueId ? await getVenue(ctx, venueId) : venues.length === 1 ? venues[0]! : null;

  const brand = await getBrand(ctx, { venueId });
  const skeletonKey: SkeletonKey = (venueId ? scope.config.skeleton : null) ?? brand.skeleton;
  const pages = await listPublishedPages(ctx, { venueId });
  const nav = scope.config.navItems ?? defaultNav(skeletonKey, pages.map((pg) => ({ slug: pg.slug, blockTypes: pg.blockTypes })));

  let hours: TradingHour[] = [];
  let hourExceptions: HourException[] = [];
  const enabledModules: string[] = [];
  if (venue) {
    hours = await getTradingHours(ctx, venue.id);
    const today = localDate(ctx.now(), venue.timezone);
    hourExceptions = await listHourExceptions(ctx, venue.id, today, addDays(today, 60));
    for (const def of listModuleDefs()) {
      if (!def.spine && (await getModule(ctx, venue.id, def)).enabled) enabledModules.push(def.key);
    }
  }

  const canonicalBase = await canonicalBaseFor(ctx, venueId, org.slug);
  const social = Object.values(scope.config.socialLinks).filter((v): v is string => typeof v === 'string');
  // The page a search engine should treat as the menu: the one called "menu" when it shows the menu, else the first that does.
  const menuPage = pages.find((pg) => pg.slug === 'menu' && pg.blockTypes.includes('menu')) ?? pages.find((pg) => pg.blockTypes.includes('menu'));
  const structuredData = venue
    ? restaurantJsonLd({
        venue: { ...venue, country: org.country, cuisineTags: venue.cuisineTags.length ? venue.cuisineTags : org.cuisineTags, priceBand: venue.priceBand ?? org.priceBand },
        hours,
        url: `${canonicalBase}/`,
        menuUrl: menuPage ? `${canonicalBase}${menuPage.slug === 'home' ? '/' : `/${menuPage.slug}`}` : null,
        logoUrl: brand.logo.rasterUrl ?? brand.logo.svgUrl,
        acceptsReservations: scope.config.bookingCtaTarget ? true : null,
        sameAs: social,
      })
    : null;

  return {
    org: { id: org.id, slug: org.slug, name: org.tradingName, status: org.status, currency: org.currency },
    scope: venueId ? 'venue' : 'org',
    venue,
    venues,
    hours,
    hourExceptions,
    brand,
    skeleton: SKELETONS[skeletonKey],
    config: scope.config,
    nav,
    pages: pages.map((pg) => ({ slug: pg.slug, title: pg.title })),
    enabledModules,
    canonicalBase,
    structuredData,
    cacheTags: [cacheTags.org(org.id)],
  };
}

/** The sitemap of one site: its published pages at the canonical host. Public. */
export async function getSitemap(ctx: Ctx, raw: z.input<typeof getSiteInput> = {}): Promise<SitemapEntry[]> {
  const parsed = getSiteInput.safeParse(raw);
  if (!parsed.success) throw notFound('Site not found');
  const venueId = parsed.data.venueId ?? null;
  const pages = await listPublishedPages(ctx, { venueId });
  const org = await getOrg(ctx);
  return buildSitemapEntries(await canonicalBaseFor(ctx, venueId, org.slug), pages);
}

export const getRobotsInput = z.object({ venueId: z.string().uuid().nullish(), host: z.string().max(253) });

/** robots.txt rules for the host a request arrived on. Public. */
export async function getRobots(ctx: Ctx, raw: z.input<typeof getRobotsInput>): Promise<RobotsRules> {
  const parsed = getRobotsInput.safeParse(raw);
  if (!parsed.success) throw notFound('Site not found');
  const venueId = parsed.data.venueId ?? null;
  await assertWebsite(ctx, venueId);
  const org = await getOrg(ctx);
  const base = await canonicalBaseFor(ctx, venueId, org.slug);
  const host = parsed.data.host.toLowerCase().replace(/:\d+$/, '');
  return robotsRules({ baseUrl: base, orgStatus: org.status, isPrimaryHost: base.replace(/^https?:\/\//, '') === host });
}
