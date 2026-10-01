import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, LinkButton, PageHeader } from '@/ui';

/** A module that is switched off at this venue: its screen says so instead of breaking. */
export function ModuleOff({ title, what, canManage }: { title: string; what: string; canManage: boolean }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState
        title={`${what} is switched off at this venue`}
        action={canManage ? <LinkButton href="/console/settings/features">Go to Features</LinkButton> : undefined}
      >
        {canManage ? 'Switch it on in Settings → Features to use this screen. Its data is kept while it is off.' : 'A manager can switch it on. Its data is kept while it is off.'}
      </EmptyState>
    </>
  );
}

/** A screen that exists in the plan but whose service is not built yet. */
export function NotSwitchedOnYet({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="Not switched on yet">{children ?? 'This part of the console is still being built. Nothing here is lost; it will appear when it is ready.'}</EmptyState>
    </>
  );
}

/** A role that cannot use a screen at the selected venue. The server refuses it too. */
export function NotForYourRole({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <>
      <PageHeader title={title} />
      <EmptyState title="Your role does not include this">{children ?? 'Ask a manager or the owner if you need it.'}</EmptyState>
    </>
  );
}

/** Tabs between sibling pages. Plain links; the current one is marked for assistive tech too. */
export function Tabs({ items, current }: { items: Array<{ href: string; label: string }>; current: string }) {
  return (
    <nav aria-label="Sections" className="-mt-2 mb-6 flex flex-wrap gap-1 border-b border-line">
      {items.map((t) => {
        const on = t.href === current;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={on ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${on ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** A labelled definition list for detail pages. */
export function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-ink-3">{k}</dt>
          <dd className="mt-0.5 break-words text-ink">{v ?? '–'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** An error from a read, shown in place of the section it would have filled. */
export function ReadError({ message }: { message: string }) {
  return (
    <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
      {message}
    </p>
  );
}
