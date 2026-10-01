import { z } from 'zod';
import { type Ctx, type LocalParts, localParts } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import type { MenuSurface, PublicMenu, PublicMenuItem, PublicModifierGroup } from './contract';

/** Whether a menu with an availability window is being served at a venue-local moment. */
export function menuServedAt(
  menu: { is_active: boolean; available_days: number[]; available_from: string | null; available_to: string | null },
  local: LocalParts,
): boolean {
  if (!menu.is_active) return false;
  const today = menu.available_days.includes(local.weekday);
  const from = menu.available_from;
  const to = menu.available_to;
  if (!from || !to) return today;
  const t = local.time;
  const f = from.length === 5 ? `${from}:00` : from;
  const e = to.length === 5 ? `${to}:00` : to;
  if (f <= e) return today && t >= f && t < e;
  // A window that runs past midnight belongs to the day it started on.
  const yesterday = menu.available_days.includes((local.weekday + 6) % 7);
  return (today && t >= f) || (yesterday && t < e);
}

/** The 86 button's state: off the menu until someone puts it back, or until a set time passes. */
export function itemAvailableAt(item: { is_available: boolean; unavailable_until: Date | null }, at: Date): boolean {
  if (item.is_available) return true;
  return item.unavailable_until !== null && item.unavailable_until.getTime() <= at.getTime();
}

interface GroupBundle {
  byItem: Map<string, PublicModifierGroup[]>;
}

async function loadGroups(ctx: Ctx, itemIds: string[]): Promise<GroupBundle> {
  const byItem = new Map<string, PublicModifierGroup[]>();
  if (!itemIds.length) return { byItem };
  const links = await ctx.db
    .selectFrom('item_modifier_groups as l')
    .innerJoin('modifier_groups as g', 'g.id', 'l.group_id')
    .select(['l.item_id', 'l.sort_order as link_order', 'g.id', 'g.name', 'g.selection_type', 'g.min_selections', 'g.max_selections', 'g.is_required'])
    .where('l.item_id', 'in', itemIds)
    .where('g.deleted_at', 'is', null)
    .orderBy('l.sort_order')
    .execute();
  const groupIds = [...new Set(links.map((l) => l.id))];
  const mods = groupIds.length
    ? await ctx.db
        .selectFrom('modifiers')
        .select(['id', 'group_id', 'name', 'price_delta_cents', 'is_default', 'is_available'])
        .where('group_id', 'in', groupIds)
        .where('deleted_at', 'is', null)
        .orderBy('sort_order')
        .execute()
    : [];
  for (const l of links) {
    const list = byItem.get(l.item_id) ?? [];
    list.push({
      id: l.id,
      name: l.name,
      selectionType: l.selection_type,
      minSelections: l.min_selections,
      maxSelections: l.max_selections,
      isRequired: l.is_required,
      modifiers: mods
        .filter((m) => m.group_id === l.id)
        .map((m) => ({ id: m.id, name: m.name, priceDeltaCents: m.price_delta_cents, isDefault: m.is_default, isAvailable: m.is_available })),
    });
    byItem.set(l.item_id, list);
  }
  return { byItem };
}

export const publicMenuOptions = z.object({
  surface: z.enum(['online', 'in_venue']).default('online'),
  at: z.date().optional(),
});

/**
 * The menu as a guest sees it, on the site, on a QR code and in ordering: the same rows, so an
 * 86 in the kitchen is gone from every surface at once (docs/modules/ordering.md section 1).
 *
 * No role check: this is public content. A venue id from another org is not found. Only menus
 * being served at `at` are returned; hidden sections, items hidden on this surface and anything
 * removed are left out. An 86'd item is still listed, marked unavailable.
 */
export async function getPublicMenu(ctx: Ctx, venueId: string, opts: { surface?: MenuSurface; at?: Date } = {}): Promise<PublicMenu> {
  const id = z.string().uuid().parse(venueId);
  const { surface, at: atOpt } = publicMenuOptions.parse(opts);
  const at = atOpt ?? ctx.now();
  const venue = await getVenue(ctx, id);
  const org = await getOrg(ctx);
  const local = localParts(at, venue.timezone);

  const menus = (
    await ctx.db
      .selectFrom('menus')
      .select(['id', 'name', 'is_active', 'available_days', 'available_from', 'available_to'])
      .where('venue_id', '=', id)
      .where('deleted_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('created_at')
      .execute()
  ).filter((m) => menuServedAt(m, local));

  const out: PublicMenu = { venueId: id, currency: org.currency, taxInclusive: org.taxInclusive, menus: [], generatedAt: ctx.now().toISOString() };
  if (!menus.length) return out;

  const sections = await ctx.db
    .selectFrom('menu_sections')
    .select(['id', 'menu_id', 'name', 'description'])
    .where('menu_id', 'in', menus.map((m) => m.id))
    .where('deleted_at', 'is', null)
    .where('is_visible', '=', true)
    .orderBy('sort_order')
    .execute();
  const items = sections.length
    ? await ctx.db
        .selectFrom('menu_items')
        .select([
          'id',
          'section_id',
          'name',
          'description',
          'price_cents',
          'image_url',
          'is_available',
          'unavailable_until',
          'dietary_tags',
          'allergens',
          'spice_level',
          'calories',
          'prep_minutes',
          'max_per_order',
          'is_alcohol',
        ])
        .where('section_id', 'in', sections.map((s) => s.id))
        .where('deleted_at', 'is', null)
        .where(surface === 'online' ? 'is_visible_online' : 'is_visible_in_venue', '=', true)
        .orderBy('sort_order')
        .orderBy('name')
        .execute()
    : [];
  const groups = await loadGroups(ctx, items.map((i) => i.id));

  const toItem = (i: (typeof items)[number]): PublicMenuItem => ({
    id: i.id,
    name: i.name,
    description: i.description,
    priceCents: i.price_cents,
    imageUrl: i.image_url,
    isAvailable: itemAvailableAt(i, at),
    dietaryTags: i.dietary_tags,
    allergens: i.allergens,
    spiceLevel: i.spice_level,
    calories: i.calories,
    prepMinutes: i.prep_minutes,
    maxPerOrder: i.max_per_order,
    isAlcohol: i.is_alcohol,
    modifierGroups: groups.byItem.get(i.id) ?? [],
  });

  for (const m of menus) {
    const menuSections = sections
      .filter((s) => s.menu_id === m.id)
      .map((s) => ({ id: s.id, name: s.name, description: s.description, items: items.filter((i) => i.section_id === s.id).map(toItem) }))
      .filter((s) => s.items.length > 0);
    if (menuSections.length) out.menus.push({ id: m.id, name: m.name, sections: menuSections });
  }
  return out;
}

/** A menu item as ordering needs it: the server's own price, state and modifier rules. */
export interface OrderableItem {
  id: string;
  venueId: string;
  name: string;
  /** The section it sits in, frozen onto the order as its category. */
  category: string | null;
  priceCents: number;
  /** False while 86'd at the time asked about. */
  isAvailable: boolean;
  /** False when the menu it belongs to is not being served at the time asked about. */
  isServed: boolean;
  allergens: string[];
  isAlcohol: boolean;
  prepMinutes: number;
  maxPerOrder: number | null;
  posCatalogId: string | null;
  modifierGroups: PublicModifierGroup[];
}

/**
 * Look up the items a cart names, for one venue and one surface. An id that is not an item a
 * guest could see at this venue (another org's, another venue's, removed, hidden) is simply
 * absent from the result; the caller answers not-found.
 */
export async function getOrderableItems(
  ctx: Ctx,
  venueId: string,
  itemIds: string[],
  opts: { surface: MenuSurface; at?: Date },
): Promise<Map<string, OrderableItem>> {
  const out = new Map<string, OrderableItem>();
  const ids = [...new Set(itemIds)];
  if (!ids.length) return out;
  const at = opts.at ?? ctx.now();
  const venue = await getVenue(ctx, venueId);
  const local = localParts(at, venue.timezone);

  const rows = await ctx.db
    .selectFrom('menu_items as i')
    .innerJoin('menu_sections as s', 's.id', 'i.section_id')
    .innerJoin('menus as m', 'm.id', 's.menu_id')
    .select([
      'i.id',
      'i.venue_id',
      'i.name',
      'i.price_cents',
      'i.is_available',
      'i.unavailable_until',
      'i.allergens',
      'i.is_alcohol',
      'i.prep_minutes',
      'i.max_per_order',
      'i.pos_catalog_id',
      's.name as section_name',
      'm.is_active',
      'm.available_days',
      'm.available_from',
      'm.available_to',
    ])
    .where('i.id', 'in', ids)
    .where('i.venue_id', '=', venueId)
    .where('i.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.is_visible', '=', true)
    .where('m.deleted_at', 'is', null)
    .where(opts.surface === 'online' ? 'i.is_visible_online' : 'i.is_visible_in_venue', '=', true)
    .execute();
  const groups = await loadGroups(ctx, rows.map((r) => r.id));

  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      venueId: r.venue_id,
      name: r.name,
      category: r.section_name,
      priceCents: r.price_cents,
      isAvailable: itemAvailableAt(r, at),
      isServed: menuServedAt(r, local),
      allergens: r.allergens,
      isAlcohol: r.is_alcohol,
      prepMinutes: r.prep_minutes,
      maxPerOrder: r.max_per_order,
      posCatalogId: r.pos_catalog_id,
      modifierGroups: groups.byItem.get(r.id) ?? [],
    });
  }
  return out;
}
