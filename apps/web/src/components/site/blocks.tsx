import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { menu, website } from '@ros/modules';
import { type SiteScope, scopedHref } from '@/lib/site-scope';
import type { TableContext } from '@/lib/site-table';
import { Address, HoursTable, OpenNow, directionsUrl } from './chrome';
import { TrackedLink } from './client-bits';
import { cx, paragraphs } from './format';
import { FullMenu, MenuHighlights } from './menu-view';

/**
 * Page blocks, rendered as data. Every string a venue wrote goes into the page as text: no
 * block has a field that is treated as markup, and nothing here uses dangerouslySetInnerHTML.
 */

export type Block = website.Block;
export type SkeletonKey = website.SkeletonKey;
export type Region = website.Region;

export interface BlockContext {
  scope: SiteScope;
  pageSlug: string;
  skeleton: SkeletonKey;
  region: Region;
  /** The live menu of the scope's venue, when a menu block is on the page. */
  menu: menu.PublicMenu | null;
  /** Active dietary filters from the address. */
  diet: string[];
  /** This page's own path, for the menu filter form. */
  path: string;
  table: TableContext | null;
  /** True for the block whose heading is the page's one h1. */
  isH1: boolean;
  /** An id for the section, unique on the page (an anchor for single-scroll navigation). */
  anchor: string;
}

const orderingOn = (scope: SiteScope) => (scope.venue ? scope.view.enabledModules.includes('ordering') : scope.view.venues.length > 0);

function orderHref(scope: SiteScope, href: string | null): string {
  return scopedHref(scope.basePath, href ?? scope.view.config.orderCtaTarget ?? '/order');
}

function Heading({ ctx, text, className }: { ctx: BlockContext; text: string | null; className?: string }) {
  if (!text) return null;
  const Tag = ctx.isH1 ? 'h1' : 'h2';
  return (
    <Tag id={`${ctx.anchor}-h`} className={cx('s-heading', className)}>
      {text}
    </Tag>
  );
}

function Paras({ text, className, dropcap }: { text: string | null; className?: string; dropcap?: boolean }) {
  return (
    <>
      {paragraphs(text).map((p, i) => (
        <p key={i} className={cx('whitespace-pre-line', className, dropcap && i === 0 && p.length > 180 && 's-dropcap')}>
          {p}
        </p>
      ))}
    </>
  );
}

function ctaTarget(ctx: BlockContext, block: Extract<Block, { type: 'hero' }>): { href: string; kind: 'order' | 'booking' | 'other' } | null {
  const { scope } = ctx;
  if (block.ctaHref) return { href: scopedHref(scope.basePath, block.ctaHref), kind: 'other' };
  if (orderingOn(scope)) return { href: orderHref(scope, null), kind: 'order' };
  if (scope.view.config.bookingCtaTarget) return { href: scope.view.config.bookingCtaTarget, kind: 'booking' };
  return { href: scopedHref(scope.basePath, scope.view.skeleton.singlePage ? '/#menu' : '/menu'), kind: 'other' };
}

function CtaButton({ target, label, className }: { target: { href: string; kind: 'order' | 'booking' | 'other' } | null; label: string | null; className?: string }) {
  if (!target || !label) return null;
  if (target.kind === 'booking' || /^https?:/.test(target.href)) {
    return (
      <TrackedLink href={target.href} kind={target.kind === 'other' ? 'other' : target.kind} className={className ?? 's-btn'} external={/^https?:/.test(target.href)}>
        {label}
      </TrackedLink>
    );
  }
  return (
    <Link href={target.href} className={className ?? 's-btn'}>
      {label}
    </Link>
  );
}

function HeroBlock({ block, ctx }: { block: Extract<Block, { type: 'hero' }>; ctx: BlockContext }) {
  const target = ctaTarget(ctx, block);
  const img = block.imageUrl;
  const alt = block.imageAlt ?? '';
  const inLead = ctx.region === 'lead';
  const sub = block.subheading ? <p className="max-w-2xl text-lg sm:text-xl">{block.subheading}</p> : null;

  if (!inLead) {
    return (
      <div className="space-y-4">
        <Heading ctx={ctx} text={block.heading} />
        {sub}
        <CtaButton target={target} label={block.ctaLabel} />
      </div>
    );
  }

  switch (ctx.skeleton) {
    case 'hero-photo':
      return img ? (
        <div className="s-on-dark relative isolate flex min-h-[62vh] items-end overflow-hidden text-white sm:min-h-[72vh]">
          <Image src={img} alt={alt} fill unoptimized priority className="-z-10 object-cover" style={{ filter: 'var(--brand-image-filter)' }} sizes="100vw" />
          <div className="s-hero-shade absolute inset-0 -z-10" />
          <div className="mx-auto w-full max-w-6xl space-y-5 px-4 pb-14 sm:px-6">
            <Heading ctx={ctx} text={block.heading} className="s-display" />
            {sub}
            <div className="flex flex-wrap gap-3">
              <CtaButton target={target} label={block.ctaLabel} />
              <Link href={scopedHref(ctx.scope.basePath, '/menu')} className="s-btn-outline">
                See the menu
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="s-primary-bg">
          <div className="mx-auto flex min-h-[52vh] max-w-6xl flex-col justify-end space-y-5 px-4 py-14 sm:px-6">
            <Heading ctx={ctx} text={block.heading} className="s-display" />
            {sub}
            <div className="flex flex-wrap gap-3">
              <CtaButton target={target} label={block.ctaLabel} />
              <Link href={scopedHref(ctx.scope.basePath, '/menu')} className="s-btn-outline" style={{ color: 'inherit', borderColor: 'currentColor' }}>
                See the menu
              </Link>
            </div>
          </div>
        </div>
      );
    case 'editorial':
      return (
        <div className="mx-auto max-w-6xl px-4 pt-16 pb-10 sm:px-6 sm:pt-28">
          <p className="mb-6 text-sm tracking-[0.2em] uppercase">{ctx.scope.venue?.suburb ?? ctx.scope.view.org.name}</p>
          <Heading ctx={ctx} text={block.heading} className="s-display max-w-4xl" />
          {block.subheading ? <p className="mt-8 max-w-xl text-xl italic sm:text-2xl" style={{ fontFamily: 'var(--brand-font-heading)' }}>{block.subheading}</p> : null}
          <div className="mt-10">
            <CtaButton target={target} label={block.ctaLabel} className="s-btn-quiet px-0 text-lg" />
          </div>
          {img ? <Image src={img} alt={alt} width={1600} height={800} unoptimized priority className="s-img mt-14" style={{ aspectRatio: '21 / 9' }} /> : <hr className="s-rule mt-14 border-t-2" />}
        </div>
      );
    case 'menu-forward':
      return (
        <div className="s-alt border-b s-rule">
          <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <Heading ctx={ctx} text={block.heading} className="text-3xl sm:text-4xl" />
              {block.subheading ? <p className="mt-1">{block.subheading}</p> : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <OpenNow openNow={ctx.scope.openNow} />
              <CtaButton target={target} label={block.ctaLabel} />
            </div>
          </div>
        </div>
      );
    case 'minimal':
      return (
        <div className="mx-auto flex min-h-[64vh] max-w-2xl flex-col items-center justify-center gap-6 px-4 py-20 text-center">
          <Heading ctx={ctx} text={block.heading} className="s-display" />
          {block.subheading ? <p className="text-lg">{block.subheading}</p> : null}
          <CtaButton target={target} label={block.ctaLabel} className="s-btn-outline" />
        </div>
      );
    case 'split-panel':
      return (
        <div className="space-y-6">
          {img ? <Image src={img} alt={alt} width={1200} height={900} unoptimized priority className="s-img" /> : <div aria-hidden="true" className="s-primary-bg h-3 w-24 rounded-[var(--brand-radius-pill)]" />}
          <Heading ctx={ctx} text={block.heading} className="s-display" />
          {sub}
          <CtaButton target={target} label={block.ctaLabel} />
        </div>
      );
    case 'single-scroll':
      return (
        <div className={cx('relative isolate flex min-h-[80vh] items-center overflow-hidden', img ? 's-on-dark text-white' : 's-primary-bg')}>
          {img ? (
            <>
              <Image src={img} alt={alt} fill unoptimized priority className="-z-10 object-cover" sizes="100vw" />
              <div className="s-hero-shade absolute inset-0 -z-10" />
            </>
          ) : null}
          <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-20 text-center sm:px-6">
            <Heading ctx={ctx} text={block.heading} className="s-display" />
            {block.subheading ? <p className="text-xl">{block.subheading}</p> : null}
            <div className="flex flex-wrap justify-center gap-3">
              <CtaButton target={target} label={block.ctaLabel} />
              <a href="#menu" className="s-btn-outline" style={{ color: 'inherit', borderColor: 'currentColor' }}>
                Jump to the menu
              </a>
            </div>
          </div>
        </div>
      );
  }
}

function MenuBlock({ block, ctx }: { block: Extract<Block, { type: 'menu' }>; ctx: BlockContext }) {
  const { scope } = ctx;
  const showPrices = block.showPrices && (ctx.table ? ctx.table.showPrices : true);
  return (
    <div className="space-y-6">
      <Heading ctx={ctx} text={block.heading ?? 'Menu'} />
      <Paras text={block.intro} />
      {!scope.venue ? (
        <VenuePicker scope={scope} path="/menu" verb="See the menu at" compact={ctx.region === 'aside'} />
      ) : !ctx.menu ? (
        <p className="s-notice">The menu is not available right now.</p>
      ) : block.display === 'highlights' ? (
        <MenuHighlights data={ctx.menu} limit={block.itemLimit} showPrices={showPrices} moreHref={scopedHref(scope.basePath, scope.view.skeleton.singlePage ? '/menu' : '/menu')} />
      ) : (
        <FullMenu data={ctx.menu} diet={ctx.diet} action={ctx.path} showPrices={showPrices} table={ctx.table} />
      )}
    </div>
  );
}

/** A group's org-level site: choose a location for anything that belongs to one venue. */
export function VenuePicker({ scope, path, verb, compact }: { scope: SiteScope; path: string; verb: string; compact?: boolean }) {
  if (compact) {
    return (
      <div>
        <p className="mb-2 font-semibold">{verb}:</p>
        <ul className="space-y-2">
          {scope.view.venues.map((v) => (
            <li key={v.id}>
              <Link href={`/at/${v.slug}${path === '/' ? '' : path}`} className="s-link font-semibold">
                {v.name}
              </Link>
              <span className="block text-sm">{[v.addressLine1, v.suburb].filter(Boolean).join(', ')}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div>
      <p className="mb-3 font-semibold">{verb}:</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {scope.view.venues.map((v) => (
          <li key={v.id}>
            <Link href={`/at/${v.slug}${path === '/' ? '' : path}`} className="s-card flex h-full flex-col gap-1 p-5 no-underline hover:border-[var(--brand-color-text)]">
              <span className="s-heading text-xl">{v.name}</span>
              <span className="text-sm">{[v.addressLine1, v.suburb].filter(Boolean).join(', ')}</span>
              <span className="s-link mt-2 text-sm font-semibold">Choose {v.name.replace(scope.view.org.name, '').trim() || v.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HoursLocationBlock({ block, ctx }: { block: Extract<Block, { type: 'hours-location' }>; ctx: BlockContext }) {
  const { scope } = ctx;
  const venue = scope.venue;
  if (!venue) {
    return (
      <div className="space-y-4">
        <Heading ctx={ctx} text={block.heading ?? 'Our locations'} />
        <Paras text={block.note} />
        <VenuePicker scope={scope} path="/" verb="Hours and directions for" compact={ctx.region === 'aside'} />
      </div>
    );
  }
  const maps = directionsUrl(venue);
  return (
    <div className="space-y-5">
      <Heading ctx={ctx} text={block.heading ?? 'Hours and location'} />
      <div className={cx('grid gap-8', ctx.region !== 'aside' && 'sm:grid-cols-2')}>
        <div className="space-y-3">
          <Address venue={venue} />
          {block.showMap && maps ? (
            <TrackedLink href={maps} kind="directions" className="s-btn-outline" external>
              Open in maps
            </TrackedLink>
          ) : null}
          {venue.phone ? (
            <p>
              <TrackedLink href={`tel:${venue.phone.replace(/\s+/g, '')}`} kind="call" className="s-link">
                {venue.phone}
              </TrackedLink>
            </p>
          ) : null}
        </div>
        <div className="space-y-3">
          <OpenNow openNow={scope.openNow} />
          <HoursTable hours={scope.view.hours} exceptions={scope.view.hourExceptions} />
        </div>
      </div>
      <Paras text={block.note} className="text-sm" />
    </div>
  );
}

function CtaBlock({ block, ctx }: { block: Extract<Block, { type: 'booking-cta' | 'order-cta' }>; ctx: BlockContext }) {
  const { scope } = ctx;
  let button: ReactNode = null;
  if (block.type === 'order-cta') {
    if (!orderingOn(scope)) return null;
    button = (
      <Link href={orderHref(scope, block.href)} className="s-btn">
        {block.label}
      </Link>
    );
  } else {
    const href = block.href ?? scope.view.config.bookingCtaTarget;
    if (href) {
      button = /^https?:/.test(href) ? (
        <TrackedLink href={href} kind="booking" className="s-btn" external>
          {block.label}
        </TrackedLink>
      ) : (
        <Link href={scopedHref(scope.basePath, href)} className="s-btn">
          {block.label}
        </Link>
      );
    } else if (scope.venue?.phone) {
      button = (
        <TrackedLink href={`tel:${scope.venue.phone.replace(/\s+/g, '')}`} kind="booking" className="s-btn">
          Call {scope.venue.phone} to book
        </TrackedLink>
      );
    } else if (!scope.venue) {
      button = <VenuePicker scope={scope} path="/contact" verb="Book at" compact={ctx.region === 'aside'} />;
    }
  }
  // A call to action with nowhere to go says nothing useful: leave it out.
  if (!button && !block.body) return null;
  return (
    <div className="space-y-4">
      <Heading ctx={ctx} text={block.heading} />
      <Paras text={block.body} />
      {button}
    </div>
  );
}

function GalleryBlock({ block, ctx }: { block: Extract<Block, { type: 'gallery' }>; ctx: BlockContext }) {
  return (
    <div className="space-y-5">
      <Heading ctx={ctx} text={block.heading} />
      <ul className={cx('grid gap-3', ctx.region === 'band' ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2')}>
        {block.images.map((img) => (
          <li key={img.url}>
            <figure>
              <Image src={img.url} alt={img.alt} width={800} height={600} unoptimized className="s-img" />
              {img.caption ? <figcaption className="mt-1 text-sm">{img.caption}</figcaption> : null}
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TestimonialsBlock({ block, ctx }: { block: Extract<Block, { type: 'testimonials' }>; ctx: BlockContext }) {
  const aside = ctx.region === 'aside';
  return (
    <div className="space-y-5">
      <Heading ctx={ctx} text={block.heading} className={aside ? 'text-xl' : undefined} />
      <ul className={cx('grid gap-6', !aside && 'md:grid-cols-2')}>
        {block.items.map((t, i) => (
          <li key={i}>
            <figure className="space-y-2">
              <blockquote className={cx('whitespace-pre-line', aside ? 'text-base' : 'text-xl')} style={{ fontFamily: 'var(--brand-font-heading)' }}>
                “{t.quote}”
              </blockquote>
              <figcaption className="text-sm">
                — {t.author}
                {t.source ? `, ${t.source}` : ''}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FaqBlock({ block, ctx }: { block: Extract<Block, { type: 'faq' }>; ctx: BlockContext }) {
  return (
    <div className="space-y-4">
      <Heading ctx={ctx} text={block.heading ?? 'Questions'} />
      <div className="divide-y divide-[var(--brand-color-border)] border-y s-rule">
        {block.items.map((q, i) => (
          <details key={i} className="group py-1">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 py-2 font-semibold [&::-webkit-details-marker]:hidden">
              {q.question}
              <span aria-hidden="true" className="text-xl transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <div className="space-y-2 pb-3">
              <Paras text={q.answer} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function ContactBlock({ block, ctx }: { block: Extract<Block, { type: 'contact' }>; ctx: BlockContext }) {
  const venue = ctx.scope.venue;
  return (
    <div className="space-y-4">
      <Heading ctx={ctx} text={block.heading ?? 'Contact'} />
      <Paras text={block.body} />
      {venue ? (
        <dl className="grid gap-4 sm:grid-cols-3">
          {block.showPhone && venue.phone ? (
            <div>
              <dt className="font-semibold">Phone</dt>
              <dd>
                <TrackedLink href={`tel:${venue.phone.replace(/\s+/g, '')}`} kind="call" className="s-link">
                  {venue.phone}
                </TrackedLink>
              </dd>
            </div>
          ) : null}
          {block.showEmail && venue.email ? (
            <div>
              <dt className="font-semibold">Email</dt>
              <dd>
                <a href={`mailto:${venue.email}`} className="s-link break-all">
                  {venue.email}
                </a>
              </dd>
            </div>
          ) : null}
          {block.showAddress ? (
            <div>
              <dt className="font-semibold">Address</dt>
              <dd>
                <Address venue={venue} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <VenuePicker scope={ctx.scope} path="/contact" verb="Contact" compact={ctx.region === 'aside'} />
      )}
    </div>
  );
}

function RichTextBlock({ block, ctx }: { block: Extract<Block, { type: 'rich-text' }>; ctx: BlockContext }) {
  const editorial = ctx.skeleton === 'editorial';
  let firstParagraph = true;
  return (
    <div className={cx('space-y-5', editorial && 'text-[1.075em]')}>
      <Heading ctx={ctx} text={block.heading} />
      {block.paragraphs.map((p, i) => {
        switch (p.kind) {
          case 'paragraph': {
            const drop = editorial && firstParagraph;
            firstParagraph = false;
            return <Paras key={i} text={p.text} dropcap={drop} />;
          }
          case 'subheading':
            return (
              <h3 key={i} className="s-heading pt-2">
                {p.text}
              </h3>
            );
          case 'quote':
            return (
              <figure key={i} className="border-l-4 pl-5" style={{ borderColor: 'var(--brand-color-text)' }}>
                <blockquote className="text-xl whitespace-pre-line" style={{ fontFamily: 'var(--brand-font-heading)' }}>
                  “{p.text}”
                </blockquote>
                {p.attribution ? <figcaption className="mt-2 text-sm">— {p.attribution}</figcaption> : null}
              </figure>
            );
          case 'list':
            return (
              <ul key={i} className="list-disc space-y-1 pl-6">
                {p.items.map((it, j) => (
                  <li key={j}>{it}</li>
                ))}
              </ul>
            );
        }
      })}
    </div>
  );
}

function AboutBlock({ block, ctx }: { block: Extract<Block, { type: 'about' }>; ctx: BlockContext }) {
  const editorial = ctx.skeleton === 'editorial';
  return (
    <div className={cx('grid gap-8', block.imageUrl && ctx.region !== 'aside' && 'md:grid-cols-2 md:items-center')}>
      <div className="space-y-4">
        <Heading ctx={ctx} text={block.heading} />
        <Paras text={block.body} dropcap={editorial} className={cx(ctx.skeleton === 'minimal' && 'text-lg')} />
      </div>
      {block.imageUrl ? <Image src={block.imageUrl} alt={block.imageAlt ?? ''} width={900} height={675} unoptimized className="s-img" /> : null}
    </div>
  );
}

function InstagramBlock({ block, ctx }: { block: Extract<Block, { type: 'instagram-feed' }>; ctx: BlockContext }) {
  // We do not load Instagram's script on a venue's site: a link to the profile, nothing third-party.
  const href = `https://www.instagram.com/${block.handle}/`;
  return (
    <div className="space-y-3">
      <Heading ctx={ctx} text={block.heading ?? 'On Instagram'} />
      <p>
        See what is on the pass today at{' '}
        <TrackedLink href={href} kind="social" className="s-link font-semibold" external>
          @{block.handle}
        </TrackedLink>
        .
      </p>
    </div>
  );
}

function CriotaReelBlock({ block, ctx }: { block: Extract<Block, { type: 'criota-reel' }>; ctx: BlockContext }) {
  // No creator content is shown until Criota is connected: a placeholder grid, never made-up videos.
  const tiles = Math.min(block.limit, 6);
  return (
    <div className="space-y-4">
      <Heading ctx={ctx} text={block.heading ?? 'From creators'} />
      <p>Creator videos appear here once Criota is connected.</p>
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6" aria-label="Creator video placeholders">
        {Array.from({ length: tiles }, (_, i) => (
          <li key={i} className="grid aspect-[9/16] place-items-center rounded-[var(--brand-radius-md)] border-2 border-dashed s-rule text-center text-xs" style={{ borderColor: 'var(--s-edge)' }}>
            <span className="px-2">Video {i + 1}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether a block has anything to show in this scope: a region is never given an empty card. */
export function blockVisible(block: Block, scope: SiteScope, table: TableContext | null = null): boolean {
  // A guest who scanned a table's code orders from the table (the banner above the menu says how),
  // or not at all when the venue's codes are view-only. "Order ahead for pickup" is for neither.
  if (block.type === 'order-cta') return !table && orderingOn(scope);
  if (block.type === 'booking-cta') return !!(block.href ?? scope.view.config.bookingCtaTarget) || !!scope.venue?.phone || !scope.venue || !!block.body;
  return true;
}

export function BlockView({ block, ctx }: { block: Block; ctx: BlockContext }) {
  switch (block.type) {
    case 'hero':
      return <HeroBlock block={block} ctx={ctx} />;
    case 'about':
      return <AboutBlock block={block} ctx={ctx} />;
    case 'menu':
      return <MenuBlock block={block} ctx={ctx} />;
    case 'gallery':
      return <GalleryBlock block={block} ctx={ctx} />;
    case 'hours-location':
      return <HoursLocationBlock block={block} ctx={ctx} />;
    case 'booking-cta':
    case 'order-cta':
      return <CtaBlock block={block} ctx={ctx} />;
    case 'testimonials':
      return <TestimonialsBlock block={block} ctx={ctx} />;
    case 'faq':
      return <FaqBlock block={block} ctx={ctx} />;
    case 'contact':
      return <ContactBlock block={block} ctx={ctx} />;
    case 'rich-text':
      return <RichTextBlock block={block} ctx={ctx} />;
    case 'instagram-feed':
      return <InstagramBlock block={block} ctx={ctx} />;
    case 'criota-reel':
      return <CriotaReelBlock block={block} ctx={ctx} />;
  }
}
