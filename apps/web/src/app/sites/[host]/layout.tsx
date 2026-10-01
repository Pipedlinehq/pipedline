import type { ReactNode } from 'react';
import '../../globals.css';
import '@/components/site/site.css';
import { Beacon } from '@/components/beacon';
import { getSite } from '@/lib/site';

/**
 * Every page of a venue's site renders inside this layout, so an unknown or unverified host is
 * a 404 for the whole tree before any page code runs. The brand, header and footer are drawn by
 * the scope layouts below it: (site) for the host's own pages, at/[venue] for one venue of a
 * group on the group's host.
 */
export default async function SiteLayout({ children, params }: { children: ReactNode; params: Promise<{ host: string }> }) {
  await getSite((await params).host);
  return (
    <html lang="en-AU">
      <body>
        {children}
        <Beacon />
      </body>
    </html>
  );
}
