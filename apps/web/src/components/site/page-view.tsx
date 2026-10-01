import type { ReactNode } from 'react';
import { menu, website } from '@ros/modules';
import { type SiteScope, siteCall } from '@/lib/site-scope';
import type { TableContext } from '@/lib/site-table';
import { type Block, type BlockContext, BlockView, type Region, blockVisible } from './blocks';
import { cx } from './format';

export interface PageLike {
  slug: string;
  title: string;
  blocks: Block[];
}

interface Placed {
  key: string;
  block: Block;
  region: Region;
  anchor: string;
  labelled: boolean;
  node: ReactNode;
}

const ALWAYS_HEADED = new Set<Block['type']>(['hero', 'menu', 'hours-location', 'booking-cta', 'order-cta', 'faq', 'contact', 'instagram-feed', 'criota-reel']);
const hasHeading = (b: Block) => ALWAYS_HEADED.has(b.type) || ('heading' in b && !!b.heading);

/** The live menu for a page that shows one, on the surface the guest is on. */
export async function loadMenu(scope: SiteScope, table: TableContext | null): Promise<menu.PublicMenu | null> {
  if (!scope.venue) return null;
  const venueId = scope.venue.id;
  return siteCall(scope.host, (ctx) => menu.getPublicMenu(ctx, venueId, { surface: table ? 'in_venue' : 'online' }));
}

/**
 * A page drawn in its skeleton. Each block's region comes from the website module's
 * `regionFor`, and each skeleton draws the five regions as its own composition: the same
 * blocks read as a different site under each one.
 */
export async function PageView({ scope, page, diet, path, table, menuData }: { scope: SiteScope; page: PageLike; diet: string[]; path: string; table: TableContext | null; menuData?: menu.PublicMenu | null }) {
  const skeleton = scope.view.skeleton.key;
  const live = menuData !== undefined ? menuData : page.blocks.some((b) => b.type === 'menu') ? await loadMenu(scope, table) : null;

  // A page the skeleton does not name (a venue's own extra page) is composed like its home page.
  const layoutSlug = website.SKELETONS[skeleton].pages.some((pg) => pg.slug === page.slug) ? page.slug : 'home';
  const blocks = page.blocks.filter((b) => blockVisible(b, scope, table));
  const regions = blocks.map((b) => website.regionFor(skeleton, layoutSlug, b.type));
  const leadHero = blocks.findIndex((b, i) => b.type === 'hero' && regions[i] === 'lead');
  const h1Index = leadHero >= 0 ? leadHero : blocks.findIndex(hasHeading);
  const seen = new Set<string>();

  const placed: Placed[] = blocks.map((block, i) => {
    // The first block of a type is anchored by its type (single-scroll navigation links to /#menu …).
    const anchor = seen.has(block.type) ? `b-${block.id}` : block.type;
    seen.add(block.type);
    const ctx: BlockContext = { scope, pageSlug: page.slug, skeleton, region: regions[i]!, menu: live, diet, path, table, isH1: i === h1Index, anchor };
    return { key: `${block.id}-${i}`, block, region: regions[i]!, anchor, labelled: hasHeading(block), node: <BlockView block={block} ctx={ctx} /> };
  });

  const by = (r: Region) => placed.filter((p) => p.region === r);
  const titleH1 = h1Index < 0 ? <h1 className="sr-only">{page.title}</h1> : null;
  const Section = ({ p, className, children }: { p: Placed; className?: string; children?: ReactNode }) => (
    <section id={p.anchor} aria-labelledby={p.labelled ? `${p.anchor}-h` : undefined} aria-label={p.labelled ? undefined : page.title} className={cx('scroll-mt-24', className)} data-block={p.block.type} data-region={p.region}>
      {children ?? p.node}
    </section>
  );
  const Lead = () => (
    <>
      {by('lead').map((p) =>
        p.block.type === 'hero' ? (
          <Section key={p.key} p={p} />
        ) : (
          <Section key={p.key} p={p} className="mx-auto max-w-6xl px-4 py-[var(--s-section)] sm:px-6" />
        ),
      )}
    </>
  );
  const Bands = ({ bleed }: { bleed?: boolean }) => (
    <>
      {by('band').map((p) => (
        <Section key={p.key} p={p} className={cx('py-[var(--s-section)]', !bleed && 's-alt')}>
          <div className={cx('mx-auto', bleed ? 'max-w-none px-4 sm:px-6' : 'max-w-6xl px-4 sm:px-6')}>{p.node}</div>
        </Section>
      ))}
    </>
  );
  const main = by('main');
  const aside = by('aside');
  const closing = by('closing');

  switch (skeleton) {
    case 'hero-photo':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <Lead />
          {main.length || aside.length ? (
            <div className={cx('mx-auto max-w-6xl px-4 py-[var(--s-section)] sm:px-6', aside.length > 0 && 'grid gap-12 lg:grid-cols-[minmax(0,1fr)_22rem]')}>
              <div className={cx('space-y-[var(--s-section)]', aside.length === 0 && 'mx-auto max-w-3xl')}>
                {main.map((p) => (
                  <Section key={p.key} p={p} />
                ))}
              </div>
              {aside.length ? (
                <aside className="space-y-6" aria-label="Details">
                  {aside.map((p) => (
                    <Section key={p.key} p={p} className="s-card p-6" />
                  ))}
                </aside>
              ) : null}
            </div>
          ) : null}
          <Bands />
          {closing.map((p) => (
            <Section key={p.key} p={p} className="mx-auto max-w-6xl border-t s-rule px-4 py-[var(--s-section)] sm:px-6" />
          ))}
        </div>
      );

    case 'editorial':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <Lead />
          {main.length || aside.length ? (
            <div className="mx-auto grid max-w-6xl gap-14 px-4 py-[var(--s-section)] sm:px-6 lg:grid-cols-[minmax(0,40rem)_15rem] lg:justify-center">
              <div className="space-y-16 text-[1.06em] leading-[1.75]">
                {main.map((p) => (
                  <Section key={p.key} p={p} />
                ))}
              </div>
              {aside.length ? (
                <aside className="space-y-10 text-sm lg:border-l lg:pl-8 s-rule" aria-label="Notes">
                  {aside.map((p) => (
                    <Section key={p.key} p={p} />
                  ))}
                </aside>
              ) : null}
            </div>
          ) : null}
          <Bands bleed />
          {closing.map((p) => (
            <Section key={p.key} p={p} className="mx-auto max-w-2xl border-t s-rule px-4 py-[var(--s-section)] text-center sm:px-6 [&_.s-btn]:mx-auto [&_ul]:justify-center" />
          ))}
        </div>
      );

    case 'menu-forward':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <Lead />
          <div className={cx('mx-auto max-w-6xl px-4 py-10 sm:px-6', aside.length > 0 && 'grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem]')}>
            <div className="space-y-14">
              {main.map((p) => (
                <Section key={p.key} p={p} />
              ))}
            </div>
            {aside.length ? (
              <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start" aria-label="Order and hours">
                {aside.map((p) => (
                  <Section key={p.key} p={p} className="s-card p-5 [&_h2]:text-2xl" />
                ))}
              </aside>
            ) : null}
          </div>
          <Bands />
          {closing.map((p) => (
            <Section key={p.key} p={p} className="mx-auto max-w-6xl border-t s-rule px-4 py-[var(--s-section)] sm:px-6" />
          ))}
        </div>
      );

    case 'minimal':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <Lead />
          <div className="mx-auto max-w-xl space-y-[var(--s-section)] px-4 py-[var(--s-section)] sm:px-6">
            {[...main, ...aside].map((p) => (
              <Section key={p.key} p={p} className="[&_h2]:text-center" />
            ))}
          </div>
          <Bands bleed />
          {closing.map((p) => (
            <Section key={p.key} p={p} className="mx-auto max-w-xl border-t s-rule px-4 py-[var(--s-section)] sm:px-6" />
          ))}
        </div>
      );

    case 'split-panel':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <div className={cx(aside.length > 0 && 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,36%)]')}>
            <div className="mx-auto w-full max-w-4xl space-y-[var(--s-section)] px-4 py-10 sm:px-8 lg:py-14">
              {by('lead').map((p) => (
                <Section key={p.key} p={p} />
              ))}
              {main.map((p) => (
                <Section key={p.key} p={p} />
              ))}
            </div>
            {aside.length ? (
              <aside className="s-alt space-y-10 border-t s-rule px-4 py-10 sm:px-8 lg:sticky lg:top-0 lg:h-dvh lg:overflow-y-auto lg:border-t-0 lg:border-l" aria-label="Book, order and hours">
                {aside.map((p) => (
                  <Section key={p.key} p={p} className="[&_h2]:text-2xl" />
                ))}
              </aside>
            ) : null}
          </div>
          <Bands />
          {closing.map((p) => (
            <Section key={p.key} p={p} className="mx-auto max-w-6xl border-t s-rule px-4 py-[var(--s-section)] sm:px-6" />
          ))}
        </div>
      );

    case 'single-scroll':
      return (
        <div data-page={page.slug}>
          {titleH1}
          <Lead />
          {placed
            .filter((p) => p.region !== 'lead')
            .map((p, i) => (
              <Section key={p.key} p={p} className={cx('py-[var(--s-section)]', p.region === 'band' || i % 2 === 1 ? 's-alt' : '', p.region === 'closing' && 'border-t s-rule')}>
                <div className="mx-auto max-w-4xl px-4 sm:px-6">{p.node}</div>
              </Section>
            ))}
        </div>
      );
  }
}
