'use client';

import { useActionState, useState } from 'react';
import { Button, Field, FormMessage, Input, SubmitButton, type FormState } from '@/ui';

/**
 * The guest-list builder (docs/CONSOLE_IA.md section 9, pattern 5): a field, an operator and a
 * value per row, joined by "all" or "any", and a text box that holds the same rule in plain words.
 * The two round-trip: rows are written out as text here, and text typed by a person is parsed by
 * the server (the one grammar, identity/list-grammar.ts) back into rows. Nothing typed becomes a
 * query on this side: the service parses the text again when it saves or counts.
 */

export interface BuilderField {
  field: string;
  words: string;
  kind: 'date' | 'count' | 'money' | 'yesno' | 'text';
  hint: string;
  operators: Array<{ op: string; words: string }>;
}

export interface BuilderRow {
  field: string;
  op: string;
  /** As typed: a number of days, a count, dollars, "yes"/"no", or a word. */
  value: string;
}

export type ParsedRows = { join: 'and' | 'or'; rows: BuilderRow[] } | null;
export type ParseState = ({ ok: true; message?: string; data?: { text: string; words: string; rows: ParsedRows } } | { ok: false; error: string }) | null;

const control = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';

const needsQuotes = (v: string) => /\b(and|or|is|not)\b/i.test(v) || /[()"]/.test(v);

/** One row as the grammar writes it. */
export function rowText(r: BuilderRow, fields: BuilderField[]): string | null {
  const f = fields.find((x) => x.field === r.field);
  if (!f) return null;
  const v = r.value.trim();
  switch (f.kind) {
    case 'date':
      if (r.op === 'never') return `${f.words} is never`;
      if (!/^\d+$/.test(v)) return null;
      return r.op === 'within_days' ? `${f.words} within the last ${v} days` : `${f.words} more than ${v} days ago`;
    case 'count':
      if (!/^\d+$/.test(v)) return null;
      return `${f.words} ${opWords(r.op)} ${v}`;
    case 'money':
      if (!/^\$?\d+(\.\d{1,2})?$/.test(v)) return null;
      return `${f.words} ${opWords(r.op)} $${v.replace(/^\$/, '')}`;
    case 'yesno':
      return `${f.words} ${opWords(r.op)} ${v === 'no' ? 'no' : 'yes'}`;
    case 'text':
      if (!v) return null;
      return `${f.words} ${opWords(r.op)} ${needsQuotes(v) ? `"${v.replace(/"/g, '')}"` : v}`;
  }
}

const opWords = (op: string) => (op === 'more_than' ? 'more than' : op === 'less_than' ? 'less than' : op === 'is_not' ? 'is not' : 'is');

export function rowsText(join: 'and' | 'or', rows: BuilderRow[], fields: BuilderField[]): string {
  return rows
    .map((r) => rowText(r, fields))
    .filter((s): s is string => !!s)
    .join(join === 'and' ? ' and ' : ' or ');
}

function blank(field: string, fields: BuilderField[]): BuilderRow {
  const f = fields.find((x) => x.field === field) ?? fields[0]!;
  const op = f.operators[0]!.op;
  return { field: f.field, op, value: f.kind === 'yesno' ? 'yes' : '' };
}

function ValueInput({ row, field, set }: { row: BuilderRow; field: BuilderField; set: (v: string) => void }) {
  if (field.kind === 'date') {
    if (row.op === 'never') return null;
    return (
      <span className="flex items-center gap-2 text-sm text-ink-2">
        <input type="number" min={0} max={36500} aria-label="Days" className={`${control} w-24`} value={row.value} onChange={(e) => set(e.currentTarget.value)} />
        days{row.op === 'more_than_days_ago' ? ' ago' : ''}
      </span>
    );
  }
  if (field.kind === 'count') return <input type="number" min={0} aria-label="Number" className={`${control} w-24`} value={row.value} onChange={(e) => set(e.currentTarget.value)} />;
  if (field.kind === 'money') {
    return (
      <span className="flex items-center gap-1 text-sm text-ink-2">
        $<input type="number" min={0} step="0.01" aria-label="Dollars" className={`${control} w-28`} value={row.value} onChange={(e) => set(e.currentTarget.value)} />
      </span>
    );
  }
  if (field.kind === 'yesno') {
    return (
      <select aria-label="Yes or no" className={control} value={row.value === 'no' ? 'no' : 'yes'} onChange={(e) => set(e.currentTarget.value)}>
        <option value="yes">yes</option>
        <option value="no">no</option>
      </select>
    );
  }
  return <input aria-label="Value" placeholder={field.field === 'suburb' ? 'e.g. Newtown' : 'e.g. walk-in'} className={`${control} w-48`} value={row.value} onChange={(e) => set(e.currentTarget.value)} maxLength={80} />;
}

export function ListBuilder({
  save,
  preview,
  parse,
  fields,
  initial,
  submitLabel,
}: {
  save: (prev: FormState, fd: FormData) => Promise<FormState>;
  preview: (prev: FormState, fd: FormData) => Promise<FormState>;
  parse: (prev: ParseState, fd: FormData) => Promise<ParseState>;
  fields: BuilderField[];
  initial?: { id?: string; name: string; description: string | null; text: string; rows: ParsedRows };
  submitLabel?: string;
}) {
  const [saved, saveAction] = useActionState(save, null);
  const [counted, previewAction] = useActionState(preview, null);
  const [parsed, parseAction] = useActionState(parse, null);
  const [mode, setMode] = useState<'builder' | 'text'>(initial && !initial.rows ? 'text' : 'builder');
  const [join, setJoin] = useState<'and' | 'or'>(initial?.rows?.join ?? 'and');
  const [rows, setRows] = useState<BuilderRow[]>(initial?.rows?.rows ?? [blank('last_visit', fields)]);
  const [text, setText] = useState(initial?.text ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  // Text parsed by the server flows back into the rows once, when the person asks.
  const [appliedParse, setAppliedParse] = useState<ParseState>(null);
  if (parsed && parsed !== appliedParse) {
    setAppliedParse(parsed);
    if (parsed.ok && parsed.data) {
      setText(parsed.data.text);
      if (parsed.data.rows) {
        setJoin(parsed.data.rows.join);
        setRows(parsed.data.rows.rows);
      }
    }
  }
  const builtText = rowsText(join, rows, fields);
  const query = mode === 'builder' ? builtText : text.trim();
  const update = (i: number, patch: Partial<BuilderRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fieldOf = (r: BuilderRow) => fields.find((f) => f.field === r.field) ?? fields[0]!;

  return (
    <form action={saveAction} className="space-y-5" data-testid="list-builder">
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <input type="hidden" name="query" value={query} />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Name">
          <Input name="name" required maxLength={80} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        </Field>
        <Field label="What it is for (optional)">
          <Input name="description" maxLength={300} value={description} onChange={(e) => setDescription(e.currentTarget.value)} />
        </Field>
      </div>

      <div role="tablist" aria-label="How to write the rule" className="flex gap-1 border-b border-line">
        {(['builder', 'text'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            data-testid={`list-mode-${m}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${mode === m ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink'}`}
            onClick={() => {
              if (m === 'text' && mode === 'builder') setText(builtText);
              setMode(m);
            }}
          >
            {m === 'builder' ? 'Pick the conditions' : 'Write it in words'}
          </button>
        ))}
      </div>

      {mode === 'builder' ? (
        <fieldset className="space-y-3 rounded-md border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">Guests who match</legend>
          <label className="flex items-center gap-2 text-sm text-ink-2">
            <select aria-label="All or any" className={control} value={join} onChange={(e) => setJoin(e.currentTarget.value === 'or' ? 'or' : 'and')}>
              <option value="and">all</option>
              <option value="or">any</option>
            </select>
            of these conditions
          </label>
          {rows.map((r, i) => {
            const f = fieldOf(r);
            return (
              <div key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-sunken px-3 py-2" data-testid="list-condition">
                <select aria-label="Field" className={control} value={r.field} onChange={(e) => update(i, blank(e.currentTarget.value, fields))}>
                  {fields.map((x) => (
                    <option key={x.field} value={x.field}>
                      {x.words}
                    </option>
                  ))}
                </select>
                <select aria-label="Operator" className={control} value={r.op} onChange={(e) => update(i, { op: e.currentTarget.value })}>
                  {f.operators.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.words}
                    </option>
                  ))}
                </select>
                <ValueInput row={r} field={f} set={(value) => update(i, { value })} />
                <span className="text-xs text-ink-3">{f.hint}</span>
                {rows.length > 1 ? (
                  <button type="button" className="ml-auto rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                ) : null}
              </div>
            );
          })}
          {rows.length < 10 ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRows((rs) => [...rs, blank('email_yes', fields)])}>
              Add a condition
            </Button>
          ) : (
            <p className="text-xs text-ink-3">Ten conditions is the most a list can have.</p>
          )}
          <p className="text-sm text-ink" data-testid="list-text">
            {builtText ? `In words: ${builtText}` : 'Fill in at least one condition.'}
          </p>
        </fieldset>
      ) : (
        <fieldset className="space-y-3 rounded-md border border-line p-4">
          <legend className="px-1 text-sm font-medium text-ink">The rule, in words</legend>
          <textarea
            name="text"
            aria-label="Rule"
            className="min-h-24 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            placeholder='e.g. last visit more than 60 days ago and said yes to email'
            data-testid="list-text-input"
          />
          <p className="text-xs text-ink-3">
            Fields: {fields.map((f) => f.words).join(' · ')}. Say &quot;more than&quot;, &quot;less than&quot;, &quot;is&quot;, &quot;is not&quot;, &quot;within the last N days&quot; or &quot;more than N days ago&quot;; join with &quot;and&quot; or &quot;or&quot;, and use brackets to group. At most ten conditions.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" size="sm" formAction={parseAction} formNoValidate data-testid="list-parse">
              Check the wording
            </Button>
            {parsed ? (
              parsed.ok ? (
                <span className="text-sm text-ink" data-testid="list-parsed">
                  {parsed.data?.words}
                  {parsed.data?.rows ? '' : ' (grouped with brackets: shown here as words only)'}
                </span>
              ) : (
                <span className="text-sm text-bad" data-testid="list-parse-error">
                  {parsed.error}
                </span>
              )
            ) : null}
          </div>
        </fieldset>
      )}

      {counted ? <div data-testid="list-count">{counted.ok ? <FormMessage tone="info">{counted.message}</FormMessage> : <FormMessage tone="error">{counted.error}</FormMessage>}</div> : null}
      {saved && !saved.ok ? <FormMessage tone="error">{saved.error}</FormMessage> : null}
      {saved?.ok && saved.message ? <FormMessage tone="success">{saved.message}</FormMessage> : null}
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving…">{submitLabel ?? (initial?.id ? 'Save list' : 'Create list')}</SubmitButton>
        <Button type="submit" variant="secondary" formAction={previewAction} formNoValidate data-testid="list-preview">
          Count guests
        </Button>
        <span className="text-xs text-ink-3">A list never bypasses consent: sending still checks each guest at the moment it goes.</span>
      </div>
    </form>
  );
}
