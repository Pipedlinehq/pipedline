import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/guest-plugin.md section 6. One row per venue in `venue_modules`.
 * Every setting has a default, so `guestPluginConfig.parse({})` is a working config, and every
 * setting has a `.describe()`: that text is what an assistant reads in `plugins_list`.
 *
 * Switching the module on is what lists the venue on the public assistant connection; switching
 * it off takes the venue out at once (every tool, and every cart link already handed out).
 */
export const guestPluginConfig = z.object({
  visible_menus: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    .default([])
    .describe(
      'The names of the menus guests\' assistants may read and order from, e.g. ["Lunch","Dinner"]. Empty: every menu the venue serves online. A menu not named here is never shown to an assistant.',
    ),
  offer_bookings: z
    .boolean()
    .default(true)
    .describe('Whether a guest\'s assistant may book a table here. Needs Table bookings switched on as well.'),
  offer_ordering: z
    .boolean()
    .default(true)
    .describe('Whether a guest\'s assistant may start a pickup order here. The guest always pays on the venue\'s own order page. Needs Online ordering switched on with pickup.'),
  assistant_note: z
    .string()
    .trim()
    .max(200)
    .default('')
    .describe('A short line shown to guests\' assistants with the venue\'s details, e.g. "Groups over 8, please call." Empty: none.'),
});
export type GuestPluginConfig = z.infer<typeof guestPluginConfig>;

export const guestPluginModule = defineModule({
  key: 'guest-plugin',
  name: 'Guests\' assistants',
  description:
    'Lists the venue on Pipedline\'s public assistant connection, so a guest using ChatGPT or Claude can find it, read the menu and hours, book a table and start a pickup order. Payment always happens on the venue\'s own order page. Alcohol is never orderable this way.',
  dependsOn: [],
  needs: [
    'The venue marked live.',
    'Table bookings switched on, for bookings.',
    'Online ordering switched on with pickup, and the website, for orders.',
  ],
  tables: [],
  configSchema: guestPluginConfig,
  configVersion: 1,
  defaultConfig: guestPluginConfig.parse({}),
});

export const assistantCartCreated = defineEvent({
  name: 'assistant_cart.created',
  module: 'guest-plugin',
  description: 'A guest\'s assistant built a pickup cart and was given a link to the venue\'s order page. Nothing is ordered until the guest pays there.',
  properties: z.object({ item_count: z.number().int(), subtotal_cents: z.number().int(), asap: z.boolean() }),
});

export const assistantCartOpened = defineEvent({
  name: 'assistant_cart.opened',
  module: 'guest-plugin',
  description: 'A cart link from a guest\'s assistant was opened on the venue\'s order page. `ok` is false when the link was refused (expired, altered, or the venue switched assistants off).',
  properties: z.object({ item_count: z.number().int(), ok: z.boolean() }),
});
