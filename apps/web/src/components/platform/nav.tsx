'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/ui/format';

const ITEMS = [
  { href: '/platform', label: 'Overview' },
  { href: '/platform/onboarding', label: 'Onboarding' },
  { href: '/platform/tenants', label: 'Tenants' },
  { href: '/platform/plugs', label: 'Plug review' },
];

export function PlatformNav() {
  const path = usePathname();
  return (
    <nav aria-label="Platform" className="flex flex-wrap gap-1">
      {ITEMS.map((i) => {
        const active = i.href === '/platform' ? path === '/platform' : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? 'page' : undefined} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', active ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken hover:text-ink')}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
