import { setModule } from '@ros/core';
import { hub } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/**
 * Assistant access is switched on at every fixture venue, with the defaults: guest-level reads
 * off, no plug offered to assistants, no sharing with Criota. No access key is seeded: a key is
 * shown once to the person who makes it, so tests and the development console create their own.
 */
const seeder: ModuleSeeder = {
  module: 'hub',
  async seed(app, fixture) {
    for (const org of [fixture.diner, fixture.group]) {
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venue of Object.values(org.venues)) {
          await setModule(ctx, hub.hubModule, { venueId: venue.id, enabled: true });
        }
      });
    }
  },
};

export default seeder;
