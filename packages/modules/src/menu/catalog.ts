import type { Ctx } from '@ros/core';
import { setCatalogResolver } from '../ledger/record';

/** How an order placed on this platform names its lines to the ledger: by our own item id. */
export const MENU_REF_PREFIX = 'menu:';
export const menuItemRef = (menuItemId: string): string => `${MENU_REF_PREFIX}${menuItemId}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Tells the ledger which menu item a sale line is. A POS names its lines by its own catalogue
 * id (menu_items.pos_catalog_id); an order placed here names them `menu:<item id>`. Items
 * removed from the menu still resolve, because the sale happened.
 */
export async function resolveCatalogIds(ctx: Ctx, venueId: string, externalItemIds: string[]): Promise<Map<string, { menuItemId: string; category: string | null }>> {
  const out = new Map<string, { menuItemId: string; category: string | null }>();
  const own = externalItemIds.filter((e) => e.startsWith(MENU_REF_PREFIX) && UUID.test(e.slice(MENU_REF_PREFIX.length)));
  const pos = externalItemIds.filter((e) => !e.startsWith(MENU_REF_PREFIX));
  if (!own.length && !pos.length) return out;

  const rows = await ctx.db
    .selectFrom('menu_items as i')
    .innerJoin('menu_sections as s', 's.id', 'i.section_id')
    .select(['i.id', 'i.pos_catalog_id', 'i.deleted_at', 's.name as section_name'])
    .where('i.venue_id', '=', venueId)
    .where((eb) =>
      eb.or([
        ...(own.length ? [eb('i.id', 'in', own.map((e) => e.slice(MENU_REF_PREFIX.length)))] : []),
        ...(pos.length ? [eb('i.pos_catalog_id', 'in', pos)] : []),
      ]),
    )
    .execute();

  // A live item wins over a removed one that once carried the same catalogue id.
  rows.sort((a, b) => Number(a.deleted_at !== null) - Number(b.deleted_at !== null));
  for (const r of rows) {
    const hit = { menuItemId: r.id, category: r.section_name };
    if (own.includes(menuItemRef(r.id)) && !out.has(menuItemRef(r.id))) out.set(menuItemRef(r.id), hit);
    if (r.pos_catalog_id && pos.includes(r.pos_catalog_id) && !out.has(r.pos_catalog_id)) out.set(r.pos_catalog_id, hit);
  }
  return out;
}

setCatalogResolver(resolveCatalogIds);
