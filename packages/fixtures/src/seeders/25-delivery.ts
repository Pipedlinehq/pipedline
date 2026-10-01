import { type App, type Principal, addDays, addMinutes, connect, drainJobs, localDate, setModule, zonedTimeToUtc } from '@ros/core';
import { SIM_COURIER_A, SIM_COURIER_B, SIM_PAY_TOKENS, type SimCourierAdapter } from '@ros/adapters';
import { delivery, menu, ordering } from '@ros/modules';
import type { ModuleSeeder } from '../index';
import type { FixtureOrg } from '../load';

/**
 * First-party delivery for the fixtures (docs/modules/delivery.md part A):
 *
 *   - delivery on at the diner and at the group's CBD venue, off elsewhere
 *   - both simulated courier services connected to each org, courier A preferred
 *   - a 3 km zone and a wider 6 km zone with a flat fee at each delivering venue
 *   - at the CBD venue, a few deliveries made through the real flow (quote, order, pay, accept, courier booked at
 *     the prep time, courier webhooks): most delivered, one failed at the door and refunded
 */

const TZ = 'Australia/Sydney';
const WORKER: Principal = { kind: 'worker', job: 'fixtures' };
const JOBS = ['delivery.request_courier', 'delivery.cancel_courier', 'comms.send', 'ordering.refund', 'ordering.pos_push', 'ordering.expire_unpaid'];
export const simCourierWebhookSecret = (orgSlug: string, key: string) => `${key}-whsec-${orgSlug}`;

interface Plan {
  org: FixtureOrg;
  venueSlug: string;
  daysAgo: number;
  time: string;
  outcome: 'delivered' | 'failed';
  guest: { name: string; email: string; phone: string };
  /** Metres north and east of the venue. */
  offset: [number, number];
}

async function setUp(app: App, org: FixtureOrg, venueSlug: string): Promise<void> {
  const venueId = org.venues[venueSlug]!.id;
  await app.tenant(org.orgId, WORKER, async (ctx) => {
    await setModule(ctx, delivery.deliveryModule, {
      venueId,
      enabled: true,
      config: { providers: [SIM_COURIER_A, SIM_COURIER_B], fee_rule: { kind: 'subsidised', venue_pays_up_to_cents: 300 }, min_order_cents: 2000, courier_request_lead_minutes: 10 },
    });
    await delivery.saveZone(ctx, { venueId, name: 'Nearby', kind: 'radius', radiusM: 3000, minOrderCents: 2000 });
    await delivery.saveZone(ctx, { venueId, name: 'Wider area', kind: 'radius', radiusM: 6000, minOrderCents: 3500, feeRule: { kind: 'flat', cents: 1200 } });
  });
}

const seeder: ModuleSeeder = {
  module: 'delivery',
  async seed(app, fixture, opts) {
    const couriers = { a: app.adapters.get('courier', SIM_COURIER_A) as SimCourierAdapter, b: app.adapters.get('courier', SIM_COURIER_B) as SimCourierAdapter };
    for (const org of [fixture.diner, fixture.group]) {
      // One courier account per org, shared by its venues (plugs are not venue-scoped).
      await app.tenant(org.orgId, WORKER, async (ctx) => {
        for (const key of [SIM_COURIER_A, SIM_COURIER_B]) {
          await connect(ctx, { plugKey: key, externalAccountId: `${key}-${org.slug}`, credentials: { webhookSecret: simCourierWebhookSecret(org.slug, key) } });
        }
      });
    }
    await setUp(app, fixture.diner, 'main');
    await setUp(app, fixture.group, 'cbd');

    const today = localDate(opts.now, TZ);
    // The history sits at the group's CBD venue. The diner has delivery switched on and zoned but
    // no past deliveries, so its sales history keeps the two channels other modules' tests expect.
    const plans: Plan[] = [
      { org: fixture.group, venueSlug: 'cbd', daysAgo: 1, time: '12:20:00', outcome: 'delivered', guest: { name: 'Dana Delivery', email: 'dana.delivery@orders.oak-group.example', phone: '0400 100 201' }, offset: [900, 400] },
      { org: fixture.group, venueSlug: 'cbd', daysAgo: 1, time: '12:45:00', outcome: 'delivered', guest: { name: 'Gus Groupdelivery', email: 'gus.delivery@orders.oak-group.example', phone: '0400 100 204' }, offset: [700, 700] },
      { org: fixture.group, venueSlug: 'cbd', daysAgo: 3, time: '12:40:00', outcome: 'delivered', guest: { name: 'Eli Eastside', email: 'eli.eastside@orders.oak-group.example', phone: '0400 100 202' }, offset: [-600, 1500] },
      { org: fixture.group, venueSlug: 'cbd', daysAgo: 3, time: '13:05:00', outcome: 'failed', guest: { name: 'Nora Notathome', email: 'nora.notathome@orders.oak-group.example', phone: '0400 100 203' }, offset: [1200, -300] },
      { org: fixture.group, venueSlug: 'cbd', daysAgo: 4, time: '12:50:00', outcome: 'delivered', guest: { name: 'Hana Harbour', email: 'hana.harbour@orders.oak-group.example', phone: '0400 100 205' }, offset: [-1100, 200] },
    ];

    for (const [i, p] of plans.entries()) {
      const venue = p.org.venues[p.venueSlug]!;
      const venueId = venue.id;
      const anon: Principal = { kind: 'anon' };
      // The fixture venues are closed on Mondays (base.ts): a plan that lands on one moves back a day,
      // so the seed works whatever weekday the clock starts on.
      let date = addDays(today, -p.daysAgo);
      while (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) date = addDays(date, -1);
      const at = zonedTimeToUtc(date, p.time, TZ);
      opts.setNow(at);

      const items = (await app.tenant(p.org.orgId, anon, (ctx) => menu.getPublicMenu(ctx, venueId, { surface: 'online' }))).menus.flatMap((m) => m.sections.flatMap((s) => s.items));
      const pick = items.filter((x) => x.isAvailable && !x.isAlcohol && x.modifierGroups.every((g) => g.minSelections === 0)).slice(0, 3);
      const lines = pick.map((x) => ({ menuItemId: x.id, qty: 1 }));
      const subtotal = pick.reduce((s, x) => s + x.priceCents, 0);
      // Read outside a tenant: the seeder only needs the venue's own coordinates.
      const geo = await app.db.selectFrom('venues').select(['lat', 'lng']).where('id', '=', venueId).executeTakeFirstOrThrow();
      const lat = geo.lat ?? -33.8861;
      const lng = geo.lng ?? 151.2111;
      const quote = await delivery.quoteDelivery(app, { orgId: p.org.orgId, principal: anon }, {
        venueId,
        address: { line1: `${10 + i} Fixture Lane`, suburb: 'Surry Hills', state: 'NSW', postcode: '2010', lat: lat + p.offset[0] / 111_000, lng: lng + p.offset[1] / 92_000 },
        notes: i === 0 ? 'Buzz 4, second floor' : null,
        subtotalCents: subtotal,
      });
      const order = await app.tenant(p.org.orgId, anon, (ctx) =>
        ordering.createOrder(ctx, { venueId, channel: 'delivery', deliveryId: quote.deliveryId, lines, idempotencyKey: `fixture-delivery-${p.org.slug}-${i}`, customer: p.guest }),
      );
      const paid = await ordering.payOrder(app, { orgId: p.org.orgId, principal: anon }, { trackingToken: order.trackingToken!, sourceToken: `${SIM_PAY_TOKENS.ok}:fixture-delivery-${i}` });
      if (paid.status !== 'paid') continue;
      opts.setNow(addMinutes(at, 1));
      await app.tenant(p.org.orgId, WORKER, (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'accepted' }));
      // The courier is booked shortly before the food is due, not at order time.
      opts.setNow(addMinutes(order.promisedAt ?? at, -9));
      await drainJobs(app, { kinds: JOBS });

      const row = await app.db.selectFrom('deliveries').select(['external_ref', 'provider']).where('order_id', '=', order.id).executeTakeFirst();
      if (!row?.external_ref) continue;
      const secret = simCourierWebhookSecret(p.org.slug, row.provider);
      const sim = row.provider === SIM_COURIER_B ? couriers.b : couriers.a;
      // The failed one: collected, then nobody answered the door (refunded per the venue's policy).
      const steps: Array<[number, 'courier_assigned' | 'picked_up' | 'delivered' | 'failed']> = [
        [3, 'courier_assigned'],
        [12, 'picked_up'],
        [34, p.outcome === 'failed' ? 'failed' : 'delivered'],
      ];
      for (const [minutes, status] of steps) {
        opts.setNow(addMinutes(order.promisedAt ?? at, minutes - 10));
        const hook = sim.advance(row.external_ref, status, secret);
        await delivery.handleCourierWebhook(app, { plugKey: row.provider, rawBody: hook.rawBody, headers: hook.headers, url: `https://console.rosplatform.test/webhooks/courier/${row.provider}` });
        await drainJobs(app, { kinds: JOBS });
      }
    }
    opts.setNow(opts.now);
    await drainJobs(app, { kinds: JOBS });
  },
};

export default seeder;
