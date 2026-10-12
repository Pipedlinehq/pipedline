'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, FormMessage, SubmitButton, type FormState } from '@/ui';

/**
 * A form with a save bar (docs/CONSOLE_IA.md section 9, wave 1; pattern 4). While nothing has
 * changed, the form's own Save button sits where it always did. The moment a field differs from
 * what was loaded, a bar appears with Discard and Save, and the person cannot leave the page by a
 * link or by closing the tab without choosing: a dialog asks "Leave without saving?". Discard
 * puts every field back. A save that worked resets the baseline, so the bar goes.
 *
 * Wave-2 builders: use this in place of ActionForm on any form that edits a record or settings.
 * Fields stay uncontrolled (defaultValue), so Discard is the browser's own reset.
 */
export function GuardedForm({
  action,
  children,
  className,
  submitLabel = 'Save',
  pendingLabel = 'Saving…',
  testId,
  hideMessage = false,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  children: ReactNode;
  className?: string;
  submitLabel?: string;
  pendingLabel?: string;
  testId?: string;
  /** The page shows the outcome itself. */
  hideMessage?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);
  const baseline = useRef<string>('');
  const [dirty, setDirty] = useState(false);
  const snapshot = useCallback(() => {
    const form = ref.current;
    if (!form) return '';
    const fd = new FormData(form);
    const parts: string[] = [];
    for (const [k, v] of fd.entries()) if (typeof v === 'string') parts.push(`${k}=${v}`);
    return parts.join('\n');
  }, []);
  useEffect(() => {
    baseline.current = snapshot();
  }, [snapshot]);
  // A save that worked is the new baseline.
  const lastOk = useRef<FormState>(null);
  useEffect(() => {
    if (state?.ok && state !== lastOk.current) {
      lastOk.current = state;
      baseline.current = snapshot();
      setDirty(false);
    }
  }, [state, snapshot]);
  const check = () => setDirty(snapshot() !== baseline.current);
  const discard = () => {
    ref.current?.reset();
    setDirty(false);
  };
  useUnsavedGuard(dirty);
  return (
    <form ref={ref} action={formAction} onInput={check} onChange={check} onReset={() => setTimeout(check, 0)} className={className} data-testid={testId} data-dirty={dirty ? 'true' : 'false'}>
      {children}
      {!hideMessage && state && !state.ok ? (
        <div className="mt-3">
          <FormMessage tone="error">{state.error}</FormMessage>
        </div>
      ) : null}
      {!hideMessage && state?.ok && state.message ? (
        <div className="mt-3">
          <FormMessage tone="success">{state.message}</FormMessage>
        </div>
      ) : null}
      {dirty ? (
        <div role="region" aria-label="Unsaved changes" data-testid="save-bar" className="fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 md:bottom-4">
          <div className="flex items-center gap-3 rounded-lg border border-line-strong bg-ink px-4 py-2.5 text-sm text-page shadow-xl">
            <span className="font-medium">Unsaved changes</span>
            <Button type="button" variant="ghost" size="sm" onClick={discard} className="text-page hover:bg-page/15 hover:text-page">
              Discard
            </Button>
            <SubmitButton size="sm" pendingLabel={pendingLabel} variant="secondary">
              {submitLabel}
            </SubmitButton>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex justify-end">
          <SubmitButton size="sm" pendingLabel={pendingLabel}>
            {submitLabel}
          </SubmitButton>
        </div>
      )}
    </form>
  );
}

/**
 * While `dirty`, a link inside the console asks before it is followed, and closing or reloading
 * the tab asks through the browser's own prompt. The dialog is the native element, so focus stays
 * in it and Escape means "Stay".
 */
export function useUnsavedGuard(dirty: boolean): void {
  const router = useRouter();
  const pendingHref = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      pendingHref.current = url.pathname + url.search + url.hash;
      dialogRef.current?.showModal();
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);
  useEffect(() => {
    // One dialog for the page, made once, so a form deep in a card need not render it.
    if (dialogRef.current) return;
    const d = document.createElement('dialog');
    d.setAttribute('aria-label', 'Leave without saving?');
    d.setAttribute('data-testid', 'leave-dialog');
    d.className = 'm-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-5 text-ink shadow-xl';
    d.innerHTML = `
      <h2 class="text-base font-semibold">Leave without saving?</h2>
      <p class="mt-2 text-sm text-ink-2">The changes you made on this page will be lost.</p>
      <div class="mt-4 flex justify-end gap-2">
        <button type="button" data-stay class="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium text-ink-2 hover:bg-sunken hover:text-ink">Stay</button>
        <button type="button" data-leave class="inline-flex h-10 items-center rounded-md bg-bad px-4 text-sm font-medium text-page hover:bg-bad/85">Leave without saving</button>
      </div>`;
    d.querySelector('[data-stay]')!.addEventListener('click', () => d.close());
    d.querySelector('[data-leave]')!.addEventListener('click', () => {
      const href = pendingHref.current;
      d.close();
      if (href) {
        // Leaving on purpose: nothing left to guard.
        window.onbeforeunload = null;
        router.push(href);
      }
    });
    document.body.appendChild(d);
    dialogRef.current = d;
    return () => {
      d.remove();
      dialogRef.current = null;
    };
  }, [router]);
}
