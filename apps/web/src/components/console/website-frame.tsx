import Link from 'next/link';
import type { ReactNode } from 'react';
import { PageHeader } from '@/ui';
import { Tabs } from './states';

export type SiteScope = 'org' | 'venue';

/** Which site is being edited: the org's own site, or the selected venue's own pages (groups only). */
export function readSite(raw: string | undefined, venues: number): SiteScope {
  return venues > 1 && raw === 'venue' ? 'venue' : 'org';
}

export function WebsiteFrame({
  current,
  title,
  description,
  site,
  venueName,
  orgName,
  multi,
  actions,
  children,
}: {
  current: string;
  title: string;
  description?: ReactNode;
  site: SiteScope;
  venueName: string;
  orgName: string;
  multi: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const q = site === 'venue' ? '?site=venue' : '';
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      <Tabs
        current={current}
        items={[
          { href: '/console/website', label: 'Pages' },
          { href: '/console/website/brand', label: 'Brand' },
          { href: '/console/website/media', label: 'Media' },
          { href: '/console/website/redirects', label: 'Redirects' },
          { href: '/console/website/settings', label: 'Settings' },
        ].map((t) => ({ ...t, href: t.href === current ? t.href : `${t.href}${t.href.endsWith('media') || t.href.endsWith('redirects') || t.href.endsWith('settings') ? '' : q}` }))}
      />
      {multi && (current === '/console/website' || current === '/console/website/brand') ? (
        <p className="-mt-3 mb-5 flex flex-wrap items-center gap-2 text-sm text-ink-2" data-testid="site-scope">
          Editing:
          <Link href={current} aria-current={site === 'org' ? 'true' : undefined} className={`rounded-md px-2 py-1 ${site === 'org' ? 'bg-sunken font-medium text-ink' : 'hover:bg-sunken'}`}>
            {orgName} (group site)
          </Link>
          <Link href={`${current}?site=venue`} aria-current={site === 'venue' ? 'true' : undefined} className={`rounded-md px-2 py-1 ${site === 'venue' ? 'bg-sunken font-medium text-ink' : 'hover:bg-sunken'}`}>
            {venueName}&apos;s own {current.endsWith('brand') ? 'look' : 'pages'}
          </Link>
        </p>
      ) : null}
      {children}
    </>
  );
}
