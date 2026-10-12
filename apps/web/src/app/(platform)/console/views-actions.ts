'use server';

import { redirect } from 'next/navigation';
import { events } from '@ros/modules';
import { act, text } from '@/lib/console-actions';
import { VIEW_PAGE_PATHS } from '@/lib/console-views';
import type { FormState } from '@/ui/client';

/**
 * Saved views (docs/CONSOLE_IA.md section 9, wave 1). The venue is the console's selected one,
 * never a form field; the service checks the role there. A default view is code: there is no
 * row to rename or delete, so the actions below only ever touch the venue's own views.
 */
const isPage = (p: string): p is events.ConsoleViewPage => (events.CONSOLE_VIEW_PAGES as readonly string[]).includes(p);

function filtersFrom(fd: FormData): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text(fd, 'filters') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string' && v !== '') as Array<[string, string]>);
  } catch {
    return {};
  }
}

/** Save the filters in force as a new view, or update one. Lands on the view afterwards. */
export async function saveView(_prev: FormState, fd: FormData): Promise<FormState> {
  const page = text(fd, 'page');
  if (!isPage(page)) return { ok: false, error: 'That page has no saved views.' };
  const id = text(fd, 'id') || undefined;
  const r = await act((ctx, c) => events.saveConsoleView(ctx, { venueId: c.venue.id, page, name: text(fd, 'name'), filters: filtersFrom(fd), id }), { revalidate: VIEW_PAGE_PATHS[page] });
  if (!r.ok) return r;
  redirect(`${VIEW_PAGE_PATHS[page]}?view=saved:${r.data!.id}`);
}

export async function renameView(_prev: FormState, fd: FormData): Promise<FormState> {
  const page = text(fd, 'page');
  const r = await act((ctx) => events.renameConsoleView(ctx, { id: text(fd, 'id'), name: text(fd, 'name') }), { success: (v) => `Renamed to “${v.name}”.`, revalidate: isPage(page) ? VIEW_PAGE_PATHS[page] : '/console' });
  return r.ok ? { ok: true, message: r.message } : r;
}

/** Delete one of the venue's own views, then back to the page's first view. */
export async function deleteView(_prev: FormState, fd: FormData): Promise<FormState> {
  const page = text(fd, 'page');
  const path = isPage(page) ? VIEW_PAGE_PATHS[page] : '/console';
  const r = await act((ctx) => events.deleteConsoleView(ctx, text(fd, 'id')), { revalidate: path });
  if (!r.ok) return r;
  redirect(path);
}
