import { addDays, localDate } from '@ros/core';
import { analytics } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };
const TZ = 'Australia/Sydney';

/**
 * Analytics for the fixture orgs (docs/MODULES.md contract item 5).
 *
 *   - the derived facts back-filled from the whole seeded ledger and event stream, so the
 *     facts are level with the ledger at "today" and dashboards read them straight away
 *   - the customer snapshot, with RFM scores and segments
 *   - digests a venue would already have: the last four complete weeks, the last complete
 *     month and yesterday, for each org as a whole and for each venue of the group
 *   - two pinned views per org, the kind an owner saves in their first week
 *
 * Seeders that run after this one and add sales are picked up by the next roll-up; queries
 * never depend on the facts being level (they fall back to the ledger).
 */
const seeder: ModuleSeeder = {
  module: 'analytics',
  async seed(app, fixture, opts) {
    const today = localDate(opts.now, TZ);
    const monday = analytics.weekStart(today);
    for (const org of [fixture.diner, fixture.group]) {
      await analytics.backfill(app, org.orgId);

      const venues = Object.values(org.venues);
      const targets: Array<string | undefined> = venues.length > 1 ? [undefined, ...venues.map((v) => v.id)] : [undefined];
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venueId of targets) {
          const scope = venueId ? { venueId } : {};
          for (let w = 4; w >= 1; w--) await analytics.buildDigest(ctx, { ...scope, period: 'week', date: addDays(monday, -7 * w) });
          await analytics.buildDigest(ctx, { ...scope, period: 'month' });
          await analytics.buildDigest(ctx, { ...scope, period: 'day' });
        }
        await analytics.saveView(ctx, {
          name: 'Weekly sales by channel',
          description: 'Net sales and orders for the last four weeks, split by channel, against the four weeks before.',
          query: { metrics: ['net_sales', 'orders', 'avg_order_value'], dimensions: ['channel'], period: 'last_28_days', compareTo: 'previous_period' },
          pinned: true,
        });
        await analytics.saveView(ctx, {
          name: 'Top items this month',
          description: 'What is selling this month, by revenue.',
          query: { metrics: ['item_revenue', 'item_quantity', 'item_attach_rate'], dimensions: ['item'], period: 'this_month', limit: 20 },
          pinned: false,
        });
      });
    }
  },
};

export default seeder;
