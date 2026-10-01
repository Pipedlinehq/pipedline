import { simPosToken } from '@ros/adapters';
import { ledger } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/** One simulated merchant account per fixture org; one location per venue, as a real multi-site seller has. */
export const simPosAccountRef = (orgSlug: string) => `simpos-acct-${orgSlug}`;
export const simPosLocationRef = (orgSlug: string, venueSlug: string) => `simpos-loc-${orgSlug}-${venueSlug}`;
/** Each org's webhooks are signed with its own secret, so one org's signature is worthless against another's. */
export const simPosWebhookSecret = (orgSlug: string) => `simpos-whsec-${orgSlug}`;

/**
 * Every fixture venue is connected to the simulated POS. No history is back-filled: the
 * fixture ledger is already seeded, and the simulator holds no sales until a test or the
 * development console rings one up.
 */
const seeder: ModuleSeeder = {
  module: 'ledger',
  async seed(app, fixture) {
    for (const org of [fixture.diner, fixture.group]) {
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venue of Object.values(org.venues)) {
          await ledger.connectPos(ctx, {
            plugKey: 'sim-pos',
            venueId: venue.id,
            externalAccountId: simPosAccountRef(org.slug),
            locationRef: simPosLocationRef(org.slug, venue.slug),
            credentials: { accessToken: simPosToken(simPosAccountRef(org.slug)), webhookSecret: simPosWebhookSecret(org.slug) },
            backfillMonths: 0,
          });
        }
      });
    }
  },
};

export default seeder;
