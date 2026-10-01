'use client';

import { useActionState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

export type SiteFormState = { ok: true; message?: string } | { ok: false; error: string } | null;

export function SiteSubmit({ children, pending, className, name, value }: { children: ReactNode; pending?: string; className?: string; name?: string; value?: string }) {
  const { pending: busy } = useFormStatus();
  return (
    <button type="submit" className={className ?? 's-btn'} disabled={busy} aria-busy={busy} name={name} value={value}>
      {busy ? (pending ?? 'Saving…') : children}
    </button>
  );
}

/** A form bound to a server action; shows the action's own words for success or failure in place. */
export function SiteActionForm({ action, children, className }: { action: (prev: SiteFormState, form: FormData) => Promise<SiteFormState>; children: ReactNode; className?: string }) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      {state && !state.ok ? (
        <p role="alert" className="s-notice mt-3" data-tone="error">
          {state.error}
        </p>
      ) : null}
      {state?.ok && state.message ? (
        <p role="status" className="s-notice mt-3" data-tone="success">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
