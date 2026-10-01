import type { ReactNode } from 'react';
import { SiteChrome } from '@/components/site/chrome';
import { loadScope } from '@/lib/site-scope';

/**
 * One venue of a group, on the group's own host: that venue's pages, menu, hours and its brand
 * (with any per-venue override). Only on an org-level host, only for the org's public venues.
 */
export default async function VenueScopeLayout({ children, params }: { children: ReactNode; params: Promise<{ host: string; venue: string }> }) {
  const { host, venue } = await params;
  const scope = await loadScope(host, venue);
  return <SiteChrome scope={scope}>{children}</SiteChrome>;
}
