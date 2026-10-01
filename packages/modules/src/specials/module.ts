import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/specials.md section 4. One row per venue in `venue_modules`.
 * Every setting has a default, so `specialsConfig.parse({})` is a working config, and every
 * setting has a `.describe()`: that text is what an assistant reads in `plugins_list`.
 */
export const specialsConfig = z.object({
  heading: z.string().trim().min(1).max(40).default('Specials').describe('The heading guests see above the specials, e.g. "Today\'s specials".'),
  show_prices: z.boolean().default(true).describe('Whether guests see the price of each special. Staff always see it.'),
  max_running: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('The most specials that may be running or scheduled at once. Posting one more is refused until one ends.'),
  max_days: z.number().int().min(1).max(366).default(31).describe('The longest a single special may run, in days.'),
});
export type SpecialsConfig = z.infer<typeof specialsConfig>;

export const specialsModule = defineModule({
  key: 'specials',
  name: 'Specials board',
  description: 'Daily or weekly specials a manager posts with a name, a price and the days they run. Guests see the ones running today.',
  dependsOn: [],
  needs: ['Nothing to connect. A page that shows the specials to guests needs the Website or the QR menu switched on.'],
  tables: ['specials'],
  configSchema: specialsConfig,
  configVersion: 1,
  defaultConfig: specialsConfig.parse({}),
});

export const specialPosted = defineEvent({
  name: 'special.posted',
  module: 'specials',
  description: 'A manager (or their assistant, after a yes) posted a special. Carries its price and how many days it runs.',
  properties: z.object({ special_id: z.string(), price_cents: z.number().int(), days: z.number().int() }),
});

export const specialEnded = defineEvent({
  name: 'special.ended',
  module: 'specials',
  description: 'A manager took a special down. `early` is true when it was still running or had not started.',
  properties: z.object({ special_id: z.string(), early: z.boolean() }),
});
