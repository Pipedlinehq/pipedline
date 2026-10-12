'use client';

import { useActionState, useState } from 'react';
import { SubmitButton, type FormState } from '@/ui';

/**
 * The 86 control for one item: take it off everywhere at once until the end of this service,
 * until tomorrow, until a time you pick, or until someone puts it back; or put it back. One tap
 * on a busy line. The item comes back on its own when the time passes.
 */
export function EightySix({
  action,
  itemId,
  name,
  available,
}: {
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  itemId: string;
  name: string;
  available: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const [until, setUntil] = useState('end_of_service');
  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-2" data-testid={`eighty-six-${itemId}`}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="available" value={available ? 'false' : 'true'} />
      {available ? (
        <>
          <label className="sr-only" htmlFor={`until-${itemId}`}>
            How long {name} is off
          </label>
          <select id={`until-${itemId}`} name="until" value={until} onChange={(e) => setUntil(e.currentTarget.value)} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-xs text-ink">
            <option value="end_of_service">Until end of service</option>
            <option value="tomorrow">Until tomorrow</option>
            <option value="at">Until a time…</option>
            <option value="">Until put back</option>
          </select>
          {until === 'at' ? (
            <>
              <label className="sr-only" htmlFor={`until-at-${itemId}`}>
                When {name} is back
              </label>
              <input id={`until-at-${itemId}`} name="untilAt" type="datetime-local" required className="h-8 rounded-md border border-line-strong bg-surface px-2 text-xs text-ink" />
            </>
          ) : null}
          <SubmitButton size="sm" variant="secondary" pendingLabel="…">
            86 it
          </SubmitButton>
        </>
      ) : (
        <SubmitButton size="sm" variant="primary" pendingLabel="…">
          Bring back
        </SubmitButton>
      )}
      {state && !state.ok ? (
        <span role="alert" className="w-full text-right text-xs text-bad">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
