import { setModule } from '@ros/core';
import { guestPlugin } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/**
 * Guests' assistants: on at the diner, CBD and Newtown, so they can be found, booked and
 * ordered from through the public assistant connection. Bondi keeps it off, so there is always
 * a live venue the connection must not see. The diner carries a note for assistants; the group's
 * venues use the defaults (every online menu, bookings and pickup orders offered).
 */
const seeder: ModuleSeeder = {
  module: 'guest-plugin',
  async seed(app, fixture) {
    await app.tenant(fixture.diner.orgId, WORKER, (ctx) =>
      setModule(ctx, guestPlugin.guestPluginModule, { venueId: fixture.diner.venueId, enabled: true, config: { assistant_note: 'Walk-ins welcome at the bar.' } }),
    );
    await app.tenant(fixture.group.orgId, WORKER, async (ctx) => {
      for (const key of ['cbd', 'newtown'] as const) {
        await setModule(ctx, guestPlugin.guestPluginModule, { venueId: fixture.group.venues[key]!.id, enabled: true });
      }
    });
  },
};

export default seeder;
