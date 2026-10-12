'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState, useTransition } from 'react';
import type { SearchCategory, SearchGroup } from '@/app/(platform)/console/search-actions';

/**
 * Search from anywhere (docs/CONSOLE_IA.md section 9, wave 1; pattern 15): Ctrl/Cmd+K or the
 * button in the sidebar opens a dialog; type two letters and the matches arrive as links, grouped,
 * with a category to narrow by. Arrow keys move through the results; Escape closes.
 */
const CATEGORIES: Array<{ value: SearchCategory; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'orders', label: 'Orders' },
  { value: 'guests', label: 'Guests' },
  { value: 'menu', label: 'Menu items' },
  { value: 'bookings', label: 'Bookings' },
];

export function ConsoleSearch({ action, compact = false }: { action: (q: string, category: string) => Promise<{ q: string; groups: SearchGroup[] }>; compact?: boolean }) {
  // The phone header has its own copy; test ids tell them apart and only the sidebar's answers the shortcut.
  const tid = (name: string) => (compact ? `${name}-phone` : name);
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<SearchCategory>('all');
  const [groups, setGroups] = useState<SearchGroup[] | null>(null);
  const [pending, start] = useTransition();
  const pathname = usePathname();
  const id = useId();
  const open = () => {
    ref.current?.showModal();
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (ref.current?.open) ref.current.close();
        else open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact]);
  // Following a result closes the dialog.
  useEffect(() => {
    ref.current?.close();
  }, [pathname]);
  // Ask after a short pause in typing.
  useEffect(() => {
    if (q.trim().length < 2) {
      setGroups(null);
      return;
    }
    const t = window.setTimeout(() => start(async () => setGroups((await action(q, category)).groups)), 220);
    return () => window.clearTimeout(t);
  }, [q, category, action]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDialogElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const links = Array.from(ref.current?.querySelectorAll<HTMLAnchorElement>('a[data-hit]') ?? []);
    if (!links.length) return;
    e.preventDefault();
    const at = links.findIndex((l) => l === document.activeElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % links.length : at <= 0 ? links.length - 1 : at - 1;
    links[next]!.focus();
  };
  const total = groups?.reduce((n, g) => n + g.hits.length, 0) ?? 0;
  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label="Search orders, guests, menu items and bookings"
        data-testid={tid('search-open')}
        className={compact ? 'rounded-md px-2 py-1 text-ink-2 hover:bg-sunken hover:text-ink' : 'flex w-full items-center justify-between rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-sm text-ink-3 hover:bg-sunken'}
      >
        {compact ? (
          <span aria-hidden className="text-base leading-none">
            ⌕
          </span>
        ) : (
          <>
            <span>Search…</span>
            <kbd className="rounded border border-line px-1 font-mono text-[0.625rem] text-ink-3">⌘K</kbd>
          </>
        )}
      </button>
      <dialog ref={ref} aria-label="Search" onKeyDown={onKeyDown} onClose={() => setQ('')} className="m-auto mt-[10vh] w-[min(40rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-xl" data-testid={tid('search-dialog')}>
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <label htmlFor={`${id}-q`} className="sr-only">
            Search
          </label>
          <input
            ref={input}
            id={`${id}-q`}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search orders, guests, menu items, bookings…"
            autoComplete="off"
            className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3"
            data-testid={tid('search-input')}
          />
          <label htmlFor={`${id}-c`} className="sr-only">
            Search in
          </label>
          <select id={`${id}-c`} value={category} onChange={(e) => setCategory(e.target.value as SearchCategory)} className="h-10 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink" data-testid={tid('search-category')}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-2" aria-live="polite" aria-busy={pending}>
          {q.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">Type at least two letters. An order reference, a guest's name, email or phone, a dish, a booking.</p>
          ) : groups === null ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">Looking…</p>
          ) : total === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3" data-testid={tid('search-empty')}>
              Nothing matches “{q.trim()}” at this venue.
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.key} aria-labelledby={`${id}-${g.key}`} className="mb-2">
                <h3 id={`${id}-${g.key}`} className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-3">
                  {g.label}
                </h3>
                <ul>
                  {g.hits.map((h) => (
                    <li key={h.href}>
                      <Link href={h.href} data-hit data-testid={tid(`search-hit-${g.key}`)} className="block rounded-md px-3 py-2 hover:bg-sunken focus:bg-sunken">
                        <span className="block text-sm font-medium text-ink">{h.title}</span>
                        <span className="block text-xs text-ink-2">{h.detail}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </dialog>
    </>
  );
}
