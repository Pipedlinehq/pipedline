import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, getTool, tickSchedules } from '@ros/core';
import { SIM_COURIER_A, SIM_COURIER_B } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { delivery, identity, ordering } from '@ros/modules';
import {
  QUIET_EVENING,
  accept,
  anon,
  burgerLines,
  courierSecret,
  deliveryRow,
  footprint,
  history,
  menuOf,
  paidDelivery,
  postWebhook,
  quote,
  setDelivery,
} from './helpers';

describe('first-party delivery', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const secretA = () => courierSecret(diner(), SIM_COURIER_A);
  const secretB = () => courierSecret(diner(), SIM_COURIER_B);
  const jobsFor = (reference: string) => [...t.sim.courierA.jobs, ...t.sim.courierB.jobs].filter((j) => j.reference === reference);
  const mailTo = (email: string) => t.sim.email.sent.filter((m) => m.to === email);

  beforeAll(() => t.clock.set(QUIET_EVENING));
  beforeEach(() => {
    t.clock.set(QUIET_EVENING);
    t.sim.courierA.setNoCourier(false);
    t.sim.courierB.setNoCourier(false);
  });

  it('quote → order → pay → accept → courier booked once, at the prep time → tracking messages → delivered → order completed', async () => {
    const { order, deliveryId, email } = await paidDelivery(t, diner(), venueId());
    // The fee is the server's: courier A's $9.00 less the $3.00 the venue subsidises.
    expect(order).toMatchObject({ channel: 'delivery', status: 'placed', deliveryFeeCents: 600, subtotalCents: 2600, totalCents: 3200 });
    let d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ order_id: order.id, status: 'quoted', provider: SIM_COURIER_A, customer_fee_cents: 600, courier_fee_cents: 900, customer_id: order.customerId, dropoff_notes: 'Gate code 1234' });
    expect(t.sim.email.sent.filter((m) => m.to === email)).toHaveLength(0);

    await accept(t, diner(), order.id);
    d = await deliveryRow(t, deliveryId);
    // Promised for 6:20; the courier is asked for ten minutes before, not at order time.
    expect(order.promisedAt!.toISOString()).toBe('2026-10-01T08:20:00.000Z');
    expect(d.request_at!.toISOString()).toBe('2026-10-01T08:10:00.000Z');
    const job = await t.db.selectFrom('jobs').select(['run_at', 'status']).where('kind', '=', 'delivery.request_courier').where('idempotency_key', '=', `courier:${deliveryId}`).executeTakeFirstOrThrow();
    expect(job.run_at.toISOString()).toBe('2026-10-01T08:10:00.000Z');

    await drainJobs(t.app);
    expect(jobsFor(order.reference)).toHaveLength(0);
    expect((await deliveryRow(t, deliveryId)).status).toBe('quoted');

    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    await drainJobs(t.app);
    const booked = jobsFor(order.reference);
    expect(booked).toHaveLength(1);
    expect(booked[0]!.idempotencyKey).toBe(`courier:${deliveryId}:${SIM_COURIER_A}`);
    // The checkout quote lapsed while the food was cooked: a fresh one was asked for, never the stale one.
    expect(booked[0]!.quoteId).not.toBe(d.quote_id);
    expect(booked[0]!.request).toMatchObject({ dropoff: { name: 'Dee Livery', notes: 'Gate code 1234' }, orderValueCents: 2600, containsAlcohol: false });
    d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ status: 'requested', external_ref: booked[0]!.externalRef, tracking_url: booked[0]!.trackingUrl });
    expect(d.requested_at!.toISOString()).toBe('2026-10-01T08:10:30.000Z');
    const dispatched = mailTo(email).filter((m) => m.subject?.includes('has a courier'));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.body).toContain(booked[0]!.trackingUrl);

    const ref = booked[0]!.externalRef;
    const step = async (status: 'courier_assigned' | 'picked_up' | 'delivered') => {
      t.clock.advanceMinutes(5);
      expect(await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, status, secretA()))).toEqual({ status: 'processed' });
      await drainJobs(t.app);
    };
    await step('courier_assigned');
    await step('picked_up');
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference} is on its way`)).toHaveLength(1);
    await step('delivered');

    d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ status: 'delivered', courier_name: 'Sam Courier' });
    expect(d.proof).toMatchObject({ photo_url: expect.stringContaining(ref) });
    expect(d.delivered_at).not.toBeNull();
    expect(await history(t, deliveryId)).toEqual(['null>quoted:quote', 'quoted>requested:dispatch', 'requested>courier_assigned:webhook', 'courier_assigned>picked_up:webhook', 'picked_up>delivered:webhook']);
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'completed', channel: 'delivery' });
    expect(f.tickets[0]!.status).toBe('bumped');
    expect(f.transactions[0]).toMatchObject({ channel: 'delivery', total_cents: 3200 });
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference} was delivered`)).toHaveLength(1);
    const evs = await t.db.selectFrom('events').select('name').where(sql<boolean>`properties->>'delivery_id' = ${deliveryId}`).execute();
    expect(evs.map((e) => e.name)).toEqual(expect.arrayContaining(['delivery.quoted', 'delivery.requested', 'delivery.status_changed', 'delivery.delivered']));
    // Only one courier was ever booked.
    expect(jobsFor(order.reference)).toHaveLength(1);

    // The guest's tracking page: the delivery, not the address.
    const tracking = await t.app.tenant(diner().orgId, anon(), (ctx) => delivery.getDeliveryTracking(ctx, order.trackingToken!));
    expect(tracking).toMatchObject({ status: 'delivered', label: 'Delivered', courierFirstName: 'Sam' });
    expect(JSON.stringify(tracking)).not.toMatch(/Test Street|Gate code/);
  });

  it('an expired quote is refused at checkout and never charged; checking the address again gives a fresh one', async () => {
    const q = await quote(t, diner(), venueId());
    const lines = await burgerLines(t, diner(), venueId());
    t.clock.advanceMinutes(11);
    const priced = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: q.deliveryId, lines }));
    expect(priced).toMatchObject({ orderable: false, deliveryFeeCents: 0 });
    expect(priced.issues.map((i) => i.code)).toEqual(['delivery']);
    const key = `test-${randomUUID()}`;
    await expect(
      t.app.tenant(diner().orgId, anon(), (ctx) => ordering.createOrder(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: q.deliveryId, lines, idempotencyKey: key, customer: { name: 'Stale Quote', email: 'stale@delivery.example' } })),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.db.selectFrom('orders').select('id').where('idempotency_key', '=', key).execute()).toHaveLength(0);
    expect((await deliveryRow(t, q.deliveryId)).order_id).toBeNull();

    const fresh = await quote(t, diner(), venueId());
    const again = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: fresh.deliveryId, lines }));
    expect(again).toMatchObject({ orderable: true, deliveryFeeCents: 600 });
    // A quote is used by one order only.
    const o1 = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.createOrder(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: fresh.deliveryId, lines, idempotencyKey: `test-${randomUUID()}`, customer: { name: 'One Use', email: 'one@delivery.example' } }));
    expect(o1.deliveryFeeCents).toBe(600);
    await expect(
      t.app.tenant(diner().orgId, anon(), (ctx) => ordering.createOrder(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: fresh.deliveryId, lines, idempotencyKey: `test-${randomUUID()}`, customer: { name: 'Two Use', email: 'two@delivery.example' } })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('an address outside every zone, or with no map point, is refused before any courier is asked; the fee follows the zone and the spend', async () => {
    const before = t.sim.courierA.calls.quote;
    await expect(quote(t, diner(), venueId(), { north: 9000, east: 0 })).rejects.toMatchObject({ code: 'invalid', message: 'Sorry, that address is outside our delivery area.' });
    await expect(
      delivery.quoteDelivery(t.app, { orgId: diner().orgId, principal: anon() }, { venueId: venueId(), address: { line1: '1 Nowhere Rd', suburb: 'Nowhere', state: 'NSW', postcode: '2999' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(t.sim.courierA.calls.quote).toBe(before);

    // The wider zone charges a flat $12 and needs $35.
    const wide = await quote(t, diner(), venueId(), { north: 4000, east: 0, subtotalCents: 5200 });
    expect(wide).toMatchObject({ feeCents: 1200, zoneName: 'Wider area' });
    const lines = await burgerLines(t, diner(), venueId());
    const small = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: wide.deliveryId, lines }));
    expect(small.issues).toEqual([{ code: 'delivery', message: 'The smallest order we deliver is $35.00.' }]);
    const two = await burgerLines(t, diner(), venueId(), 2);
    const big = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: wide.deliveryId, lines: two }));
    expect(big).toMatchObject({ orderable: true, deliveryFeeCents: 1200 });
    // A fee the browser claims is not read.
    const forged = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: wide.deliveryId, lines: two, deliveryFeeCents: 0, customerFeeCents: 0 } as never));
    expect(forged.deliveryFeeCents).toBe(1200);
  });

  it('the preferred courier has none: the second provider is booked, and the failover is on record', async () => {
    const { order, deliveryId } = await paidDelivery(t, diner(), venueId());
    t.sim.courierA.setNoCourier(true);
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    expect(t.sim.courierA.jobs.filter((j) => j.reference === order.reference)).toHaveLength(0);
    const b = t.sim.courierB.jobs.filter((j) => j.reference === order.reference);
    expect(b).toHaveLength(1);
    const d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ status: 'requested', provider: SIM_COURIER_B, courier_fee_cents: 1100, customer_fee_cents: 600, external_ref: b[0]!.externalRef });
    expect(d.attempted_providers).toEqual([SIM_COURIER_A, SIM_COURIER_B]);
    const ev = await t.db.selectFrom('events').select('properties').where('name', '=', 'delivery.requested').where(sql<boolean>`properties->>'delivery_id' = ${deliveryId}`).executeTakeFirstOrThrow();
    expect(ev.properties).toMatchObject({ provider: SIM_COURIER_B, failover: true, courier_fee_cents: 1100 });
    // Courier B's webhooks are checked with courier B's secret, not A's.
    const forged = t.sim.courierB.advance(b[0]!.externalRef, 'courier_assigned', secretA());
    await expect(postWebhook(t, SIM_COURIER_B, forged)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await postWebhook(t, SIM_COURIER_B, t.sim.courierB.webhook(secretB(), { externalRef: b[0]!.externalRef, status: 'courier_assigned' }))).toEqual({ status: 'processed' });
    expect((await deliveryRow(t, deliveryId)).status).toBe('courier_assigned');
  });

  it('no courier anywhere: the order is cancelled, the guest is told and refunded in full, and nothing is left hanging', async () => {
    const { order, deliveryId, email } = await paidDelivery(t, diner(), venueId());
    t.sim.courierA.setNoCourier(true);
    t.sim.courierB.setNoCourier(true);
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    await drainJobs(t.app);

    expect(jobsFor(order.reference)).toHaveLength(0);
    const d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ status: 'failed', failure_reason: 'no_courier' });
    expect(d.attempted_providers).toEqual([SIM_COURIER_A, SIM_COURIER_B]);
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
    expect(f.tickets[0]!.status).toBe('cancelled');
    const charge = t.sim.payment.captured().find((c) => c.reference === order.reference)!;
    expect(t.sim.payment.refunds.filter((r) => r.paymentRef === charge.externalRef).map((r) => r.amountCents)).toEqual([3200]);
    const told = mailTo(email).filter((m) => m.subject?.includes('was cancelled'));
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('no courier was available');
    expect(told[0]!.body).toContain('refunded in full');
    const audits = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', deliveryId).execute();
    expect(audits.map((a) => a.action)).toContain('delivery.no_courier');
    const left = await t.db.selectFrom('jobs').select(['kind', 'status']).where('status', 'in', ['queued', 'running', 'dead']).where('kind', 'like', 'delivery.%').execute();
    expect(left).toEqual([]);
  });

  it('no courier, and the venue offers pickup: the order becomes a pickup, the delivery fee is refunded, the guest is told where to collect it, staff are flagged', async () => {
    await setDelivery(t, diner(), venueId(), { no_courier_fallback: 'offer_pickup' });
    const { order, deliveryId, email } = await paidDelivery(t, diner(), venueId());
    t.sim.courierA.setNoCourier(true);
    t.sim.courierB.setNoCourier(true);
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    await drainJobs(t.app);
    expect((await deliveryRow(t, deliveryId)).status).toBe('failed');
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ channel: 'pickup', status: 'accepted', payment_status: 'partially_refunded' });
    expect(f.order.attention_reason).toContain('No courier');
    expect(f.payments[0]!.refunded_cents).toBe(600);
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference}: no courier, ready for pickup instead`)).toHaveLength(1);
    // The pickup now tells the guest when it is ready, as any pickup does.
    await t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'preparing' }));
    await t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'ready' }));
    await drainJobs(t.app);
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference} is ready`)).toHaveLength(1);
    await setDelivery(t, diner(), venueId(), { no_courier_fallback: 'refund' });
  });

  it('webhooks: a forged one changes nothing, a replay acts once, late news never moves a delivery back, and a lying hint is ignored', async () => {
    const { order, deliveryId, email } = await paidDelivery(t, diner(), venueId());
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    const ref = jobsFor(order.reference)[0]!.externalRef;

    // Forged: wrong secret, no signature, an unknown delivery. All the same answer, nothing stored.
    const hook = t.sim.courierA.advance(ref, 'courier_assigned', secretA());
    await expect(postWebhook(t, SIM_COURIER_A, { rawBody: hook.rawBody, headers: { 'x-sim-signature': 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(postWebhook(t, SIM_COURIER_A, { rawBody: hook.rawBody, headers: {} })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(postWebhook(t, SIM_COURIER_A, t.sim.courierA.webhook(secretA(), { externalRef: 'nope', status: 'delivered' }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(delivery.handleCourierWebhook(t.app, { plugKey: 'no-such-plug', rawBody: hook.rawBody, headers: hook.headers, url: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await deliveryRow(t, deliveryId)).status).toBe('requested');
    expect(await t.db.selectFrom('webhook_events').select('id').where('provider', '=', `courier:${SIM_COURIER_A}`).where('event_id', '=', `${ref}:${hook.eventId}`).execute()).toHaveLength(0);

    // A hint that lies (says delivered while the courier has not even collected it): the re-fetch decides.
    const lie = t.sim.courierA.webhook(secretA(), { externalRef: ref, status: 'delivered' });
    expect(await postWebhook(t, SIM_COURIER_A, lie)).toEqual({ status: 'processed' });
    expect((await deliveryRow(t, deliveryId)).status).toBe('courier_assigned');
    expect((await footprint(t, order.id)).order.status).not.toBe('completed');

    // Picked up, delivered: then the picked-up event arrives again, and late.
    const picked = t.sim.courierA.advance(ref, 'picked_up', secretA());
    expect(await postWebhook(t, SIM_COURIER_A, picked)).toEqual({ status: 'processed' });
    expect(await postWebhook(t, SIM_COURIER_A, picked)).toEqual({ status: 'duplicate' });
    await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, 'delivered', secretA()));
    const late = t.sim.courierA.webhook(secretA(), { externalRef: ref, status: 'picked_up' });
    expect(await postWebhook(t, SIM_COURIER_A, late)).toEqual({ status: 'processed' });
    await drainJobs(t.app);

    expect((await deliveryRow(t, deliveryId)).status).toBe('delivered');
    expect(await history(t, deliveryId)).toEqual(['null>quoted:quote', 'quoted>requested:dispatch', 'requested>courier_assigned:webhook', 'courier_assigned>picked_up:webhook', 'picked_up>delivered:webhook']);
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference} is on its way`)).toHaveLength(1);
    expect(mailTo(email).filter((m) => m.subject === `Order ${order.reference} was delivered`)).toHaveLength(1);
    expect((await footprint(t, order.id)).history.filter((h) => h.to_status === 'completed')).toHaveLength(1);
  });

  it('reconciliation finds what a lost webhook would have said', async () => {
    const { order, deliveryId } = await paidDelivery(t, diner(), venueId());
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    const ref = jobsFor(order.reference)[0]!.externalRef;
    // The courier collects and delivers; neither webhook ever arrives.
    t.sim.courierA.advance(ref, 'courier_assigned', secretA());
    t.sim.courierA.advance(ref, 'picked_up', secretA());
    t.sim.courierA.advance(ref, 'delivered', secretA());
    const getsBefore = t.sim.courierA.calls.get;

    t.clock.set('2026-10-01T08:25:00.000Z');
    await tickSchedules(t.app, { only: ['delivery.reconcile'] });
    await drainJobs(t.app);

    expect(t.sim.courierA.calls.get).toBeGreaterThan(getsBefore);
    expect(await history(t, deliveryId)).toEqual(['null>quoted:quote', 'quoted>requested:dispatch', 'requested>delivered:reconcile']);
    expect((await footprint(t, order.id)).order.status).toBe('completed');
    // Asked again, nothing changes.
    t.clock.set('2026-10-01T08:40:00.000Z');
    await tickSchedules(t.app, { only: ['delivery.reconcile'] });
    await drainJobs(t.app);
    expect(await history(t, deliveryId)).toHaveLength(3);
  });

  it('an order cancelled after the courier was assigned calls the courier off, and the cancellation fee is recorded', async () => {
    const { order, deliveryId } = await paidDelivery(t, diner(), venueId());
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    const ref = jobsFor(order.reference)[0]!.externalRef;
    await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, 'courier_assigned', secretA()));
    await t.app.tenant(diner().orgId, await diner().as('manager'), (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'cancelled', reason: 'The kitchen burnt it, sorry.' }));
    await drainJobs(t.app);
    await drainJobs(t.app);
    expect(t.sim.courierA.job(ref)).toMatchObject({ status: 'cancelled', cancellationFeeCents: 500 });
    const d = await deliveryRow(t, deliveryId);
    expect(d).toMatchObject({ status: 'cancelled', cancellation_fee_cents: 500 });
    expect((await footprint(t, order.id)).order).toMatchObject({ status: 'cancelled', payment_status: 'refunded' });
    const audit = await t.db.selectFrom('audit_log').select('after').where('action', '=', 'delivery.cancelled').where('entity_id', '=', deliveryId).executeTakeFirstOrThrow();
    expect(audit.after).toMatchObject({ cancellationFeeCents: 500, paidBy: 'venue' });
  });

  it('a delivery that fails at the door is refunded per the venue\'s policy, less a cancellation fee when the venue passes it on', async () => {
    await setDelivery(t, diner(), venueId(), { failed_delivery_refund: 'delivery_fee' });
    const { order, deliveryId, email } = await paidDelivery(t, diner(), venueId());
    await accept(t, diner(), order.id);
    t.clock.set('2026-10-01T08:10:30.000Z');
    await drainJobs(t.app);
    const ref = jobsFor(order.reference)[0]!.externalRef;
    await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, 'courier_assigned', secretA()));
    await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, 'picked_up', secretA()));
    await postWebhook(t, SIM_COURIER_A, t.sim.courierA.advance(ref, 'failed', secretA(), { failureReason: 'Nobody home.' }));
    await drainJobs(t.app);
    await drainJobs(t.app);
    expect(await deliveryRow(t, deliveryId)).toMatchObject({ status: 'failed', failure_reason: 'Nobody home.' });
    const f = await footprint(t, order.id);
    expect(f.payments[0]!.refunded_cents).toBe(600);
    expect(f.order.attention_reason).toContain('Nobody home.');
    const told = mailTo(email).filter((m) => m.subject === `Order ${order.reference} could not be delivered`);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('$6.00 delivery fee is being refunded');
    await setDelivery(t, diner(), venueId(), { failed_delivery_refund: 'full' });
  });

  it('another org\'s delivery is not found; delivery switched off is not found; alcohol is refused unless the venue allows it', async () => {
    const q = await quote(t, diner(), venueId());
    const group = t.fixture.group;
    const cbd = group.venues.cbd!.id;
    await expect(t.app.tenant(group.orgId, await group.as('owner'), (ctx) => delivery.getDelivery(ctx, q.deliveryId))).rejects.toMatchObject({ code: 'not_found' });
    // The diner's quote at the group's venue: no fee, not orderable.
    const lines = await burgerLines(t, group, cbd);
    const cross = await t.app.tenant(group.orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: cbd, channel: 'delivery', deliveryId: q.deliveryId, lines }));
    expect(cross).toMatchObject({ orderable: false, deliveryFeeCents: 0 });
    // Staff of the right org, wrong venue, or too junior.
    await expect(t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => delivery.saveZone(ctx, { venueId: venueId(), name: 'Mine', radiusM: 1000 }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(group.orgId, await group.as('host'), (ctx) => delivery.saveZone(ctx, { venueId: cbd, name: 'Theirs', radiusM: 1000 }))).rejects.toMatchObject({ code: 'not_found' });

    // Newtown never switched delivery on.
    const newtown = group.venues.newtown!.id;
    await expect(quote(t, group, newtown)).rejects.toMatchObject({ code: 'module_disabled', status: 404 });
    // Switched off at the diner: quotes, pricing, zones and tracking are gone; the data stays.
    await setDelivery(t, diner(), venueId(), {}, false);
    await expect(quote(t, diner(), venueId())).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: q.deliveryId, lines: [{ menuItemId: lines[0]!.menuItemId, qty: 1 }] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner().orgId, await diner().as('manager'), (ctx) => delivery.listZones(ctx, venueId()))).rejects.toMatchObject({ code: 'module_disabled' });
    expect(await t.db.selectFrom('delivery_zones').select('id').where('venue_id', '=', venueId()).execute()).not.toHaveLength(0);
    await setDelivery(t, diner(), venueId(), {}, true);
    // Paused by its own switch: the same.
    await setDelivery(t, diner(), venueId(), { delivery_enabled: false });
    await expect(quote(t, diner(), venueId())).rejects.toMatchObject({ code: 'module_disabled' });
    await setDelivery(t, diner(), venueId(), { delivery_enabled: true });

    // Alcohol: off by default, so neither a quote for it nor a cart with it is accepted.
    await expect(quote(t, diner(), venueId(), { containsAlcohol: true })).rejects.toMatchObject({ code: 'invalid', message: 'Alcohol cannot be delivered from here. Remove it, or choose pickup.' });
    const m = await menuOf(t, diner(), venueId());
    const drink = m.all.find((i) => i.isAlcohol);
    if (drink) {
      const fresh = await quote(t, diner(), venueId());
      const cart = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId: fresh.deliveryId, lines: [...lines.map((l) => ({ ...l, menuItemId: m.byName('Cheeseburger').id })), { menuItemId: drink.id, qty: 1 }] }));
      expect(cart.orderable).toBe(false);
      expect(cart.issues.map((i) => i.message)).toContain('Alcohol cannot be delivered from here. Remove it, or choose pickup.');
    }
  });

  it('quotes are rate limited per address', async () => {
    const ip = '203.0.113.90';
    for (let i = 0; i < 30; i++) await quote(t, diner(), venueId(), {}, anon(), ip);
    await expect(quote(t, diner(), venueId(), {}, anon(), ip)).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    expect((await quote(t, diner(), venueId(), {}, anon(), '203.0.113.91')).deliveryId).toBeTruthy();
  });

  it('the console: settings, zones and the delivery timeline for a manager; the assistant\'s summary; the guest\'s export and erasure', async () => {
    const manager = await diner().as('manager');
    const settings = await t.app.tenant(diner().orgId, manager, (ctx) => delivery.getDeliverySettings(ctx, venueId()));
    expect(settings).toMatchObject({ enabled: true, config: { providers: [SIM_COURIER_A, SIM_COURIER_B], courier_request_lead_minutes: 10, alcohol_enabled: false } });
    const changed = await t.app.tenant(diner().orgId, manager, (ctx) => delivery.updateDeliverySettings(ctx, { venueId: venueId(), config: { courier_request_lead_minutes: 15 } }));
    expect(changed.config.courier_request_lead_minutes).toBe(15);
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => delivery.updateDeliverySettings(ctx, { venueId: venueId(), config: { max_radius_m: 5 } }))).rejects.toMatchObject({ code: 'invalid' });
    await t.app.tenant(diner().orgId, manager, (ctx) => delivery.updateDeliverySettings(ctx, { venueId: venueId(), config: { courier_request_lead_minutes: 10 } }));
    expect(await t.db.selectFrom('audit_log').select('id').where('action', '=', 'module.set').where('entity_id', '=', `${venueId()}:delivery`).execute()).not.toHaveLength(0);

    const zone = await t.app.tenant(diner().orgId, manager, (ctx) => delivery.saveZone(ctx, { venueId: venueId(), name: 'Park side', kind: 'polygon', polygon: [[-33.88, 151.21], [-33.88, 151.22], [-33.89, 151.22]], minOrderCents: 1500 }));
    expect(zone).toMatchObject({ kind: 'polygon', feeRule: null, isActive: true });
    await t.app.tenant(diner().orgId, manager, (ctx) => delivery.deactivateZone(ctx, zone.id));
    expect((await t.app.tenant(diner().orgId, manager, (ctx) => delivery.listZones(ctx, venueId()))).map((z) => z.id)).not.toContain(zone.id);

    const { order, deliveryId } = await paidDelivery(t, diner(), venueId(), { phone: '0400 222 333' });
    const view = await t.app.tenant(diner().orgId, manager, (ctx) => delivery.getDeliveryForOrder(ctx, order.id));
    expect(view).toMatchObject({ id: deliveryId, status: 'quoted', dropoffNotes: 'Gate code 1234', customerFeeCents: 600 });
    expect(view!.timeline.map((s) => s.to)).toEqual(['quoted']);
    const listed = await t.app.tenant(diner().orgId, manager, (ctx) => delivery.listDeliveries(ctx, { venueId: venueId() }));
    expect(listed.find((d) => d.id === deliveryId)).toMatchObject({ dropoffAddress: null, dropoffNotes: null });

    const tool = getTool('deliveries_summary')!;
    if (tool.effect !== 'read') throw new Error('expected a read tool');
    const out = tool.output.parse(await t.app.tenant(diner().orgId, manager, (ctx) => tool.run({ ctx, venueId: venueId() }, tool.input.parse({ days: 7 }))));
    expect(out.delivered).toBeGreaterThanOrEqual(1);
    // The group's seeded history: delivered ones and the one that failed at the door.
    const group = t.fixture.group;
    const cbd = group.venues.cbd!.id;
    const summary = tool.output.parse(await t.app.tenant(group.orgId, await group.as('owner'), (ctx) => tool.run({ ctx, venueId: cbd }, tool.input.parse({ days: 7 }))));
    expect(summary).toMatchObject({ delivered: 4, failed: 1 });
    expect(JSON.stringify(out)).not.toMatch(/Test Street|Gate code|Dee Livery/);

    // The guest's data follows them out, and goes when they are erased. The venue's costs stay.
    const customerId = order.customerId!;
    const owner = await diner().as('owner');
    const exported = await t.app.tenant(diner().orgId, owner, (ctx) => identity.exportCustomer(ctx, customerId));
    expect(exported.deliveries).toEqual([expect.objectContaining({ notesForCourier: 'Gate code 1234', deliveryFeeCents: 600 })]);
    await t.app.tenant(diner().orgId, owner, (ctx) => identity.eraseCustomer(ctx, customerId));
    const erased = await deliveryRow(t, deliveryId);
    expect(erased).toMatchObject({ customer_id: null, dropoff_notes: null, dropoff_lat: null, dropoff_address: { erased: true }, customer_fee_cents: 600 });
  });

  it('the group: delivery is on at the CBD venue only, with its own zones', async () => {
    const group = t.fixture.group;
    const cbd = group.venues.cbd!.id;
    const q = await quote(t, group, cbd, { subtotalCents: 5200 });
    expect(q).toMatchObject({ feeCents: 600, zoneName: 'Nearby' });
    for (const v of ['newtown', 'bondi']) await expect(quote(t, group, group.venues[v]!.id)).rejects.toMatchObject({ code: 'module_disabled' });
    // The seeder's history went through the real flow: four delivered (orders completed), one failed at the door (refunded).
    const seeded = await t.db.selectFrom('deliveries').select(['status', 'venue_id', 'order_id']).where('org_id', '=', group.orgId).where('order_id', 'is not', null).execute();
    expect(seeded.map((d) => d.status).sort()).toEqual(['delivered', 'delivered', 'delivered', 'delivered', 'failed']);
    expect(seeded.every((d) => d.venue_id === cbd)).toBe(true);
    const orders = await t.db.selectFrom('orders').select(['id', 'status', 'payment_status']).where('id', 'in', seeded.map((d) => d.order_id!)).execute();
    const failed = seeded.find((d) => d.status === 'failed')!;
    expect(orders.find((o) => o.id === failed.order_id)).toMatchObject({ status: 'refunded', payment_status: 'refunded' });
    expect(orders.filter((o) => o.status === 'completed')).toHaveLength(4);
    const dinerHistory = await t.db.selectFrom('deliveries').select('id').where('org_id', '=', t.fixture.diner.orgId).where('order_id', 'is not', null).where('created_at', '<', new Date('2026-09-30T02:00:00.000Z')).execute();
    expect(dinerHistory).toHaveLength(0);
  });
});
