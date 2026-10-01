import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './format';

const control =
  'block w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 disabled:bg-sunken disabled:text-ink-3';

/** A labelled control. Every input in the console sits in one: the label is never a placeholder. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-ink-3">{hint}</span> : null}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-bad">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(control, 'h-10', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(control, 'min-h-24 py-2', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(control, 'h-10', className)}>
      {children}
    </select>
  );
}

export function Checkbox({ label, hint, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: string }) {
  return (
    <label className={cx('flex items-start gap-3 text-sm', className)}>
      <input type="checkbox" {...rest} className="mt-0.5 size-4 rounded border-line-strong accent-ink" />
      <span>
        <span className="text-ink">{label}</span>
        {hint ? <span className="block text-xs text-ink-3">{hint}</span> : null}
      </span>
    </label>
  );
}

export function FormMessage({ tone, children }: { tone: 'error' | 'success' | 'info'; children: ReactNode }) {
  const tones = { error: 'bg-bad-soft text-bad', success: 'bg-good-soft text-good', info: 'bg-accent-soft text-accent' };
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cx('rounded-md px-3 py-2 text-sm', tones[tone])}>
      {children}
    </p>
  );
}
