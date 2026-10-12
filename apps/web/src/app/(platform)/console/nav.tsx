'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { cx } from '@/ui/format';
import type { NavLink, NavSection } from '@/lib/console-sections';

export type { NavLink, NavSection };

const matches = (href: string, pathname: string) => (href === '/console' ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

/** The link under the pointer, and the section it belongs to. The longest matching link wins, so /console/analytics/menu marks only itself. */
function useCurrent(sections: NavSection[]): { href: string | undefined; section: string | undefined } {
  const pathname = usePathname();
  const href = sections
    .flatMap((s) => s.items.map((i) => i.href))
    .filter((h) => matches(h, pathname))
    .sort((a, b) => b.length - a.length)[0];
  if (!href) return { href: undefined, section: undefined };
  // A page listed in two sections (kitchen screens: Orders and Settings) counts as Settings when it was reached under /settings.
  const holders = sections.filter((s) => s.items.some((i) => i.href === href));
  const section = (pathname.startsWith('/console/settings/') ? holders.find((s) => s.key === 'settings') : undefined) ?? holders[0];
  return { href, section: section?.key };
}

/** The sidebar: the twelve sections in order; the current one opens to show its pages. */
export function ConsoleNav({ sections }: { sections: NavSection[] }) {
  const current = useCurrent(sections);
  return (
    <nav aria-label="Console" className="space-y-0.5">
      {sections.map((s) => {
        const open = s.key === current.section;
        const onlyPage = s.items.length === 1;
        return (
          <div key={s.key}>
            <Link
              href={s.href}
              aria-current={open && (onlyPage || current.href === s.href) ? 'page' : undefined}
              className={cx(
                'flex items-center justify-between rounded-md px-3 py-1.5 text-[0.9375rem]',
                open ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
              )}
            >
              {s.label}
            </Link>
            {open && !onlyPage ? (
              <ul className="mb-1 mt-0.5 space-y-0.5 border-l border-line ml-4 pl-1">
                {s.items.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current.href === item.href ? 'page' : undefined}
                      className={cx('block rounded-md px-3 py-1 text-sm', current.href === item.href ? 'font-medium text-ink' : 'text-ink-2 hover:text-ink')}
                    >
                      {item.label}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}

/** The venue switcher. `id` differs between the sidebar and the phone header so each select has one label and one id. */
export function VenueSelect({ venues, selected, action, id = 'venue-select' }: { venues: Array<{ id: string; name: string }>; selected: string; action: (form: FormData) => Promise<void>; id?: string }) {
  if (venues.length < 2) return <p className="truncate font-display text-lg text-ink">{venues[0]?.name}</p>;
  return (
    <form action={action}>
      <label className="sr-only" htmlFor={id}>
        Venue
      </label>
      {/*
        Keyed by the selected venue: after the change is saved the form is reset to its default,
        and a select that kept its old default option beside the new one snapped back to whichever
        came later in the list, while the console had in fact switched venue.
      */}
      <select
        key={selected}
        id={id}
        name="venueId"
        defaultValue={selected}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="h-9 w-full rounded-md border border-line-strong bg-surface px-2 text-sm text-ink"
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

const PHONE_ICONS: Record<string, string> = { home: '⌂', orders: '☰', bookings: '◷', menu: '☷' };

/**
 * On a phone the sidebar becomes a bar along the bottom: Home, Orders, Bookings, Menu, and
 * "More", which opens every section in a sheet. The sheet is a native dialog, so focus stays in
 * it and Escape closes it. It closes itself when a link in it is followed.
 */
export function PhoneBar({ sections, signOut }: { sections: NavSection[]; signOut: () => Promise<void> }) {
  const current = useCurrent(sections);
  const ref = useRef<HTMLDialogElement>(null);
  const pathname = usePathname();
  useEffect(() => {
    ref.current?.close();
  }, [pathname]);
  const quick = sections.filter((s) => s.phone);
  const item = 'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[0.6875rem] font-medium';
  return (
    <>
      <nav aria-label="Main sections" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur md:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <ul className="flex items-stretch px-1 py-1">
          {quick.map((s) => {
            const on = s.key === current.section;
            return (
              <li key={s.key} className="flex min-w-0 flex-1">
                <Link href={s.href} aria-current={on ? 'page' : undefined} className={cx(item, on ? 'text-accent' : 'text-ink-2')}>
                  <span aria-hidden className="text-lg leading-none">
                    {PHONE_ICONS[s.key] ?? '•'}
                  </span>
                  <span className="truncate">{s.label}</span>
                </Link>
              </li>
            );
          })}
          <li className="flex min-w-0 flex-1">
            <button type="button" aria-haspopup="dialog" onClick={() => ref.current?.showModal()} className={cx(item, current.section && !quick.some((s) => s.key === current.section) ? 'text-accent' : 'text-ink-2')}>
              <span aria-hidden className="text-lg leading-none">
                ⋯
              </span>
              <span>More</span>
            </button>
          </li>
        </ul>
      </nav>
      <dialog ref={ref} aria-label="All sections" className="m-0 mt-auto w-full max-w-none rounded-t-card border-t border-line bg-surface p-0 text-ink shadow-xl md:hidden">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-lg">Everything</h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <nav aria-label="All sections" className="max-h-[70dvh] overflow-y-auto px-2 py-2">
          <ul className="grid grid-cols-2 gap-1">
            {sections.map((s) => (
              <li key={s.key}>
                <Link href={s.href} aria-current={s.key === current.section ? 'page' : undefined} className={cx('block rounded-md px-3 py-2.5 text-sm', s.key === current.section ? 'bg-sunken font-medium text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink')}>
                  {s.label}
                </Link>
              </li>
            ))}
          </ul>
          <form action={signOut} className="mt-2 border-t border-line px-1 pt-2">
            <button type="submit" className="w-full rounded-md px-3 py-2 text-left text-sm text-ink-2 hover:bg-sunken hover:text-ink">
              Sign out
            </button>
          </form>
        </nav>
      </dialog>
    </>
  );
}
