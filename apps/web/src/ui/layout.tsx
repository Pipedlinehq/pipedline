import type { ReactNode } from 'react';
import { cx } from './format';

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function Card({ title, description, actions, children, className, padded = true }: { title?: string; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-lg border border-line bg-surface', className)}>
      {title || actions ? (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title ? <h2 className="text-base font-semibold text-ink">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-sm text-ink-2">{description}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={padded ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const tones: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2',
  good: 'bg-good-soft text-good',
  warn: 'bg-warn-soft text-warn',
  bad: 'bg-bad-soft text-bad',
  accent: 'bg-accent-soft text-accent',
};

/** A status word. Always a word, never colour alone. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone])}>{children}</span>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong px-6 py-10 text-center">
      <p className="text-base font-medium text-ink">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-md text-sm text-ink-2">{children}</p> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

/**
 * A table that scrolls sideways when it is wider than its space. The scrolling box can be reached
 * and scrolled from the keyboard, and says what it is.
 */
export function Table({ children, className, label = 'Table' }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="group" aria-label={label} tabIndex={0} className={cx('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, align = 'left', className }: { children?: ReactNode; align?: 'left' | 'right'; className?: string }) {
  return (
    <th scope="col" className={cx('border-b border-line px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-ink-3', align === 'right' && 'text-right', className)}>
      {children}
    </th>
  );
}

export function Td({ children, align = 'left', className, numeric }: { children?: ReactNode; align?: 'left' | 'right'; className?: string; numeric?: boolean }) {
  return (
    <td className={cx('border-b border-line px-4 py-3 align-top text-ink', (align === 'right' || numeric) && 'text-right', numeric && 'tabular-nums', className)}>{children}</td>
  );
}

/** Text a guest or another outside party wrote. Rendered as text, visibly quoted, never as markup. */
export function GuestText({ children }: { children: string | null | undefined }) {
  if (!children) return null;
  return <q className="whitespace-pre-wrap break-words text-ink-2 before:content-['“'] after:content-['”']">{children}</q>;
}
