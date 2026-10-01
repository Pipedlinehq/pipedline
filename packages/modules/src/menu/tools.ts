import { z } from 'zod';
import { defineTool, formatMoney, invalid } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { setItemAvailability } from './availability';
import { getMenuEditor } from './edit';
import { itemAvailableAt } from './public';

export const menuListTool = defineTool({
  name: 'menu_list',
  module: 'menu',
  title: 'The menu',
  description:
    'The venue\'s menu as it stands now: every menu, section and item with its price, allergens and whether it is available or sold out. Use it to answer "what is 86\'d?" or to find an item before changing its availability.',
  effect: 'read',
  scope: 'menu:read',
  venueScoped: true,
  input: z.object({
    search: z.string().max(100).optional().describe('Only items whose name contains this text'),
    only_unavailable: z.boolean().optional().describe('True to list only what is sold out'),
  }),
  output: z.object({
    currency_note: z.string(),
    menus: z.array(
      z.object({
        menu: z.string(),
        active: z.boolean(),
        sections: z.array(
          z.object({
            section: z.string(),
            items: z.array(
              z.object({
                item_id: z.string(),
                name: z.string(),
                price: z.string(),
                price_cents: z.number().int(),
                available: z.boolean(),
                back_at: z.string().nullable(),
                allergens: z.array(z.string()),
                dietary: z.array(z.string()),
                alcohol: z.boolean(),
                shown_online: z.boolean(),
                shown_in_venue: z.boolean(),
              }),
            ),
          }),
        ),
      }),
    ),
    item_count: z.number().int(),
  }),
  async run({ ctx, venueId }, input) {
    const editor = await getMenuEditor(ctx, venueId!);
    const now = ctx.now();
    const q = input.search?.trim().toLowerCase();
    let count = 0;
    const menus = editor.menus.map((m) => ({
      menu: m.name,
      active: m.isActive,
      sections: m.sections
        .map((s) => ({
          section: s.name,
          items: s.items
            .map((i) => ({ i, available: itemAvailableAt({ is_available: i.isAvailable, unavailable_until: i.unavailableUntil }, now) }))
            .filter(({ i, available }) => (!q || i.name.toLowerCase().includes(q)) && (!input.only_unavailable || !available))
            .map(({ i, available }) => {
              count++;
              return {
                item_id: i.id,
                name: i.name,
                price: formatMoney(i.priceCents),
                price_cents: i.priceCents,
                available,
                back_at: !available && i.unavailableUntil ? i.unavailableUntil.toISOString() : null,
                allergens: i.allergens,
                dietary: i.dietaryTags,
                alcohol: i.isAlcohol,
                shown_online: i.isVisibleOnline,
                shown_in_venue: i.isVisibleInVenue,
              };
            }),
        }))
        .filter((s) => s.items.length > 0),
    }));
    return { currency_note: 'Prices include tax where the venue\'s prices do.', menus, item_count: count };
  },
});

export const menuSetAvailabilityTool = defineTool({
  name: 'menu_set_availability',
  module: 'menu',
  title: 'Mark an item sold out, or put it back',
  description:
    'The 86 button. Mark a menu item as sold out (for the rest of this service, or until someone puts it back), or make it available again. Shows on the website, the QR menu and ordering straight away.',
  effect: 'write',
  scope: 'menu:write',
  minRole: 'kitchen',
  venueScoped: true,
  input: z.object({
    item: z.string().min(1).max(200).describe('The item\'s id from menu_list, or its exact name'),
    available: z.boolean().describe('False to mark it sold out, true to put it back'),
    until: z
      .enum(['end_of_service', 'until_changed'])
      .default('end_of_service')
      .describe('For a sold-out item: back on when this service ends, or only when someone puts it back'),
  }),
  output: z.object({ item_id: z.string(), name: z.string(), available: z.boolean(), back_at: z.string().nullable() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const editor = await getMenuEditor(ctx, venue.id);
    const all = editor.menus.flatMap((m) => m.sections.flatMap((s) => s.items));
    const wanted = input.item.trim().toLowerCase();
    const matches = all.filter((i) => i.id === wanted || i.name.toLowerCase() === wanted);
    if (!matches.length) throw invalid('No item on this menu has that id or exact name. Use menu_list to find it.');
    if (matches.length > 1) throw invalid('More than one item has that name. Use the item id from menu_list.');
    const item = matches[0]!;
    const question = input.available
      ? `Put "${item.name}" back on the menu at ${venue.name}? Guests will be able to order it straight away.`
      : `Mark "${item.name}" as sold out at ${venue.name} ${input.until === 'end_of_service' ? 'until the end of this service' : 'until someone puts it back'}? It will show as unavailable on the website, the QR menu and in ordering straight away.`;
    return {
      question,
      commit: async () => {
        const r = await setItemAvailability(ctx, {
          itemId: item.id,
          available: input.available,
          until: input.available || input.until === 'until_changed' ? null : 'end_of_service',
        });
        return { item_id: r.itemId, name: r.name, available: r.available, back_at: r.until ? r.until.toISOString() : null };
      },
    };
  },
});
