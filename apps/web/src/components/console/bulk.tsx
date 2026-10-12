'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from 'react';
import { Button, FormMessage, type FormState } from '@/ui';
import { flash } from './flash';

/**
 * Bulk selection and the "N selected" bar (docs/CONSOLE_IA.md section 9, wave 1; pattern 4).
 * Rows carry a checkbox, the header one selects the page, and a bar appears with the page's
 * actions. Every action confirms in a dialog whose title and button repeat the verb ("Cancel 3
 * orders?" → Cancel orders), takes a reason when the service needs one, and reports in a toast.
 *
 * Wave-2 builders: wrap the table in <BulkSelection noun actions action>, put <SelectAllBox />
 * in the header and <RowBox id label /> in each row. `action` is one server action that reads
 * `action` (the key), `ids` (repeated) and `reason` from the form data; see bulkAct() in
 * lib/console-actions.ts for the loop that runs the service once per id and words the outcome.
 */
export interface BulkActionDef {
  key: string;
  /** The verb on the bar button and, by default, in the dialog: "Accept". */
  verb: string;
  /**
   * The dialog's title. Default "{verb} {n} {nouns}?". Placeholders: {verb}, {n}, {nouns} ("order"
   * or "orders"), {is} (is/are), {them} (it/them), {their} (its/their). Plain strings only: these
   * definitions cross from a server component to this client one.
   */
  title?: string;
  /** The confirm button. Default "{verb} {nouns}". */
  confirmLabel?: string;
  /** What happens, in plain words, with the same placeholders. */
  body?: string;
  destructive?: boolean;
  reason?: { label: string; placeholder?: string; required?: boolean };
  pendingLabel?: string;
}

/** Fill a definition's placeholders for a selection of `n`. */
export function bulkWords(template: string, a: BulkActionDef, n: number, noun: { one: string; many: string }): string {
  const nouns = n === 1 ? noun.one : noun.many;
  return template
    .replaceAll('{verb}', a.verb)
    .replaceAll('{n}', String(n))
    .replaceAll('{nouns}', nouns)
    .replaceAll('{is}', n === 1 ? 'is' : 'are')
    .replaceAll('{them}', n === 1 ? 'it' : 'them')
    .replaceAll('{their}', n === 1 ? 'its' : 'their');
}

interface Ctx {
  selected: Set<string>;
  toggle(id: string, on: boolean): void;
  register(id: string, name: string): () => void;
  all: string[];
  names: Map<string, string>;
  setAll(on: boolean): void;
  clear(): void;
}

const BulkCtx = createContext<Ctx | null>(null);
const useBulk = () => {
  const c = useContext(BulkCtx);
  if (!c) throw new Error('RowBox and SelectAllBox belong inside <BulkSelection>');
  return c;
};

export function BulkSelection({ noun, actions, action, children, testId = 'bulk' }: { noun: { one: string; many: string }; actions: BulkActionDef[]; action: (prev: FormState, fd: FormData) => Promise<FormState>; children: ReactNode; testId?: string }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [all, setAllIds] = useState<string[]>([]);
  const names = useRef(new Map<string, string>());
  const register = useCallback((id: string, name: string) => {
    names.current.set(id, name);
    setAllIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    return () => {
      names.current.delete(id);
      setAllIds((prev) => prev.filter((x) => x !== id));
      setSelected((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };
  }, []);
  const ctx = useMemo<Ctx>(
    () => ({
      selected,
      all,
      names: names.current,
      register,
      toggle: (id, on) =>
        setSelected((prev) => {
          const next = new Set(prev);
          if (on) next.add(id);
          else next.delete(id);
          return next;
        }),
      setAll: (on) => setSelected(on ? new Set(all) : new Set()),
      clear: () => setSelected(new Set()),
    }),
    [selected, all, register],
  );
  return (
    <BulkCtx.Provider value={ctx}>
      {children}
      <BulkBar noun={noun} actions={actions} action={action} testId={testId} />
    </BulkCtx.Provider>
  );
}

/** The header checkbox: selects or clears every row on the page. */
export function SelectAllBox({ label = 'Select every row' }: { label?: string }) {
  const { selected, all, setAll } = useBulk();
  const every = all.length > 0 && all.every((id) => selected.has(id));
  const some = !every && all.some((id) => selected.has(id));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={every} onChange={(e) => setAll(e.currentTarget.checked)} disabled={all.length === 0} className="size-4 rounded border-line-strong accent-ink" data-testid="select-all" />;
}

/** One row's checkbox. `label` names the row for assistive tech ("Select order A7K2"); `name` is how a refusal names it ("A7K2"). */
export function RowBox({ id, label, name }: { id: string; label: string; name?: string }) {
  const { selected, toggle, register } = useBulk();
  useEffect(() => register(id, name ?? label), [id, label, name, register]);
  return <input type="checkbox" aria-label={label} checked={selected.has(id)} onChange={(e) => toggle(id, e.currentTarget.checked)} className="size-4 rounded border-line-strong accent-ink" data-testid={`select-${id}`} />;
}

function BulkBar({ noun, actions, action, testId }: { noun: { one: string; many: string }; actions: BulkActionDef[]; action: (prev: FormState, fd: FormData) => Promise<FormState>; testId: string }) {
  const { selected, clear, names } = useBulk();
  const n = selected.size;
  const [open, setOpen] = useState<BulkActionDef | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  if (n === 0 && !open) return null;
  const nouns = n === 1 ? noun.one : noun.many;
  const words = (a: BulkActionDef) => ({
    title: bulkWords(a.title ?? '{verb} {n} {nouns}?', a, n, noun),
    button: bulkWords(a.confirmLabel ?? '{verb} {nouns}', a, n, noun),
    body: a.body ? bulkWords(a.body, a, n, noun) : `The ${n} ${nouns} you selected ${n === 1 ? 'is' : 'are'} changed one by one; any that cannot be is left as it was and named.`,
  });
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!open) return;
    const fd = new FormData(e.currentTarget);
    fd.set('action', open.key);
    for (const id of selected) {
      fd.append('ids', id);
      fd.append('names', names.get(id) ?? id);
    }
    setError(null);
    start(async () => {
      const r = await action(null, fd);
      if (r && !r.ok) {
        setError(r.error);
        return;
      }
      flash(r?.message ?? 'Done.');
      setOpen(null);
      clear();
      router.refresh();
    });
  };
  return (
    <>
      {n > 0 ? (
        <div role="region" aria-label={`${n} selected`} data-testid={`${testId}-bar`} className="fixed inset-x-0 bottom-16 z-40 flex justify-center px-4 md:bottom-4">
          <div className="flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-line-strong bg-ink px-4 py-2.5 text-sm text-page shadow-xl">
            <span className="font-medium tabular-nums" data-testid={`${testId}-count`}>
              {n} selected
            </span>
            <span aria-hidden className="text-page/40">
              ·
            </span>
            {actions.map((a) => (
              <button key={a.key} type="button" onClick={() => setOpen(a)} data-testid={`${testId}-${a.key}`} className={`rounded-md px-2.5 py-1 font-medium hover:bg-page/15 ${a.destructive ? 'text-bad-soft' : 'text-page'}`}>
                {a.verb}
              </button>
            ))}
            <button type="button" onClick={clear} className="ml-1 rounded-md px-2 py-1 text-page/70 hover:bg-page/15 hover:text-page" aria-label="Clear selection">
              Clear
            </button>
          </div>
        </div>
      ) : null}
      <dialog ref={dialog} aria-label={open ? words(open).title : 'Confirm'} onClose={() => setOpen(null)} className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-xl">
        {open ? (
          <>
            <div className="flex items-center justify-between border-b border-line px-5 py-4">
              <h2 className="text-base font-semibold">{words(open).title}</h2>
              <button type="button" onClick={() => setOpen(null)} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
                ✕
              </button>
            </div>
            <form onSubmit={submit} className="space-y-4 p-5">
              <div className="text-sm text-ink-2">{words(open).body}</div>
              {open.reason ? (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-ink">{open.reason.label}</span>
                  <textarea name="reason" required={open.reason.required !== false} minLength={open.reason.required === false ? 0 : 3} maxLength={300} placeholder={open.reason.placeholder} className="block min-h-20 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink" />
                </label>
              ) : null}
              {error ? <FormMessage tone="error">{error}</FormMessage> : null}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant={open.destructive ? 'danger' : 'primary'} disabled={pending} aria-busy={pending} data-testid={`${testId}-confirm`}>
                  {pending ? (open.pendingLabel ?? 'Working…') : words(open).button}
                </Button>
              </div>
            </form>
          </>
        ) : null}
      </dialog>
    </>
  );
}
