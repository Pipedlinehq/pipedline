import { sql } from 'kysely';
import { z } from 'zod';
import { type Ctx, type LocalParts, localParts, notFound } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { type MenuChannel, type MenuSurface, type PublicMenu, type PublicMenuItem, type PublicModifierGroup, MENU_CHANNELS, channelOf, liveAt } from './contract';

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

/**
 * The 86 button's state: off the menu until someone puts it back, or until a set time passes.
 * Worked out at read time from `unavailable_until`, never by a job: the moment the time passes,
 * every reader (site, QR, ordering, kitchen screen, console, assistants) sees the item back, on
 * the same clock, with nothing that could run late or twice.
 */
export function itemAvailableAt(item: { is_available: boolean; unavailable_until: Date | null }, at: Date): boolean {
  if (item.is_available) return true;
  return item.unavailable_until !== null && item.unavailable_until.getTime() <= at.getTime();
}

/** When a sold-out item comes back on its own; null when it is available or off until someone puts it back. */
export function itemBackAt(item: { is_available: boolean; unavailable_until: Date | null }, at: Date): Date | null {
  if (itemAvailableAt(item, at)) return null;
  return item.unavailable_until;
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

/** The venue's own price for these items on one channel, where it set one. */
export async function loadChannelPrices(ctx: Ctx, itemIds: string[], channel: MenuChannel): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!itemIds.length) return out;
  const rows = await ctx.db.selectFrom('menu_item_prices').select(['item_id', 'price_cents']).where('item_id', 'in', itemIds).where('channel', '=', channel).execute();
  for (const r of rows) out.set(r.item_id, r.price_cents);
  return out;
}

/** `shown_on` contains the channel. */
const shownOn = (channel: MenuChannel, column = 'shown_on') => sql<boolean>`${sql.val(channel)} = any(${sql.ref(column)})`;

export const publicMenuOptions = z.object({
  surface: z.enum([...MENU_CHANNELS, 'online', 'in_venue']).default('online'),
  at: z.date().optional(),
});

/**
 * The menu as a guest sees it, on the site, on a QR code, in ordering and inside an assistant:
 * the same rows, so an 86 in the kitchen is gone from every surface at once
 * (docs/modules/ordering.md section 1).
 *
 * No role check: this is public content. A venue id from another org is not found. Only menus
 * and sections being served at `at` (their days and hours, and their live-from and retire
 * times) are returned; hidden sections, items not shown on this surface's channel and anything
 * removed are left out. An 86'd item is still listed, marked unavailable. Prices are the
 * channel's own where the venue set one.
 */
export async function getPublicMenu(ctx: Ctx, venueId: string, opts: { surface?: MenuSurface; at?: Date } = {}): Promise<PublicMenu> {
  const id = z.string().uuid().parse(venueId);
  const { surface, at: atOpt } = publicMenuOptions.parse(opts);
  const channel = channelOf(surface);
  const at = atOpt ?? ctx.now();
  const venue = await getVenue(ctx, id);
  const org = await getOrg(ctx);
  const local = localParts(at, venue.timezone);

  const menus = (
    await ctx.db
      .selectFrom('menus')
      .select(['id', 'name', 'is_active', 'available_days', 'available_from', 'available_to', 'live_from', 'live_until'])
      .where('venue_id', '=', id)
      .where('deleted_at', 'is', null)
      .orderBy('sort_order')
      .orderBy('created_at')
      .execute()
  ).filter((m) => menuServedAt(m, local) && liveAt(m, at));

  const out: PublicMenu = { venueId: id, currency: org.currency, taxInclusive: org.taxInclusive, channel, menus: [], generatedAt: ctx.now().toISOString() };
  if (!menus.length) return out;

  const sections = (
    await ctx.db
      .selectFrom('menu_sections')
      .select(['id', 'menu_id', 'name', 'description', 'live_from', 'live_until'])
      .where('menu_id', 'in', menus.map((m) => m.id))
      .where('deleted_at', 'is', null)
      .where('is_visible', '=', true)
      .orderBy('sort_order')
      .execute()
  ).filter((s) => liveAt(s, at));
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
        .where(shownOn(channel))
        .orderBy('sort_order')
        .orderBy('name')
        .execute()
    : [];
  const groups = await loadGroups(ctx, items.map((i) => i.id));
  const prices = await loadChannelPrices(ctx, items.map((i) => i.id), channel);

  const toItem = (i: (typeof items)[number]): PublicMenuItem => ({
    id: i.id,
    name: i.name,
    description: i.description,
    priceCents: prices.get(i.id) ?? i.price_cents,
    imageUrl: i.image_url,
    isAvailable: itemAvailableAt(i, at),
    availableFrom: itemBackAt(i, at),
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
  /** The price on the channel asked for (the surface's channel), else the item's own. */
  priceCents: number;
  /** False while 86'd at the time asked about. */
  isAvailable: boolean;
  /** False when the menu or section it belongs to is not being served at the time asked about. */
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
 * guest could see at this venue (another org's, another venue's, removed, hidden, not shown on
 * the surface's channel) is simply absent from the result; the caller answers not-found.
 *
 * Pass the order's channel as the surface (`pickup`, `delivery`, `qr`) and the channel's own
 * price list and "where it shows" apply. The older `online` means the website's menu.
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
  const channel = channelOf(opts.surface);
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
      's.live_from as section_live_from',
      's.live_until as section_live_until',
      'm.is_active',
      'm.available_days',
      'm.available_from',
      'm.available_to',
      'm.live_from',
      'm.live_until',
    ])
    .where('i.id', 'in', ids)
    .where('i.venue_id', '=', venueId)
    .where('i.deleted_at', 'is', null)
    .where('s.deleted_at', 'is', null)
    .where('s.is_visible', '=', true)
    .where('m.deleted_at', 'is', null)
    .where(shownOn(channel, 'i.shown_on'))
    .execute();
  const groups = await loadGroups(ctx, rows.map((r) => r.id));
  const prices = await loadChannelPrices(ctx, rows.map((r) => r.id), channel);

  for (const r of rows) {
    out.set(r.id, {
      id: r.id,
      venueId: r.venue_id,
      name: r.name,
      category: r.section_name,
      priceCents: prices.get(r.id) ?? r.price_cents,
      isAvailable: itemAvailableAt(r, at),
      isServed: menuServedAt(r, local) && liveAt(r, at) && liveAt({ live_from: r.section_live_from, live_until: r.section_live_until }, at),
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

export const priceForInput = z.object({ itemId: z.string().uuid(), channel: z.enum([...MENU_CHANNELS, 'online', 'in_venue']) });

/**
 * What one item costs on one channel: the venue's price for that channel, or the item's own.
 * No role check (it is what the menu shows); an item of another org, or removed, is not found.
 * Ordering prices an order from this (through `getOrderableItems` with the order's channel as
 * the surface, or by calling this per line); the browser's number is never used.
 */
export async function priceFor(ctx: Ctx, itemId: string, channel: MenuSurface): Promise<{ itemId: string; channel: MenuChannel; priceCents: number; basePriceCents: number }> {
  const input = priceForInput.parse({ itemId, channel });
  const ch = channelOf(input.channel);
  const item = await ctx.db.selectFrom('menu_items').select(['id', 'price_cents']).where('id', '=', input.itemId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!item) throw notFound('Menu item not found');
  const prices = await loadChannelPrices(ctx, [item.id], ch);
  return { itemId: item.id, channel: ch, priceCents: prices.get(item.id) ?? item.price_cents, basePriceCents: item.price_cents };
}
