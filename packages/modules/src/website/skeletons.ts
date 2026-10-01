import { z } from 'zod';
import { type Block, type BlockInput, type BlockType, blocksSchema } from './blocks';
import { imageUrl, plainText } from './safe';

/**
 * The six layout skeletons, as data (docs/modules/website.md section 2). Each is a hand-designed
 * page composition; this file says which blocks a skeleton places in which region and which
 * pages a new site starts with. The React that draws each region is built separately and reads
 * this, so a skeleton's composition is declared once.
 */
export const SKELETON_KEYS = ['hero-photo', 'editorial', 'menu-forward', 'minimal', 'split-panel', 'single-scroll'] as const;
export type SkeletonKey = (typeof SKELETON_KEYS)[number];

/** Where on the page a block sits. Every skeleton draws the same five regions differently. */
export const REGIONS = ['lead', 'main', 'aside', 'band', 'closing'] as const;
export type Region = (typeof REGIONS)[number];

export interface SkeletonPlacement {
  type: BlockType;
  region: Region;
}

export interface SkeletonPage {
  slug: string;
  title: string;
  /** The label of this page's navigation entry, or null to leave it out of the navigation. */
  nav: string | null;
  /** For a one-page site: the in-page anchor the navigation entry points at. */
  anchor?: string;
  blocks: SkeletonPlacement[];
}

export interface SkeletonDef {
  key: SkeletonKey;
  name: string;
  description: string;
  suits: string;
  /** True when everything lives on the home page and the navigation scrolls to sections. */
  singlePage: boolean;
  /** How each region is drawn in this skeleton. */
  regions: Record<Region, string>;
  /** Blocks of a type not placed below fall into this region. */
  defaultRegion: Region;
  /** The pages a new site starts with, the first being the home page. */
  pages: SkeletonPage[];
}

const p = (type: BlockType, region: Region): SkeletonPlacement => ({ type, region });

export const SKELETONS: Record<SkeletonKey, SkeletonDef> = {
  'hero-photo': {
    key: 'hero-photo',
    name: 'Hero photo',
    description: 'A full-bleed photograph leads, the story and menu highlights follow, photography carries the page.',
    suits: 'Food-led, image-heavy, casual venues.',
    singlePage: false,
    regions: {
      lead: 'Full-bleed image with the headline and one button over it.',
      main: 'A centred single column.',
      aside: 'A card beside the main column on wide screens, below it on a phone.',
      band: 'A full-width strip on the alternate background.',
      closing: 'The last section before the footer.',
    },
    defaultRegion: 'main',
    pages: [
      {
        slug: 'home',
        title: 'Home',
        nav: null,
        blocks: [p('hero', 'lead'), p('about', 'main'), p('menu', 'main'), p('gallery', 'band'), p('testimonials', 'main'), p('order-cta', 'band'), p('booking-cta', 'band'), p('instagram-feed', 'main'), p('hours-location', 'closing')],
      },
      { slug: 'menu', title: 'Menu', nav: 'Menu', blocks: [p('menu', 'main'), p('order-cta', 'closing')] },
      { slug: 'about', title: 'About', nav: 'About', blocks: [p('about', 'main'), p('gallery', 'band')] },
      { slug: 'contact', title: 'Visit us', nav: 'Visit', blocks: [p('contact', 'main'), p('hours-location', 'aside'), p('faq', 'closing')] },
    ],
  },
  editorial: {
    key: 'editorial',
    name: 'Editorial',
    description: 'Story first: a large typographic opening, long-form copy with pull quotes, photographs set into the text.',
    suits: 'Chef-led, story-first, fine dining.',
    singlePage: false,
    regions: {
      lead: 'A typographic opening: large heading, generous white space, the image set below it.',
      main: 'A narrow reading column.',
      aside: 'Margin notes beside the reading column on wide screens.',
      band: 'A full-width image strip.',
      closing: 'A quiet, centred sign-off.',
    },
    defaultRegion: 'main',
    pages: [
      {
        slug: 'home',
        title: 'Home',
        nav: null,
        blocks: [p('hero', 'lead'), p('rich-text', 'main'), p('about', 'main'), p('gallery', 'band'), p('testimonials', 'aside'), p('booking-cta', 'closing'), p('order-cta', 'closing')],
      },
      { slug: 'menu', title: 'Menu', nav: 'Menu', blocks: [p('menu', 'main')] },
      { slug: 'story', title: 'Our story', nav: 'Story', blocks: [p('about', 'main'), p('gallery', 'band')] },
      { slug: 'contact', title: 'Reservations and contact', nav: 'Contact', blocks: [p('booking-cta', 'lead'), p('contact', 'main'), p('hours-location', 'aside'), p('faq', 'closing')] },
    ],
  },
  'menu-forward': {
    key: 'menu-forward',
    name: 'Menu forward',
    description: 'The menu is the landing page, with ordering and opening hours always beside it.',
    suits: 'Cafes and takeaway.',
    singlePage: false,
    regions: {
      lead: 'A compact header: name, one line, the order button.',
      main: 'The menu, full width on a phone, two columns on wide screens.',
      aside: 'A sticky panel with ordering and hours.',
      band: 'A full-width strip on the alternate background.',
      closing: 'The last section before the footer.',
    },
    defaultRegion: 'closing',
    pages: [
      {
        slug: 'home',
        title: 'Menu',
        nav: null,
        blocks: [p('hero', 'lead'), p('menu', 'main'), p('order-cta', 'aside'), p('booking-cta', 'aside'), p('hours-location', 'aside'), p('about', 'closing'), p('instagram-feed', 'closing')],
      },
      { slug: 'about', title: 'About', nav: 'About', blocks: [p('about', 'main'), p('gallery', 'band'), p('testimonials', 'main')] },
      { slug: 'contact', title: 'Find us', nav: 'Find us', blocks: [p('contact', 'main'), p('hours-location', 'aside'), p('faq', 'closing')] },
    ],
  },
  minimal: {
    key: 'minimal',
    name: 'Minimal',
    description: 'Very little on the page: a name, a sentence, the hours and one way to book.',
    suits: 'Wine bars, omakase, small rooms.',
    singlePage: false,
    regions: {
      lead: 'The name and one sentence, centred, nothing else above the fold.',
      main: 'A narrow centred column.',
      aside: 'Set below the main column; this skeleton has no side column.',
      band: 'A single full-width image.',
      closing: 'The last section before the footer.',
    },
    defaultRegion: 'main',
    pages: [
      { slug: 'home', title: 'Home', nav: null, blocks: [p('hero', 'lead'), p('about', 'main'), p('booking-cta', 'main'), p('order-cta', 'main'), p('hours-location', 'closing')] },
      { slug: 'menu', title: 'Menu', nav: 'Menu', blocks: [p('menu', 'main')] },
      { slug: 'contact', title: 'Contact', nav: 'Contact', blocks: [p('contact', 'main'), p('hours-location', 'main'), p('faq', 'closing')] },
    ],
  },
  'split-panel': {
    key: 'split-panel',
    name: 'Split panel',
    description: 'Two columns: the venue on one side, booking and practical details pinned on the other.',
    suits: 'Venues where booking matters as much as the story.',
    singlePage: false,
    regions: {
      lead: 'The left panel opening: image and headline.',
      main: 'The left, scrolling column.',
      aside: 'The right panel, pinned while the left scrolls.',
      band: 'A full-width strip that breaks the two columns.',
      closing: 'Full width, below both columns.',
    },
    defaultRegion: 'main',
    pages: [
      {
        slug: 'home',
        title: 'Home',
        nav: null,
        blocks: [p('hero', 'lead'), p('about', 'main'), p('menu', 'main'), p('booking-cta', 'aside'), p('order-cta', 'aside'), p('hours-location', 'aside'), p('gallery', 'band'), p('testimonials', 'closing')],
      },
      { slug: 'menu', title: 'Menu', nav: 'Menu', blocks: [p('menu', 'main'), p('order-cta', 'aside')] },
      { slug: 'contact', title: 'Contact', nav: 'Contact', blocks: [p('contact', 'main'), p('hours-location', 'aside'), p('faq', 'closing')] },
    ],
  },
  'single-scroll': {
    key: 'single-scroll',
    name: 'Single scroll',
    description: 'One page with everything inline; the navigation scrolls to each section.',
    suits: 'Food trucks, pop-ups and venues with little to say beyond the essentials.',
    singlePage: true,
    regions: {
      lead: 'The opening screen.',
      main: 'Sections stacked in one column, each with an anchor.',
      aside: 'Stacked with the main column; this skeleton has no side column.',
      band: 'A full-width strip on the alternate background.',
      closing: 'The last section before the footer.',
    },
    defaultRegion: 'main',
    pages: [
      {
        slug: 'home',
        title: 'Home',
        nav: null,
        blocks: [p('hero', 'lead'), p('about', 'main'), p('menu', 'main'), p('order-cta', 'band'), p('booking-cta', 'band'), p('gallery', 'band'), p('hours-location', 'main'), p('faq', 'main'), p('contact', 'closing')],
      },
    ],
  },
};

export function listSkeletons(): SkeletonDef[] {
  return SKELETON_KEYS.map((k) => SKELETONS[k]);
}

export function getSkeleton(key: string): SkeletonDef {
  return SKELETONS[(SKELETON_KEYS as readonly string[]).includes(key) ? (key as SkeletonKey) : 'hero-photo'];
}

/** The region a block of this type is drawn in on a page of this skeleton. */
export function regionFor(skeleton: SkeletonKey, pageSlug: string, type: BlockType): Region {
  const def = SKELETONS[skeleton];
  const page = def.pages.find((pg) => pg.slug === pageSlug);
  return page?.blocks.find((b) => b.type === type)?.region ?? def.defaultRegion;
}

export interface NavItem {
  label: string;
  href: string;
}

/** The navigation a new site on this skeleton starts with. */
export function defaultNav(skeleton: SkeletonKey, pages?: Array<{ slug: string; blockTypes: BlockType[] }>): NavItem[] {
  const def = SKELETONS[skeleton];
  if (def.singlePage) {
    const present = new Set(pages?.find((pg) => pg.slug === 'home')?.blockTypes ?? def.pages[0]!.blocks.map((b) => b.type));
    const anchors: Array<[BlockType, string]> = [
      ['menu', 'Menu'],
      ['about', 'About'],
      ['hours-location', 'Hours'],
      ['contact', 'Contact'],
    ];
    return anchors.filter(([type]) => present.has(type)).map(([type, label]) => ({ label, href: `/#${type}` }));
  }
  const built = pages ? new Set(pages.map((pg) => pg.slug)) : null;
  return def.pages.filter((pg) => pg.nav && (!built || built.has(pg.slug))).map((pg) => ({ label: pg.nav!, href: `/${pg.slug}` }));
}

/** The copy a venue gave at intake, from which its first pages are written. */
export const defaultPageCopy = z.object({
  tradingName: plainText(120),
  tagline: plainText(240).nullish(),
  about: plainText(4000, { multiline: true }).nullish(),
  heroImageUrl: imageUrl.nullish(),
  galleryImages: z
    .array(z.object({ url: imageUrl, alt: plainText(200) }))
    .max(24)
    .default([]),
  testimonials: z
    .array(z.object({ quote: plainText(600, { multiline: true }), author: plainText(80), source: plainText(80).nullish() }))
    .max(12)
    .default([]),
  faq: z
    .array(z.object({ question: plainText(200), answer: plainText(1500, { multiline: true }) }))
    .max(30)
    .default([]),
  instagramHandle: z
    .string()
    .regex(/^[A-Za-z0-9._]{1,30}$/)
    .nullish(),
  suburb: plainText(80).nullish(),
  /** Which calls to action make sense for this venue. */
  takesBookings: z.boolean().default(false),
  takesOrders: z.boolean().default(false),
});
export type DefaultPageCopy = z.input<typeof defaultPageCopy>;

export interface DefaultPage {
  slug: string;
  title: string;
  blocks: Block[];
  seoTitle: string;
  seoDescription: string | null;
}

/**
 * The pages a new site starts with: the skeleton's composition filled from the venue's own
 * words. A block with nothing to show (a gallery with no photographs, a booking button at a
 * venue that takes no bookings) is left out rather than shown empty. Pure: writes nothing.
 */
export function buildDefaultPages(skeletonKey: SkeletonKey, rawCopy: DefaultPageCopy): DefaultPage[] {
  const copy = defaultPageCopy.parse(rawCopy);
  const def = SKELETONS[skeletonKey];
  const name = copy.tradingName;

  const make = (type: BlockType, page: SkeletonPage): BlockInput | null => {
    const id = def.singlePage ? type : `${page.slug}-${type}`;
    switch (type) {
      case 'hero':
        return {
          type,
          id,
          heading: name,
          subheading: copy.tagline ?? null,
          imageUrl: copy.heroImageUrl ?? null,
          imageAlt: copy.heroImageUrl ? name : null,
          ctaLabel: copy.takesOrders ? 'Order now' : copy.takesBookings ? 'Book a table' : 'See the menu',
          ctaHref: copy.takesOrders || copy.takesBookings ? null : def.singlePage ? '/#menu' : '/menu',
        };
      case 'about':
        return copy.about ? { type, id, heading: `About ${name}`, body: copy.about } : null;
      case 'menu':
        return page.slug === 'home' && !def.singlePage && skeletonKey !== 'menu-forward'
          ? { type, id, heading: 'From the menu', display: 'highlights', itemLimit: 6 }
          : { type, id, heading: 'Menu', display: 'full' };
      case 'gallery':
        return copy.galleryImages.length ? { type, id, images: copy.galleryImages } : null;
      case 'hours-location':
        return { type, id, heading: copy.suburb ? `Find us in ${copy.suburb}` : 'Hours and location' };
      case 'booking-cta':
        return copy.takesBookings ? { type, id, heading: 'Join us', label: 'Book a table' } : null;
      case 'order-cta':
        return copy.takesOrders ? { type, id, heading: 'Order ahead', label: 'Order now' } : null;
      case 'testimonials':
        return copy.testimonials.length ? { type, id, heading: 'What guests say', items: copy.testimonials } : null;
      case 'faq':
        return copy.faq.length ? { type, id, heading: 'Good to know', items: copy.faq } : null;
      case 'contact':
        return { type, id, heading: 'Get in touch' };
      case 'instagram-feed':
        return copy.instagramHandle ? { type, id, handle: copy.instagramHandle } : null;
      // Long-form copy and creator reels are added by the venue later: intake has nothing to fill them with.
      case 'rich-text':
      case 'criota-reel':
        return null;
    }
  };

  const pages: DefaultPage[] = [];
  for (const page of def.pages) {
    const seen = new Set<BlockType>();
    const inputs: BlockInput[] = [];
    for (const placement of page.blocks) {
      if (seen.has(placement.type)) continue;
      seen.add(placement.type);
      const block = make(placement.type, page);
      if (block) inputs.push(block);
    }
    if (!inputs.length) continue;
    const isHome = page.slug === 'home';
    pages.push({
      slug: page.slug,
      title: page.title,
      blocks: blocksSchema.parse(inputs),
      seoTitle: isHome ? name : `${page.title} | ${name}`,
      seoDescription: isHome ? (copy.tagline ?? null) : null,
    });
  }
  return pages;
}
