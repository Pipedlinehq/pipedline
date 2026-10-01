'use server';

import { redirect } from 'next/navigation';
import { onboarding } from '@ros/modules';
import { act, bool, cents, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/**
 * Menu import: a model reads a pasted menu or a menu page and proposes items; a manager decides
 * each one. Nothing reaches the live menu except through confirmImportItem, one item at a time.
 */
const PATH = '/console/menu/import';
const plain = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);
const list = (fd: FormData, name: string) =>
  text(fd, name)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export async function startImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const url = text(fd, 'url');
  const pasted = text(fd, 'text');
  if (!url && !pasted) return { ok: false, error: 'Paste the menu, or give the address of the page it is on.' };
  if (url && pasted) return { ok: false, error: 'Use one or the other: the pasted menu, or the page address.' };
  const r = await act((ctx, c) => onboarding.requestMenuImport(ctx, { venueId: c.venue.id, source: url ? { kind: 'url', url } : { kind: 'text', text: pasted } }), { revalidate: PATH });
  if (!r.ok) return r;
  redirect(`${PATH}/${r.data!.importId}`);
}

export async function saveImportItem(_prev: FormState, fd: FormData): Promise<FormState> {
  const price = cents(fd, 'price');
  if (price !== undefined && (Number.isNaN(price) || price < 0)) return { ok: false, error: 'Price: enter an amount in dollars, like 24.50.' };
  const importId = text(fd, 'importId');
  return plain(
    await act(
      (ctx) =>
        onboarding.editImportItem(ctx, {
          importId,
          itemKey: text(fd, 'itemKey'),
          patch: {
            name: text(fd, 'name'),
            description: text(fd, 'description') || null,
            ...(price !== undefined ? { priceCents: price } : {}),
            dietaryTags: list(fd, 'dietaryTags'),
            // Sent only when the person says the list is theirs: saving it marks the allergens as checked.
            ...(bool(fd, 'allergensMine') ? { allergens: list(fd, 'allergens') } : {}),
          },
        }),
      { success: (i) => `“${i.name}” saved. It is not on the menu until you add it.`, revalidate: `${PATH}/${importId}` },
    ),
  );
}

export async function confirmImportItem(_prev: FormState, fd: FormData): Promise<FormState> {
  const importId = text(fd, 'importId');
  const name = text(fd, 'itemName') || 'The item';
  return plain(
    await act((ctx) => onboarding.confirmImportItem(ctx, { importId, itemKey: text(fd, 'itemKey'), allergensChecked: bool(fd, 'allergensChecked') }), {
      success: `“${name}” is on the menu.`,
      revalidate: [`${PATH}/${importId}`, '/console/menu'],
    }),
  );
}

export async function discardImportItem(_prev: FormState, fd: FormData): Promise<FormState> {
  const importId = text(fd, 'importId');
  const name = text(fd, 'itemName') || 'The item';
  return plain(await act((ctx) => onboarding.discardImportItem(ctx, { importId, itemKey: text(fd, 'itemKey') }), { success: `“${name}” left out. Nothing was added to the menu.`, revalidate: `${PATH}/${importId}` }));
}

export async function discardImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const importId = text(fd, 'importId');
  return plain(await act((ctx) => onboarding.discardMenuImport(ctx, importId), { success: 'The rest of this import was left out. Items already added stay on the menu.', revalidate: [PATH, `${PATH}/${importId}`] }));
}
