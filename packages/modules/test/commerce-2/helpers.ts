import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { type Principal, setModule } from '@ros/core';
import { SIM_COURIER_A, SIM_COURIER_B, type SimCourierAdapter } from '@ros/adapters';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { delivery, ordering } from '@ros/modules';
import { WORKER, anon, menuOf, okCard } from '../commerce/helpers';

export { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, pairScreen, pay, placeOrder } from '../commerce/helpers';

export const WEBHOOK_URL = (plug: string) => `https://console.rosplatform.test/webhooks/courier/${plug}`;
/** The secret the fixture seeder gave each org's courier connection (packages/fixtures/src/seeders/25-delivery.ts). */
export const courierSecret = (org: FixtureOrg, plug: string) => `${plug}-whsec-${org.slug}`;

export const sims = (t: TestEnv): Record<string, SimCourierAdapter> => ({ [SIM_COURIER_A]: t.sim.courierA, [SIM_COURIER_B]: t.sim.courierB });

/** A point this many metres north and east of the venue. */
export async function near(t: TestEnv, venueId: string, north: number, east: number): Promise<{ lat: number; lng: number }> {
  const v = await t.db.selectFrom('venues').select(['lat', 'lng']).where('id', '=', venueId).executeTakeFirstOrThrow();
  return { lat: v.lat! + north / 111_000, lng: v.lng! + east / 92_000 };
}

export async function quote(t: TestEnv, org: FixtureOrg, venueId: string, over: Partial<Parameters<typeof delivery.quoteDelivery>[2]> & { north?: number; east?: number } = {}, principal: Principal = anon(), ip?: string) {
  const { north = 800, east = 400, ...rest } = over;
  const at = await near(t, venueId, north, east);
  return delivery.quoteDelivery(t.app, { orgId: org.orgId, principal, ip }, {
    venueId,
    address: { line1: '12 Test Street', suburb: 'Surry Hills', state: 'NSW', postcode: '2010', ...at },
    notes: 'Gate code 1234',
    subtotalCents: 2600,
    ...rest,
  });
}

export async function burgerLines(t: TestEnv, org: FixtureOrg, venueId: string, qty = 1) {
  const m = await menuOf(t, org, venueId);
  return [{ menuItemId: m.byName('Cheeseburger').id, qty }];
}

export interface DeliveryOrder {
  order: ordering.OrderView;
  deliveryId: string;
  email: string;
}

/** Quote, order and pay a delivery, as a guest. Not yet accepted. */
export async function paidDelivery(t: TestEnv, org: FixtureOrg, venueId: string, over: { email?: string; phone?: string; qty?: number } = {}): Promise<DeliveryOrder> {
  const q = await quote(t, org, venueId, { subtotalCents: 2600 * (over.qty ?? 1) });
  const email = over.email ?? `guest.${randomUUID().slice(0, 8)}@delivery.example`;
  const lines = await burgerLines(t, org, venueId, over.qty ?? 1);
  const order = await t.app.tenant(org.orgId, anon(), (ctx) =>
    ordering.createOrder(ctx, {
      venueId,
      channel: 'delivery',
      deliveryId: q.deliveryId,
      lines,
      idempotencyKey: `test-${randomUUID()}`,
      customer: { name: 'Dee Livery', email, ...(over.phone ? { phone: over.phone } : {}) },
    }),
  );
  const paid = await ordering.payOrder(t.app, { orgId: org.orgId, principal: anon() }, { trackingToken: order.trackingToken!, sourceToken: okCard() });
  if (paid.status !== 'paid') throw new Error('expected the delivery order to be paid');
  return { order: paid.order, deliveryId: q.deliveryId, email };
}

export async function accept(t: TestEnv, org: FixtureOrg, orderId: string) {
  return t.app.tenant(org.orgId, await org.as('manager'), (ctx) => ordering.updateOrderStatus(ctx, { orderId, status: 'accepted' }));
}

export async function deliveryRow(t: TestEnv, deliveryId: string) {
  return t.db.selectFrom('deliveries').selectAll().where('id', '=', deliveryId).executeTakeFirstOrThrow();
}

export async function history(t: TestEnv, deliveryId: string) {
  return (await t.db.selectFrom('delivery_status_history').select(['from_status', 'to_status', 'source']).where('delivery_id', '=', deliveryId).orderBy('at').orderBy(sql`ctid`).execute()).map(
    (h) => `${h.from_status}>${h.to_status}:${h.source}`,
  );
}

/** Post a courier webhook the way the route would. */
export function postWebhook(t: TestEnv, plug: string, hook: { rawBody: string; headers: Record<string, string> }) {
  return delivery.handleCourierWebhook(t.app, { plugKey: plug, rawBody: hook.rawBody, headers: hook.headers, url: WEBHOOK_URL(plug) });
}

export async function setDelivery(t: TestEnv, org: FixtureOrg, venueId: string, config: Partial<delivery.DeliveryConfig>, enabled?: boolean) {
  return t.app.tenant(org.orgId, WORKER, (ctx) => setModule(ctx, delivery.deliveryModule, { venueId, config, enabled }));
}
