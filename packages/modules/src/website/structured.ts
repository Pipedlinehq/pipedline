import type { PublicMenu } from '../menu/contract';

/**
 * Structured data, sitemap entries and robots rules (docs/modules/website.md section 5). Pure
 * functions: they take what the read model already loaded and return plain objects. We are
 * taking over a venue's organic traffic, so these are a deliverable, not decoration.
 */

export type JsonLd = Record<string, unknown>;

export interface StructuredVenue {
  name: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  suburb?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  lat?: number | null;
  lng?: number | null;
  phone?: string | null;
  email?: string | null;
  cuisineTags?: string[];
  priceBand?: number | null;
}

export interface StructuredHour {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (t: string) => t.slice(0, 5);

function drop<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}

export interface RestaurantJsonLdInput {
  venue: StructuredVenue;
  hours: StructuredHour[];
  /** The canonical address of the venue's site. */
  url: string;
  menuUrl?: string | null;
  imageUrl?: string | null;
  logoUrl?: string | null;
  acceptsReservations?: boolean | null;
  /** Social and listing profiles. */
  sameAs?: string[];
}

/** `Restaurant` (a `LocalBusiness`) for one venue: address, geo, hours, price range, cuisine, menu. */
export function restaurantJsonLd(input: RestaurantJsonLdInput): JsonLd {
  const v = input.venue;
  // Periods with the same opening and closing times are grouped across days, as the vocabulary expects.
  const groups = new Map<string, number[]>();
  for (const h of input.hours) {
    const key = `${hhmm(h.opensAt)}-${hhmm(h.closesAt)}`;
    const days = groups.get(key) ?? [];
    if (!days.includes(h.dayOfWeek)) days.push(h.dayOfWeek);
    groups.set(key, days);
  }
  const openingHoursSpecification = [...groups.entries()].map(([key, days]) => {
    const [opens, closes] = key.split('-') as [string, string];
    return { '@type': 'OpeningHoursSpecification', dayOfWeek: days.sort((a, b) => a - b).map((d) => `https://schema.org/${DAYS[d]}`), opens, closes };
  });
  const hasAddress = Boolean(v.addressLine1 || v.suburb || v.postcode);
  return drop({
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': `${input.url.replace(/\/$/, '')}/#restaurant`,
    name: v.name,
    url: input.url,
    telephone: v.phone,
    email: v.email,
    image: input.imageUrl,
    logo: input.logoUrl,
    address: hasAddress
      ? drop({
          '@type': 'PostalAddress',
          streetAddress: [v.addressLine1, v.addressLine2].filter(Boolean).join(', '),
          addressLocality: v.suburb,
          addressRegion: v.state,
          postalCode: v.postcode,
          addressCountry: v.country ?? 'AU',
        })
      : undefined,
    geo: typeof v.lat === 'number' && typeof v.lng === 'number' ? { '@type': 'GeoCoordinates', latitude: v.lat, longitude: v.lng } : undefined,
    servesCuisine: v.cuisineTags ?? [],
    priceRange: v.priceBand ? '$'.repeat(Math.min(4, Math.max(1, v.priceBand))) : undefined,
    openingHoursSpecification,
    hasMenu: input.menuUrl,
    acceptsReservations: input.acceptsReservations ?? undefined,
    sameAs: input.sameAs ?? [],
  });
}

const DIETS: Record<string, string> = {
  vegetarian: 'https://schema.org/VegetarianDiet',
  vegan: 'https://schema.org/VeganDiet',
  'gluten-free': 'https://schema.org/GlutenFreeDiet',
  gluten_free: 'https://schema.org/GlutenFreeDiet',
  gf: 'https://schema.org/GlutenFreeDiet',
  halal: 'https://schema.org/HalalDiet',
  kosher: 'https://schema.org/KosherDiet',
  'dairy-free': 'https://schema.org/LowLactoseDiet',
};

/** `Menu` from the live menu model: sections, items, prices. Items that are 86'd are still listed. */
export function menuJsonLd(menu: PublicMenu, opts: { url: string; name?: string }): JsonLd {
  const price = (cents: number) => (cents / 100).toFixed(2);
  const sections = (list: PublicMenu['menus'][number]['sections']) =>
    list.map((s) =>
      drop({
        '@type': 'MenuSection',
        name: s.name,
        description: s.description,
        hasMenuItem: s.items.map((i) =>
          drop({
            '@type': 'MenuItem',
            name: i.name,
            description: i.description,
            image: i.imageUrl,
            suitableForDiet: i.dietaryTags.map((t) => DIETS[t.toLowerCase()]).filter((d): d is string => Boolean(d)),
            offers: { '@type': 'Offer', price: price(i.priceCents), priceCurrency: menu.currency },
          }),
        ),
      }),
    );
  const menus = menu.menus.map((m) => drop({ '@type': 'Menu', name: m.name, hasMenuSection: sections(m.sections) }));
  if (menus.length === 1) {
    return drop({ '@context': 'https://schema.org', ...menus[0]!, name: opts.name ?? (menus[0]!.name as string), url: opts.url });
  }
  return drop({ '@context': 'https://schema.org', '@type': 'Menu', name: opts.name ?? 'Menu', url: opts.url, hasMenuSection: menus.flatMap((m) => (m.hasMenuSection as unknown[]) ?? []) });
}

export interface StructuredDataCheck {
  valid: boolean;
  /** What a search engine needs and is not there, in plain words. */
  missing: string[];
}

/** Whether a Restaurant object has what search engines require for a local-business result. */
export function validateRestaurantJsonLd(doc: JsonLd): StructuredDataCheck {
  const missing: string[] = [];
  const address = (doc.address ?? {}) as Record<string, unknown>;
  if (doc['@type'] !== 'Restaurant') missing.push('type');
  if (!doc.name) missing.push('name');
  if (typeof doc.url !== 'string' || !/^https?:\/\//.test(doc.url)) missing.push('site address');
  if (!address.streetAddress) missing.push('street address');
  if (!address.addressLocality) missing.push('suburb');
  if (!address.postalCode) missing.push('postcode');
  if (!doc.telephone) missing.push('phone number');
  if (!Array.isArray(doc.openingHoursSpecification) || !doc.openingHoursSpecification.length) missing.push('opening hours');
  return { valid: missing.length === 0, missing };
}

/**
 * JSON-LD as text for a <script type="application/ld+json"> element. A venue's name or a menu
 * description containing "</script>" must not be able to close the element, so the characters
 * that matter to an HTML parser are written as JSON escapes; the parsed value is unchanged.
 */
export function serializeJsonLd(doc: JsonLd | JsonLd[]): string {
  return JSON.stringify(doc)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface SitemapEntry {
  /** Absolute address. */
  loc: string;
  path: string;
  lastModified: Date | null;
  priority: number;
}

/** Sitemap entries for a site's published pages. The home page is the site root. */
export function buildSitemapEntries(baseUrl: string, pages: Array<{ slug: string; publishedAt: Date | null }>): SitemapEntry[] {
  const base = baseUrl.replace(/\/+$/, '');
  return pages.map((pg) => {
    const path = pg.slug === 'home' ? '/' : `/${pg.slug}`;
    return { loc: `${base}${path}`, path, lastModified: pg.publishedAt, priority: pg.slug === 'home' ? 1 : pg.slug === 'menu' ? 0.9 : 0.6 };
  });
}

export interface RobotsRules {
  rules: Array<{ userAgent: string; allow: string[]; disallow: string[] }>;
  sitemap: string | null;
  host: string | null;
}

/** Paths that are per-guest or functional and never belong in a search index. */
export const ROBOTS_DISALLOW = ['/api/', '/account', '/checkout', '/order/', '/u/', '/q/'];

/**
 * robots.txt for one host. Only a live org's primary host is indexable: a site still being
 * built, a paused or closed org, and the platform subdomain once a custom domain has taken
 * over all answer "disallow everything", so the old address cannot compete with the new one.
 */
export function robotsRules(input: { baseUrl: string; orgStatus: 'onboarding' | 'live' | 'paused' | 'closed'; isPrimaryHost: boolean }): RobotsRules {
  const base = input.baseUrl.replace(/\/+$/, '');
  if (input.orgStatus !== 'live' || !input.isPrimaryHost) {
    return { rules: [{ userAgent: '*', allow: [], disallow: ['/'] }], sitemap: null, host: null };
  }
  return { rules: [{ userAgent: '*', allow: ['/'], disallow: [...ROBOTS_DISALLOW] }], sitemap: `${base}/sitemap.xml`, host: base.replace(/^https?:\/\//, '') };
}

/** The same rules as the text of a robots.txt file. */
export function robotsTxt(rules: RobotsRules): string {
  const lines: string[] = [];
  for (const r of rules.rules) {
    lines.push(`User-agent: ${r.userAgent}`);
    for (const a of r.allow) lines.push(`Allow: ${a}`);
    for (const d of r.disallow) lines.push(`Disallow: ${d}`);
    lines.push('');
  }
  if (rules.sitemap) lines.push(`Sitemap: ${rules.sitemap}`);
  return `${lines.join('\n').trimEnd()}\n`;
}
