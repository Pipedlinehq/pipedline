'use client';

import { useActionState, useEffect } from 'react';
import { Button, FormMessage, SubmitButton, type FormState } from '@/ui';

/**
 * After signing in at the provider with an account that has several locations: say which one
 * is this venue, or leave. `pending` is the service's signed reference to the sign-in that is
 * waiting; it rides in a hidden field and is checked against the session on the server.
 */
export function PosLocationChooser({
  plugKey,
  plugName,
  pending,
  locations,
  choose,
  leave,
}: {
  plugKey: string;
  plugName: string;
  pending: string;
  locations: Array<{ ref: string; name: string }>;
  choose: (prev: FormState, fd: FormData) => Promise<FormState>;
  leave: (fd: FormData) => Promise<void>;
}) {
  const [state, chooseAction] = useActionState(choose, null);
  // The code and state this page arrived with are spent: take them out of the address bar and the history.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  }, []);
  return (
    <div className="space-y-4" data-testid="signin-choose">
      <form action={chooseAction} className="space-y-4">
        <input type="hidden" name="pending" value={pending} />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium text-ink">Locations in that {plugName} account</legend>
          {locations.map((l, i) => (
            <label key={l.ref} className="flex items-start gap-3 text-sm">
              <input type="radio" name="locationRef" value={l.ref} required defaultChecked={i === 0} className="mt-0.5 size-4 accent-ink" />
              <span>
                <span className="text-ink">{l.name}</span>
                <span className="block font-mono text-xs text-ink-2">{l.ref}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
        <SubmitButton size="sm" pendingLabel="Connecting…">
          Connect this location
        </SubmitButton>
      </form>
      <form action={leave} className="border-t border-line pt-4">
        <input type="hidden" name="pending" value={pending} />
        <input type="hidden" name="plugKey" value={plugKey} />
        <p className="mb-2 text-xs text-ink-2">None of these? Leave, and nothing is connected: the sign-in you just made is discarded and ended at {plugName}.</p>
        <Button type="submit" variant="secondary" size="sm">
          Leave without connecting
        </Button>
      </form>
    </div>
  );
}
