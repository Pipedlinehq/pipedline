import Image from 'next/image';
import Link from 'next/link';
import { preconnect } from 'react-dom';
import type { ReactNode } from 'react';
import { website } from '@ros/modules';
import { type SiteScope, scopedHref } from '@/lib/site-scope';
import { headers } from 'next/headers';
import { readCookie } from '@/lib/cookies';
import { TAGS_COOKIE, siteTags } from '@/lib/site-tags';
import { siteStyle } from './brand';
import { TrackedLink } from './client-bits';
import { TagChoiceButton, ThirdPartyTags } from './tags';
import { cx, shortDate, weeklyHours } from './format';

/** Structured data as a JSON-LD script. The only raw HTML on a venue site, escaped by the website module. */
export function JsonLd({ doc }: { doc: website.JsonLd | website.JsonLd[] }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: website.serializeJsonLd(doc) }} />;
}

const SOCIAL_NAMES: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
  x: 'X',
  youtube: 'YouTube',
  tripadvisor: 'Tripadvisor',
  googleBusiness: 'Google',
};

export function directionsUrl(v: { name: string; addressLine1: string | null; suburb: string | null; lat: number | null; lng: number | null }): string | null {
  if (v.lat !== null && v.lng !== null) return `https://www.google.com/maps/search/?api=1&query=${v.lat},${v.lng}`;
  const q = [v.name, v.addressLine1, v.suburb].filter(Boolean).join(', ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : null;
}

function orderingAvailable(scope: SiteScope): boolean {
  // A group's org-level site links to its venue picker; a venue's site only when ordering is on there.
  return scope.venue ? scope.view.enabledModules.includes('ordering') : scope.view.venues.length > 0;
}

function Wordmark({ scope }: { scope: SiteScope }) {
  const { brand, venue, org } = scope.view;
  const name = scope.basePath && venue ? venue.name : org.name;
  const logo = brand.logo.svgUrl ?? brand.logo.rasterUrl;
  return (
    <Link href={scopedHref(scope.basePath, '/')} className="inline-flex min-h-11 items-center gap-3 no-underline">
      {logo ? <Image src={logo} alt={name} width={160} height={40} unoptimized className="h-10 w-auto" priority /> : <span className="s-heading text-xl sm:text-2xl">{name}</span>}
    </Link>
  );
}

export function SiteHeader({ scope }: { scope: SiteScope }) {
  const { view, basePath } = scope;
  const nav = view.nav.map((n) => ({ label: n.label, href: scopedHref(basePath, n.href) }));
  const sticky = view.skeleton.singlePage || view.skeleton.key === 'menu-forward';
  const accountLink = (
    <Link href="/account" className="s-link text-sm">
      {scope.signedIn ? 'Your account' : 'Sign in'}
    </Link>
  );
  return (
    <header className={cx('border-b s-rule', sticky ? 'sticky top-0 z-40' : 'relative z-30')} style={{ background: 'var(--brand-color-surface)' }}>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <Wordmark scope={scope} />
          {basePath ? (
            <p className="text-sm">
              <Link href="/" className="s-link">
                All {view.org.name} locations
              </Link>
            </p>
          ) : null}
        </div>
        <nav aria-label="Main" className="hidden items-center gap-5 md:flex">
          {nav.map((n) => (
            <Link key={n.href + n.label} href={n.href} className="font-medium no-underline hover:underline underline-offset-4">
              {n.label}
            </Link>
          ))}
          {accountLink}
          {orderingAvailable(scope) ? (
            <Link href={scopedHref(basePath, '/order')} className="s-btn">
              Order
            </Link>
          ) : null}
        </nav>
        <div className="flex items-center gap-2 md:hidden">
          {orderingAvailable(scope) ? (
            <Link href={scopedHref(basePath, '/order')} className="s-btn px-4">
              Order
            </Link>
          ) : null}
          {/* A disclosure, not a script: the menu opens with or without JavaScript. */}
          <details className="group relative">
            <summary className="s-btn-outline list-none px-3 [&::-webkit-details-marker]:hidden" aria-label="Menu">
              <span aria-hidden="true" className="text-lg leading-none">
                ☰
              </span>
              <span className="text-sm">Menu</span>
            </summary>
            <div className="s-card absolute right-0 mt-2 w-64 p-2 shadow-lg">
              <ul className="flex flex-col">
                {nav.map((n) => (
                  <li key={n.href + n.label}>
                    <Link href={n.href} className="block rounded px-3 py-3 font-medium no-underline hover:bg-[var(--brand-color-surface-alt)]">
                      {n.label}
                    </Link>
                  </li>
                ))}
                <li>
                  <Link href="/account" className="block rounded px-3 py-3 font-medium no-underline hover:bg-[var(--brand-color-surface-alt)]">
                    {scope.signedIn ? 'Your account' : 'Sign in'}
                  </Link>
                </li>
              </ul>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
}

export function HoursTable({ hours, exceptions, compact }: { hours: website.SiteView['hours']; exceptions: website.SiteView['hourExceptions']; compact?: boolean }) {
  const week = weeklyHours(hours);
  const soon = exceptions.slice(0, 4);
  return (
    <div>
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Opening hours</caption>
        <tbody>
          {week.map((d) => (
            <tr key={d.day} className="align-top">
              <th scope="row" className="py-1 pr-4 font-semibold">
                {compact ? d.short : d.name}
              </th>
              <td className="py-1 s-tabular">{d.periods.length ? d.periods.join(', ') : 'Closed'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {soon.length ? (
        <ul className="mt-3 space-y-1 text-sm">
          {soon.map((e) => (
            <li key={e.date}>
              <strong>{shortDate(e.date)}:</strong> {e.closed ? 'Closed' : `Open ${e.opensAt?.slice(0, 5)}–${e.closesAt?.slice(0, 5)}`}
              {e.reason ? ` (${e.reason})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Address({ venue }: { venue: NonNullable<SiteScope['venue']> }) {
  const lines = [venue.addressLine1, venue.addressLine2, [venue.suburb, venue.state, venue.postcode].filter(Boolean).join(' ')].filter((l): l is string => !!l);
  return (
    <address className="not-italic">
      {lines.map((l) => (
        <span key={l} className="block">
          {l}
        </span>
      ))}
    </address>
  );
}

export function OpenNow({ openNow }: { openNow: boolean | null }) {
  if (openNow === null) return null;
  return (
    <p className="s-pill font-semibold">
      <span aria-hidden="true">{openNow ? '●' : '○'}</span> {openNow ? 'Open now' : 'Closed now'}
    </p>
  );
}

export function SiteFooter({ scope }: { scope: SiteScope }) {
  const { view, venue } = scope;
  const social = Object.entries(view.config.socialLinks).filter((e): e is [string, string] => typeof e[1] === 'string');
  const maps = venue ? directionsUrl(venue) : null;
  return (
    <footer className="s-alt mt-auto border-t s-rule">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-3">
        {venue ? (
          <>
            <section aria-labelledby="footer-visit">
              <h2 id="footer-visit" className="s-heading mb-3 text-xl">
                {scope.basePath ? venue.name : 'Visit'}
              </h2>
              <Address venue={venue} />
              <div className="mt-3 flex flex-col items-start gap-1">
                {maps ? (
                  <TrackedLink href={maps} kind="directions" className="s-link" external>
                    Get directions
                  </TrackedLink>
                ) : null}
                {venue.phone ? (
                  <TrackedLink href={`tel:${venue.phone.replace(/\s+/g, '')}`} kind="call" className="s-link">
                    Call {venue.phone}
                  </TrackedLink>
                ) : null}
                {venue.email ? (
                  <a href={`mailto:${venue.email}`} className="s-link">
                    {venue.email}
                  </a>
                ) : null}
              </div>
            </section>
            {/* Left out (site.css) on a page whose own content already shows the hours. */}
            <section aria-labelledby="footer-hours" className="s-footer-hours">
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <h2 id="footer-hours" className="s-heading text-xl">
                  Hours
                </h2>
                <OpenNow openNow={scope.openNow} />
              </div>
              <HoursTable hours={view.hours} exceptions={view.hourExceptions} compact />
            </section>
          </>
        ) : (
          <section aria-labelledby="footer-locations" className="md:col-span-2">
            <h2 id="footer-locations" className="s-heading mb-3 text-xl">
              Our locations
            </h2>
            <ul className="grid gap-4 sm:grid-cols-2">
              {view.venues.map((v) => (
                <li key={v.id}>
                  <Link href={`/at/${v.slug}`} className="font-semibold s-link">
                    {v.name}
                  </Link>
                  <span className="block text-sm">{[v.addressLine1, v.suburb].filter(Boolean).join(', ')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="footer-more">
          <h2 id="footer-more" className="s-heading mb-3 text-xl">
            More
          </h2>
          <ul className="space-y-1">
            {social.map(([key, href]) => (
              <li key={key}>
                <TrackedLink href={href} kind="social" className="s-link" external>
                  {SOCIAL_NAMES[key] ?? key}
                </TrackedLink>
              </li>
            ))}
            <li>
              <Link href="/account" className="s-link">
                {scope.signedIn ? 'Your account' : 'Sign in or join'}
              </Link>
            </li>
            <TagChoiceItem scope={scope} />
          </ul>
          <p className="mt-6 text-sm">© {view.org.name}</p>
        </section>
      </div>
    </footer>
  );
}

/** Whether the request carried Global Privacy Control, and what this browser chose before. */
async function tagChoice(): Promise<{ gpc: boolean; choice: 'yes' | 'no' | null }> {
  const saved = await readCookie(TAGS_COOKIE);
  return { gpc: (await headers()).get('sec-gpc') === '1', choice: saved === 'yes' || saved === 'no' ? saved : null };
}

/** The venue's third-party tags and the question that gates them. Nothing at all unless the venue has ids and the deployment allows tags. */
async function TagsSlot({ scope }: { scope: SiteScope }) {
  const tags = siteTags(scope.view.config);
  if (!tags) return null;
  const { gpc, choice } = await tagChoice();
  const siteName = scope.basePath && scope.venue ? scope.venue.name : scope.view.org.name;
  return <ThirdPartyTags googleAnalyticsId={tags.googleAnalyticsId} metaPixelId={tags.metaPixelId} siteName={siteName} initialChoice={choice} gpc={gpc} />;
}

/** "Measurement choices" in the footer: the way back to the question. Not offered where there is nothing to choose. */
async function TagChoiceItem({ scope }: { scope: SiteScope }) {
  if (!siteTags(scope.view.config) || (await tagChoice()).gpc) return null;
  return (
    <li>
      <TagChoiceButton className="s-link" />
    </li>
  );
}

/** Everything around a page: brand variables and fonts, skip link, header, footer, structured data. */
export function SiteChrome({ scope, children }: { scope: SiteScope; children: ReactNode }) {
  preconnect('https://fonts.gstatic.com', { crossOrigin: 'anonymous' });
  const { view } = scope;
  return (
    <div className="site" style={siteStyle(view.brand)} data-skeleton={view.skeleton.key} data-brand={view.brand.hasVenueOverride ? 'venue' : 'org'}>
      <link rel="stylesheet" href={view.brand.fontsHref} precedence="brand-fonts" />
      {view.structuredData ? <JsonLd doc={view.structuredData} /> : null}
      <a href="#main" className="s-skip">
        Skip to content
      </a>
      <TagsSlot scope={scope} />
      <SiteHeader scope={scope} />
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <SiteFooter scope={scope} />
    </div>
  );
}
