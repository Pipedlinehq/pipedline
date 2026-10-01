'use client';

import { useActionState } from 'react';
import { SubmitButton, type FormState } from '@/ui';

/**
 * The 86 control for one item: take it off everywhere at once, either until the end of the
 * current service or until someone puts it back; or put it back. One tap on a busy line.
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
  return (
    <form action={formAction} className="flex flex-wrap items-center justify-end gap-2" data-testid={`eighty-six-${itemId}`}>
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="available" value={available ? 'false' : 'true'} />
      {available ? (
        <>
          <label className="sr-only" htmlFor={`until-${itemId}`}>
            How long {name} is off
          </label>
          <select id={`until-${itemId}`} name="until" defaultValue="end_of_service" className="h-8 rounded-md border border-line-strong bg-surface px-2 text-xs text-ink">
            <option value="end_of_service">Until end of service</option>
            <option value="">Until put back</option>
          </select>
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
