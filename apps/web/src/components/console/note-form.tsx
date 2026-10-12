'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';
import { FormMessage, SubmitButton, type FormState } from '@/ui';

/**
 * "Leave a note for the team…" with @mentions (docs/CONSOLE_IA.md section 9, wave 1). Typing @
 * offers the names of staff at the venue; arrow keys and Enter pick one, Escape closes. The note
 * is text; it is rendered as text and never shown to the guest.
 */
export function NoteForm({ action, venueId, entityType, entityId, people }: { action: (prev: FormState, fd: FormData) => Promise<FormState>; venueId: string; entityType: string; entityId: string; people: Array<{ id: string; name: string }> }) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [body, setBody] = useState('');
  const [open, setOpen] = useState<{ start: number; needle: string } | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  useEffect(() => {
    if (state?.ok) {
      setBody('');
      formRef.current?.reset();
    }
  }, [state]);
  const matches = open ? people.filter((p) => p.name.toLowerCase().startsWith(open.needle.toLowerCase())).slice(0, 6) : [];

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setBody(v);
    const caret = e.target.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = /(^|\s)@([A-Za-z][A-Za-z' -]{0,40})?$/.exec(before);
    if (m) {
      setOpen({ start: caret - (m[2]?.length ?? 0) - 1, needle: m[2] ?? '' });
      setActive(0);
    } else setOpen(null);
  };
  const pick = (name: string) => {
    if (!open) return;
    const el = ref.current;
    const caret = el?.selectionStart ?? body.length;
    const next = `${body.slice(0, open.start)}@${name} ${body.slice(caret)}`;
    setBody(next);
    setOpen(null);
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = open.start + name.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || !matches.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + matches.length) % matches.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(matches[active]!.name);
    } else if (e.key === 'Escape') {
      setOpen(null);
    }
  };

  return (
    <form ref={formRef} action={formAction} className="space-y-2" data-testid="note-form">
      <input type="hidden" name="venueId" value={venueId} />
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <label className="block">
        <span className="sr-only">Note for the team</span>
        <div className="relative">
          <textarea
            ref={ref}
            name="body"
            value={body}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => setOpen(null), 150)}
            required
            maxLength={2000}
            rows={2}
            placeholder="Leave a note for the team… Type @ to name someone."
            aria-autocomplete="list"
            aria-expanded={open ? matches.length > 0 : undefined}
            aria-controls={open ? listId : undefined}
            className="block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3"
          />
          {open && matches.length ? (
            <ul id={listId} role="listbox" aria-label="People to mention" className="absolute left-0 top-full z-20 mt-1 w-64 overflow-hidden rounded-md border border-line bg-surface shadow-lg">
              {matches.map((p, i) => (
                <li key={p.id} role="option" aria-selected={i === active}>
                  <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(p.name)} className={`block w-full px-3 py-1.5 text-left text-sm ${i === active ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken'}`}>
                    @{p.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </label>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-ink-3">Only the team sees notes. Guests never do.</span>
        <SubmitButton size="sm" variant="secondary" pendingLabel="Leaving…">
          Leave note
        </SubmitButton>
      </div>
      {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
      {state?.ok && state.message ? <FormMessage tone="success">{state.message}</FormMessage> : null}
    </form>
  );
}
