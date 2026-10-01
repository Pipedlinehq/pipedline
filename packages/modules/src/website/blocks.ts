import { z } from 'zod';
import { newSlug } from '@ros/core';
import { imageUrl, linkUrl, plainText } from './safe';

/**
 * Page content is a list of typed blocks (docs/modules/website.md section 3). A block is data:
 * plain-text fields, validated links, numbers and enums. No block has a field that carries
 * markup or script, and unknown fields are dropped on the way in, so there is nothing for a
 * renderer to mistake for HTML (docs/THREAT_MODEL.md section 6).
 */

export const BLOCK_TYPES = [
  'hero',
  'about',
  'menu',
  'gallery',
  'hours-location',
  'booking-cta',
  'order-cta',
  'testimonials',
  'faq',
  'contact',
  'rich-text',
  'instagram-feed',
  'criota-reel',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

/** Addresses one block on a page (the editor and the assistant tool both use it). */
const blockId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'A block id is lowercase letters, numbers and hyphens.')
  .default(() => newSlug(8));

const heading = plainText(120);
const optionalHeading = heading.nullable().default(null);
const label = plainText(40);

export const heroBlock = z.object({
  type: z.literal('hero'),
  id: blockId,
  heading,
  subheading: plainText(240).nullable().default(null),
  imageUrl: imageUrl.nullable().default(null),
  imageAlt: plainText(200).nullable().default(null),
  ctaLabel: label.nullable().default(null),
  /** Where the button goes. When absent the layout uses the venue's order or booking target. */
  ctaHref: linkUrl.nullable().default(null),
});

export const aboutBlock = z.object({
  type: z.literal('about'),
  id: blockId,
  heading: optionalHeading,
  body: plainText(4000, { multiline: true }),
  imageUrl: imageUrl.nullable().default(null),
  imageAlt: plainText(200).nullable().default(null),
});

/** Carries no menu content: the layout pulls the live menu for the venue. */
export const menuBlock = z.object({
  type: z.literal('menu'),
  id: blockId,
  heading: optionalHeading,
  intro: plainText(600, { multiline: true }).nullable().default(null),
  display: z.enum(['full', 'highlights']).default('full'),
  /** For 'highlights': how many items to show. */
  itemLimit: z.number().int().min(1).max(24).default(6),
  showPrices: z.boolean().default(true),
});

export const galleryBlock = z.object({
  type: z.literal('gallery'),
  id: blockId,
  heading: optionalHeading,
  images: z
    .array(z.object({ url: imageUrl, alt: plainText(200), caption: plainText(200).nullable().default(null) }))
    .min(1)
    .max(24),
});

/** Address, map and trading hours come from the venue record, not from this block. */
export const hoursLocationBlock = z.object({
  type: z.literal('hours-location'),
  id: blockId,
  heading: optionalHeading,
  note: plainText(400, { multiline: true }).nullable().default(null),
  showMap: z.boolean().default(true),
});

const ctaFields = {
  heading,
  body: plainText(600, { multiline: true }).nullable().default(null),
  label,
  /** When absent the layout uses the venue's configured target. */
  href: linkUrl.nullable().default(null),
};

export const bookingCtaBlock = z.object({ type: z.literal('booking-cta'), id: blockId, ...ctaFields });
export const orderCtaBlock = z.object({ type: z.literal('order-cta'), id: blockId, ...ctaFields });

export const testimonialsBlock = z.object({
  type: z.literal('testimonials'),
  id: blockId,
  heading: optionalHeading,
  items: z
    .array(z.object({ quote: plainText(600, { multiline: true }), author: plainText(80), source: plainText(80).nullable().default(null) }))
    .min(1)
    .max(12),
});

export const faqBlock = z.object({
  type: z.literal('faq'),
  id: blockId,
  heading: optionalHeading,
  items: z
    .array(z.object({ question: plainText(200), answer: plainText(1500, { multiline: true }) }))
    .min(1)
    .max(30),
});

/** Phone, email and address come from the venue record; the block chooses which to show. */
export const contactBlock = z.object({
  type: z.literal('contact'),
  id: blockId,
  heading: optionalHeading,
  body: plainText(800, { multiline: true }).nullable().default(null),
  showPhone: z.boolean().default(true),
  showEmail: z.boolean().default(true),
  showAddress: z.boolean().default(true),
});

/** Long-form copy as structured paragraphs. There is no HTML and no inline markup. */
export const richTextParagraph = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), text: plainText(3000, { multiline: true }) }),
  z.object({ kind: z.literal('subheading'), text: plainText(160) }),
  z.object({ kind: z.literal('quote'), text: plainText(800, { multiline: true }), attribution: plainText(120).nullable().default(null) }),
  z.object({ kind: z.literal('list'), items: z.array(plainText(300)).min(1).max(30) }),
]);

export const richTextBlock = z.object({
  type: z.literal('rich-text'),
  id: blockId,
  heading: optionalHeading,
  paragraphs: z.array(richTextParagraph).min(1).max(60),
});

export const instagramFeedBlock = z.object({
  type: z.literal('instagram-feed'),
  id: blockId,
  heading: optionalHeading,
  handle: z.string().regex(/^[A-Za-z0-9._]{1,30}$/, 'Enter the Instagram handle without the @.'),
  count: z.number().int().min(3).max(12).default(6),
});

/** Creator videos from Criota, shown on the venue's own site. The layout loads them by campaign. */
export const criotaReelBlock = z.object({
  type: z.literal('criota-reel'),
  id: blockId,
  heading: optionalHeading,
  campaignId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .nullable()
    .default(null),
  limit: z.number().int().min(1).max(12).default(6),
  layout: z.enum(['carousel', 'grid']).default('carousel'),
});

export const blockSchema = z.discriminatedUnion('type', [
  heroBlock,
  aboutBlock,
  menuBlock,
  galleryBlock,
  hoursLocationBlock,
  bookingCtaBlock,
  orderCtaBlock,
  testimonialsBlock,
  faqBlock,
  contactBlock,
  richTextBlock,
  instagramFeedBlock,
  criotaReelBlock,
]);
export type Block = z.infer<typeof blockSchema>;
export type BlockInput = z.input<typeof blockSchema>;

export const MAX_BLOCKS_PER_PAGE = 40;

/** A page's blocks, in order. Ids are unique within the page. */
export const blocksSchema = z
  .array(blockSchema)
  .max(MAX_BLOCKS_PER_PAGE)
  .superRefine((blocks, issue) => {
    const seen = new Set<string>();
    blocks.forEach((b, i) => {
      if (seen.has(b.id)) issue.addIssue({ code: 'custom', path: [i, 'id'], message: 'Two sections on this page have the same id.' });
      seen.add(b.id);
    });
  });

/** The single-value text fields of each block type: what the copy tool may change. */
export const BLOCK_TEXT_FIELDS: Record<BlockType, readonly string[]> = {
  hero: ['heading', 'subheading', 'ctaLabel', 'imageAlt'],
  about: ['heading', 'body', 'imageAlt'],
  menu: ['heading', 'intro'],
  gallery: ['heading'],
  'hours-location': ['heading', 'note'],
  'booking-cta': ['heading', 'body', 'label'],
  'order-cta': ['heading', 'body', 'label'],
  testimonials: ['heading'],
  faq: ['heading'],
  contact: ['heading', 'body'],
  'rich-text': ['heading'],
  'instagram-feed': ['heading'],
  'criota-reel': ['heading'],
};

/**
 * Blocks as stored, read back defensively: anything that no longer validates is left out
 * rather than handed to a renderer.
 */
export function readBlocks(stored: unknown): Block[] {
  if (!Array.isArray(stored)) return [];
  const out: Block[] = [];
  for (const raw of stored) {
    const parsed = blockSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
