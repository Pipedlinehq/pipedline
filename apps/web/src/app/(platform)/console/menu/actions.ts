'use server';

import { redirect } from 'next/navigation';
import { menu } from '@ros/modules';
import { act, all, bool, cents, int, nullableText, optText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/**
 * Menu changes. The venue a new menu or group belongs to comes from the console's selected venue;
 * every other id is checked by the menu service, which answers another venue's id as not found.
 */

const PATHS = ['/console/menu'];
const ok = (r: FormState & { data?: unknown }): FormState => (r && r.ok ? { ok: true, message: r.message } : r);
const tags = (fd: FormData, name: string) =>
  text(fd, name)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
const days = (fd: FormData) => all(fd, 'days').map(Number);

// ── 86: kitchen, front of house and managers ────────────────────────────────

export async function setAvailability(_: FormState, fd: FormData): Promise<FormState> {
  const available = text(fd, 'available') === 'true';
  const until = text(fd, 'until');
  return ok(
    await act((ctx) => menu.setItemAvailability(ctx, { itemId: text(fd, 'itemId'), available, until: !available && until === 'end_of_service' ? 'end_of_service' : null }), {
      success: (d) => (d.available ? `${d.name} is back on.` : `${d.name} is 86'd${d.until ? ' until the end of service' : ' until someone puts it back'}.`),
      revalidate: PATHS,
    }),
  );
}

export async function setModifierAvailability(_: FormState, fd: FormData): Promise<FormState> {
  const available = text(fd, 'available') === 'true';
  return ok(
    await act((ctx) => menu.setModifierAvailability(ctx, { modifierId: text(fd, 'modifierId'), available }), {
      success: (d) => (d.available ? `${d.name} is back on.` : `${d.name} is 86'd.`),
      revalidate: PATHS,
    }),
  );
}

// ── Menus and sections: managers ────────────────────────────────────────────

function menuFields(fd: FormData) {
  return {
    name: text(fd, 'name'),
    isActive: bool(fd, 'isActive'),
    availableDays: days(fd),
    availableFrom: nullableText(fd, 'availableFrom'),
    availableTo: nullableText(fd, 'availableTo'),
    sortOrder: int(fd, 'sortOrder') ?? 0,
  };
}

export async function createMenu(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx, c) => menu.createMenu(ctx, { venueId: c.venue.id, ...menuFields(fd) }), { success: (m) => `${m.name} created.`, revalidate: PATHS }));
}

export async function updateMenu(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => menu.updateMenu(ctx, text(fd, 'menuId'), menuFields(fd)), { success: 'Menu saved.', revalidate: PATHS }));
}

export async function deleteMenu(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => menu.deleteMenu(ctx, text(fd, 'menuId')), { success: 'Menu removed.', revalidate: PATHS }));
}

export async function createSection(_: FormState, fd: FormData): Promise<FormState> {
  return ok(
    await act(
      (ctx) =>
        menu.createSection(ctx, {
          menuId: text(fd, 'menuId'),
          name: text(fd, 'name'),
          description: nullableText(fd, 'description'),
          sortOrder: int(fd, 'sortOrder') ?? 0,
          isVisible: bool(fd, 'isVisible'),
        }),
      { success: (s) => `${s.name} added.`, revalidate: PATHS },
    ),
  );
}

export async function updateSection(_: FormState, fd: FormData): Promise<FormState> {
  return ok(
    await act(
      (ctx) =>
        menu.updateSection(ctx, text(fd, 'sectionId'), {
          name: text(fd, 'name'),
          description: nullableText(fd, 'description'),
          sortOrder: int(fd, 'sortOrder') ?? 0,
          isVisible: bool(fd, 'isVisible'),
        }),
      { success: 'Section saved.', revalidate: PATHS },
    ),
  );
}

export async function deleteSection(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => menu.deleteSection(ctx, text(fd, 'sectionId')), { success: 'Section and its items removed.', revalidate: PATHS }));
}

// ── Items: managers ─────────────────────────────────────────────────────────

function itemFields(fd: FormData) {
  const price = cents(fd, 'price');
  return {
    name: text(fd, 'name'),
    description: nullableText(fd, 'description'),
    priceCents: price ?? Number.NaN,
    imageUrl: nullableText(fd, 'imageUrl'),
    sortOrder: int(fd, 'sortOrder') ?? 0,
    dietaryTags: tags(fd, 'dietaryTags'),
    allergens: tags(fd, 'allergens'),
    spiceLevel: int(fd, 'spiceLevel') ?? null,
    calories: int(fd, 'calories') ?? null,
    prepMinutes: int(fd, 'prepMinutes') ?? 10,
    maxPerOrder: int(fd, 'maxPerOrder') ?? null,
    isAlcohol: bool(fd, 'isAlcohol'),
    isVisibleOnline: bool(fd, 'isVisibleOnline'),
    isVisibleInVenue: bool(fd, 'isVisibleInVenue'),
    posCatalogId: nullableText(fd, 'posCatalogId'),
  };
}

export async function createItem(_: FormState, fd: FormData): Promise<FormState> {
  if (Number.isNaN(cents(fd, 'price') ?? Number.NaN)) return { ok: false, error: 'Give a price in dollars, such as 24.50.' };
  return ok(await act((ctx) => menu.createItem(ctx, { sectionId: text(fd, 'sectionId'), ...itemFields(fd) }), { success: (i) => `${i.name} added.`, revalidate: PATHS }));
}

export async function updateItem(_: FormState, fd: FormData): Promise<FormState> {
  if (Number.isNaN(cents(fd, 'price') ?? Number.NaN)) return { ok: false, error: 'Give a price in dollars, such as 24.50.' };
  const sectionId = optText(fd, 'sectionId');
  return ok(
    await act((ctx) => menu.updateItem(ctx, text(fd, 'itemId'), { ...itemFields(fd), ...(sectionId ? { sectionId } : {}) }), {
      success: 'Item saved.',
      revalidate: ['/console/menu', `/console/menu/items/${text(fd, 'itemId')}`],
    }),
  );
}

export async function deleteItem(_: FormState, fd: FormData): Promise<FormState> {
  const r = ok(await act((ctx) => menu.deleteItem(ctx, text(fd, 'itemId')), { success: 'Item removed from the menu. Past orders keep their record of it.', revalidate: PATHS }));
  // From the item's own page there is nothing left to show: go back to the menu.
  if (r?.ok && bool(fd, 'backToMenu')) redirect('/console/menu');
  return r;
}

export async function setItemGroups(_: FormState, fd: FormData): Promise<FormState> {
  const itemId = text(fd, 'itemId');
  return ok(await act((ctx) => menu.setItemModifierGroups(ctx, itemId, all(fd, 'groupIds')), { success: 'Choices saved.', revalidate: ['/console/menu', `/console/menu/items/${itemId}`] }));
}

// ── Modifier groups and modifiers: managers ─────────────────────────────────

function groupFields(fd: FormData) {
  return {
    name: text(fd, 'name'),
    selectionType: (text(fd, 'selectionType') === 'multi' ? 'multi' : 'single') as 'single' | 'multi',
    minSelections: int(fd, 'minSelections') ?? 0,
    maxSelections: int(fd, 'maxSelections') ?? 1,
    isRequired: bool(fd, 'isRequired'),
    sortOrder: int(fd, 'sortOrder') ?? 0,
  };
}

export async function createGroup(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx, c) => menu.createModifierGroup(ctx, { venueId: c.venue.id, ...groupFields(fd) }), { success: (g) => `${g.name} created.`, revalidate: PATHS }));
}

export async function updateGroup(_: FormState, fd: FormData): Promise<FormState> {
  const groupId = text(fd, 'groupId');
  return ok(await act((ctx) => menu.updateModifierGroup(ctx, groupId, groupFields(fd)), { success: 'Group saved.', revalidate: ['/console/menu', `/console/menu/groups/${groupId}`] }));
}

export async function deleteGroup(_: FormState, fd: FormData): Promise<FormState> {
  const r = ok(await act((ctx) => menu.deleteModifierGroup(ctx, text(fd, 'groupId')), { success: 'Group removed from every item.', revalidate: PATHS }));
  if (r?.ok && bool(fd, 'backToMenu')) redirect('/console/menu');
  return r;
}

function modifierFields(fd: FormData) {
  const delta = cents(fd, 'priceDelta');
  return {
    name: text(fd, 'name'),
    priceDeltaCents: delta ?? 0,
    isDefault: bool(fd, 'isDefault'),
    sortOrder: int(fd, 'sortOrder') ?? 0,
  };
}

export async function createModifier(_: FormState, fd: FormData): Promise<FormState> {
  if (Number.isNaN(cents(fd, 'priceDelta') ?? 0)) return { ok: false, error: 'Give the price change in dollars, such as 2.50 or -1.'};
  const groupId = text(fd, 'groupId');
  return ok(await act((ctx) => menu.createModifier(ctx, { groupId, ...modifierFields(fd) }), { success: (m) => `${m.name} added.`, revalidate: ['/console/menu', `/console/menu/groups/${groupId}`] }));
}

export async function updateModifier(_: FormState, fd: FormData): Promise<FormState> {
  if (Number.isNaN(cents(fd, 'priceDelta') ?? 0)) return { ok: false, error: 'Give the price change in dollars, such as 2.50 or -1.' };
  return ok(await act((ctx) => menu.updateModifier(ctx, text(fd, 'modifierId'), modifierFields(fd)), { success: 'Choice saved.', revalidate: ['/console/menu', `/console/menu/groups/${text(fd, 'groupId')}`] }));
}

export async function deleteModifier(_: FormState, fd: FormData): Promise<FormState> {
  return ok(await act((ctx) => menu.deleteModifier(ctx, text(fd, 'modifierId')), { success: 'Choice removed.', revalidate: ['/console/menu', `/console/menu/groups/${text(fd, 'groupId')}`] }));
}
