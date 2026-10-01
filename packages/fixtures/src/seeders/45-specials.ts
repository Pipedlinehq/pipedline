import { addDays, localDate, setModule } from '@ros/core';
import { specials } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/**
 * The specials board is switched on at every fixture venue, with one special running today and
 * one starting tomorrow, posted through the module's own function so the audit entry and the
 * event exist as they would for a real venue.
 */
const seeder: ModuleSeeder = {
  module: 'specials',
  async seed(app, fixture) {
    // Every fixture venue is in Sydney; "today" is the venue's own calendar day.
    const today = localDate(app.clock(), 'Australia/Sydney');
    for (const org of [fixture.diner, fixture.group]) {
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venue of Object.values(org.venues)) {
          await setModule(ctx, specials.specialsModule, { venueId: venue.id, enabled: true });
          await specials.postSpecial(ctx, {
            venueId: venue.id,
            name: 'Slow-roasted lamb shoulder',
            description: 'For two, with roast potatoes and mint sauce.',
            priceCents: 6400,
            startsOn: today,
            endsOn: addDays(today, 2),
          });
          await specials.postSpecial(ctx, { venueId: venue.id, name: 'Oyster hour', description: 'Half a dozen, natural.', priceCents: 1800, startsOn: addDays(today, 1) });
        }
      });
    }
  },
};

export default seeder;
