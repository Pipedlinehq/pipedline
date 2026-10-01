'use client';

import { useActionState, useState, type ReactNode } from 'react';
import { Button, FormMessage, SubmitButton } from '@/ui';

/**
 * Forms whose answer carries a secret shown exactly once: an assistant key, a pairing code.
 * The secret lives only in this component's state, from the action's response; it is never in
 * the page's HTML, a URL or storage, so a reload loses it for good.
 */
type OnceState<T> = ({ ok: true; message?: string; data?: T } | { ok: false; error: string }) | null;

function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-ink">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 break-all rounded-md border border-line bg-sunken px-3 py-2 font-mono text-sm text-ink">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function CreateKeyForm({
  action,
  children,
}: {
  action: (prev: OnceState<{ key: string; name: string; expiresAt: string }>, fd: FormData) => Promise<OnceState<{ key: string; name: string; expiresAt: string }>>;
  children: ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  const made = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-4">
      {made ? (
        <div className="space-y-3 rounded-lg border border-good bg-good-soft p-4" role="status">
          <p className="text-sm font-medium text-good">Key “{made.name}” created. Copy it now: it is shown only this once and cannot be shown again.</p>
          <CopyField value={made.key} label="Access key" testId="new-agent-key" />
          <p className="text-xs text-ink-2">Paste it into your assistant together with the address below. It stops working on {made.expiresAt}, or when you revoke it.</p>
        </div>
      ) : null}
      <form action={formAction} className="space-y-4">
        {children}
        {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
        <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
      </form>
    </div>
  );
}

export function PairScreenForm({
  action,
  children,
  pairUrl,
}: {
  action: (prev: OnceState<{ code: string; name: string; expiresAt: string }>, fd: FormData) => Promise<OnceState<{ code: string; name: string; expiresAt: string }>>;
  children: ReactNode;
  pairUrl: string;
}) {
  const [state, formAction] = useActionState(action, null);
  const made = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-4">
      {made ? (
        <div className="space-y-2 rounded-lg border border-good bg-good-soft p-4" role="status">
          <p className="text-sm font-medium text-good">Pairing code for “{made.name}”</p>
          <p data-testid="pairing-code" className="font-mono text-3xl font-semibold tracking-[0.3em] text-ink">
            {made.code}
          </p>
          <p className="text-xs text-ink-2">
            On the screen, open <span className="font-mono">{pairUrl}</span> and type this code before {made.expiresAt}. It works once, and is not shown again.
          </p>
        </div>
      ) : null}
      <form action={formAction} className="space-y-4">
        {children}
        {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
        <SubmitButton pendingLabel="Creating…">Get a pairing code</SubmitButton>
      </form>
    </div>
  );
}

type MadeServiceKey = { key: string; name: string; expiresAt: string; service: string };

/** A key for a connected service to read outcomes with. Shown once, like any other key. */
export function ServiceKeyForm({
  action,
  connectionId,
  service,
  maxDays,
}: {
  action: (prev: OnceState<MadeServiceKey>, fd: FormData) => Promise<OnceState<MadeServiceKey>>;
  connectionId: string;
  service: string;
  maxDays: number;
}) {
  const [state, formAction] = useActionState(action, null);
  const made = state?.ok ? state.data : undefined;
  return (
    <div className="space-y-3">
      {made ? (
        <div className="space-y-3 rounded-lg border border-good bg-good-soft p-4" role="status">
          <p className="text-sm font-medium text-good">
            Key “{made.name}” created for {made.service}. Copy it now: it is shown only this once.
          </p>
          <CopyField value={made.key} label={`Access key for ${made.service}`} testId="new-service-key" />
          <p className="text-xs text-ink-2">Paste it into {made.service}’s own settings. It can read campaign outcomes (totals) and nothing else, stops working on {made.expiresAt}, and ends at once if you disconnect {made.service}.</p>
        </div>
      ) : null}
      <form action={formAction} className="flex flex-wrap items-end gap-3" data-testid={`service-key-form-${connectionId}`}>
        <input type="hidden" name="connectionId" value={connectionId} />
        <input type="hidden" name="service" value={service} />
        <label className="block min-w-40 flex-1">
          <span className="mb-1 block text-xs font-medium text-ink">Name for the key</span>
          <input name="name" maxLength={80} defaultValue={`${service} outcomes`} className="block h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink" />
        </label>
        <label className="block w-28">
          <span className="mb-1 block text-xs font-medium text-ink">Lasts (days)</span>
          <input name="expiresInDays" type="number" min={1} max={maxDays} defaultValue={Math.min(30, maxDays)} required className="block h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink" />
        </label>
        <SubmitButton size="sm" variant="secondary" pendingLabel="Creating…">
          Create a key for {service}
        </SubmitButton>
      </form>
      {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
    </div>
  );
}
