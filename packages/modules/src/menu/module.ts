import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/** Config surface: see docs/modules/menu.md. Extend this schema; never hardcode a venue's choice. */
export const menuConfig = z.object({});
export type MenuConfig = z.infer<typeof menuConfig>;

export const menuModule = defineModule({
  key: 'menu',
  name: 'Menu',
  description: 'One menu model for the website, QR, ordering and later the POS: menus, sections, items, modifiers, availability.',
  spine: true,
  dependsOn: [],
  tables: ['menus', 'menu_sections', 'menu_items', 'modifier_groups', 'modifiers', 'item_modifier_groups'],
  configSchema: menuConfig,
  configVersion: 1,
  defaultConfig: menuConfig.parse({}),
});

export const menuEdited = defineEvent({
  name: 'menu.edited',
  module: 'menu',
  description: 'A manager changed the menu: a menu, section, item, modifier group or modifier was added, changed or removed.',
  properties: z.object({
    entity: z.enum(['menu', 'section', 'item', 'modifier_group', 'modifier']),
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
