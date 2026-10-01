import { Tabs } from '../states';

/** The analytics section's own tabs. The filter travels with them. */
export function AnalyticsTabs({ current, query, manager }: { current: string; query?: string; manager: boolean }) {
  const q = query ? `?${query}` : '';
  const items = [
    { href: '/console/analytics', label: 'Sales' },
    { href: '/console/analytics/menu', label: 'Menu' },
    { href: '/console/analytics/customers', label: 'Customers' },
    { href: '/console/analytics/marketing', label: 'Marketing' },
    { href: '/console/analytics/views', label: 'Explore and saved views' },
    { href: '/console/analytics/benchmarks', label: 'Benchmarks' },
    { href: '/console/analytics/digest', label: 'Digests' },
    { href: '/console/analytics/dictionary', label: 'Data dictionary' },
    ...(manager ? [{ href: '/console/analytics/settings', label: 'Settings' }] : []),
  ];
  const full = items.map((i) => ({ base: i.href, label: i.label, href: i.href + (/(dictionary|settings|digest)$/.test(i.href) ? '' : q) }));
  return <Tabs current={full.find((i) => i.base === current)?.href ?? current} items={full} />;
}
