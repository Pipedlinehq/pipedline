import { z } from 'zod';
import { type Ctx, AppError, assertModule, defineEvent, defineModule, getModule } from '@ros/core';
import { BLOCK_TYPES } from './blocks';
import { httpsUrlOn, linkUrl, plainText } from './safe';
import { SKELETON_KEYS } from './skeletons';

const navItem = z
  .object({
    label: plainText(40).describe('The words shown for this entry, e.g. "Menu" or "Book a table". Plain text, up to 40 characters.'),
    href: linkUrl.describe('Where it goes: a page on this site such as /menu, or a full https:// address.'),
  })
  .describe('One entry in the site\'s navigation: the words shown and where it goes.');

/** Social profiles, each accepted only on its own site so a link cannot be pointed anywhere else. */
export const socialLinks = z
  .object({
    instagram: httpsUrlOn(['instagram.com']).nullable().default(null).describe('The full https:// address of the venue\'s Instagram profile. Empty: no Instagram link is shown.'),
    facebook: httpsUrlOn(['facebook.com']).nullable().default(null).describe('The full https:// address of the venue\'s Facebook page. Empty: no Facebook link is shown.'),
    tiktok: httpsUrlOn(['tiktok.com']).nullable().default(null).describe('The full https:// address of the venue\'s TikTok profile. Empty: no TikTok link is shown.'),
    x: httpsUrlOn(['x.com', 'twitter.com']).nullable().default(null).describe('The full https:// address of the venue\'s X (Twitter) profile. Empty: no X link is shown.'),
    youtube: httpsUrlOn(['youtube.com']).nullable().default(null).describe('The full https:// address of the venue\'s YouTube channel. Empty: no YouTube link is shown.'),
    tripadvisor: httpsUrlOn(['tripadvisor.com', 'tripadvisor.com.au'])
      .nullable()
      .default(null)
      .describe('The full https:// address of the venue\'s Tripadvisor page. Empty: no Tripadvisor link is shown.'),
    googleBusiness: httpsUrlOn(['google.com', 'g.page', 'goo.gl'])
      .nullable()
      .default(null)
      .describe('The full https:// address of the venue\'s Google Business Profile or Google Maps listing (google.com, g.page or goo.gl). Empty: no Google link is shown.'),
  })
  .describe('Links to the venue\'s profiles elsewhere, shown on the site. Each is accepted only on its own service, so a link cannot be pointed anywhere else. Leave one empty to hide it.');
export type SocialLinks = z.infer<typeof socialLinks>;

/**
 * Third-party tags, as ids only. There is no free "head snippet": we write the script for each
 * integration ourselves and a venue supplies nothing but an id that matches the provider's own
 * format (docs/THREAT_MODEL.md section 6 and open item 9).
 */
export const integrations = z
  .object({
    /** Google Analytics 4 measurement id, e.g. G-AB12CD34EF. */
    googleAnalyticsId: z
      .string()
      .regex(/^G-[A-Z0-9]{6,12}$/, 'A Google Analytics id looks like G-AB12CD34EF.')
      .nullable()
      .default(null)
      .describe('Your Google Analytics measurement ID, so visits to the site are counted in your Google Analytics account. It looks like G-AB12CD34EF. Empty: no Google Analytics.'),
    /** Meta (Facebook) pixel id: digits only. */
    metaPixelId: z
      .string()
      .regex(/^\d{10,20}$/, 'A Meta pixel id is 10 to 20 digits.')
      .nullable()
      .default(null)
      .describe('Your Meta (Facebook and Instagram) pixel ID, so Meta can count visits from your ads. Digits only, 10 to 20 of them. Empty: no Meta pixel.'),
    /** Google Search Console ownership token, for the verification meta tag. */
    googleSiteVerification: z
      .string()
      .regex(/^[A-Za-z0-9_-]{20,100}$/, 'Paste only the code from the verification tag.')
      .nullable()
      .default(null)
      .describe('The code Google Search Console gives you to prove you own the site. Paste only the code from the tag Google shows, not the whole tag. Empty: none.'),
  })
  .describe('Google and Meta tracking codes (integrations), as IDs only. Pipedline adds the right code to the site for each; nothing else can be pasted in.');
export type Integrations = z.infer<typeof integrations>;

/** Config surface: docs/modules/website.md section 7. One per venue, in venue_modules.config. */
export const websiteConfig = z.object({
  /** A venue's own layout skeleton. null follows the org's brand. */
  skeleton: z
    .enum(SKELETON_KEYS)
    .nullable()
    .default(null)
    .describe('The page layout this venue\'s site uses: hero-photo, editorial, menu-forward, minimal, split-panel or single-scroll. Empty (the default): the layout chosen for the organisation\'s brand.'),
  /** Block types this venue's pages may show. A block of a type switched off here stays stored and is hidden. */
  enabledBlocks: z
    .array(z.enum(BLOCK_TYPES).describe('One kind of block, e.g. hero, menu, gallery, hours-location, booking-cta.'))
    .default([...BLOCK_TYPES])
    .describe('The kinds of block this venue\'s pages may show, e.g. hero, about, menu, gallery, hours-location, booking-cta, order-cta, testimonials, faq, contact. A block of a kind switched off here is kept but hidden. Default: every kind.'),
  /** The site navigation. null uses the skeleton's default for the pages that exist. */
  navItems: z
    .array(navItem)
    .max(8)
    .nullable()
    .default(null)
    .describe('The site\'s navigation, up to eight entries, each with the words shown and where it goes. Empty (the default): the layout\'s standard navigation for the pages that exist.'),
  /** Where "Book" buttons go when a block does not say. */
  bookingCtaTarget: linkUrl
    .nullable()
    .default(null)
    .describe('Where "Book" buttons go when a block does not set its own link: a page on this site such as /book, or a full https:// address (e.g. a bookings service). Empty (the default): a booking block with no link of its own shows "Call … to book" with the venue\'s phone number instead.'),
  /** Where "Order" buttons go when a block does not say. */
  orderCtaTarget: linkUrl
    .nullable()
    .default(null)
    .describe('Where "Order" buttons go when a block does not set its own link: a page on this site, or a full https:// address. Empty (the default): the site\'s own /order page.'),
  socialLinks: socialLinks
    .default(socialLinks.parse({}))
    .describe('Links to the venue\'s profiles elsewhere (Instagram, Facebook, TikTok, X, YouTube, Tripadvisor, Google), shown on the site. Each is accepted only on its own service. Leave one empty to hide it.'),
  integrations: integrations
    .default(integrations.parse({}))
    .describe('Google and Meta tracking codes (integrations), as IDs only: Google Analytics, the Meta pixel and the Google Search Console verification code. Pipedline adds the right code to the site for each; nothing else can be pasted in.'),
});
export type WebsiteConfig = z.infer<typeof websiteConfig>;

export const websiteModule = defineModule({
  key: 'website',
  name: 'Website',
  description: 'Brand tokens, layout skeleton, pages built from typed blocks, media, redirects.',
  dependsOn: [],
  manifest: {
    name: 'Website',
    purpose: 'The venue\'s own site: pages built from blocks, brand colours and logo, the menu, opening hours, book and order buttons, on a Pipedline address or the venue\'s own domain.',
    category: 'channels',
    kind: 'channel',
    needs: ['Nothing to connect. Every venue gets a Pipedline address; a domain of the venue\'s own is optional.'],
    reads: ['venue details and opening hours', 'the menu', 'the specials board, where it is on'],
    writes: ['pages, brand kit, images and redirects'],
    publicAddress: ({ siteOrigin }) => siteOrigin,
  },
  tables: ['brands', 'pages', 'media', 'redirects'],
  configSchema: websiteConfig,
  configVersion: 1,
  defaultConfig: websiteConfig.parse({}),
});

export const pagePublished = defineEvent({
  name: 'page.published',
  module: 'website',
  description: 'A page on the venue\'s site was published or republished.',
  properties: z.object({
    page_id: z.string(),
    slug: z.string(),
    scope: z.enum(['org', 'venue']),
    blocks: z.number().int(),
    via: z.enum(['console', 'assistant', 'provisioning']),
  }),
});

export const pageUnpublished = defineEvent({
  name: 'page.unpublished',
  module: 'website',
  description: 'A page was taken off the venue\'s site.',
  properties: z.object({ page_id: z.string(), slug: z.string(), scope: z.enum(['org', 'venue']) }),
});

export const brandUpdated = defineEvent({
  name: 'brand.updated',
  module: 'website',
  description: 'The brand tokens, logo or layout skeleton changed.',
  properties: z.object({ scope: z.enum(['org', 'venue']), skeleton: z.string() }),
});

export interface WebsiteScope {
  config: WebsiteConfig;
  /** The venue whose config applies: the venue asked for, or the first venue with the website on. */
  configVenueId: string;
  /** Every venue with the website switched on, oldest first. */
  venueIds: string[];
}

const DISABLED = () => new AppError('module_disabled', 'That is not available at this venue.');

/**
 * The module guard for website surfaces. A venue's own site needs the module on at that venue.
 * The org-level site (venueId null: a single-venue org, or a group's brand site) is available
 * when the module is on at any venue, and takes its config from the first such venue.
 */
export async function assertWebsite(ctx: Ctx, venueId: string | null | undefined): Promise<WebsiteScope> {
  const rows = await ctx.db
    .selectFrom('venue_modules as vm')
    .innerJoin('venues as v', 'v.id', 'vm.venue_id')
    .select('vm.venue_id')
    .where('vm.module_key', '=', websiteModule.key)
    .where('vm.enabled', '=', true)
    .orderBy('v.created_at')
    .orderBy('v.id')
    .execute();
  const venueIds = rows.map((r) => r.venue_id);
  if (venueId) {
    const config = await assertModule(ctx, venueId, websiteModule);
    return { config, configVenueId: venueId, venueIds };
  }
  const first = venueIds[0];
  if (!first) throw DISABLED();
  const state = await getModule(ctx, first, websiteModule);
  return { config: state.config, configVenueId: first, venueIds };
}
