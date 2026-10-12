import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/ordering.md section 1 ("as built"). The menu is spine (always on),
 * so per-venue settings live in `menu_settings` (see edit.ts `getMenuSettings`), not here.
 */
export const menuConfig = z.object({});
export type MenuConfig = z.infer<typeof menuConfig>;

export const menuModule = defineModule({
  key: 'menu',
  name: 'Menu',
  description: 'One menu model for the website, QR, ordering and later the POS: menus, sections, items, modifiers, availability, schedules, where each item shows and its price per channel.',
  spine: true,
  dependsOn: [],
  manifest: {
    name: 'Menu',
    purpose:
      'One menu for the website, the QR menu, online ordering and assistants: menus, sections, items, options and prices; what is sold out (86\'d) right now and when it is back; when a menu goes live and retires; where each item shows and what it costs on each channel.',
    category: 'selling',
    kind: 'module',
    needs: ['Nothing to connect. Bring a menu in from a link, a file or the till, or type it in.'],
    reads: ['the menu'],
    writes: ['menus, sections, items, options and prices', 'sold-out marks and when an item is back', 'when a menu or section goes live and retires', 'where each item shows and its price per channel'],
  },
  tables: ['menus', 'menu_sections', 'menu_items', 'modifier_groups', 'modifiers', 'item_modifier_groups', 'menu_item_prices', 'menu_settings'],
  configSchema: menuConfig,
  configVersion: 1,
  defaultConfig: menuConfig.parse({}),
});

export const menuEdited = defineEvent({
  name: 'menu.edited',
  module: 'menu',
  description: 'A manager changed the menu: a menu, section, item, modifier group, modifier or the venue\'s menu settings was added, changed or removed.',
  properties: z.object({
    entity: z.enum(['menu', 'section', 'item', 'modifier_group', 'modifier', 'settings']),
    action: z.enum(['created', 'updated', 'deleted']),
    entity_id: z.string(),
    price_changed: z.boolean().optional(),
  }),
});

export const itemAvailabilityChanged = defineEvent({
  name: 'item.availability_changed',
  module: 'menu',
  description: 'An item was marked sold out (86\'d) or put back on, from the console, the kitchen screen or an assistant.',
  properties: z.object({
    menu_item_id: z.string(),
    name: z.string(),
    available: z.boolean(),
    until: z.string().nullable().describe('When it comes back on its own, or null for until someone puts it back'),
    by: z.string().describe('staff, device, agent or worker'),
  }),
});

export const modifierAvailabilityChanged = defineEvent({
  name: 'modifier.availability_changed',
  module: 'menu',
  description: 'A modifier option (a side, a milk) was marked sold out or put back on.',
  properties: z.object({ modifier_id: z.string(), name: z.string(), available: z.boolean(), by: z.string() }),
});
