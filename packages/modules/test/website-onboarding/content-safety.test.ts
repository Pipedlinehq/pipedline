import { describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { website } from '@ros/modules';
import type { PublicMenu } from '@ros/modules/menu';

const ANON = { kind: 'anon' as const };

/** One valid example of every block type, with every optional text field filled in. */
const SAMPLE_BLOCKS: website.BlockInput[] = [
  { type: 'hero', id: 'b-hero', heading: 'Welcome', subheading: 'Wood fire and wine', imageUrl: 'https://assets.example.com/hero.jpg', imageAlt: 'The grill', ctaLabel: 'Book', ctaHref: '/contact' },
  { type: 'about', id: 'b-about', heading: 'About us', body: 'Line one.\nLine two.', imageUrl: '/media/room.jpg', imageAlt: 'The room' },
  { type: 'menu', id: 'b-menu', heading: 'Menu', intro: 'Changes weekly.', display: 'highlights', itemLimit: 4, showPrices: true },
  { type: 'gallery', id: 'b-gallery', heading: 'Photos', images: [{ url: 'https://assets.example.com/1.jpg', alt: 'Steak', caption: 'Rib eye' }] },
  { type: 'hours-location', id: 'b-hours', heading: 'Find us', note: 'Closed public holidays.', showMap: true },
  { type: 'booking-cta', id: 'b-book', heading: 'Join us', body: 'Tables for up to eight.', label: 'Book a table', href: 'https://bookings.example.com/oak' },
  { type: 'order-cta', id: 'b-order', heading: 'Order ahead', body: 'Ready in twenty minutes.', label: 'Order now', href: '/order' },
  { type: 'testimonials', id: 'b-quotes', heading: 'Guests say', items: [{ quote: 'Best in town.', author: 'Sam', source: 'Google' }] },
  { type: 'faq', id: 'b-faq', heading: 'Questions', items: [{ question: 'Walk-ins?', answer: 'Yes, at the bar.' }] },
  { type: 'contact', id: 'b-contact', heading: 'Contact', body: 'Call before five.', showPhone: true, showEmail: true, showAddress: true },
  {
    type: 'rich-text',
    id: 'b-rich',
    heading: 'Our story',
    paragraphs: [
      { kind: 'paragraph', text: 'It began with a fire.' },
      { kind: 'subheading', text: 'The early years' },
      { kind: 'quote', text: 'Cook it slowly.', attribution: 'The founder' },
      { kind: 'list', items: ['Beef', 'Salt', 'Smoke'] },
    ],
  },
  { type: 'instagram-feed', id: 'b-insta', heading: 'On Instagram', handle: 'oak.diner', count: 6 },
  { type: 'criota-reel', id: 'b-reel', heading: 'From our creators', campaignId: 'spring_2026', limit: 6, layout: 'grid' },
];

/** Every string leaf in a value, as a path. */
function stringLeaves(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (typeof value === 'string') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringLeaves(v, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => stringLeaves(v, [...path, k]));
  return [];
}

function withLeaf<T>(value: T, path: Array<string | number>, replacement: string): T {
  const copy = structuredClone(value) as unknown;
  let cursor = copy as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string | number, unknown>;
  cursor[path.at(-1)!] = replacement;
  return copy as T;
}

const MARKUP = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'Hello <b>there</b>', '</p><iframe src="https://evil.example">', '<!-- x -->', '<svg/onload=alert(1)>'];
const BAD_URLS = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '//evil.example/path', 'http://insecure.example/', 'data:text/html,<script>alert(1)</script>', '/\\evil.example', 'https://user:pass@evil.example/', 'https://evil.example/"onmouseover="x', ' https://spaced.example', 'vbscript:x', 'ftp://files.example/x', '/ok path'];

describe('website content is data, never markup', () => {
  const t = useTestEnv();

  it('there are thirteen block types and the sample of each one is valid', () => {
    expect(website.BLOCK_TYPES).toHaveLength(13);
    expect(SAMPLE_BLOCKS.map((b) => b.type).sort()).toEqual([...website.BLOCK_TYPES].sort());
    const parsed = website.blocksSchema.parse(SAMPLE_BLOCKS);
    expect(parsed).toHaveLength(13);
  });

  it('markup or script in any string field of any block is refused', () => {
    let checked = 0;
    for (const block of SAMPLE_BLOCKS) {
      for (const path of stringLeaves(block)) {
        for (const payload of MARKUP) {
          const result = website.blockSchema.safeParse(withLeaf(block, path, payload));
          expect(result.success, `${block.type}.${path.join('.')} accepted ${payload}`).toBe(false);
          checked++;
        }
      }
    }
    // Every block has at least its type, id and heading; this is a few hundred attempts.
    expect(checked).toBeGreaterThan(300);
  });

  it('a block has no field that could carry markup: unknown fields are dropped, not stored', () => {
    const parsed = website.blockSchema.parse({ type: 'hero', heading: 'Hi', html: '<b>x</b>', dangerouslySetInnerHTML: { __html: '<script>1</script>' }, onClick: 'alert(1)', style: 'x' });
    expect(Object.keys(parsed).sort()).toEqual(['ctaHref', 'ctaLabel', 'heading', 'id', 'imageAlt', 'imageUrl', 'subheading', 'type']);
    // Rich text is structured paragraphs: there is no "html" kind to ask for.
    expect(website.blockSchema.safeParse({ type: 'rich-text', paragraphs: [{ kind: 'html', text: 'x' }] }).success).toBe(false);
  });

  it('text that merely contains angle brackets or ampersands is kept exactly as typed', () => {
    const text = 'Steak & chips < $50, kids <3 it. 2 > 1';
    const parsed = website.blockSchema.parse({ type: 'about', body: text });
    expect(parsed).toMatchObject({ type: 'about', body: text });
  });

  it('a javascript:, protocol-relative, http or credentialed URL is refused wherever a link or image goes', () => {
    for (const url of BAD_URLS) {
      expect(website.linkUrl.safeParse(url).success, url).toBe(false);
      expect(website.blockSchema.safeParse({ type: 'hero', heading: 'Hi', ctaLabel: 'Go', ctaHref: url }).success, `hero.ctaHref ${url}`).toBe(false);
      expect(website.blockSchema.safeParse({ type: 'hero', heading: 'Hi', imageUrl: url }).success, `hero.imageUrl ${url}`).toBe(false);
      expect(website.blockSchema.safeParse({ type: 'gallery', images: [{ url, alt: 'x' }] }).success, `gallery ${url}`).toBe(false);
      expect(website.blockSchema.safeParse({ type: 'booking-cta', heading: 'Book', label: 'Book', href: url }).success, `booking ${url}`).toBe(false);
    }
    for (const ok of ['/menu', '/#hours', '/order?ref=home', 'https://bookings.example.com/oak?x=1']) {
      expect(website.linkUrl.safeParse(ok).success, ok).toBe(true);
    }
  });

  it('the website config takes named integrations by id only, and links only to safe places', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const set = (config: Record<string, unknown>) => t.app.tenant(diner.orgId, manager, (ctx) => setModule(ctx, website.websiteModule, { venueId: diner.venueId, config: config as never }));

    for (const bad of ['G-1"><script>alert(1)</script>', 'UA-12345', 'G-abc', "G-ABCDEF';alert(1)//"]) {
      await expect(set({ integrations: { googleAnalyticsId: bad, metaPixelId: null, googleSiteVerification: null } })).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(set({ integrations: { googleAnalyticsId: null, metaPixelId: '123<script>', googleSiteVerification: null } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(set({ navItems: [{ label: 'Win a prize', href: 'javascript:alert(1)' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(set({ navItems: [{ label: '<b>Menu</b>', href: '/menu' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(set({ orderCtaTarget: '//evil.example' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(set({ socialLinks: { ...website.socialLinks.parse({}), instagram: 'https://instagram.com.evil.example/oak' } })).rejects.toMatchObject({ code: 'invalid' });

    // There is no free head snippet: a key that is not part of the schema is not stored.
    await set({ customHeadSnippet: '<script src="https://evil.example/x.js"></script>', integrations: { googleAnalyticsId: 'G-AB12CD34EF', metaPixelId: '1234567890123456', googleSiteVerification: null } });
    const row = await t.db.selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'website').executeTakeFirstOrThrow();
    expect(JSON.stringify(row.config)).not.toContain('script');
    expect(row.config).toMatchObject({ integrations: { googleAnalyticsId: 'G-AB12CD34EF', metaPixelId: '1234567890123456' } });
  });

  it('saving a page with markup or a bad link changes nothing', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const home = await t.db.selectFrom('pages').select(['id', 'blocks', 'draft']).where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    const save = (blocks: unknown[]) => t.app.tenant(diner.orgId, manager, (ctx) => website.savePageDraft(ctx, { pageId: home.id, blocks }));
    await expect(save([{ type: 'hero', heading: '<script>alert(1)</script>' }])).rejects.toMatchObject({ code: 'invalid' });
    await expect(save([{ type: 'hero', heading: 'Hi', ctaLabel: 'Go', ctaHref: 'javascript:alert(1)' }])).rejects.toMatchObject({ code: 'invalid' });
    await expect(save([{ type: 'marquee', text: 'not a block type' }])).rejects.toMatchObject({ code: 'invalid' });
    const after = await t.db.selectFrom('pages').select(['blocks', 'draft']).where('id', '=', home.id).executeTakeFirstOrThrow();
    expect(after).toEqual({ blocks: home.blocks, draft: home.draft });
  });

  it('a stored block that does not validate is left out of what the site renders', async () => {
    const { diner } = t.fixture;
    const home = await t.db.selectFrom('pages').select(['id', 'blocks']).where('org_id', '=', diner.orgId).where('slug', '=', 'home').executeTakeFirstOrThrow();
    const tampered = [...(home.blocks as unknown[]), { type: 'hero', id: 'evil', heading: '<script>alert(1)</script>' }, { type: 'raw-html', html: '<script>1</script>' }];
    await t.db.updateTable('pages').set({ blocks: JSON.stringify(tampered) }).where('id', '=', home.id).execute();
    const page = await t.app.tenant(diner.orgId, ANON, (ctx) => website.getPage(ctx, { slug: 'home' }));
    expect(JSON.stringify(page)).not.toContain('<script');
    expect(page.blocks.length).toBe((home.blocks as unknown[]).length);
    await t.db.updateTable('pages').set({ blocks: JSON.stringify(home.blocks) }).where('id', '=', home.id).execute();
  });
});

describe('brand tokens and the CSS they become', () => {
  const t = useTestEnv();

  it('the defaults are valid, from the font allowlist, and produce one clean :root rule', () => {
    expect(website.FONTS.length).toBeGreaterThanOrEqual(18);
    expect(website.FONTS.length).toBeLessThanOrEqual(24);
    for (const f of website.FONTS) expect(f.fallback).toMatch(/(serif|sans-serif)$/);
    const vars = website.brandCssVariables(website.DEFAULT_BRAND_TOKENS);
    expect(vars['--brand-color-primary']).toBe('#8B2F2F');
    expect(vars['--brand-font-heading']).toBe("'Fraunces', Georgia, Cambria, Times New Roman, serif");
    expect(website.brandCss(website.DEFAULT_BRAND_TOKENS)).toMatch(/^:root\{(--brand-[a-z-]+:[^;{}<>]+;?)+\}$/);
    expect(website.googleFontsHref(website.DEFAULT_BRAND_TOKENS)).toBe('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;700&family=Inter:wght@400;500&display=swap');
  });

  it('no token value can break out of a CSS declaration', () => {
    const payloads = ['red;}body{display:none}', '#FFF;background:url(https://evil.example/x)', '</style><script>alert(1)</script>', 'Inter}*{color:red', "Inter', serif; } html { display: none", '16px;position:fixed', 'expression(alert(1))', '0em;} @import url(https://evil.example/x.css); .x{', '\\3c script'];
    let attempts = 0;
    const leaves = (value: unknown, path: string[] = []): string[][] =>
      value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k])) : [path];
    for (const path of leaves(website.DEFAULT_BRAND_TOKENS)) {
      for (const payload of payloads) {
        const tokens = structuredClone(website.DEFAULT_BRAND_TOKENS) as unknown as Record<string, unknown>;
        let cursor = tokens;
        for (const key of path.slice(0, -1)) cursor = cursor[key] as Record<string, unknown>;
        cursor[path.at(-1)!] = payload;
        expect(() => website.brandCssVariables(tokens), `${path.join('.')} = ${payload}`).toThrow();
        expect(() => website.brandCss(tokens)).toThrow();
        attempts++;
      }
    }
    expect(attempts).toBeGreaterThan(200);
    // Not even an object that was never validated gets through.
    expect(() => website.brandCssVariables({ colour: { primary: 'red' } })).toThrow();
  });

  it('colours must be hex and the text pairs must be readable', () => {
    const ok = website.brandTokensSchema.safeParse(website.DEFAULT_BRAND_TOKENS);
    expect(ok.success).toBe(true);
    const lowContrast = website.brandTokensSchema.safeParse(website.mergeTokens(website.DEFAULT_BRAND_TOKENS, { colour: { text: '#EEEEEE' } }));
    expect(lowContrast.success).toBe(false);
    expect(lowContrast.error!.issues[0]!.message).toMatch(/contrast of at least 4.5:1/);
    expect(website.brandTokensSchema.safeParse(website.mergeTokens(website.DEFAULT_BRAND_TOKENS, { colour: { primary: 'rgb(1,2,3)' } })).success).toBe(false);
    expect(website.brandTokensSchema.safeParse(website.mergeTokens(website.DEFAULT_BRAND_TOKENS, { typography: { heading: { family: 'Comic Sans MS' } } })).success).toBe(false);
    // A weight the chosen face does not come in.
    expect(website.brandTokensSchema.safeParse(website.mergeTokens(website.DEFAULT_BRAND_TOKENS, { typography: { heading: { family: 'DM Serif Display', weights: [700] } } })).success).toBe(false);
    expect(website.contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 0);
  });

  it('setBrand stores a valid change, refuses an invalid one, and a venue override merges over the org brand', async () => {
    const { group } = t.fixture;
    const owner = await group.as('owner');
    const run = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(group.orgId, owner, fn);
    const cbd = group.venues.cbd!.id;
    const newtown = group.venues.newtown!.id;

    // The seeded group: navy org brand, and a sub-brand at Newtown.
    const orgBrand = await t.app.tenant(group.orgId, ANON, (ctx) => website.getBrand(ctx));
    const atCbd = await t.app.tenant(group.orgId, ANON, (ctx) => website.getBrand(ctx, { venueId: cbd }));
    const atNewtown = await t.app.tenant(group.orgId, ANON, (ctx) => website.getBrand(ctx, { venueId: newtown }));
    expect(orgBrand.tokens.colour.primary).toBe('#1F3A5F');
    expect(atCbd.tokens).toEqual(orgBrand.tokens);
    expect(atCbd.hasVenueOverride).toBe(false);
    expect(atNewtown.hasVenueOverride).toBe(true);
    expect(atNewtown.tokens.colour.primary).toBe('#7A1E48');
    expect(atNewtown.tokens.typography.heading.family).toBe('Oswald');
    // What the override does not change still comes from the org.
    expect(atNewtown.tokens.colour.text).toBe(orgBrand.tokens.colour.text);
    expect(atNewtown.tokens.typography.body).toEqual(orgBrand.tokens.typography.body);
    // Only the overridden keys are stored on the venue's row.
    const stored = await t.db.selectFrom('brands').select('tokens').where('venue_id', '=', newtown).executeTakeFirstOrThrow();
    expect(stored.tokens).toEqual({ colour: { primary: '#7A1E48', accent: '#F2B705' }, typography: { heading: { family: 'Oswald' } } });

    const before = await t.db.selectFrom('brands').select(['venue_id', 'tokens']).where('org_id', '=', group.orgId).orderBy('venue_id').execute();
    await expect(run((ctx) => website.setBrand(ctx, { tokens: { colour: { primary: 'red;}body{display:none}' } } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => website.setBrand(ctx, { tokens: { colour: { text: '#FAFAFA' } } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => website.setBrand(ctx, { venueId: newtown, tokens: { colour: { primaryContrast: '#7A1E48' } } }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(run((ctx) => website.setBrand(ctx, { logo: { svgUrl: 'javascript:alert(1)' } }))).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.db.selectFrom('brands').select(['venue_id', 'tokens']).where('org_id', '=', group.orgId).orderBy('venue_id').execute()).toEqual(before);

    // An org-level change flows to the venue that overrides something else.
    await run((ctx) => website.setBrand(ctx, { tokens: { colour: { accent: '#0A7A5C', border: '#94A3B8' } }, skeleton: 'editorial' }));
    const after = await t.app.tenant(group.orgId, ANON, (ctx) => website.getBrand(ctx, { venueId: newtown }));
    expect(after.tokens.colour.border).toBe('#94A3B8');
    expect(after.tokens.colour.accent).toBe('#F2B705');
    expect(after.skeleton).toBe('editorial');
    const audited = await t.db.selectFrom('audit_log').select('action').where('org_id', '=', group.orgId).where('action', '=', 'brand.updated').execute();
    expect(audited.length).toBeGreaterThanOrEqual(1);

    // A front-of-house role cannot restyle the site; a manager has no say at a venue they hold no role at.
    const host = await group.as('host');
    await expect(t.app.tenant(group.orgId, host, (ctx) => website.setBrand(ctx, { tokens: { density: 'compact' } }))).rejects.toMatchObject({ code: 'forbidden' });
    const manager = await group.as('manager');
    await expect(t.app.tenant(group.orgId, manager, (ctx) => website.setBrand(ctx, { venueId: group.venues.bondi!.id, tokens: { density: 'compact' } }))).rejects.toMatchObject({ code: 'not_found' });

    await run((ctx) => website.clearBrandOverride(ctx, { venueId: newtown }));
    expect((await t.app.tenant(group.orgId, ANON, (ctx) => website.getBrand(ctx, { venueId: newtown }))).tokens.colour.primary).toBe('#1F3A5F');
  });
});

describe('skeletons, structured data, sitemap and robots', () => {
  it('all six skeletons are defined as data and each builds a home page from intake copy', () => {
    expect(Object.keys(website.SKELETONS).sort()).toEqual(['editorial', 'hero-photo', 'menu-forward', 'minimal', 'single-scroll', 'split-panel']);
    for (const s of website.listSkeletons()) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.pages[0]!.slug).toBe('home');
      for (const page of s.pages) {
        for (const placed of page.blocks) {
          expect(website.BLOCK_TYPES).toContain(placed.type);
          expect(website.REGIONS).toContain(placed.region);
        }
      }
      const pages = website.buildDefaultPages(s.key, {
        tradingName: 'Bella Trattoria',
        tagline: 'Pasta made this morning.',
        about: 'A family room in Leichhardt since 1987.',
        faq: [{ question: 'BYO?', answer: 'Wine only, Monday to Wednesday.' }],
        galleryImages: [{ url: 'https://assets.example.com/a.jpg', alt: 'Pasta' }],
        takesBookings: true,
        takesOrders: false,
      });
      expect(pages[0]!.slug).toBe('home');
      expect(pages[0]!.blocks[0]).toMatchObject({ type: 'hero', heading: 'Bella Trattoria' });
      // A venue that takes no orders gets no order button; one with no testimonials gets no empty section.
      const types = pages.flatMap((p) => p.blocks.map((b) => b.type));
      expect(types).not.toContain('order-cta');
      expect(types).not.toContain('testimonials');
      expect(types).toContain('booking-cta');
      const ids = pages.flatMap((p) => p.blocks.map((b) => `${p.slug}:${b.id}`));
      expect(new Set(ids).size).toBe(ids.length);
    }
    expect(website.buildDefaultPages('single-scroll', { tradingName: 'Taco Truck' })).toHaveLength(1);
    expect(website.defaultNav('single-scroll').map((n) => n.href)).toEqual(['/#menu', '/#about', '/#hours-location', '/#contact']);
    expect(website.defaultNav('hero-photo')).toEqual([
      { label: 'Menu', href: '/menu' },
      { label: 'About', href: '/about' },
      { label: 'Visit', href: '/contact' },
    ]);
    expect(website.regionFor('split-panel', 'home', 'booking-cta')).toBe('aside');
    // Copy is held to the same rule as any other content.
    expect(() => website.buildDefaultPages('minimal', { tradingName: '<script>alert(1)</script>' })).toThrow();
  });

  it('builds Restaurant structured data from a venue and its hours', () => {
    const doc = website.restaurantJsonLd({
      venue: { name: 'Oak Diner', addressLine1: '1 Fixture Street', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', lat: -33.88, lng: 151.21, phone: '+61 2 5550 0000', cuisineTags: ['steakhouse'], priceBand: 3 },
      hours: [
        { dayOfWeek: 2, opensAt: '12:00:00', closesAt: '15:00:00' },
        { dayOfWeek: 3, opensAt: '12:00:00', closesAt: '15:00:00' },
        { dayOfWeek: 2, opensAt: '17:30:00', closesAt: '22:00:00' },
      ],
      url: 'https://oakdiner.example.com.au/',
      menuUrl: 'https://oakdiner.example.com.au/menu',
      acceptsReservations: true,
      sameAs: ['https://www.instagram.com/oakdiner'],
    });
    expect(doc).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Restaurant',
      name: 'Oak Diner',
      telephone: '+61 2 5550 0000',
      priceRange: '$$$',
      servesCuisine: ['steakhouse'],
      hasMenu: 'https://oakdiner.example.com.au/menu',
      acceptsReservations: true,
      address: { '@type': 'PostalAddress', streetAddress: '1 Fixture Street', addressLocality: 'Surry Hills', addressRegion: 'NSW', postalCode: '2010', addressCountry: 'AU' },
      geo: { '@type': 'GeoCoordinates', latitude: -33.88, longitude: 151.21 },
    });
    expect(doc.openingHoursSpecification).toEqual([
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['https://schema.org/Tuesday', 'https://schema.org/Wednesday'], opens: '12:00', closes: '15:00' },
      { '@type': 'OpeningHoursSpecification', dayOfWeek: ['https://schema.org/Tuesday'], opens: '17:30', closes: '22:00' },
    ]);
    expect(website.validateRestaurantJsonLd(doc)).toEqual({ valid: true, missing: [] });
    const bare = website.restaurantJsonLd({ venue: { name: 'No Details' }, hours: [], url: 'https://x.example/' });
    expect(bare).not.toHaveProperty('address');
    expect(website.validateRestaurantJsonLd(bare)).toEqual({ valid: false, missing: ['street address', 'suburb', 'postcode', 'phone number', 'opening hours'] });
  });

  it('builds Menu structured data from a PublicMenu', () => {
    const menu: PublicMenu = {
      venueId: '00000000-0000-0000-0000-000000000001',
      currency: 'AUD',
      taxInclusive: true,
      generatedAt: '2026-09-30T02:00:00.000Z',
      menus: [
        {
          id: 'm1',
          name: 'All day',
          sections: [
            {
              id: 's1',
              name: 'Mains',
              description: null,
              items: [
                { id: 'i1', name: 'Rib eye', description: '400g, dry-aged', priceCents: 5900, imageUrl: null, isAvailable: true, dietaryTags: ['gluten-free'], allergens: [], spiceLevel: null, calories: null, prepMinutes: 20, maxPerOrder: null, isAlcohol: false, modifierGroups: [] },
                { id: 'i2', name: 'Mushroom pie', description: null, priceCents: 2850, imageUrl: null, isAvailable: false, dietaryTags: ['vegetarian', 'house-special'], allergens: ['gluten'], spiceLevel: null, calories: null, prepMinutes: 15, maxPerOrder: null, isAlcohol: false, modifierGroups: [] },
              ],
            },
          ],
        },
      ],
    };
    const doc = website.menuJsonLd(menu, { url: 'https://oakdiner.example.com.au/menu', name: 'Oak Diner menu' });
    expect(doc).toEqual({
      '@context': 'https://schema.org',
      '@type': 'Menu',
      name: 'Oak Diner menu',
      url: 'https://oakdiner.example.com.au/menu',
      hasMenuSection: [
        {
          '@type': 'MenuSection',
          name: 'Mains',
          hasMenuItem: [
            { '@type': 'MenuItem', name: 'Rib eye', description: '400g, dry-aged', suitableForDiet: ['https://schema.org/GlutenFreeDiet'], offers: { '@type': 'Offer', price: '59.00', priceCurrency: 'AUD' } },
            { '@type': 'MenuItem', name: 'Mushroom pie', suitableForDiet: ['https://schema.org/VegetarianDiet'], offers: { '@type': 'Offer', price: '28.50', priceCurrency: 'AUD' } },
          ],
        },
      ],
    });
  });

  it('JSON-LD is escaped so that nothing in it can close the script element', () => {
    const doc = website.restaurantJsonLd({ venue: { name: 'Bad </script><script>alert(1)</script> & Co \u2028' }, hours: [], url: 'https://x.example/' });
    const text = website.serializeJsonLd(doc);
    expect(text).not.toMatch(/<|>|&/);
    expect(text).not.toContain('\u2028');
    expect(text).toContain('\\u003c/script\\u003e');
    // It is still the same JSON.
    expect(JSON.parse(text)).toEqual(doc);
  });

  it('sitemap entries and robots rules', () => {
    const at = new Date('2026-09-01T00:00:00Z');
    expect(
      website.buildSitemapEntries('https://oakdiner.example.com.au/', [
        { slug: 'home', publishedAt: at },
        { slug: 'menu', publishedAt: at },
      ]),
    ).toEqual([
      { loc: 'https://oakdiner.example.com.au/', path: '/', lastModified: at, priority: 1 },
      { loc: 'https://oakdiner.example.com.au/menu', path: '/menu', lastModified: at, priority: 0.9 },
    ]);
    const live = website.robotsRules({ baseUrl: 'https://oakdiner.example.com.au', orgStatus: 'live', isPrimaryHost: true });
    expect(live.sitemap).toBe('https://oakdiner.example.com.au/sitemap.xml');
    expect(live.rules[0]!.disallow).toContain('/checkout');
    expect(website.robotsTxt(live)).toContain('Sitemap: https://oakdiner.example.com.au/sitemap.xml');
    // A site still being built, and the old subdomain once a custom domain is primary, are not indexed.
    for (const closed of [
      website.robotsRules({ baseUrl: 'https://x.example', orgStatus: 'onboarding', isPrimaryHost: true }),
      website.robotsRules({ baseUrl: 'https://x.example', orgStatus: 'live', isPrimaryHost: false }),
    ]) {
      expect(closed).toEqual({ rules: [{ userAgent: '*', allow: [], disallow: ['/'] }], sitemap: null, host: null });
    }
  });
});
