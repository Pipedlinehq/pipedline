'use client';

import { useActionState, useState } from 'react';
import { Button, Field, FormMessage, Input, SubmitButton, type FormState } from '@/ui';
import { type EditorRow, FIELDS, type Leaf, MONTHS, RFM, SALE_CHANNELS, fromRows, ruleWords } from './segment-words';

const control = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';
const kindOf = (field: string) => FIELDS.find((f) => f.value === field)?.kind ?? 'range';

function blank(field: string): Leaf {
  switch (kindOf(field)) {
    case 'consent':
      return { field, purpose: 'marketing_email', granted: true };
    case 'yesno':
      return { field, is: true };
    case 'range':
    case 'money':
    case 'dates':
      return { field };
    default:
      return { field, in: [] };
  }
}

/** A leaf is complete when it would pass the service's own shape check. */
function complete(l: Leaf): boolean {
  const k = kindOf(l.field);
  if (k === 'range' || k === 'money') return l.min !== undefined || l.max !== undefined;
  if (k === 'dates') return !!l.after || !!l.before;
  if (k === 'consent' || k === 'yesno') return true;
  return Array.isArray(l.in) && l.in.length > 0;
}

function Picks<T extends string | number>({ options, value, onChange, label }: { options: Array<{ value: T; label: string }>; value: T[]; onChange: (v: T[]) => void; label: string }) {
  return (
    <span role="group" aria-label={label} className="flex flex-wrap gap-x-3 gap-y-1">
      {options.map((o) => (
        <label key={String(o.value)} className="flex items-center gap-1.5 text-sm text-ink">
          <input type="checkbox" className="size-4 accent-ink" checked={value.includes(o.value)} onChange={(e) => onChange(e.currentTarget.checked ? [...value, o.value] : value.filter((x) => x !== o.value))} />
          {o.label}
        </label>
      ))}
    </span>
  );
}

function LeafInputs({ leaf, set, venues }: { leaf: Leaf; set: (l: Leaf) => void; venues: Array<{ id: string; name: string }> }) {
  const k = kindOf(leaf.field);
  const num = (v: string) => (v === '' ? undefined : Math.max(0, Math.trunc(Number(v))));
  const inList = (Array.isArray(leaf.in) ? leaf.in : []) as Array<string | number>;
  if (k === 'range' || k === 'money') {
    const scale = k === 'money' ? 100 : 1;
    const show = (v: unknown) => (v === undefined ? '' : String(Number(v) / scale));
    const put = (key: 'min' | 'max', v: string) => {
      const n = num(v);
      set({ ...leaf, [key]: n === undefined ? undefined : n * scale });
    };
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        at least
        <input type="number" min={0} aria-label="At least" className={`${control} w-24`} value={show(leaf.min)} onChange={(e) => put('min', e.currentTarget.value)} />
        at most
        <input type="number" min={0} aria-label="At most" className={`${control} w-24`} value={show(leaf.max)} onChange={(e) => put('max', e.currentTarget.value)} />
        {k === 'money' ? 'dollars' : ''}
      </span>
    );
  }
  if (k === 'dates') {
    return (
      <span className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
        after
        <input type="date" aria-label="After" className={control} value={String(leaf.after ?? '')} onChange={(e) => set({ ...leaf, after: e.currentTarget.value || undefined })} />
        before
        <input type="date" aria-label="Before" className={control} value={String(leaf.before ?? '')} onChange={(e) => set({ ...leaf, before: e.currentTarget.value || undefined })} />
      </span>
    );
  }
  if (k === 'consent') {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <select aria-label="Channel" className={control} value={String(leaf.purpose)} onChange={(e) => set({ ...leaf, purpose: e.currentTarget.value })}>
          <option value="marketing_email">by email</option>
          <option value="marketing_sms">by SMS</option>
        </select>
        <select aria-label="Agreed" className={control} value={leaf.granted ? 'yes' : 'no'} onChange={(e) => set({ ...leaf, granted: e.currentTarget.value === 'yes' })}>
          <option value="yes">has agreed</option>
          <option value="no">has not agreed</option>
        </select>
      </span>
    );
  }
  if (k === 'yesno') {
    return (
      <select aria-label="Is or is not" className={control} value={leaf.is ? 'yes' : 'no'} onChange={(e) => set({ ...leaf, is: e.currentTarget.value === 'yes' })}>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    );
  }
  if (k === 'words') {
    return (
      <input
        aria-label="Values, separated by commas"
        placeholder="e.g. organic, criota"
        className={`${control} w-64`}
        defaultValue={inList.join(', ')}
        onChange={(e) => set({ ...leaf, in: e.currentTarget.value.split(',').map((s) => s.trim()).filter(Boolean) })}
      />
    );
  }
  const options: Array<{ value: string | number; label: string }> =
    k === 'rfm'
      ? RFM.map((s) => ({ value: s, label: s.replace('_', ' ') }))
      : k === 'score'
        ? [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))
        : k === 'channels'
          ? SALE_CHANNELS.map((s) => ({ value: s, label: s }))
          : k === 'months'
            ? MONTHS.map((m, i) => ({ value: i + 1, label: m.slice(0, 3) }))
            : venues.map((v) => ({ value: v.id, label: v.name }));
  return <Picks label="Any of" options={options} value={inList} onChange={(v) => set({ ...leaf, in: v })} />;
}

/**
 * A segment as "all (or any) of these conditions". The rule is built here as data and checked
 * again by the service; nothing a person types becomes a query.
 */
export function SegmentForm({
  save,
  preview,
  venues,
  initial,
}: {
  save: (prev: FormState, fd: FormData) => Promise<FormState>;
  preview: (prev: FormState, fd: FormData) => Promise<FormState>;
  venues: Array<{ id: string; name: string }>;
  initial?: { id?: string; name: string; description: string | null; join: 'all' | 'any'; rows: EditorRow[] };
}) {
  const [saved, saveAction] = useActionState(save, null);
  const [counted, previewAction] = useActionState(preview, null);
  const [join, setJoin] = useState<'all' | 'any'>(initial?.join ?? 'all');
  const [rows, setRows] = useState<EditorRow[]>(initial?.rows ?? [{ not: false, leaf: blank('orders') }]);
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const ready = rows.filter((r) => complete(r.leaf));
  const definition = ready.length ? JSON.stringify(fromRows(join, ready)) : '';
  const venueName = (id: string) => venues.find((v) => v.id === id)?.name ?? 'another venue';
  const update = (i: number, patch: Partial<EditorRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form action={saveAction} className="space-y-5">
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="definition" value={definition} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <Input name="name" required maxLength={80} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="Description (optional)">
          <Input name="description" maxLength={300} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        </Field>
      </div>

      <fieldset className="space-y-3 rounded-md border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">Guests who match</legend>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          <select aria-label="All or any" className={control} value={join} onChange={(e) => setJoin(e.currentTarget.value === 'any' ? 'any' : 'all')}>
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these conditions
        </label>
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-3 py-2" data-testid="segment-condition">
            <select aria-label="Negate" className={control} value={r.not ? 'not' : 'is'} onChange={(e) => update(i, { not: e.currentTarget.value === 'not' })}>
              <option value="is">where</option>
              <option value="not">not where</option>
            </select>
            <select aria-label="Field" className={control} value={r.leaf.field} onChange={(e) => update(i, { leaf: blank(e.currentTarget.value) })}>
              {FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <LeafInputs key={r.leaf.field} leaf={r.leaf} set={(leaf) => update(i, { leaf })} venues={venues} />
            {rows.length > 1 ? (
              <button type="button" className="ml-auto rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {rows.length < 12 ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setRows((rs) => [...rs, { not: false, leaf: blank('rfm_segment') }])}>
            Add a condition
          </Button>
        ) : null}
        <p className="text-sm text-ink" data-testid="segment-words">
          {ready.length ? `In words: ${ruleWords(fromRows(join, ready), venueName)}.` : 'Fill in at least one condition.'}
        </p>
      </fieldset>

      {counted ? <div data-testid="segment-count">{counted.ok ? <FormMessage tone="info">{counted.message}</FormMessage> : <FormMessage tone="error">{counted.error}</FormMessage>}</div> : null}
      {saved && !saved.ok ? <FormMessage tone="error">{saved.error}</FormMessage> : null}
      {saved?.ok && saved.message ? <FormMessage tone="success">{saved.message}</FormMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">{initial?.id ? 'Save segment' : 'Create segment'}</SubmitButton>
        <Button type="submit" variant="secondary" formAction={previewAction} formNoValidate>
          Count guests
        </Button>
        <span className="text-xs text-ink-3">Counts only: a segment never lists who is in it.</span>
      </div>
    </form>
  );
}
