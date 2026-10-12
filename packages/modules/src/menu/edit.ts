import { sql } from 'kysely';
import { z } from 'zod';
import { type Ctx, audit, invalid, notFound, parsePatch, requireStaff, track, zonedTimeToUtc } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { type MenuChannel, type ScheduleState, MENU_CHANNELS, ONLINE_CHANNELS, normaliseChannels, scheduleStateAt } from './contract';
import { menuEdited } from './module';

/**
 * Menu editing, for managers. Everything here is a change a venue could dispute ("who put the
 * rump up to $54?"), so every function audits. Nothing is hard-deleted: past orders, receipts
 * and ledger lines still point at these rows (docs/SCHEMA.md section 3, name_snapshot).
 */

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a 24-hour time such as 17:30.');
/** A venue-local date and time, "2026-10-10T08:00". Stored as the instant it names in the venue's zone. */
const LOCAL_DT = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Use a date and time such as 2026-10-10T08:00.');
const NAME = z.string().trim().min(1).max(200);
const TEXT = z.string().trim().max(2000);
const TAGS = z.array(z.string().trim().min(1).max(40)).max(30);
const SORT = z.number().int().min(0).max(100_000);
const CHANNEL = z.enum(MENU_CHANNELS);
const CHANNELS = z.array(CHANNEL).max(MENU_CHANNELS.length);
const PRICE = z.number().int().min(0).max(10_000_000);

type Entity = 'menu' | 'section' | 'item' | 'modifier_group' | 'modifier' | 'settings';

async function changed(
  ctx: Ctx,
  venueId: string,
  entity: Entity,
  action: 'created' | 'updated' | 'deleted',
  id: string,
  before: unknown,
  after: unknown,
  priceChanged?: boolean,
): Promise<void> {
  await audit(ctx, { action: `menu.${entity}_${action}`, entityType: `menu_${entity}`, entityId: id, venueId, before, after });
  await track(ctx, menuEdited, { entity, action, entity_id: id, ...(priceChanged === undefined ? {} : { price_changed: priceChanged }) }, { venueId });
}

const manager = (ctx: Ctx, venueId: string) => requireStaff(ctx, { venueId, minRole: 'manager' });

/** The instant a venue-local "YYYY-MM-DDTHH:MM" names, or null. */
async function localInstant(ctx: Ctx, venueId: string, local: string | null | undefined): Promise<Date | null | undefined> {
  if (local === undefined) return undefined;
  if (local === null) return null;
  const venue = await getVenue(ctx, venueId);
  const [date, time] = local.split('T') as [string, string];
  return zonedTimeToUtc(date, time, venue.timezone);
}

function assertSchedule(from: Date | null, until: Date | null): void {
  if (from && until && until.getTime() <= from.getTime()) throw invalid('The retire time must be after the go-live time.');
}

// ── Venue settings ───────────────────────────────────────────────────────────

export interface MenuSettings {
  venueId: string;
  /** The channels a new item goes on when neither the item nor its section says. */
  newItemsShownOn: MenuChannel[];
}

async function readSettings(ctx: Ctx, venueId: string): Promise<MenuSettings> {
  const r = await ctx.db.selectFrom('menu_settings').select('new_items_shown_on').where('venue_id', '=', venueId).executeTakeFirst();
  return { venueId, newItemsShownOn: r ? normaliseChannels(r.new_items_shown_on) : [...MENU_CHANNELS] };
}

/** The venue's menu settings. Any staff role at the venue. */
export async function getMenuSettings(ctx: Ctx, venueId: string): Promise<MenuSettings> {
  const id = z.string().uuid().parse(venueId);
  requireStaff(ctx, { venueId: id, minRole: 'read_only' });
  return readSettings(ctx, id);
}

export const menuSettingsInput = z.object({ venueId: z.string().uuid(), newItemsShownOn: CHANNELS });

/** "New items go everywhere" per channel: the venue's default for an item nobody placed. Manager. */
export async function updateMenuSettings(ctx: Ctx, raw: z.input<typeof menuSettingsInput>): Promise<MenuSettings> {
  const input = menuSettingsInput.parse(raw);
  manager(ctx, input.venueId);
  const before = await readSettings(ctx, input.venueId);
  const channels = normaliseChannels(input.newItemsShownOn);
  await ctx.db
    .insertInto('menu_settings')
    .values({ org_id: ctx.orgId, venue_id: input.venueId, new_items_shown_on: channels, updated_at: ctx.now() })
    .onConflict((oc) => oc.column('venue_id').doUpdateSet({ new_items_shown_on: channels, updated_at: ctx.now() }))
    .execute();
  const after = { venueId: input.venueId, newItemsShownOn: channels };
  await changed(ctx, input.venueId, 'settings', 'updated', input.venueId, before, after);
  return after;
}

// ── Menus ────────────────────────────────────────────────────────────────────

export const menuInput = z.object({
  venueId: z.string().uuid(),
  name: NAME,
  isActive: z.boolean().default(true),
  /** 0 = Sunday, in the venue's own time zone. */
  availableDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  /** Venue-local. Leave both empty for an all-day menu. A window may run past midnight. */
  availableFrom: TIME.nullish(),
  availableTo: TIME.nullish(),
  /** Venue-local date and time the menu goes live ("Brunch goes live Saturday 8:00"). Null or omitted: live now. */
  liveFrom: LOCAL_DT.nullish(),
  /** Venue-local date and time the menu retires. Null or omitted: never. */
  liveUntil: LOCAL_DT.nullish(),
  sortOrder: SORT.default(0),
});

export interface MenuRow {
  id: string;
  venueId: string;
  name: string;
  isActive: boolean;
  availableDays: number[];
  availableFrom: string | null;
  availableTo: string | null;
  /** Instants. The console shows them in the venue's zone. */
  liveFrom: Date | null;
  liveUntil: Date | null;
  sortOrder: number;
}

const MENU_COLS = ['id', 'venue_id', 'name', 'is_active', 'available_days', 'available_from', 'available_to', 'live_from', 'live_until', 'sort_order'] as const;
type MenuDbRow = {
  id: string;
  venue_id: string;
  name: string;
  is_active: boolean;
  available_days: number[];
  available_from: string | null;
  available_to: string | null;
  live_from: Date | null;
  live_until: Date | null;
  sort_order: number;
};
const menuRow = (r: MenuDbRow): MenuRow => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  isActive: r.is_active,
  availableDays: r.available_days,
  availableFrom: r.available_from,
  availableTo: r.available_to,
  liveFrom: r.live_from,
  liveUntil: r.live_until,
  sortOrder: r.sort_order,
});

function assertWindow(from: string | null | undefined, to: string | null | undefined): void {
  if ((from && !to) || (!from && to)) throw invalid('Give both a start and an end time, or neither.');
}

async function loadMenu(ctx: Ctx, menuId: string) {
  const r = await ctx.db.selectFrom('menus').select(MENU_COLS).where('id', '=', menuId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Menu not found');
  return r;
}

export async function createMenu(ctx: Ctx, raw: z.input<typeof menuInput>): Promise<MenuRow> {
  const input = menuInput.parse(raw);
  manager(ctx, input.venueId);
  assertWindow(input.availableFrom, input.availableTo);
  const liveFrom = (await localInstant(ctx, input.venueId, input.liveFrom)) ?? null;
  const liveUntil = (await localInstant(ctx, input.venueId, input.liveUntil)) ?? null;
  assertSchedule(liveFrom, liveUntil);
  const r = await ctx.db
    .insertInto('menus')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      name: input.name,
      is_active: input.isActive,
      available_days: input.availableDays,
      available_from: input.availableFrom ?? null,
      available_to: input.availableTo ?? null,
      live_from: liveFrom,
      live_until: liveUntil,
      sort_order: input.sortOrder,
      created_at: ctx.now(),
    })
    .returning(MENU_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'menu', 'created', r.id, undefined, menuRow(r));
  return menuRow(r);
}

export const updateMenuInput = menuInput.omit({ venueId: true }).partial();

export async function updateMenu(ctx: Ctx, menuId: string, raw: z.input<typeof updateMenuInput>): Promise<MenuRow> {
  const input = parsePatch(updateMenuInput, raw);
  const before = await loadMenu(ctx, z.string().uuid().parse(menuId));
  manager(ctx, before.venue_id);
  const from = input.availableFrom === undefined ? before.available_from : input.availableFrom;
  const to = input.availableTo === undefined ? before.available_to : input.availableTo;
  assertWindow(from, to);
  const liveFrom = await localInstant(ctx, before.venue_id, input.liveFrom);
  const liveUntil = await localInstant(ctx, before.venue_id, input.liveUntil);
  assertSchedule(liveFrom === undefined ? before.live_from : liveFrom, liveUntil === undefined ? before.live_until : liveUntil);
  const r = await ctx.db
    .updateTable('menus')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.availableDays !== undefined ? { available_days: input.availableDays } : {}),
      ...(input.availableFrom !== undefined ? { available_from: input.availableFrom } : {}),
      ...(input.availableTo !== undefined ? { available_to: input.availableTo } : {}),
      ...(liveFrom !== undefined ? { live_from: liveFrom } : {}),
      ...(liveUntil !== undefined ? { live_until: liveUntil } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      updated_at: ctx.now(),
    })
    .where('id', '=', before.id)
    .returning(MENU_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'menu', 'updated', r.id, menuRow(before), menuRow(r));
  return menuRow(r);
}

/** Removes the menu and what is on it from every surface. The rows stay for past orders. */
export async function deleteMenu(ctx: Ctx, menuId: string): Promise<void> {
  const before = await loadMenu(ctx, z.string().uuid().parse(menuId));
  manager(ctx, before.venue_id);
  const now = ctx.now();
  const sections = await ctx.db.selectFrom('menu_sections').select('id').where('menu_id', '=', before.id).where('deleted_at', 'is', null).execute();
  if (sections.length) {
    const ids = sections.map((s) => s.id);
    await ctx.db.updateTable('menu_items').set({ deleted_at: now }).where('section_id', 'in', ids).where('deleted_at', 'is', null).execute();
    await ctx.db.updateTable('menu_sections').set({ deleted_at: now }).where('id', 'in', ids).execute();
  }
  await ctx.db.updateTable('menus').set({ deleted_at: now, is_active: false }).where('id', '=', before.id).execute();
  await changed(ctx, before.venue_id, 'menu', 'deleted', before.id, menuRow(before), undefined);
}

// ── Sections ─────────────────────────────────────────────────────────────────

export const sectionInput = z.object({
  menuId: z.string().uuid(),
  name: NAME,
  description: TEXT.nullish(),
  sortOrder: SORT.default(0),
  isVisible: z.boolean().default(true),
  /** Venue-local date and time the section goes live. Null or omitted: with its menu. */
  liveFrom: LOCAL_DT.nullish(),
  /** Venue-local date and time the section retires. Null or omitted: never. */
  liveUntil: LOCAL_DT.nullish(),
  /** Where a new item in this section shows, unless the item says. Null or omitted: the venue's default. */
  shownOn: CHANNELS.nullish(),
});

export interface SectionRow {
  id: string;
  venueId: string;
  menuId: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isVisible: boolean;
  liveFrom: Date | null;
  liveUntil: Date | null;
  /** The default for new items here; null = the venue's default. */
  shownOn: MenuChannel[] | null;
}

const SECTION_COLS = ['id', 'venue_id', 'menu_id', 'name', 'description', 'sort_order', 'is_visible', 'live_from', 'live_until', 'shown_on'] as const;
type SectionDbRow = {
  id: string;
  venue_id: string;
  menu_id: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_visible: boolean;
  live_from: Date | null;
  live_until: Date | null;
  shown_on: string[] | null;
};
const sectionRow = (r: SectionDbRow): SectionRow => ({
  id: r.id,
  venueId: r.venue_id,
  menuId: r.menu_id,
  name: r.name,
  description: r.description,
  sortOrder: r.sort_order,
  isVisible: r.is_visible,
  liveFrom: r.live_from,
  liveUntil: r.live_until,
  shownOn: r.shown_on ? normaliseChannels(r.shown_on) : null,
});

async function loadSection(ctx: Ctx, sectionId: string) {
  const r = await ctx.db.selectFrom('menu_sections').select(SECTION_COLS).where('id', '=', sectionId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Menu section not found');
  return r;
}

export async function createSection(ctx: Ctx, raw: z.input<typeof sectionInput>): Promise<SectionRow> {
  const input = sectionInput.parse(raw);
  const menu = await loadMenu(ctx, input.menuId);
  manager(ctx, menu.venue_id);
  const liveFrom = (await localInstant(ctx, menu.venue_id, input.liveFrom)) ?? null;
  const liveUntil = (await localInstant(ctx, menu.venue_id, input.liveUntil)) ?? null;
  assertSchedule(liveFrom, liveUntil);
  const r = await ctx.db
    .insertInto('menu_sections')
    .values({
      org_id: ctx.orgId,
      venue_id: menu.venue_id,
      menu_id: menu.id,
      name: input.name,
      description: input.description ?? null,
      sort_order: input.sortOrder,
      is_visible: input.isVisible,
      live_from: liveFrom,
      live_until: liveUntil,
      shown_on: input.shownOn ? normaliseChannels(input.shownOn) : null,
    })
    .returning(SECTION_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'section', 'created', r.id, undefined, sectionRow(r));
  return sectionRow(r);
}

export const updateSectionInput = sectionInput.omit({ menuId: true }).partial();

export async function updateSection(ctx: Ctx, sectionId: string, raw: z.input<typeof updateSectionInput>): Promise<SectionRow> {
  const input = parsePatch(updateSectionInput, raw);
  const before = await loadSection(ctx, z.string().uuid().parse(sectionId));
  manager(ctx, before.venue_id);
  const liveFrom = await localInstant(ctx, before.venue_id, input.liveFrom);
  const liveUntil = await localInstant(ctx, before.venue_id, input.liveUntil);
  assertSchedule(liveFrom === undefined ? before.live_from : liveFrom, liveUntil === undefined ? before.live_until : liveUntil);
  const r = await ctx.db
    .updateTable('menu_sections')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.isVisible !== undefined ? { is_visible: input.isVisible } : {}),
      ...(liveFrom !== undefined ? { live_from: liveFrom } : {}),
      ...(liveUntil !== undefined ? { live_until: liveUntil } : {}),
      ...(input.shownOn !== undefined ? { shown_on: input.shownOn ? normaliseChannels(input.shownOn) : null } : {}),
    })
    .where('id', '=', before.id)
    .returning(SECTION_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'section', 'updated', r.id, sectionRow(before), sectionRow(r));
  return sectionRow(r);
}

export async function deleteSection(ctx: Ctx, sectionId: string): Promise<void> {
  const before = await loadSection(ctx, z.string().uuid().parse(sectionId));
  manager(ctx, before.venue_id);
  const now = ctx.now();
  await ctx.db.updateTable('menu_items').set({ deleted_at: now }).where('section_id', '=', before.id).where('deleted_at', 'is', null).execute();
  await ctx.db.updateTable('menu_sections').set({ deleted_at: now }).where('id', '=', before.id).execute();
  await changed(ctx, before.venue_id, 'section', 'deleted', before.id, sectionRow(before), undefined);
}

// ── Items ────────────────────────────────────────────────────────────────────

export const itemInput = z.object({
  sectionId: z.string().uuid(),
  name: NAME,
  description: TEXT.nullish(),
  priceCents: PRICE,
  imageUrl: z.string().url().max(1000).nullish(),
  sortOrder: SORT.default(0),
  dietaryTags: TAGS.default([]),
  /** A safety field. Shown on every surface and on the kitchen ticket. */
  allergens: TAGS.default([]),
  spiceLevel: z.number().int().min(0).max(5).nullish(),
  calories: z.number().int().min(0).max(20_000).nullish(),
  prepMinutes: z.number().int().min(0).max(600).default(10),
  maxPerOrder: z.number().int().min(1).max(1000).nullish(),
  isAlcohol: z.boolean().default(false),
  /** Where it shows. Omitted on create: the section's default, else the venue's. */
  shownOn: CHANNELS.optional(),
  /** The older switches. "Online" stands for website, pickup, delivery and assistants; "in venue" for the QR menu. Read only when `shownOn` is not given. */
  isVisibleOnline: z.boolean().optional(),
  isVisibleInVenue: z.boolean().optional(),
  /** A price per channel over the item's own; null takes that channel's price off. */
  channelPrices: z.partialRecord(CHANNEL, PRICE.nullable()).optional(),
  posCatalogId: z.string().trim().min(1).max(200).nullish(),
  /** Modifier groups offered with this item, in display order. */
  modifierGroupIds: z.array(z.string().uuid()).max(20).optional(),
});

export interface ItemRow {
  id: string;
  venueId: string;
  sectionId: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  sortOrder: number;
  /** The raw switch. Whether the item is on right now also depends on `unavailableUntil`: see `itemAvailableAt`. */
  isAvailable: boolean;
  unavailableUntil: Date | null;
  dietaryTags: string[];
  allergens: string[];
  spiceLevel: number | null;
  calories: number | null;
  prepMinutes: number;
  maxPerOrder: number | null;
  isAlcohol: boolean;
  /** Where it shows. */
  shownOn: MenuChannel[];
  /** The older switches, kept in step: website in `shownOn`, and the QR menu in `shownOn`. */
  isVisibleOnline: boolean;
  isVisibleInVenue: boolean;
  /** The venue's price per channel, where it set one. */
  channelPrices: Partial<Record<MenuChannel, number>>;
  posCatalogId: string | null;
  modifierGroupIds: string[];
}

const ITEM_COLS = [
  'id',
  'venue_id',
  'section_id',
  'name',
  'description',
  'price_cents',
  'image_url',
  'sort_order',
  'is_available',
  'unavailable_until',
  'dietary_tags',
  'allergens',
  'spice_level',
  'calories',
  'prep_minutes',
  'max_per_order',
  'is_alcohol',
  'shown_on',
  'is_visible_online',
  'is_visible_in_venue',
  'pos_catalog_id',
] as const;

type ItemDbRow = {
  id: string;
  venue_id: string;
  section_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  image_url: string | null;
  sort_order: number;
  is_available: boolean;
  unavailable_until: Date | null;
  dietary_tags: string[];
  allergens: string[];
  spice_level: number | null;
  calories: number | null;
  prep_minutes: number;
  max_per_order: number | null;
  is_alcohol: boolean;
  shown_on: string[];
  is_visible_online: boolean;
  is_visible_in_venue: boolean;
  pos_catalog_id: string | null;
};

const itemRow = (r: ItemDbRow, groupIds: string[], prices: Partial<Record<MenuChannel, number>> = {}): ItemRow => ({
  id: r.id,
  venueId: r.venue_id,
  sectionId: r.section_id,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  imageUrl: r.image_url,
  sortOrder: r.sort_order,
  isAvailable: r.is_available,
  unavailableUntil: r.unavailable_until,
  dietaryTags: r.dietary_tags,
  allergens: r.allergens,
  spiceLevel: r.spice_level,
  calories: r.calories,
  prepMinutes: r.prep_minutes,
  maxPerOrder: r.max_per_order,
  isAlcohol: r.is_alcohol,
  shownOn: normaliseChannels(r.shown_on),
  isVisibleOnline: r.is_visible_online,
  isVisibleInVenue: r.is_visible_in_venue,
  channelPrices: prices,
  posCatalogId: r.pos_catalog_id,
  modifierGroupIds: groupIds,
});

/** The three columns that say where an item shows, kept in step: the two old switches follow the list. */
function shownOnColumns(channels: readonly MenuChannel[]) {
  const list = normaliseChannels(channels);
  return { shown_on: list, is_visible_online: list.includes('website'), is_visible_in_venue: list.includes('qr') };
}

/** Apply the two older switches to a channel list, when a caller still uses them. */
function applyLegacySwitches(channels: readonly string[], online: boolean | undefined, inVenue: boolean | undefined): MenuChannel[] {
  let list: MenuChannel[] = normaliseChannels(channels);
  if (online === true) list = [...list, ...ONLINE_CHANNELS];
  if (online === false) list = list.filter((c) => !ONLINE_CHANNELS.includes(c));
  if (inVenue === true) list = [...list, 'qr'];
  if (inVenue === false) list = list.filter((c) => c !== 'qr');
  return normaliseChannels(list);
}

export async function loadItemRow(ctx: Ctx, itemId: string): Promise<ItemDbRow> {
  const r = await ctx.db.selectFrom('menu_items').select(ITEM_COLS).where('id', '=', itemId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Menu item not found');
  return r;
}

async function groupIdsOf(ctx: Ctx, itemId: string): Promise<string[]> {
  const rows = await ctx.db.selectFrom('item_modifier_groups').select('group_id').where('item_id', '=', itemId).orderBy('sort_order').execute();
  return rows.map((r) => r.group_id);
}

async function pricesOf(ctx: Ctx, itemIds: string[]): Promise<Map<string, Partial<Record<MenuChannel, number>>>> {
  const out = new Map<string, Partial<Record<MenuChannel, number>>>();
  if (!itemIds.length) return out;
  const rows = await ctx.db.selectFrom('menu_item_prices').select(['item_id', 'channel', 'price_cents']).where('item_id', 'in', itemIds).execute();
  for (const r of rows) out.set(r.item_id, { ...(out.get(r.item_id) ?? {}), [r.channel]: r.price_cents });
  return out;
}

async function writeItemGroups(ctx: Ctx, itemId: string, venueId: string, groupIds: string[]): Promise<void> {
  const unique = [...new Set(groupIds)];
  if (unique.length) {
    // Every group must be this venue's own: a group id from another venue (or org) is not found.
    const found = await ctx.db
      .selectFrom('modifier_groups')
      .select('id')
      .where('id', 'in', unique)
      .where('venue_id', '=', venueId)
      .where('deleted_at', 'is', null)
      .execute();
    if (found.length !== unique.length) throw notFound('Modifier group not found');
  }
  await ctx.db.deleteFrom('item_modifier_groups').where('item_id', '=', itemId).execute();
  if (unique.length) {
    await ctx.db
      .insertInto('item_modifier_groups')
      .values(unique.map((g, i) => ({ org_id: ctx.orgId, item_id: itemId, group_id: g, sort_order: i })))
      .execute();
  }
}

/** Write the per-channel prices given: a number sets, null removes. Other channels are left alone. */
async function writeChannelPrices(ctx: Ctx, item: { id: string; venue_id: string }, prices: Partial<Record<MenuChannel, number | null>>): Promise<void> {
  for (const channel of MENU_CHANNELS) {
    const v = prices[channel];
    if (v === undefined) continue;
    if (v === null) {
      await ctx.db.deleteFrom('menu_item_prices').where('item_id', '=', item.id).where('channel', '=', channel).execute();
    } else {
      await ctx.db
        .insertInto('menu_item_prices')
        .values({ org_id: ctx.orgId, venue_id: item.venue_id, item_id: item.id, channel, price_cents: v, created_at: ctx.now(), updated_at: ctx.now() })
        .onConflict((oc) => oc.columns(['item_id', 'channel']).doUpdateSet({ price_cents: v, updated_at: ctx.now() }))
        .execute();
    }
  }
}

async function itemView(ctx: Ctx, r: ItemDbRow): Promise<ItemRow> {
  return itemRow(r, await groupIdsOf(ctx, r.id), (await pricesOf(ctx, [r.id])).get(r.id) ?? {});
}

export async function createItem(ctx: Ctx, raw: z.input<typeof itemInput>): Promise<ItemRow> {
  const input = itemInput.parse(raw);
  const section = await loadSection(ctx, input.sectionId);
  manager(ctx, section.venue_id);
  // Where it shows: the item's own answer, else the section's default, else the venue's.
  const base: readonly string[] = input.shownOn ?? section.shown_on ?? (await readSettings(ctx, section.venue_id)).newItemsShownOn;
  const channels = input.shownOn ? normaliseChannels(input.shownOn) : applyLegacySwitches(base, input.isVisibleOnline, input.isVisibleInVenue);
  const r = await ctx.db
    .insertInto('menu_items')
    .values({
      org_id: ctx.orgId,
      venue_id: section.venue_id,
      section_id: section.id,
      name: input.name,
      description: input.description ?? null,
      price_cents: input.priceCents,
      image_url: input.imageUrl ?? null,
      sort_order: input.sortOrder,
      dietary_tags: input.dietaryTags,
      allergens: input.allergens,
      spice_level: input.spiceLevel ?? null,
      calories: input.calories ?? null,
      prep_minutes: input.prepMinutes,
      max_per_order: input.maxPerOrder ?? null,
      is_alcohol: input.isAlcohol,
      ...shownOnColumns(channels),
      pos_catalog_id: input.posCatalogId ?? null,
      created_at: ctx.now(),
    })
    .returning(ITEM_COLS)
    .executeTakeFirstOrThrow();
  if (input.modifierGroupIds) await writeItemGroups(ctx, r.id, r.venue_id, input.modifierGroupIds);
  if (input.channelPrices) await writeChannelPrices(ctx, r, input.channelPrices);
  const view = await itemView(ctx, r);
  await changed(ctx, r.venue_id, 'item', 'created', r.id, undefined, view);
  return view;
}

export const updateItemInput = itemInput.partial();

export async function updateItem(ctx: Ctx, itemId: string, raw: z.input<typeof updateItemInput>): Promise<ItemRow> {
  const input = parsePatch(updateItemInput, raw);
  const before = await loadItemRow(ctx, z.string().uuid().parse(itemId));
  manager(ctx, before.venue_id);
  const beforeView = await itemView(ctx, before);
  if (input.sectionId !== undefined && input.sectionId !== before.section_id) {
    const section = await loadSection(ctx, input.sectionId);
    if (section.venue_id !== before.venue_id) throw notFound('Menu section not found');
  }
  const channels = input.shownOn !== undefined ? normaliseChannels(input.shownOn) : input.isVisibleOnline !== undefined || input.isVisibleInVenue !== undefined ? applyLegacySwitches(before.shown_on, input.isVisibleOnline, input.isVisibleInVenue) : undefined;
  const r = await ctx.db
    .updateTable('menu_items')
    .set({
      ...(input.sectionId !== undefined ? { section_id: input.sectionId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.priceCents !== undefined ? { price_cents: input.priceCents } : {}),
      ...(input.imageUrl !== undefined ? { image_url: input.imageUrl } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.dietaryTags !== undefined ? { dietary_tags: input.dietaryTags } : {}),
      ...(input.allergens !== undefined ? { allergens: input.allergens } : {}),
      ...(input.spiceLevel !== undefined ? { spice_level: input.spiceLevel } : {}),
      ...(input.calories !== undefined ? { calories: input.calories } : {}),
      ...(input.prepMinutes !== undefined ? { prep_minutes: input.prepMinutes } : {}),
      ...(input.maxPerOrder !== undefined ? { max_per_order: input.maxPerOrder } : {}),
      ...(input.isAlcohol !== undefined ? { is_alcohol: input.isAlcohol } : {}),
      ...(channels !== undefined ? shownOnColumns(channels) : {}),
      ...(input.posCatalogId !== undefined ? { pos_catalog_id: input.posCatalogId } : {}),
      updated_at: ctx.now(),
    })
    .where('id', '=', before.id)
    .returning(ITEM_COLS)
    .executeTakeFirstOrThrow();
  if (input.modifierGroupIds) await writeItemGroups(ctx, r.id, r.venue_id, input.modifierGroupIds);
  if (input.channelPrices) await writeChannelPrices(ctx, r, input.channelPrices);
  const view = await itemView(ctx, r);
  const priceChanged = before.price_cents !== r.price_cents || JSON.stringify(beforeView.channelPrices) !== JSON.stringify(view.channelPrices);
  await changed(ctx, r.venue_id, 'item', 'updated', r.id, beforeView, view, priceChanged);
  return view;
}

export async function deleteItem(ctx: Ctx, itemId: string): Promise<void> {
  const before = await loadItemRow(ctx, z.string().uuid().parse(itemId));
  manager(ctx, before.venue_id);
  await ctx.db.updateTable('menu_items').set({ deleted_at: ctx.now() }).where('id', '=', before.id).execute();
  await changed(ctx, before.venue_id, 'item', 'deleted', before.id, itemRow(before, []), undefined);
}

/** Replace the modifier groups offered with an item, in the order given. */
export async function setItemModifierGroups(ctx: Ctx, itemId: string, groupIds: string[]): Promise<ItemRow> {
  const ids = z.array(z.string().uuid()).max(20).parse(groupIds);
  const before = await loadItemRow(ctx, z.string().uuid().parse(itemId));
  manager(ctx, before.venue_id);
  const beforeGroups = await groupIdsOf(ctx, before.id);
  await writeItemGroups(ctx, before.id, before.venue_id, ids);
  const view = await itemView(ctx, before);
  await changed(ctx, before.venue_id, 'item', 'updated', before.id, { modifierGroupIds: beforeGroups }, { modifierGroupIds: view.modifierGroupIds });
  return view;
}

export const itemChannelsInput = z
  .object({
    itemId: z.string().uuid(),
    /** Channels to add. */
    show: CHANNELS.optional(),
    /** Channels to take it off. */
    hide: CHANNELS.optional(),
  })
  .refine((v) => (v.show?.length ?? 0) + (v.hide?.length ?? 0) > 0, { message: 'Say where to show it or where to hide it.' });

/** "Show on… / Hide from…": add or remove channels on one item, leaving the rest as they are. Manager. */
export async function setItemChannels(ctx: Ctx, raw: z.input<typeof itemChannelsInput>): Promise<ItemRow> {
  const input = itemChannelsInput.parse(raw);
  const before = await loadItemRow(ctx, input.itemId);
  manager(ctx, before.venue_id);
  const hide = new Set<string>(input.hide ?? []);
  const channels = normaliseChannels([...before.shown_on, ...(input.show ?? [])].filter((c) => !hide.has(c)));
  const r = await ctx.db.updateTable('menu_items').set({ ...shownOnColumns(channels), updated_at: ctx.now() }).where('id', '=', before.id).returning(ITEM_COLS).executeTakeFirstOrThrow();
  const view = await itemView(ctx, r);
  await changed(ctx, r.venue_id, 'item', 'updated', r.id, { name: before.name, shownOn: normaliseChannels(before.shown_on) }, { name: r.name, shownOn: view.shownOn });
  return view;
}

export const itemChannelPriceInput = z.object({
  itemId: z.string().uuid(),
  channel: CHANNEL,
  /** The price on that channel; null takes it off so the item's own price applies there. */
  priceCents: PRICE.nullable(),
});

/** A price for one item on one channel (the delivery menu). Manager. */
export async function setItemChannelPrice(ctx: Ctx, raw: z.input<typeof itemChannelPriceInput>): Promise<ItemRow> {
  const input = itemChannelPriceInput.parse(raw);
  const item = await loadItemRow(ctx, input.itemId);
  manager(ctx, item.venue_id);
  const before = await itemView(ctx, item);
  await writeChannelPrices(ctx, item, { [input.channel]: input.priceCents });
  const view = await itemView(ctx, item);
  await audit(ctx, {
    action: 'menu.item_channel_price',
    entityType: 'menu_item',
    entityId: item.id,
    venueId: item.venue_id,
    before: { name: item.name, channel: input.channel, priceCents: before.channelPrices[input.channel] ?? null, basePriceCents: item.price_cents },
    after: { name: item.name, channel: input.channel, priceCents: input.priceCents, basePriceCents: item.price_cents },
  });
  await track(ctx, menuEdited, { entity: 'item', action: 'updated', entity_id: item.id, price_changed: true }, { venueId: item.venue_id });
  return view;
}

// ── Modifier groups and modifiers ────────────────────────────────────────────

const groupShape = z.object({
  venueId: z.string().uuid(),
  name: NAME,
  selectionType: z.enum(['single', 'multi']).default('single'),
  minSelections: z.number().int().min(0).max(50).default(0),
  maxSelections: z.number().int().min(1).max(50).default(1),
  isRequired: z.boolean().default(false),
  sortOrder: SORT.default(0),
});
export const modifierGroupInput = groupShape;

export interface ModifierGroupRow {
  id: string;
  venueId: string;
  name: string;
  selectionType: 'single' | 'multi';
  minSelections: number;
  maxSelections: number;
  isRequired: boolean;
  sortOrder: number;
}

const GROUP_COLS = ['id', 'venue_id', 'name', 'selection_type', 'min_selections', 'max_selections', 'is_required', 'sort_order'] as const;
type GroupDbRow = { id: string; venue_id: string; name: string; selection_type: 'single' | 'multi'; min_selections: number; max_selections: number; is_required: boolean; sort_order: number };
const groupRow = (r: GroupDbRow): ModifierGroupRow => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  selectionType: r.selection_type,
  minSelections: r.min_selections,
  maxSelections: r.max_selections,
  isRequired: r.is_required,
  sortOrder: r.sort_order,
});

/** One rule for what a group may ask of a guest, so the cart can always satisfy it. */
function normaliseGroup(g: { selectionType: 'single' | 'multi'; minSelections: number; maxSelections: number; isRequired: boolean }) {
  const max = g.selectionType === 'single' ? 1 : g.maxSelections;
  const min = Math.max(g.minSelections, g.isRequired ? 1 : 0);
  if (min > max) throw invalid('The fewest choices cannot be more than the most.');
  return { min, max, required: min > 0 };
}

async function loadGroup(ctx: Ctx, groupId: string): Promise<GroupDbRow> {
  const r = await ctx.db.selectFrom('modifier_groups').select(GROUP_COLS).where('id', '=', groupId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Modifier group not found');
  return r;
}

export async function createModifierGroup(ctx: Ctx, raw: z.input<typeof modifierGroupInput>): Promise<ModifierGroupRow> {
  const input = modifierGroupInput.parse(raw);
  manager(ctx, input.venueId);
  const n = normaliseGroup(input);
  const r = await ctx.db
    .insertInto('modifier_groups')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      name: input.name,
      selection_type: input.selectionType,
      min_selections: n.min,
      max_selections: n.max,
      is_required: n.required,
      sort_order: input.sortOrder,
    })
    .returning(GROUP_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'modifier_group', 'created', r.id, undefined, groupRow(r));
  return groupRow(r);
}

export const updateModifierGroupInput = groupShape.omit({ venueId: true }).partial();

export async function updateModifierGroup(ctx: Ctx, groupId: string, raw: z.input<typeof updateModifierGroupInput>): Promise<ModifierGroupRow> {
  const input = parsePatch(updateModifierGroupInput, raw);
  const before = await loadGroup(ctx, z.string().uuid().parse(groupId));
  manager(ctx, before.venue_id);
  const n = normaliseGroup({
    selectionType: input.selectionType ?? before.selection_type,
    minSelections: input.minSelections ?? (input.isRequired === false ? 0 : before.min_selections),
    maxSelections: input.maxSelections ?? before.max_selections,
    isRequired: input.isRequired ?? before.is_required,
  });
  const r = await ctx.db
    .updateTable('modifier_groups')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.selectionType !== undefined ? { selection_type: input.selectionType } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      min_selections: n.min,
      max_selections: n.max,
      is_required: n.required,
    })
    .where('id', '=', before.id)
    .returning(GROUP_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'modifier_group', 'updated', r.id, groupRow(before), groupRow(r));
  return groupRow(r);
}

/** Takes the group off every item it was offered with. */
export async function deleteModifierGroup(ctx: Ctx, groupId: string): Promise<void> {
  const before = await loadGroup(ctx, z.string().uuid().parse(groupId));
  manager(ctx, before.venue_id);
  const now = ctx.now();
  await ctx.db.deleteFrom('item_modifier_groups').where('group_id', '=', before.id).execute();
  await ctx.db.updateTable('modifiers').set({ deleted_at: now }).where('group_id', '=', before.id).where('deleted_at', 'is', null).execute();
  await ctx.db.updateTable('modifier_groups').set({ deleted_at: now }).where('id', '=', before.id).execute();
  await changed(ctx, before.venue_id, 'modifier_group', 'deleted', before.id, groupRow(before), undefined);
}

export const modifierInput = z.object({
  groupId: z.string().uuid(),
  name: NAME,
  priceDeltaCents: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  isDefault: z.boolean().default(false),
  isAvailable: z.boolean().default(true),
  sortOrder: SORT.default(0),
});

export interface ModifierRow {
  id: string;
  venueId: string;
  groupId: string;
  name: string;
  priceDeltaCents: number;
  isDefault: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

const MOD_COLS = ['id', 'venue_id', 'group_id', 'name', 'price_delta_cents', 'is_default', 'is_available', 'sort_order'] as const;
type ModDbRow = { id: string; venue_id: string; group_id: string; name: string; price_delta_cents: number; is_default: boolean; is_available: boolean; sort_order: number };
const modRow = (r: ModDbRow): ModifierRow => ({
  id: r.id,
  venueId: r.venue_id,
  groupId: r.group_id,
  name: r.name,
  priceDeltaCents: r.price_delta_cents,
  isDefault: r.is_default,
  isAvailable: r.is_available,
  sortOrder: r.sort_order,
});

export async function loadModifierRow(ctx: Ctx, modifierId: string): Promise<ModDbRow> {
  const r = await ctx.db.selectFrom('modifiers').select(MOD_COLS).where('id', '=', modifierId).where('deleted_at', 'is', null).executeTakeFirst();
  if (!r) throw notFound('Modifier not found');
  return r;
}

export async function createModifier(ctx: Ctx, raw: z.input<typeof modifierInput>): Promise<ModifierRow> {
  const input = modifierInput.parse(raw);
  const group = await loadGroup(ctx, input.groupId);
  manager(ctx, group.venue_id);
  const r = await ctx.db
    .insertInto('modifiers')
    .values({
      org_id: ctx.orgId,
      venue_id: group.venue_id,
      group_id: group.id,
      name: input.name,
      price_delta_cents: input.priceDeltaCents,
      is_default: input.isDefault,
      is_available: input.isAvailable,
      sort_order: input.sortOrder,
    })
    .returning(MOD_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'modifier', 'created', r.id, undefined, modRow(r));
  return modRow(r);
}

export const updateModifierInput = modifierInput.omit({ groupId: true }).partial();

export async function updateModifier(ctx: Ctx, modifierId: string, raw: z.input<typeof updateModifierInput>): Promise<ModifierRow> {
  const input = parsePatch(updateModifierInput, raw);
  const before = await loadModifierRow(ctx, z.string().uuid().parse(modifierId));
  manager(ctx, before.venue_id);
  const r = await ctx.db
    .updateTable('modifiers')
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.priceDeltaCents !== undefined ? { price_delta_cents: input.priceDeltaCents } : {}),
      ...(input.isDefault !== undefined ? { is_default: input.isDefault } : {}),
      ...(input.isAvailable !== undefined ? { is_available: input.isAvailable } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
    })
    .where('id', '=', before.id)
    .returning(MOD_COLS)
    .executeTakeFirstOrThrow();
  await changed(ctx, r.venue_id, 'modifier', 'updated', r.id, modRow(before), modRow(r), before.price_delta_cents !== r.price_delta_cents);
  return modRow(r);
}

export async function deleteModifier(ctx: Ctx, modifierId: string): Promise<void> {
  const before = await loadModifierRow(ctx, z.string().uuid().parse(modifierId));
  manager(ctx, before.venue_id);
  await ctx.db.updateTable('modifiers').set({ deleted_at: ctx.now() }).where('id', '=', before.id).execute();
  await changed(ctx, before.venue_id, 'modifier', 'deleted', before.id, modRow(before), undefined);
}

// ── The editor's view ────────────────────────────────────────────────────────

export interface MenuEditorView {
  venueId: string;
  menus: Array<MenuRow & { schedule: ScheduleState; sections: Array<SectionRow & { schedule: ScheduleState; items: ItemRow[] }> }>;
  modifierGroups: Array<ModifierGroupRow & { modifiers: ModifierRow[] }>;
  settings: MenuSettings;
  /** The instant `schedule` and the 86 states were worked out for (`asOf`, else now). */
  asOf: Date;
}

/** What the console's Menu views ask for: items by name, by whether they are 86'd, by where they show; menus by schedule. */
export const menuEditorFilter = z
  .object({
    /** Part of an item's name. */
    q: z.string().trim().max(100).optional(),
    /** off = 86'd right now (an 86 whose time has passed counts as back on); on = available. */
    availability: z.enum(['off', 'on']).optional(),
    /** The older "where it shows" filter: hidden_online = not on the website; hidden_in_venue = not on the QR menu. */
    visibility: z.enum(['hidden_online', 'hidden_in_venue', 'online', 'in_venue']).optional(),
    /** Only items that show on this channel. */
    shownOn: CHANNEL.optional(),
    /** Only items hidden from this channel. */
    hiddenFrom: CHANNEL.optional(),
    /** Only menus in this state (as of `asOf`). Their sections and items come with them. */
    schedule: z.enum(['scheduled', 'live', 'retired', 'not_active']).optional(),
    /** Work out schedule states as of this instant instead of now: the console's "preview as of". */
    asOf: z.date().optional(),
  })
  .strict();
export type MenuEditorFilter = z.infer<typeof menuEditorFilter>;

/**
 * The whole menu as the console edits it: hidden sections, 86'd items, inactive, scheduled and
 * retired menus included, each with its schedule state. With a filter, only the items that match
 * are listed (menus and sections stay, so the person sees where a match sits); a schedule filter
 * narrows the menus themselves.
 */
export async function getMenuEditor(ctx: Ctx, venueId: string, rawFilter: z.input<typeof menuEditorFilter> = {}): Promise<MenuEditorView> {
  const id = z.string().uuid().parse(venueId);
  const filter = menuEditorFilter.parse(rawFilter);
  requireStaff(ctx, { venueId: id, minRole: 'read_only' });
  const asOf = filter.asOf ?? ctx.now();
  const now = ctx.now();
  const allMenus = await ctx.db.selectFrom('menus').select(MENU_COLS).where('venue_id', '=', id).where('deleted_at', 'is', null).orderBy('sort_order').orderBy('created_at').execute();
  const menus = filter.schedule ? allMenus.filter((m) => scheduleStateAt(menuRow(m), asOf) === filter.schedule) : allMenus;
  const sections = await ctx.db.selectFrom('menu_sections').select(SECTION_COLS).where('venue_id', '=', id).where('deleted_at', 'is', null).orderBy('sort_order').execute();
  let itemsQ = ctx.db.selectFrom('menu_items').select(ITEM_COLS).where('venue_id', '=', id).where('deleted_at', 'is', null).orderBy('sort_order');
  if (filter.q) itemsQ = itemsQ.where('name', 'ilike', `%${filter.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
  if (filter.availability === 'off') itemsQ = itemsQ.where('is_available', '=', false).where((eb) => eb.or([eb('unavailable_until', 'is', null), eb('unavailable_until', '>', now)]));
  if (filter.availability === 'on') itemsQ = itemsQ.where((eb) => eb.or([eb('is_available', '=', true), eb('unavailable_until', '<=', now)]));
  if (filter.visibility === 'hidden_online') itemsQ = itemsQ.where('is_visible_online', '=', false);
  if (filter.visibility === 'online') itemsQ = itemsQ.where('is_visible_online', '=', true);
  if (filter.visibility === 'hidden_in_venue') itemsQ = itemsQ.where('is_visible_in_venue', '=', false);
  if (filter.visibility === 'in_venue') itemsQ = itemsQ.where('is_visible_in_venue', '=', true);
  if (filter.shownOn) itemsQ = itemsQ.where(sql<boolean>`${sql.val(filter.shownOn)} = any(shown_on)`);
  if (filter.hiddenFrom) itemsQ = itemsQ.where(sql<boolean>`not (${sql.val(filter.hiddenFrom)} = any(shown_on))`);
  const items = await itemsQ.execute();
  const links = items.length
    ? await ctx.db.selectFrom('item_modifier_groups').select(['item_id', 'group_id']).where('item_id', 'in', items.map((i) => i.id)).orderBy('sort_order').execute()
    : [];
  const prices = await pricesOf(ctx, items.map((i) => i.id));
  const groups = await ctx.db.selectFrom('modifier_groups').select(GROUP_COLS).where('venue_id', '=', id).where('deleted_at', 'is', null).orderBy('sort_order').execute();
  const mods = await ctx.db.selectFrom('modifiers').select(MOD_COLS).where('venue_id', '=', id).where('deleted_at', 'is', null).orderBy('sort_order').execute();

  const groupsOf = (itemId: string) => links.filter((l) => l.item_id === itemId).map((l) => l.group_id);
  return {
    venueId: id,
    menus: menus.map((m) => {
      const menu = menuRow(m);
      return {
        ...menu,
        schedule: scheduleStateAt(menu, asOf),
        sections: sections
          .filter((s) => s.menu_id === m.id)
          .map((s) => {
            const section = sectionRow(s);
            return { ...section, schedule: scheduleStateAt(section, asOf), items: items.filter((i) => i.section_id === s.id).map((i) => itemRow(i, groupsOf(i.id), prices.get(i.id) ?? {})) };
          }),
      };
    }),
    modifierGroups: groups.map((g) => ({ ...groupRow(g), modifiers: mods.filter((x) => x.group_id === g.id).map(modRow) })),
    settings: await readSettings(ctx, id),
    asOf,
  };
}
