'use client';

import { useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { Button } from './button';
import { FormMessage } from './form';

export type FormState = { ok: true; message?: string } | { ok: false; error: string } | null;

/** A submit button that shows it is working and cannot be pressed twice. */
export function SubmitButton({ children, pendingLabel, variant = 'primary', size = 'md' }: { children: ReactNode; pendingLabel?: string; variant?: 'primary' | 'secondary' | 'danger'; size?: 'sm' | 'md' }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending} aria-busy={pending}>
      {pending ? (pendingLabel ?? 'Saving…') : children}
    </Button>
  );
}

/**
 * A form bound to a server action that returns a FormState. Shows the action's error or
 * success message in place; the action itself is where validation and permissions live.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess = false,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);
  return (
    <form ref={ref} action={formAction} className={className}>
      {children}
      {state && !state.ok ? (
        <div className="mt-3">
          <FormMessage tone="error">{state.error}</FormMessage>
        </div>
      ) : null}
      {state?.ok && state.message ? (
        <div className="mt-3">
          <FormMessage tone="success">{state.message}</FormMessage>
        </div>
      ) : null}
    </form>
  );
}

/** A modal on the native dialog element: focus is trapped and Escape closes it without extra code. */
export function Dialog({
  trigger,
  title,
  children,
  triggerVariant = 'secondary',
  triggerSize = 'md',
}: {
  trigger: ReactNode;
  title: string;
  children: ReactNode;
  triggerVariant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  triggerSize?: 'sm' | 'md';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <Button type="button" variant={triggerVariant} size={triggerSize} onClick={() => ref.current?.showModal()}>
        {trigger}
      </Button>
      <dialog ref={ref} aria-label={title} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </dialog>
    </>
  );
}
