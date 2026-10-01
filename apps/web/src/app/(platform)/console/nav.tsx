'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cx } from '@/ui/format';

export interface NavItem {
  href: string;
  label: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export function ConsoleNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  // The longest matching link is the current one, so /console/analytics/menu marks only itself.
  const matches = (href: string) => (href === '/console' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));
  const current = groups
    .flatMap((g) => g.items.map((i) => i.href))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0];
  const active = (href: string) => href === current;
  return (
    <nav aria-label="Console" className="space-y-5">
      {groups.map((g) => (
        <div key={g.label}>
          <p className="px-3 text-xs font-medium uppercase tracking-wide text-ink-3">{g.label}</p>
          <ul className="mt-1 space-y-0.5">
            {g.items.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active(item.href) ? 'page' : undefined}
                  className={cx('block rounded-md px-3 py-1.5 text-sm', active(item.href) ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink')}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function VenueSelect({ venues, selected, action }: { venues: Array<{ id: string; name: string }>; selected: string; action: (form: FormData) => Promise<void> }) {
  if (venues.length < 2) return <p className="truncate text-sm text-ink-2">{venues[0]?.name}</p>;
  return (
    <form action={action}>
      <label className="sr-only" htmlFor="venue-select">
        Venue
      </label>
      {/*
        Keyed by the selected venue: after the change is saved the form is reset to its default,
        and a select that kept its old default option beside the new one snapped back to whichever
        came later in the list, while the console had in fact switched venue.
      */}
      <select
        key={selected}
        id="venue-select"
        name="venueId"
        defaultValue={selected}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm"
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </form>
  );
}
