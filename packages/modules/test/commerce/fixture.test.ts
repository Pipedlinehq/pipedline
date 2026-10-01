import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { getModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ordering, qr } from '@ros/modules';
import { WORKER, anon } from './helpers';

/**
 * What the commerce seeder leaves in the fixture database (packages/fixtures/src/seeders/
 * 20-commerce.ts). These run against the seeded template at the fixtures' own "now".
 */
describe('commerce fixtures', () => {
  const t = useTestEnv();
  const venues = () => [
    { org: t.fixture.diner, slug: 'main', id: t.fixture.diner.venueId, dineIn: true },
    { org: t.fixture.group, slug: 'cbd', id: t.fixture.group.venues.cbd!.id, dineIn: true },
    { org: t.fixture.group, slug: 'newtown', id: t.fixture.group.venues.newtown!.id, dineIn: true },
    { org: t.fixture.group, slug: 'bondi', id: t.fixture.group.venues.bondi!.id, dineIn: false },
  ];

  it('ordering is on everywhere, QR only where there are tables, and each venue has its own card processor connection and codes', async () => {
    for (const v of venues()) {
      const state = await t.app.tenant(v.org.orgId, WORKER, async (ctx) => ({ ordering: await getModule(ctx, v.id, ordering.orderingModule), qr: await getModule(ctx, v.id, qr.qrModule) }));
      expect(state.ordering.enabled).toBe(true);
      expect(state.ordering.config).toMatchObject({ pickup_enabled: true, max_orders_per_slot: 8, slot_minutes: 15 });
      expect(state.qr.enabled).toBe(v.dineIn);
      if (v.dineIn) expect(state.qr.config.stage).toBe('order');

      const conn = await t.db.selectFrom('connections').select(['status', 'external_account_id', 'secret_ref']).where('venue_id', '=', v.id).where('plug_key', '=', 'sim-pay').execute();
      expect(conn).toHaveLength(1);
      expect(conn[0]).toMatchObject({ status: 'connected', external_account_id: `simpay-${v.org.slug}-${v.slug}` });
      expect(conn[0]!.secret_ref).not.toBeNull();

      const codes = await t.db.selectFrom('qr_codes').select(['kind', 'label']).where('venue_id', '=', v.id).execute();
      expect(codes.filter((c) => c.kind === 'table')).toHaveLength(v.dineIn ? 12 : 0);
      expect(codes.filter((c) => c.kind !== 'table').map((c) => c.kind).sort()).toEqual(v.dineIn ? ['campaign', 'counter', 'menu'] : []);
    }
    // The group's venues differ: Newtown keeps alcohol out of table orders, the CBD does not.
    const alcohol = async (venueId: string) => (await t.app.tenant(t.fixture.group.orgId, WORKER, (ctx) => getModule(ctx, venueId, qr.qrModule))).config.exclude_alcohol;
    expect([await alcohol(t.fixture.group.venues.cbd!.id), await alcohol(t.fixture.group.venues.newtown!.id)]).toEqual([false, true]);
  });

  it('about eighty recent orders went through the real flow: paid, in the ledger, ticketed, a few rejected or refunded', async () => {
    const orders = await t.db.selectFrom('orders').selectAll().execute();
    expect(orders.length).toBeGreaterThanOrEqual(70);
    expect(orders.length).toBeLessThanOrEqual(95);
    for (const v of venues()) expect(orders.filter((o) => o.venue_id === v.id).length).toBeGreaterThanOrEqual(3);

    const count = (fn: (o: (typeof orders)[number]) => boolean) => orders.filter(fn).length;
    expect(count((o) => o.status === 'completed')).toBeGreaterThanOrEqual(45);
    expect(count((o) => o.status === 'completed')).toBe((await t.db.selectFrom('kitchen_tickets').select('id').where('status', '=', 'bumped').execute()).length);
    // Every outcome is present: turned down by the venue, refunded in full afterwards, part-refunded, never paid.
    expect(count((o) => o.status === 'rejected' && o.payment_status === 'refunded')).toBeGreaterThanOrEqual(2);
    expect(count((o) => o.status === 'refunded')).toBeGreaterThanOrEqual(2);
    expect(count((o) => o.payment_status === 'partially_refunded' && o.status === 'completed')).toBeGreaterThanOrEqual(2);
    expect(count((o) => o.status === 'cancelled' && o.payment_status === 'failed')).toBeGreaterThanOrEqual(2);
    expect(count((o) => o.channel === 'dine-in-qr')).toBeGreaterThanOrEqual(10);
    expect(count((o) => o.channel === 'pickup')).toBeGreaterThanOrEqual(30);
    // The pickup-only venue took no table orders.
    expect(count((o) => o.venue_id === t.fixture.group.venues.bondi!.id && o.channel !== 'pickup')).toBe(0);
    // Table orders carry their table and session; some were anonymous.
    const table = orders.filter((o) => o.channel === 'dine-in-qr');
    expect(table.every((o) => o.table_label && o.table_session_id && o.qr_code_id)).toBe(true);
    expect(table.some((o) => o.customer_id === null)).toBe(true);
    // Live right now: paid orders still in the kitchen's hands, with a ticket that is alerting.
    const live = orders.filter((o) => ['placed', 'accepted', 'preparing', 'ready'].includes(o.status));
    expect(live.length).toBeGreaterThanOrEqual(4);
    const alerting = await t.db.selectFrom('kitchen_tickets').select('id').where('status', '=', 'new').execute();
    expect(alerting.length).toBeGreaterThanOrEqual(1);
    // Nothing is left half-paid: an order is either paid or was never charged and has lapsed.
    expect(count((o) => o.status === 'pending_payment')).toBe(0);
    expect(orders.filter((o) => o.status === 'cancelled').every((o) => o.transaction_id === null)).toBe(true);

    // Every paid order has exactly one ledger row, one ticket and one completed payment.
    const paid = orders.filter((o) => o.payment_status !== 'unpaid' && o.payment_status !== 'failed');
    const check = await sql<{ orders: number; txns: number; tickets: number; payments: number; lines: number }>`
      select (select count(*) from orders where payment_status not in ('unpaid', 'failed'))::int as orders,
             (select count(*) from transactions where order_id is not null and source = 'online-order')::int as txns,
             (select count(*) from kitchen_tickets)::int as tickets,
             (select count(*) from payments where status in ('completed', 'refunded', 'partially_refunded'))::int as payments,
             (select count(*) from transaction_lines l join transactions x on x.id = l.transaction_id where x.order_id is not null and l.menu_item_id is null)::int as lines`.execute(t.db);
    expect(check.rows[0]).toEqual({ orders: paid.length, txns: paid.length, tickets: paid.length, payments: paid.length, lines: 0 });
    expect(paid.every((o) => o.transaction_id !== null)).toBe(true);

    // Refunds reached the ledger.
    const refunded = await t.db.selectFrom('transactions').select(['status', 'refunded_cents', 'total_cents']).where('order_id', 'in', orders.filter((o) => o.payment_status === 'refunded').map((o) => o.id)).execute();
    expect(refunded.length).toBeGreaterThanOrEqual(4);
    expect(refunded.every((r) => r.status === 'refunded' && r.refunded_cents === r.total_cents)).toBe(true);
    const part = await t.db.selectFrom('transactions').select(['status', 'refunded_cents', 'total_cents']).where('order_id', 'in', orders.filter((o) => o.payment_status === 'partially_refunded').map((o) => o.id)).execute();
    expect(part.every((r) => r.status === 'partially_refunded' && r.refunded_cents > 0 && r.refunded_cents < r.total_cents)).toBe(true);
  });

  it('the seeded orders told guests, recorded consents and attribution, and left nothing sensitive behind', async () => {
    const confirmations = await t.db.selectFrom('messages').select('status').where('template_key', '=', 'order.confirmed').execute();
    expect(confirmations.length).toBeGreaterThanOrEqual(40);
    expect(confirmations.every((m) => m.status === 'sent')).toBe(true);
    const queued = await t.db.selectFrom('jobs').select('kind').where('status', 'in', ['queued', 'dead']).where('kind', 'in', ['ordering.refund', 'ordering.pos_push']).execute();
    expect(queued).toEqual([]);

    const consents = await t.db.selectFrom('consents').select(['purpose']).where('source', 'in', ['checkout', 'qr_checkout']).execute();
    expect(consents.some((c) => c.purpose === 'marketing_email')).toBe(true);
    expect(consents.some((c) => c.purpose === 'card_recognition')).toBe(true);
    const linked = await t.db
      .selectFrom('customer_identities as ci')
      .innerJoin('customers as c', 'c.id', 'ci.customer_id')
      .select('ci.value')
      .where('ci.kind', '=', 'card_fingerprint')
      .where('c.primary_email', 'like', '%@orders.%')
      .execute();
    expect(linked.length).toBeGreaterThanOrEqual(1);
    expect(linked.every((l) => /^[0-9a-f]{64}$/.test(l.value))).toBe(true);
    const raw = await sql<{ n: number }>`
      select (select count(*) from payments where raw::text ~ 'sim-fp-|sim-par-|fingerprint')
           + (select count(*) from side_effects where result::text ~ 'sim-fp-|sim-par-|fingerprint')
           + (select count(*) from customer_identities where value like 'sim-fp-%') as n`.execute(t.db);
    expect(Number(raw.rows[0]!.n)).toBe(0);

    // Guests who arrived from a creator's post and ordered carry that creator for good.
    const viaCreator = await t.db
      .selectFrom('orders as o')
      .innerJoin('customers as c', 'c.id', 'o.customer_id')
      .select('c.id')
      .where('o.idempotency_key', 'like', 'fixture-order-%')
      .where('c.primary_email', 'like', '%@orders.%')
      .where('c.acquisition_creator_id', 'is not', null)
      .execute();
    expect(viaCreator.length).toBeGreaterThanOrEqual(1);
    const flagged = await t.db.selectFrom('orders').select('id').where(sql<boolean>`'loyalty_join' = any(flags)`).execute();
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    const funnel = await t.db.selectFrom('events').select(['name', (eb) => eb.fn.countAll<number>().as('n')]).where('name', 'in', ['order.placed', 'order.paid', 'order.completed', 'qr.scanned']).groupBy('name').execute();
    const n = (name: string) => Number(funnel.find((f) => f.name === name)?.n ?? 0);
    expect(n('order.placed')).toBeGreaterThanOrEqual(n('order.paid'));
    expect(n('order.paid')).toBeGreaterThanOrEqual(n('order.completed'));
    expect(n('order.completed')).toBeGreaterThanOrEqual(45);
    expect(n('qr.scanned')).toBeGreaterThanOrEqual(10);
  });

  it('a kitchen screen and a guest see the live orders the fixtures left at noon', async () => {
    const diner = t.fixture.diner;
    const board = await t.app.tenant(diner.orgId, await diner.as('kitchen'), (ctx) => ordering.listLiveTickets(ctx, { venueId: diner.venueId }));
    expect(board.tickets.length).toBeGreaterThanOrEqual(1);
    expect(board.tickets.every((x) => x.items.length > 0 && x.receivedAt.toISOString() === '2026-09-30T02:00:00.000Z')).toBe(true);
    const waiting = await t.app.tenant(diner.orgId, await diner.as('manager'), (ctx) => ordering.listOrders(ctx, { venueId: diner.venueId, live: true }));
    expect(waiting.map((o) => o.id).sort()).toEqual(board.tickets.map((x) => x.orderId).sort());
    const tracked = await t.app.tenant(diner.orgId, anon(), (ctx) => ordering.trackOrder(ctx, waiting[0]!.trackingToken!));
    expect(tracked).toMatchObject({ reference: waiting[0]!.reference, venueName: 'Oak Diner' });
    // Slots at noon already count what is in the kitchen.
    const slots = await t.app.tenant(diner.orgId, anon(), (ctx) => ordering.getPickupSlots(ctx, { venueId: diner.venueId }));
    expect(slots.asap.available).toBe(true);
    const first = slots.slots[0]!;
    expect(first.start.toISOString()).toBe('2026-09-30T02:30:00.000Z');
  });
});
