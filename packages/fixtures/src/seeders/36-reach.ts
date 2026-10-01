import { drainJobs, setModule } from '@ros/core';
import type { SimReviewsAdapter } from '@ros/adapters';
import { reviews } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };

/** Each fixture venue's simulated listing. */
export const simListingRef = (orgSlug: string, venueSlug: string) => `simrev-${orgSlug}-${venueSlug}`;

const SAMPLE = [
  { rating: 5, author: 'Priya S.', body: 'Best brisket in Sydney. Staff were lovely and the chips were perfect.', daysAgo: 40 },
  { rating: 4, author: 'Tom', body: 'Great food, a bit loud on a Friday night.', daysAgo: 21 },
  { rating: 2, author: 'Jordan Lee', body: 'Waited 50 minutes for our mains and nobody checked on us.', daysAgo: 9 },
  { rating: 5, author: 'Mei', body: null, daysAgo: 3 },
];

/**
 * Reviews are switched on at every fixture venue, each with a simulated listing holding a few
 * reviews and 14 days of listing insights, read in through the real ingest. The reply agent is
 * left off (the hub's `hosted_agents` is empty), and no email platform or ads account is
 * connected: those change how marketing email and sales behave, so tests connect them.
 */
const seeder: ModuleSeeder = {
  module: 'reviews',
  async seed(app, fixture) {
    const sim = app.adapters.get('reviews', 'sim-reviews') as SimReviewsAdapter;
    const now = app.clock();
    for (const org of [fixture.diner, fixture.group]) {
      for (const venue of Object.values(org.venues)) {
        const ref = simListingRef(org.slug, venue.slug);
        SAMPLE.forEach((s, i) =>
          sim.addReview(ref, {
            externalId: `${ref}-r${i + 1}`,
            rating: s.rating,
            body: s.body,
            authorName: s.author,
            reviewedAt: new Date(now.getTime() - s.daysAgo * 86_400_000),
          }),
        );
        sim.setInsights(
          ref,
          Array.from({ length: 14 }, (_, d) => {
            const day = new Date(now.getTime() - (d + 1) * 86_400_000).toISOString().slice(0, 10);
            return { day, directions: 10 + ((d * 7) % 9), calls: 2 + (d % 4), searches: 180 + d * 11, websiteClicks: 25 + (d % 6) };
          }),
        );
        await app.tenant(org.orgId, WORKER, (ctx) => setModule(ctx, reviews.reviewsModule, { venueId: venue.id, enabled: true }));
        await app.tenant(org.orgId, WORKER, (ctx) =>
          reviews.connectListing(ctx, { plugKey: 'sim-reviews', venueId: venue.id, externalAccountId: ref, credentials: { accessToken: `simrev-token-${ref}` } }),
        );
      }
    }
    await drainJobs(app, { kinds: ['reviews.sync'] });
  },
};

export default seeder;
