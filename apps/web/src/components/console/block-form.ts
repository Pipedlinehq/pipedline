import type { website } from '@ros/modules';

/**
 * Page blocks to and from plain form fields. Every field is text, a number, a yes/no or a choice
 * from a list: there is no way to type markup into a block. The website service validates the
 * whole page again when it is saved, and its message is what the person sees.
 */
type Block = website.Block;
type BlockType = website.BlockType;

export const BLOCK_LABELS: Record<BlockType, string> = {
  hero: 'Hero (big opening image and headline)',
  about: 'About',
  menu: 'Live menu',
  gallery: 'Photo gallery',
  'hours-location': 'Hours and location',
  'booking-cta': 'Book a table button',
  'order-cta': 'Order online button',
  testimonials: 'What guests say',
  faq: 'Questions and answers',
  contact: 'Contact details',
  'rich-text': 'Text',
  'instagram-feed': 'Instagram feed',
  'criota-reel': 'Creator videos',
};

const s = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const orNull = (fd: FormData, k: string) => s(fd, k) || null;
const num = (fd: FormData, k: string, fallback: number) => {
  const v = Number(s(fd, k));
  return s(fd, k) !== '' && Number.isFinite(v) ? Math.trunc(v) : fallback;
};
const yes = (fd: FormData, k: string) => fd.get(k) === 'on';
const list = (fd: FormData, k: string) => fd.getAll(k).map((v) => (typeof v === 'string' ? v.trim() : ''));

/** The block as a person filled it in. Unknown or blank rows are dropped. */
export function blockFromForm(type: BlockType, id: string, fd: FormData): unknown {
  const base = { type, id };
  switch (type) {
    case 'hero':
      return { ...base, heading: s(fd, 'heading'), subheading: orNull(fd, 'subheading'), imageUrl: orNull(fd, 'imageUrl'), imageAlt: orNull(fd, 'imageAlt'), ctaLabel: orNull(fd, 'ctaLabel'), ctaHref: orNull(fd, 'ctaHref') };
    case 'about':
      return { ...base, heading: orNull(fd, 'heading'), body: s(fd, 'body'), imageUrl: orNull(fd, 'imageUrl'), imageAlt: orNull(fd, 'imageAlt') };
    case 'menu':
      return { ...base, heading: orNull(fd, 'heading'), intro: orNull(fd, 'intro'), display: s(fd, 'display') === 'highlights' ? 'highlights' : 'full', itemLimit: num(fd, 'itemLimit', 6), showPrices: yes(fd, 'showPrices') };
    case 'gallery': {
      const urls = list(fd, 'images.url');
      const alts = list(fd, 'images.alt');
      const captions = list(fd, 'images.caption');
      const images = urls.map((url, i) => ({ url, alt: alts[i] ?? '', caption: captions[i] || null })).filter((x) => x.url);
      return { ...base, heading: orNull(fd, 'heading'), images };
    }
    case 'hours-location':
      return { ...base, heading: orNull(fd, 'heading'), note: orNull(fd, 'note'), showMap: yes(fd, 'showMap') };
    case 'booking-cta':
    case 'order-cta':
      return { ...base, heading: s(fd, 'heading'), body: orNull(fd, 'body'), label: s(fd, 'label'), href: orNull(fd, 'href') };
    case 'testimonials': {
      const quotes = list(fd, 'items.quote');
      const authors = list(fd, 'items.author');
      const sources = list(fd, 'items.source');
      return { ...base, heading: orNull(fd, 'heading'), items: quotes.map((quote, i) => ({ quote, author: authors[i] ?? '', source: sources[i] || null })).filter((x) => x.quote) };
    }
    case 'faq': {
      const qs = list(fd, 'items.question');
      const as = list(fd, 'items.answer');
      return { ...base, heading: orNull(fd, 'heading'), items: qs.map((question, i) => ({ question, answer: as[i] ?? '' })).filter((x) => x.question) };
    }
    case 'contact':
      return { ...base, heading: orNull(fd, 'heading'), body: orNull(fd, 'body'), showPhone: yes(fd, 'showPhone'), showEmail: yes(fd, 'showEmail'), showAddress: yes(fd, 'showAddress') };
    case 'rich-text': {
      const kinds = list(fd, 'p.kind');
      const texts = list(fd, 'p.text');
      const attributions = list(fd, 'p.attribution');
      const paragraphs = kinds
        .map((kind, i) => {
          const text = texts[i] ?? '';
          if (!text) return null;
          if (kind === 'list') return { kind, items: text.split('\n').map((x) => x.trim()).filter(Boolean) };
          if (kind === 'quote') return { kind, text, attribution: attributions[i] || null };
          if (kind === 'subheading') return { kind, text };
          return { kind: 'paragraph', text };
        })
        .filter(Boolean);
      return { ...base, heading: orNull(fd, 'heading'), paragraphs };
    }
    case 'instagram-feed':
      return { ...base, heading: orNull(fd, 'heading'), handle: s(fd, 'handle').replace(/^@/, ''), count: num(fd, 'count', 6) };
    case 'criota-reel':
      return { ...base, heading: orNull(fd, 'heading'), campaignId: orNull(fd, 'campaignId'), limit: num(fd, 'limit', 6), layout: s(fd, 'layout') === 'grid' ? 'grid' : 'carousel' };
  }
}

/** A new block with starter words the person replaces. Returns null when the block needs something only they can give. */
export function starterBlock(type: BlockType, id: string, ctx: { firstImage: string | null; venueName: string; instagramHandle: string | null }): unknown | null {
  const base = { type, id };
  switch (type) {
    case 'hero':
      return { ...base, heading: ctx.venueName };
    case 'about':
      return { ...base, heading: 'About us', body: `A few sentences about ${ctx.venueName}.` };
    case 'menu':
      return { ...base, heading: 'Menu' };
    case 'gallery':
      return ctx.firstImage ? { ...base, heading: 'Gallery', images: [{ url: ctx.firstImage, alt: 'Photo' }] } : null;
    case 'hours-location':
      return { ...base, heading: 'Hours and location' };
    case 'booking-cta':
      return { ...base, heading: 'Book a table', label: 'Book now' };
    case 'order-cta':
      return { ...base, heading: 'Order for pickup', label: 'Order now' };
    case 'testimonials':
      return { ...base, heading: 'What guests say', items: [{ quote: 'A few words from a guest.', author: 'A guest' }] };
    case 'faq':
      return { ...base, heading: 'Questions', items: [{ question: 'Do you take walk-ins?', answer: 'Yes.' }] };
    case 'contact':
      return { ...base, heading: 'Get in touch' };
    case 'rich-text':
      return { ...base, heading: null, paragraphs: [{ kind: 'paragraph', text: 'Write here.' }] };
    case 'instagram-feed':
      return ctx.instagramHandle ? { ...base, heading: 'On Instagram', handle: ctx.instagramHandle } : null;
    case 'criota-reel':
      return { ...base, heading: 'From our creators' };
  }
}

export type { Block, BlockType };
