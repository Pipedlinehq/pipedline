'use client';

import { useActionState, useState } from 'react';
import { FormMessage, SubmitButton, type FormState } from '@/ui';

type Located = { plugKey: string; externalAccountId: string; locations: Array<{ ref: string; name: string }> };
type LocState = ({ ok: true; message?: string; data?: Located } | { ok: false; error: string }) | null;

const control = 'block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink';

/**
 * Connect a point of sale in two steps: ask the provider which locations the account has, then
 * say which one is this venue. The access token is sent with each step and never kept in the page.
 */
export function PosConnectForm({
  plugs,
  findLocations,
  connect,
  venueName,
}: {
  plugs: Array<{ key: string; name: string; needsToken: boolean }>;
  findLocations: (prev: LocState, fd: FormData) => Promise<LocState>;
  connect: (prev: FormState, fd: FormData) => Promise<FormState>;
  venueName: string;
}) {
  const [found, findAction] = useActionState(findLocations, null);
  const [done, connectAction] = useActionState(connect, null);
  const [plug, setPlug] = useState(plugs[0]?.key ?? '');
  const needsToken = plugs.find((p) => p.key === plug)?.needsToken ?? false;
  const located = found?.ok ? found.data : undefined;

  if (!plugs.length) return <p className="text-sm text-ink-3">No point of sale can be connected from here.</p>;
  return (
    <div className="space-y-4">
      <form action={findAction} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Point of sale</span>
          <select name="plugKey" value={plug} onChange={(e) => setPlug(e.currentTarget.value)} className={control}>
            {plugs.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Account or merchant ID</span>
          <input name="externalAccountId" required maxLength={200} className={control} />
        </label>
        {needsToken ? (
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-ink">Access token</span>
            <input name="accessToken" type="password" autoComplete="off" required className={control} />
          </label>
        ) : null}
        {found && !found.ok ? <FormMessage tone="error">{found.error}</FormMessage> : null}
        <SubmitButton size="sm" variant="secondary" pendingLabel="Asking…">
          Find its locations
        </SubmitButton>
      </form>

      {located ? (
        located.locations.length === 0 ? (
          <FormMessage tone="info">That account has no locations to connect.</FormMessage>
        ) : (
          <form action={connectAction} className="space-y-3 border-t border-line pt-4">
            <input type="hidden" name="plugKey" value={located.plugKey} />
            <input type="hidden" name="externalAccountId" value={located.externalAccountId} />
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">Which location is {venueName}?</span>
              <select name="locationRef" required className={control}>
                {located.locations.map((l) => (
                  <option key={l.ref} value={l.ref}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {needsToken ? (
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-ink">Access token (again)</span>
                <input name="accessToken" type="password" autoComplete="off" required className={control} />
              </label>
            ) : null}
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-ink">Fetch past sales</span>
              <select name="backfillMonths" defaultValue="0" className={control}>
                <option value="0">No history, from now on</option>
                <option value="3">The last 3 months</option>
                <option value="6">The last 6 months</option>
                <option value="12">The last 12 months</option>
                <option value="24">The last 24 months</option>
              </select>
            </label>
            {done && !done.ok ? <FormMessage tone="error">{done.error}</FormMessage> : null}
            {done?.ok ? <FormMessage tone="success">{done.message ?? 'Connected.'}</FormMessage> : null}
            <SubmitButton size="sm" pendingLabel="Connecting…">
              Connect this location
            </SubmitButton>
          </form>
        )
      ) : null}
    </div>
  );
}
