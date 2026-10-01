import type { ReactNode } from 'react';
import { SiteChrome } from '@/components/site/chrome';
import { loadScope } from '@/lib/site-scope';

/** The host's own pages: its brand, navigation, hours and structured data. */
export default async function HostScopeLayout({ children, params }: { children: ReactNode; params: Promise<{ host: string }> }) {
  const scope = await loadScope((await params).host);
  return <SiteChrome scope={scope}>{children}</SiteChrome>;
}
