'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * The console's one place for "that worked" when the thing that was acted on has gone. A
 * confirmation dialog normally shows its own answer, but a successful change often removes the
 * row the dialog belongs to (a revoked key, a cancelled code, a rejected order), and the dialog
 * leaves with it in the same refresh. The answer is said here instead, where it survives.
 */
interface Flash {
  id: number;
  message: string;
}

let current: Flash | null = null;
let seq = 0;
const listeners = new Set<() => void>();

export function flash(message: string): void {
  current = { id: ++seq, message };
  listeners.forEach((l) => l());
}

function dismiss(id: number): void {
  if (current?.id !== id) return;
  current = null;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The region itself. Always in the page, so assistive tech hears a message placed into it. */
export function FlashRegion() {
  const now = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  useEffect(() => {
    if (!now) return;
    const id = window.setTimeout(() => dismiss(now.id), 8000);
    return () => window.clearTimeout(id);
  }, [now]);
  return (
    <div role="status" aria-live="polite" data-testid="console-flash" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      {now ? (
        <p className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-lg border border-good bg-good-soft px-4 py-3 text-sm font-medium text-good shadow-lg">
          <span>{now.message}</span>
          <button type="button" onClick={() => dismiss(now.id)} aria-label="Dismiss" className="-my-1 rounded px-1.5 py-1 text-good hover:bg-surface">
            ✕
          </button>
        </p>
      ) : null}
    </div>
  );
}
