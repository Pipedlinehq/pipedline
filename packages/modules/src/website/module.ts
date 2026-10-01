import { z } from 'zod';
import { type Ctx, AppError, assertModule, defineEvent, defineModule, getModule } from '@ros/core';
import { BLOCK_TYPES } from './blocks';
import { httpsUrlOn, linkUrl, plainText } from './safe';
import { SKELETON_KEYS } from './skeletons';

const navItem = z.object({ label: plainText(40), href: linkUrl });

/** Social profiles, each accepted only on its own site so a link cannot be pointed anywhere else. */
export const socialLinks = z.object({
  instagram: httpsUrlOn(['instagram.com']).nullable().default(null),
  facebook: httpsUrlOn(['facebook.com']).nullable().default(null),
  tiktok: httpsUrlOn(['tiktok.com']).nullable().default(null),
  x: httpsUrlOn(['x.com', 'twitter.com']).nullable().default(null),
  youtube: httpsUrlOn(['youtube.com']).nullable().default(null),
  tripadvisor: httpsUrlOn(['tripadvisor.com', 'tripadvisor.com.au']).nullable().default(null),
  googleBusiness: httpsUrlOn(['google.com', 'g.page', 'goo.gl']).nullable().default(null),
});
export type SocialLinks = z.infer<typeof socialLinks>;

/**
 * Third-party tags, as ids only. There is no free "head snippet": we write the script for each
 * integration ourselves and a venue supplies nothing but an id that matches the provider's own
 * format (docs/THREAT_MODEL.md section 6 and open item 9).
 */
export const integrations = z.object({
  /** Google Analytics 4 measurement id, e.g. G-AB12CD34EF. */
  googleAnalyticsId: z
    .string()
    .regex(/^G-[A-Z0-9]{6,12}$/, 'A Google Analytics id looks like G-AB12CD34EF.')
    .nullable()
    .default(null),
  /** Meta (Facebook) pixel id: digits only. */
  metaPixelId: z
    .string()
    .regex(/^\d{10,20}$/, 'A Meta pixel id is 10 to 20 digits.')
    .nullable()
    .default(null),
  /** Google Search Console ownership token, for the verification meta tag. */
  googleSiteVerification: z
    .string()
    .regex(/^[A-Za-z0-9_-]{20,100}$/, 'Paste only the code from the verification tag.')
    .nullable()
    .default(null),
});
export type Integrations = z.infer<typeof integrations>;

/** Config surface: docs/modules/website.md section 7. One per venue, in venue_modules.config. */
export const websiteConfig = z.object({
  /** A venue's own layout skeleton. null follows the org's brand. */
  skeleton: z.enum(SKELETON_KEYS).nullable().default(null),
  /** Block types this venue's pages may show. A block of a type switched off here stays stored and is hidden. */
  enabledBlocks: z.array(z.enum(BLOCK_TYPES)).default([...BLOCK_TYPES]),
  /** The site navigation. null uses the skeleton's default for the pages that exist. */
  navItems: z.array(navItem).max(8).nullable().default(null),
  /** Where "Book" buttons go when a block does not say. */
  bookingCtaTarget: linkUrl.nullable().default(null),
  /** Where "Order" buttons go when a block does not say. */
  orderCtaTarget: linkUrl.nullable().default(null),
  socialLinks: socialLinks.default(socialLinks.parse({})),
  integrations: integrations.default(integrations.parse({})),
});
export type WebsiteConfig = z.infer<typeof websiteConfig>;

export const websiteModule = defineModule({
  key: 'website',
  name: 'Website',
  description: 'Brand tokens, layout skeleton, pages built from typed blocks, media, redirects.',
  dependsOn: [],
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
