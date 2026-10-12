'use client';

import { useActionState } from 'react';
import { FormMessage, SubmitButton, type FormState } from '@/ui';
import type { FieldSpec, RowColumn } from '@/lib/console-schema-form';

const control = 'block w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink disabled:bg-sunken disabled:text-ink-3';
const DAY_WORDS: Record<string, string> = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

function Hint({ text }: { text?: string }) {
  return text ? <span className="mt-1 block text-xs leading-relaxed text-ink-3">{text}</span> : null;
}

function Field({ f, disabled }: { f: FieldSpec; disabled: boolean }) {
  switch (f.kind) {
    case 'boolean':
      return (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name={f.path} defaultChecked={f.value} disabled={disabled} className="mt-0.5 size-4 rounded accent-accent" />
          <span>
            <span className="text-ink">{f.label}</span>
            <Hint text={f.hint} />
          </span>
        </label>
      );
    case 'number':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">
            {f.label}
            {f.money ? ' ($)' : ''}
          </span>
          <input
            type="number"
            name={f.path}
            defaultValue={f.value === null ? '' : f.money ? (f.value / 100).toFixed(2) : f.value}
            min={f.min === undefined ? undefined : f.money ? f.min / 100 : f.min}
            max={f.max === undefined ? undefined : f.money ? f.max / 100 : f.max}
            step={f.money ? '0.01' : f.integer ? 1 : 'any'}
            required={!f.nullable}
            disabled={disabled}
            className={`${control} h-10 max-w-40`}
          />
          <Hint text={[f.hint, f.nullable ? 'Leave empty for no limit.' : null].filter(Boolean).join(' ') || undefined} />
        </label>
      );
    case 'text':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{f.label}</span>
          <input type={f.format === 'email' ? 'email' : 'text'} name={f.path} defaultValue={f.value ?? ''} disabled={disabled} className={`${control} h-10`} />
          <Hint text={[f.hint, f.nullable ? 'Optional.' : null].filter(Boolean).join(' ') || undefined} />
        </label>
      );
    case 'select':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{f.label}</span>
          <select name={f.path} defaultValue={f.value ?? ''} disabled={disabled} className={`${control} h-10 max-w-72`}>
            {f.nullable ? <option value="">(none)</option> : null}
            {f.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <Hint text={f.hint} />
        </label>
      );
    case 'multi':
      return (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">{f.label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {f.options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name={f.path} value={o} defaultChecked={f.value.includes(o)} disabled={disabled} className="size-4 rounded accent-accent" />
                {o}
              </label>
            ))}
          </div>
          <Hint text={f.hint} />
        </fieldset>
      );
    case 'list':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{f.label}</span>
          <input type="text" name={f.path} defaultValue={f.value.join(', ')} disabled={disabled} className={`${control} h-10`} />
          <Hint text={f.hint} />
        </label>
      );
    case 'group':
      return (
        <fieldset className="rounded-md border border-line p-4 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-ink">{f.label}</legend>
          <Hint text={f.hint} />
          <div className="mt-2 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {f.fields.map((x) => (
              <Field key={x.path} f={x} disabled={disabled} />
            ))}
          </div>
        </fieldset>
      );
    case 'rows':
      return <Rows f={f} disabled={disabled} />;
    case 'readonly':
      return (
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium text-ink">{f.label}</p>
          <pre className="max-h-40 overflow-auto rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">{JSON.stringify(f.value, null, 2)}</pre>
          <Hint text={f.hint} />
        </div>
      );
  }
}

/** One cell of a row: the column's control, named by row index. */
function Cell({ col, name, value, disabled }: { col: RowColumn; name: string; value: unknown; disabled: boolean }) {
  const cell = `${control} h-9`;
  switch (col.kind) {
    case 'boolean':
      return <input type="checkbox" name={name} defaultChecked={value === true} disabled={disabled} aria-label={col.label} className="size-4 rounded accent-accent" />;
    case 'number':
      return <input type="number" name={name} defaultValue={typeof value === 'number' ? value : ''} min={col.min} max={col.max} step={col.integer ? 1 : 'any'} disabled={disabled} aria-label={col.label} className={`${cell} min-w-20`} />;
    case 'text':
      return <input type="text" name={name} defaultValue={typeof value === 'string' ? value : ''} disabled={disabled} aria-label={col.label} placeholder={col.format === 'time' ? 'HH:MM' : undefined} className={`${cell} min-w-24`} />;
    case 'select':
      return (
        <select name={name} defaultValue={value === null || value === undefined ? '' : String(value)} disabled={disabled} aria-label={col.label} className={`${cell} min-w-24`}>
          {col.nullable || !col.required ? <option value="">(none)</option> : null}
          {col.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'multi': {
      const chosen = Array.isArray(value) ? value.map(String) : [];
      return (
        <fieldset className="flex flex-wrap gap-x-2 gap-y-1">
          <legend className="sr-only">{col.label}</legend>
          {col.options.map((o) => (
            <label key={o} className="flex items-center gap-1 text-xs text-ink">
              <input type="checkbox" name={name} value={o} defaultChecked={chosen.includes(o)} disabled={disabled} className="size-3.5 rounded accent-accent" />
              {DAY_WORDS[o] ?? o}
            </label>
          ))}
        </fieldset>
      );
    }
  }
}

/** A list of records as a table: the rows there are, then two blank rows to add to. A blank row is no row. */
function Rows({ f, disabled }: { f: Extract<FieldSpec, { kind: 'rows' }>; disabled: boolean }) {
  const count = Math.min(f.max, Math.max(f.value.length + 2, 3));
  return (
    <fieldset className="sm:col-span-2" data-testid={`rows-${f.path}`}>
      <legend className="mb-1 text-sm font-medium text-ink">{f.label}</legend>
      <Hint text={f.hint} />
      <div role="group" aria-label={f.label} tabIndex={0} className="mt-2 overflow-x-auto rounded-md border border-line">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {f.columns.map((col) => (
                <th key={col.path} scope="col" className="border-b border-line bg-sunken px-3 py-2 text-xs font-medium text-ink-2">
                  {col.label}
                  {col.hint ? <span className="block font-normal text-ink-3">{col.hint}</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: count }, (_, i) => (
              <tr key={i} className={i >= f.value.length ? 'bg-surface' : undefined}>
                {f.columns.map((col) => (
                  <td key={col.path} className="border-b border-line px-2 py-1.5 align-top">
                    <Cell col={col} name={`${f.path}.${i}.${col.path}`} value={f.value[i]?.[col.path]} disabled={disabled} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Hint text="Leave a row empty to drop it. Rows are saved in this order." />
    </fieldset>
  );
}

/** A module's options, generated from its config schema. Saving sends only these fields. */
export function ModuleSettingsForm({
  moduleKey,
  fields,
  action,
  disabled = false,
  submitLabel = 'Save options',
}: {
  moduleKey: string;
  fields: FieldSpec[];
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  disabled?: boolean;
  submitLabel?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  if (!fields.length) return <p className="text-sm text-ink-3">This feature has no options.</p>;
  return (
    <form action={formAction} className="space-y-4" data-testid={`settings-${moduleKey}`}>
      <input type="hidden" name="module" value={moduleKey} />
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.path} f={f} disabled={disabled} />
        ))}
      </div>
      {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
      {state?.ok ? <FormMessage tone="success">{state.message ?? 'Saved.'}</FormMessage> : null}
      {disabled ? null : <SubmitButton size="sm">{submitLabel}</SubmitButton>}
    </form>
  );
}
