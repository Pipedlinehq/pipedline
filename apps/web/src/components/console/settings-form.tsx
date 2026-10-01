'use client';

import { useActionState } from 'react';
import { FormMessage, SubmitButton, type FormState } from '@/ui';
import type { FieldSpec } from '@/lib/console-schema-form';

const control = 'block w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink disabled:bg-sunken';

function Field({ f, disabled }: { f: FieldSpec; disabled: boolean }) {
  switch (f.kind) {
    case 'boolean':
      return (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name={f.path} defaultChecked={f.value} disabled={disabled} className="mt-0.5 size-4 accent-ink" />
          <span className="text-ink">{f.label}</span>
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
          {f.hint || f.nullable ? <span className="mt-1 block text-xs text-ink-3">{[f.hint, f.nullable ? 'Leave empty for no limit.' : null].filter(Boolean).join(' ')}</span> : null}
        </label>
      );
    case 'text':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{f.label}</span>
          <input type={f.format === 'email' ? 'email' : 'text'} name={f.path} defaultValue={f.value ?? ''} disabled={disabled} className={`${control} h-10`} />
          {f.nullable ? <span className="mt-1 block text-xs text-ink-3">Optional.</span> : null}
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
        </label>
      );
    case 'multi':
      return (
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink">{f.label}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {f.options.map((o) => (
              <label key={o} className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" name={f.path} value={o} defaultChecked={f.value.includes(o)} disabled={disabled} className="size-4 accent-ink" />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      );
    case 'list':
      return (
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">{f.label}</span>
          <input type="text" name={f.path} defaultValue={f.value.join(', ')} disabled={disabled} className={`${control} h-10`} />
          {f.hint ? <span className="mt-1 block text-xs text-ink-3">{f.hint}</span> : null}
        </label>
      );
    case 'group':
      return (
        <fieldset className="rounded-md border border-line p-4 sm:col-span-2">
          <legend className="px-1 text-sm font-medium text-ink">{f.label}</legend>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {f.fields.map((x) => (
              <Field key={x.path} f={x} disabled={disabled} />
            ))}
          </div>
        </fieldset>
      );
    case 'readonly':
      return (
        <div className="sm:col-span-2">
          <p className="mb-1 text-sm font-medium text-ink">{f.label}</p>
          <pre className="max-h-40 overflow-auto rounded-md bg-sunken px-3 py-2 text-xs text-ink-2">{JSON.stringify(f.value, null, 2)}</pre>
          {f.hint ? <p className="mt-1 text-xs text-ink-3">{f.hint}</p> : null}
        </div>
      );
  }
}

/** A module's options, generated from its config schema. Saving sends only these fields. */
export function ModuleSettingsForm({
  moduleKey,
  fields,
  action,
  disabled = false,
}: {
  moduleKey: string;
  fields: FieldSpec[];
  action: (prev: FormState, fd: FormData) => Promise<FormState>;
  disabled?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  if (!fields.length) return <p className="text-sm text-ink-3">This feature has no options.</p>;
  return (
    <form action={formAction} className="space-y-4" data-testid={`settings-${moduleKey}`}>
      <input type="hidden" name="module" value={moduleKey} />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <Field key={f.path} f={f} disabled={disabled} />
        ))}
      </div>
      {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
      {state?.ok ? <FormMessage tone="success">{state.message ?? 'Saved.'}</FormMessage> : null}
      {disabled ? null : <SubmitButton size="sm">Save options</SubmitButton>}
    </form>
  );
}
