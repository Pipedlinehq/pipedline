import { json, setModule } from '@ros/core';
import { website } from '@ros/modules';
import type { ModuleSeeder } from '../index';

const WORKER = { kind: 'worker' as const, job: 'fixtures' };
const DAY = 86_400_000;

/**
 * Website and onboarding for the fixture orgs (docs/MODULES.md contract item 5).
 *
 *   - the website is on at every fixture venue
 *   - each org has its own brand tokens and layout skeleton: the diner is `hero-photo` on the
 *     default palette, the group is `split-panel` in navy
 *   - the group's Newtown venue runs a sub-brand: a per-venue override of the primary colour,
 *     the accent and the heading typeface
 *   - published default pages: an org-level set for each org, plus a set per venue for the group
 *   - a few redirects from an "old site"
 *   - an onboarding record, already live, for each org
 */
const ABOUT = {
  'oak-diner':
    'Oak Diner is a neighbourhood steakhouse in Surry Hills. We dry-age our own beef, cook over ironbark and keep the wine list short and good.\n\nWalk in for the bar, or order ahead and pick up on your way home.',
  'oak-group':
    'Oak Group runs three rooms across Sydney: the original in the CBD, a louder one in Newtown and a takeaway window at Bondi. Same butcher, same fire, three different nights out.',
} as const;

const seeder: ModuleSeeder = {
  module: 'website',
  async seed(app, fixture, opts) {
    for (const org of [fixture.diner, fixture.group]) {
      const isGroup = org.slug === 'oak-group';
      const name = isGroup ? 'Oak Group' : 'Oak Diner';
      const venues = Object.values(org.venues);

      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const venue of venues) {
          await setModule(ctx, website.websiteModule, {
            venueId: venue.id,
            enabled: true,
            config: {
              orderCtaTarget: '/order',
              socialLinks: website.socialLinks.parse({ instagram: `https://www.instagram.com/${org.slug.replace('-', '')}` }),
              integrations: website.integrations.parse({ googleAnalyticsId: isGroup ? 'G-FIXTUREGRP1' : 'G-FIXTUREDIN1' }),
            },
          });
        }

        await website.setBrand(
          ctx,
          isGroup
            ? {
                skeleton: 'split-panel',
                tokens: {
                  typography: { heading: { family: 'Playfair Display', weights: [400, 700] }, body: { family: 'DM Sans', weights: [400, 500] } },
                  colour: { primary: '#1F3A5F', primaryContrast: '#FFFFFF', secondary: '#3D5A80', accent: '#EE6C4D', surface: '#FFFFFF', surfaceAlt: '#F1F5F9', text: '#111827', textMuted: '#4B5563', border: '#D1D5DB' },
                  radius: { sm: 0, md: 2, lg: 4 },
                  imagery: { ratio: '3:2', treatment: 'cool', corner: 'sm' },
                },
                toneOfVoice: 'Dry, confident, a little formal. We talk about the produce before we talk about ourselves.',
              }
            : {
                skeleton: 'hero-photo',
                toneOfVoice: 'Warm and plain-spoken, like the person behind the bar. Short sentences. No foodie words.',
              },
        );

        // The Newtown venue is a sub-brand: same family, its own colour and headline face.
        if (isGroup) {
          await website.setBrand(ctx, {
            venueId: org.venues.newtown!.id,
            tokens: { colour: { primary: '#7A1E48', accent: '#F2B705' }, typography: { heading: { family: 'Oswald' } } },
          });
        }

        const copy = {
          tradingName: name,
          tagline: isGroup ? 'Three rooms, one fire.' : 'Dry-aged beef, cooked over ironbark.',
          about: ABOUT[org.slug as keyof typeof ABOUT],
          faq: [
            { question: 'Do you take walk-ins?', answer: 'Yes. The bar is kept for walk-ins every night.' },
            { question: 'Can you cater for allergies?', answer: 'Tell us when you order and we will tell you honestly what we can and cannot do. Our kitchen handles nuts, gluten and shellfish.' },
          ],
          testimonials: [{ quote: 'The best rib eye within walking distance of Central.', author: 'A regular', source: 'In the room' }],
          takesBookings: true,
          takesOrders: true,
        };
        await website.ensureDefaultPages(ctx, { copy, publish: true }, 'provisioning');
        if (isGroup) {
          for (const venue of venues) {
            await website.ensureDefaultPages(ctx, { venueId: venue.id, copy: { ...copy, tradingName: venue.name, takesBookings: venue.slug !== 'bondi' }, publish: true }, 'provisioning');
          }
        }

        await website.importRedirects(ctx, {
          entries: isGroup
            ? [
                { from: '/menu.html', to: '/menu' },
                { from: '/locations', to: '/contact' },
                { from: 'https://old.oak-group.example/our-story/', to: '/' },
              ]
            : [
                { from: '/menu.html', to: '/menu' },
                { from: '/about-us', to: '/about' },
                { from: '/contact-us.php', to: '/contact' },
                { from: 'https://old.oak-diner.example/bookings/', to: '/contact' },
              ],
        });
      });

      // The fixture orgs were created directly, so their onboarding is recorded after the fact:
      // sold three weeks ago, live nine days later.
      const soldAt = new Date(opts.now.getTime() - 21 * DAY);
      await app.db
        .insertInto('onboardings')
        .values({
          org_id: org.orgId,
          status: 'live',
          intake: json({ identity: { tradingName: name, slug: org.slug } }),
          manual_touch_minutes: isGroup ? 240 : 95,
          sold_at: soldAt,
          live_at: new Date(soldAt.getTime() + 9 * DAY),
        })
        .onConflict((oc) => oc.column('org_id').doNothing())
        .execute();
    }
  },
};

export default seeder;
