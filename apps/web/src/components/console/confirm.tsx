'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { Button, FormMessage, SubmitButton, type FormState } from '@/ui';
import { flash } from './flash';

/**
 * A money-moving or guest-affecting action behind a confirmation. The dialog states exactly what
 * will happen, asks for a reason when the service needs one, and shows the service's answer in
 * place. Nothing happens until the person presses the confirm button.
 *
 * A change that worked often takes away the row this dialog sits in, and the dialog with it, in
 * the same refresh, before it ever shows its answer. When that happens the answer is handed to
 * the console's flash region as the dialog leaves, so the person is still told what happened.
 */
export function ConfirmAction({
  trigger,
  title,
  children,
  action,
  hidden = {},
  reason,
  confirmLabel,
  pendingLabel = 'Working…',
  variant = 'danger',
  triggerVariant = 'secondary',
  triggerSize = 'sm',
  fields,
  testId,
}: {
  trigger: ReactNode;
  title: string;
  /** Exactly what will happen, in plain words. */
  children: ReactNode;
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  hidden?: Record<string, string>;
  reason?: { label: string; hint?: string; required?: boolean; minLength?: number; placeholder?: string };
  confirmLabel: string;
  pendingLabel?: string;
  variant?: 'primary' | 'danger';
  triggerVariant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  triggerSize?: 'sm' | 'md';
  /** Extra inputs (an amount, a number of points). */
  fields?: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // The answer the server gave, until this dialog has shown it.
  const unsaid = useRef<string | null>(null);
  const [state, formAction] = useActionState(async (prev: FormState, fd: FormData) => {
    const next = await action(prev, fd);
    unsaid.current = next?.ok ? (next.message ?? 'Done.') : null;
    return next;
  }, null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state?.ok) return;
    formRef.current?.reset();
    // Shown here, in the dialog: nothing left to say elsewhere.
    unsaid.current = null;
  }, [state]);
  useEffect(
    () => () => {
      if (unsaid.current) flash(unsaid.current);
      unsaid.current = null;
    },
    [],
  );
  return (
    <>
      <Button type="button" variant={triggerVariant} size={triggerSize} onClick={() => ref.current?.showModal()} data-testid={testId}>
        {trigger}
      </Button>
      <dialog ref={ref} aria-label={title} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <form ref={formRef} action={formAction} className="space-y-4 p-5">
          <div className="text-sm text-ink-2">{children}</div>
          {Object.entries(hidden).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {fields}
          {reason ? (
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">{reason.label}</span>
              <textarea
                name="reason"
                required={reason.required !== false}
                minLength={reason.minLength ?? 3}
                maxLength={300}
                placeholder={reason.placeholder}
                className="block min-h-20 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
              />
              {reason.hint ? <span className="mt-1 block text-xs text-ink-3">{reason.hint}</span> : null}
            </label>
          ) : null}
          {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
          {state?.ok ? <FormMessage tone="success">{state.message ?? 'Done.'}</FormMessage> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => ref.current?.close()}>
              {state?.ok ? 'Close' : 'Cancel'}
            </Button>
            {state?.ok ? null : (
              <SubmitButton variant={variant} pendingLabel={pendingLabel}>
                {confirmLabel}
              </SubmitButton>
            )}
          </div>
        </form>
      </dialog>
    </>
  );
}

/** A small inline form for a one-click, reversible action (accept an order, 86 an item). */
export function InlineAction({
  action,
  hidden = {},
  label,
  pendingLabel,
  variant = 'secondary',
  testId,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  hidden?: Record<string, string>;
  label: ReactNode;
  pendingLabel?: string;
  variant?: 'primary' | 'secondary' | 'danger';
  testId?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1" data-testid={testId}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton size="sm" variant={variant} pendingLabel={pendingLabel}>
        {label}
      </SubmitButton>
      {state && !state.ok ? (
        <span role="alert" className="max-w-56 text-xs text-bad">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
