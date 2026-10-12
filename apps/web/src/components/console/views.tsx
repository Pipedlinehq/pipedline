'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, FormMessage, SubmitButton, type FormState } from '@/ui';
import { cx } from '@/ui/format';
import type { FilterField, ResolvedView } from '@/lib/console-views';
import { flash } from './flash';

/**
 * The views row of an index page (docs/CONSOLE_IA.md section 9, wave 1; pattern 1): default
 * views that cannot be renamed or deleted, the venue's own saved views, the filter form whose
 * values live in the URL, the tokens of what is in force, and Save view as / Update view /
 * Rename / Delete view. Everything here is links and plain GET forms, so a view is a URL anyone
 * at the venue can be sent, and it works before scripts load.
 *
 * Wave-2 builders: give the page a `ViewSpec` (lib/console-views.ts), resolve it on the server
 * with `resolveView`, hand the result here, and apply `resolved.filters` through the service.
 */
export interface IndexViewsProps {
  page: string;
  path: string;
  resolved: ResolvedView;
  fields: FilterField[];
  /** False for read-only roles: they see the views but cannot save one. */
  canSave: boolean;
  saveAction: (prev: FormState, fd: FormData) => Promise<FormState>;
  renameAction: (prev: FormState, fd: FormData) => Promise<FormState>;
  deleteAction: (prev: FormState, fd: FormData) => Promise<FormState>;
  /** Shown at the right of the filter row (a count, a note). */
  aside?: ReactNode;
  /** Extra hidden fields the page needs kept on every filter submit (a date the page is on). */
  keep?: Record<string, string>;
}

const control = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';

export function IndexViews({ page, path, resolved, fields, canSave, saveAction, renameAction, deleteAction, aside, keep = {} }: IndexViewsProps) {
  const { current, filters, dirty, tabs, tokens } = resolved;
  const filtersJson = JSON.stringify(filters);
  return (
    <div className="mb-6 space-y-3" data-testid={`views-${page}`} data-view={current.key} data-dirty={dirty ? 'true' : 'false'}>
      <nav aria-label="Views" className="flex flex-wrap items-center gap-1 border-b border-line">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.href}
            aria-current={t.key === current.key ? 'page' : undefined}
            data-testid={`view-tab-${t.isDefault ? t.key : 'saved'}`}
            data-view-key={t.key}
            className={cx('-mb-px border-b-2 px-3 py-2 text-sm', t.key === current.key ? 'border-ink font-medium text-ink' : 'border-transparent text-ink-2 hover:text-ink')}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {/* Keyed by the view and its filters: the controls are uncontrolled, so a tab change must remount them to show the new view's values. */}
      <form key={`${current.key}:${filtersJson}`} method="get" action={path} role="search" aria-label="Filter the list" className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <input type="hidden" name="view" value={current.key} />
        <input type="hidden" name="f" value="1" />
        {Object.entries(keep).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            {f.label}
            {f.kind === 'select' ? (
              <select name={f.key} defaultValue={filters[f.key] ?? ''} className={control}>
                <option value="">Any</option>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input name={f.key} type={f.kind === 'date' ? 'date' : 'search'} defaultValue={filters[f.key] ?? ''} placeholder={f.placeholder} maxLength={100} autoComplete="off" className={cx(control, f.kind === 'text' && 'w-48')} />
            )}
          </label>
        ))}
        <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
          Apply
        </button>
        {tokens.length ? (
          <Link href={`${path}?view=${encodeURIComponent(current.key)}&f=1`} className="text-sm text-accent">
            Clear filters
          </Link>
        ) : null}
        {aside ? <div className="ml-auto self-center text-xs text-ink-3">{aside}</div> : null}
      </form>

      {tokens.length || (canSave && dirty) || (!current.isDefault && canSave) ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="view-tokens">
          {tokens.map((t) => (
            <Link key={t.key} href={t.removeHref} className="inline-flex items-center gap-1 rounded-full border border-line bg-sunken px-2.5 py-1 text-xs text-ink hover:border-line-strong" aria-label={`Remove filter ${t.label}: ${t.words}`}>
              <span className="text-ink-3">{t.label}:</span> {t.words}
              <span aria-hidden>×</span>
            </Link>
          ))}
          {canSave ? (
            <span className="ml-auto flex flex-wrap items-center gap-2">
              {dirty ? <SaveViewAs page={page} filtersJson={filtersJson} action={saveAction} /> : null}
              {dirty && !current.isDefault && current.id ? <UpdateView id={current.id} name={current.label} page={page} filtersJson={filtersJson} action={saveAction} /> : null}
              {!current.isDefault && current.id ? (
                <>
                  <RenameView id={current.id} name={current.label} page={page} action={renameAction} />
                  <DeleteView id={current.id} name={current.label} page={page} action={deleteAction} />
                </>
              ) : null}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A small dialog form that closes itself when the action answers well and says so through the flash region. */
function SmallDialog({ trigger, title, children, action, confirmLabel, variant = 'primary', testId, triggerVariant = 'secondary' }: { trigger: ReactNode; title: string; children: ReactNode; action: (prev: FormState, fd: FormData) => Promise<FormState>; confirmLabel: string; variant?: 'primary' | 'danger'; testId?: string; triggerVariant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, formAction] = useActionState(action, null);
  const seen = useRef<FormState>(null);
  useEffect(() => {
    if (state && state !== seen.current && state.ok) {
      seen.current = state;
      flash(state.message ?? 'Done.');
      ref.current?.close();
    }
  }, [state]);
  return (
    <>
      <Button type="button" variant={triggerVariant} size="sm" onClick={() => ref.current?.showModal()} data-testid={testId}>
        {trigger}
      </Button>
      <dialog ref={ref} aria-label={title} className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-0 text-ink shadow-xl">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={() => ref.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <form action={formAction} className="space-y-4 p-5">
          {children}
          {state && !state.ok ? <FormMessage tone="error">{state.error}</FormMessage> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <SubmitButton variant={variant} pendingLabel="Working…">
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}

function NameField({ defaultValue }: { defaultValue?: string }) {
  const [v, setV] = useState(defaultValue ?? '');
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">Name</span>
      <input name="name" value={v} onChange={(e) => setV(e.target.value)} required maxLength={60} autoComplete="off" className="block h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink" />
      <span className="mt-1 block text-xs text-ink-3">Everyone at this venue sees it.</span>
    </label>
  );
}

function SaveViewAs({ page, filtersJson, action }: { page: string; filtersJson: string; action: IndexViewsProps['saveAction'] }) {
  return (
    <SmallDialog trigger="Save view as…" title="Save this view" action={action} confirmLabel="Save view" testId="save-view-as">
      <input type="hidden" name="page" value={page} />
      <input type="hidden" name="filters" value={filtersJson} />
      <p className="text-sm text-ink-2">The filters in force are kept under a name of your own, as a tab on this page for everyone at the venue.</p>
      <NameField />
    </SmallDialog>
  );
}

function UpdateView({ id, name, page, filtersJson, action }: { id: string; name: string; page: string; filtersJson: string; action: IndexViewsProps['saveAction'] }) {
  return (
    <SmallDialog trigger="Update view" title={`Update “${name}”?`} action={action} confirmLabel="Update view" testId="update-view">
      <input type="hidden" name="page" value={page} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="filters" value={filtersJson} />
      <p className="text-sm text-ink-2">The view keeps its name and takes the filters in force now.</p>
    </SmallDialog>
  );
}

function RenameView({ id, name, page, action }: { id: string; name: string; page: string; action: IndexViewsProps['renameAction'] }) {
  return (
    <SmallDialog trigger="Rename" title={`Rename “${name}”`} action={action} confirmLabel="Rename view" testId="rename-view" triggerVariant="ghost">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="page" value={page} />
      <NameField defaultValue={name} />
    </SmallDialog>
  );
}

function DeleteView({ id, name, page, action }: { id: string; name: string; page: string; action: IndexViewsProps['deleteAction'] }) {
  return (
    <SmallDialog trigger="Delete view" title={`Delete “${name}”?`} action={action} confirmLabel="Delete view" variant="danger" testId="delete-view" triggerVariant="ghost">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="page" value={page} />
      <p className="text-sm text-ink-2">The tab goes for everyone at this venue. Nothing in the list itself changes.</p>
    </SmallDialog>
  );
}
