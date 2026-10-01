import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, setModule } from '@ros/core';
import { SIM_PAY_TOKENS } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { events, identity, ordering } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, pay, placeOrder, registerTestAdjuster } from './helpers';

const adjuster = registerTestAdjuster();
const statusSeen: Array<{ orderId: string; from: string | null; to: string; transactionId: string | null; flags: string[] }> = [];
ordering.onOrderStatusChanged(async (_ctx, order, change) => {
  statusSeen.push({ orderId: order.id, from: change.from, to: change.to, transactionId: order.transactionId, flags: order.flags });
});

describe('checkout and payment', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('a paid order is priced by the server, recorded in the ledger, put on the kitchen screen and confirmed to the guest', async () => {
    const m = await menuOf(t, diner(), venueId());
    const rump = m.byName('Wagyu rump');
    const fries = m.byName('Fries, aioli');
    const sessionId = randomUUID();
    await t.app.tenant(diner().orgId, anon(sessionId), (ctx) => events.touchSession(ctx, { sessionId, venueId: venueId(), landingPath: '/menu' }));

    const order = await placeOrder(t, diner(), venueId(), {
      lines: [
        { menuItemId: rump.id, qty: 1, modifierIds: [m.modifier(rump, 'Cook temperature', 'Medium rare'), m.modifier(rump, 'Choose a side', 'Truffle fries')] },
        { menuItemId: fries.id, qty: 2 },
      ],
      customer: { name: 'Bea Buyer', email: 'Bea.Buyer@Example.com' },
      note: 'Ring the bell',
      sessionId,
    });
    expect(order).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid', subtotalCents: 7300, discountCents: 0, taxCents: 664, totalCents: 7300, itemCount: 3, requestedAsap: true });
    expect(order.trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(order.promisedAt!.toISOString()).toBe('2026-10-01T08:20:00.000Z');

    // Placed is not paid: nothing has reached the kitchen or the ledger.
    let f = await footprint(t, order.id);
    expect(f.tickets).toHaveLength(0);
    expect(f.transactions).toHaveLength(0);
    expect(t.sim.payment.charges.filter((c) => c.reference === order.reference)).toHaveLength(0);

    const paid = await pay(t, diner(), order, okCard('bea'));
    expect(paid).toMatchObject({ status: 'paid', replayed: false });

    f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'placed', payment_status: 'paid', total_cents: 7300, customer_email: 'bea.buyer@example.com' });
    expect(f.order.transaction_id).toBe(f.transactions[0]!.id);
    expect(f.order.placed_at).not.toBeNull();

    // The charge the processor saw is the server's total, under the key the payment row carries.
    const charges = t.sim.payment.charges.filter((c) => c.reference === order.reference);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ amountCents: 7300, tipCents: 0, status: 'completed', accountRef: 'simpay-oak-diner-main' });
    expect(f.payments).toHaveLength(1);
    expect(f.payments[0]).toMatchObject({ status: 'completed', amount_cents: 7300, provider: 'sim-pay', external_ref: charges[0]!.externalRef, card_brand: 'VISA', idempotency_key: charges[0]!.idempotencyKey });

    // The ledger: one sale, its lines tied to the menu.
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({ source: 'online-order', channel: 'pickup', status: 'completed', total_cents: 7300, tax_cents: 664, external_ref: charges[0]!.externalRef, customer_id: f.order.customer_id });
    const lines = await t.db.selectFrom('transaction_lines').selectAll().where('transaction_id', '=', f.transactions[0]!.id).orderBy('line_no').execute();
    expect(lines.map((l) => [l.name_snapshot, l.qty, l.unit_price_cents, l.total_cents, l.menu_item_id, l.category_snapshot])).toEqual([
      ['Wagyu rump 250g', 1, 5100, 5100, rump.id, 'Mains'],
      ['Fries, aioli', 2, 1100, 2200, fries.id, 'Sides'],
    ]);
    expect(lines[0]!.modifiers).toEqual([
      { name: 'Medium rare', priceCents: 0 },
      { name: 'Truffle fries', priceCents: 300 },
    ]);

    // The kitchen: one new ticket, allergens on it without a join.
    expect(f.tickets).toHaveLength(1);
    expect(f.tickets[0]).toMatchObject({ status: 'new', channel: 'pickup', guest_name: 'Bea', notes: 'Ring the bell', allergen_flags: ['egg'], acknowledged_at: null });
    const ticketEvents = await t.db.selectFrom('ticket_events').select('event').where('ticket_id', '=', f.tickets[0]!.id).execute();
    expect(ticketEvents.map((e) => e.event)).toEqual(['received']);

    // The guest: nothing is sent from the request; the worker sends one confirmation.
    expect(t.sim.email.sent.filter((x) => x.to === 'bea.buyer@example.com')).toHaveLength(0);
    await drainJobs(t.app);
    const mail = t.sim.email.sent.filter((x) => x.to === 'bea.buyer@example.com');
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(`Order ${order.reference} at Oak Diner is confirmed`);
    expect(mail[0]!.body).toContain('1 x Wagyu rump 250g (Medium rare, Truffle fries)  $51.00');
    expect(mail[0]!.body).toContain('Total paid: $73.00');
    expect(mail[0]!.body).toContain(`http://${diner().host}/order/${order.trackingToken}`);

    // The funnel: placed then paid, both carrying the visitor's session.
    const evs = await t.db.selectFrom('events').select(['name', 'session_id']).where('name', 'in', ['order.placed', 'order.paid']).where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
    expect(evs.map((e) => e.name).sort()).toEqual(['order.paid', 'order.placed']);
    expect(evs.every((e) => e.session_id === sessionId)).toBe(true);

    // Other modules were told, in order, and saw the ledger row at "placed".
    const mine = statusSeen.filter((s) => s.orderId === order.id);
    expect(mine.map((s) => `${s.from}>${s.to}`)).toEqual(['null>pending_payment', 'pending_payment>placed']);
    expect(mine[1]!.transactionId).toBe(f.transactions[0]!.id);
    const history = f.history.map((h) => `${h.from_status}>${h.to_status}`).sort();
    expect(history).toEqual(['null>pending_payment', 'pending_payment>placed']);
  });

  it('prices, totals and discounts sent by the browser are ignored', async () => {
    const m = await menuOf(t, diner(), venueId());
    const burger = m.byName('Cheeseburger');
    const forged = {
      lines: [{ menuItemId: burger.id, qty: 2, unitPriceCents: 1, priceCents: 1, lineTotalCents: 1, name: 'Free burger' }],
      subtotalCents: 1,
      totalCents: 1,
      discountCents: 5199,
      taxCents: 0,
      status: 'placed',
      paymentStatus: 'paid',
    };
    const order = await placeOrder(t, diner(), venueId(), forged as never);
    expect(order).toMatchObject({ status: 'pending_payment', paymentStatus: 'unpaid', subtotalCents: 5200, discountCents: 0, totalCents: 5200 });
    expect(order.items[0]).toMatchObject({ name: 'Cheeseburger, pickles, fries', unitPriceCents: 2600, lineTotalCents: 5200 });

    const priced = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), ...forged } as never));
    expect(priced).toMatchObject({ subtotalCents: 5200, totalCents: 5200, discountCents: 0 });

    await pay(t, diner(), order);
    const charge = t.sim.payment.charges.find((c) => c.reference === order.reference)!;
    expect(charge.amountCents).toBe(5200);
    const f = await footprint(t, order.id);
    expect(f.transactions[0]!.total_cents).toBe(5200);
  });

  it('the same checkout submitted twice is one order', async () => {
    const key = `test-${randomUUID()}`;
    const first = await placeOrder(t, diner(), venueId(), { idempotencyKey: key, customer: { name: 'Dee Double', email: 'dee@example.com' } });
    const again = await placeOrder(t, diner(), venueId(), { idempotencyKey: key, customer: { name: 'Dee Double', email: 'dee@example.com' } });
    expect(again.id).toBe(first.id);
    expect(again.trackingToken).toBe(first.trackingToken);
    const rows = await t.db.selectFrom('orders').select('id').where('idempotency_key', '=', key).execute();
    expect(rows).toHaveLength(1);
    const items = await t.db.selectFrom('order_items').select('id').where('order_id', '=', first.id).execute();
    expect(items).toHaveLength(1);
  });

  it('a declined card leaves the order unpaid and nothing reaches the kitchen; another card then works', async () => {
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Dec Lined', email: 'declined@example.com' } });
    const declined = await pay(t, diner(), order, SIM_PAY_TOKENS.decline);
    expect(declined).toMatchObject({ status: 'declined', reason: 'card_declined' });
    expect(declined.order).toMatchObject({ status: 'pending_payment', paymentStatus: 'failed' });

    let f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'pending_payment', payment_status: 'failed', transaction_id: null, placed_at: null });
    expect(f.tickets).toHaveLength(0);
    expect(f.transactions).toHaveLength(0);
    expect(f.messages).toHaveLength(0);
    expect(f.payments.map((p) => [p.status, p.failure_reason])).toEqual([['failed', 'card_declined']]);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((x) => x.to === 'declined@example.com')).toHaveLength(0);
    const failed = await t.db.selectFrom('events').select('name').where('name', '=', 'payment.failed').where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
    expect(failed).toHaveLength(1);

    // The same declined token again is the same attempt: the processor is not asked twice.
    await pay(t, diner(), order, SIM_PAY_TOKENS.decline);
    expect(t.sim.payment.charges.filter((c) => c.reference === order.reference)).toHaveLength(1);

    const paid = await pay(t, diner(), order, okCard());
    expect(paid.status).toBe('paid');
    f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'placed', payment_status: 'paid' });
    expect(f.tickets).toHaveLength(1);
    expect(f.transactions).toHaveLength(1);
    expect(f.payments.map((p) => p.status).sort()).toEqual(['completed', 'failed']);
    expect(t.sim.payment.captured().filter((c) => c.reference === order.reference)).toHaveLength(1);
  });

  it('replaying the pay call charges once: one charge, one ledger row, one ticket, one confirmation', async () => {
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Rhea Play', email: 'replay@example.com' } });
    const card = okCard('rhea');
    // A double-tap: two requests at once with the same card token.
    const [a, b] = await Promise.all([pay(t, diner(), order, card), pay(t, diner(), order, card)]);
    expect([a.status, b.status]).toEqual(['paid', 'paid']);
    // And again afterwards, with the same token and with a different card.
    const c = await pay(t, diner(), order, card);
    const d = await pay(t, diner(), order, okCard('someone-else'));
    expect(c).toMatchObject({ status: 'paid', replayed: true });
    expect(d).toMatchObject({ status: 'paid', replayed: true });

    expect(t.sim.payment.charges.filter((x) => x.reference === order.reference)).toHaveLength(1);
    const f = await footprint(t, order.id);
    expect(f.payments).toHaveLength(1);
    expect(f.transactions).toHaveLength(1);
    expect(f.tickets).toHaveLength(1);
    expect(f.history.filter((h) => h.to_status === 'placed')).toHaveLength(1);
    await drainJobs(t.app);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((x) => x.to === 'replay@example.com' && x.subject?.includes('confirmed'))).toHaveLength(1);
    const paidEvents = await t.db.selectFrom('events').select('id').where('name', '=', 'order.paid').where(sql<boolean>`properties->>'order_id' = ${order.id}`).execute();
    expect(paidEvents).toHaveLength(1);
  });

  it('a payment whose outcome was never heard is retried with the same key and charges once', async () => {
    const order = await placeOrder(t, diner(), venueId());
    const token = `${SIM_PAY_TOKENS.timeout}:tim`;
    await expect(pay(t, diner(), order, token)).rejects.toMatchObject({ code: 'provider_error' });

    let f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'pending_payment', payment_status: 'unpaid' });
    expect(f.payments.map((p) => p.status)).toEqual(['pending']);
    expect(f.tickets).toHaveLength(0);
    expect(f.transactions).toHaveLength(0);

    // While that attempt is unconfirmed, a second card is refused rather than risk charging twice.
    await expect(pay(t, diner(), order, okCard())).rejects.toMatchObject({ code: 'conflict' });

    const retried = await pay(t, diner(), order, token);
    expect(retried.status).toBe('paid');
    expect(t.sim.payment.captured().filter((x) => x.reference === order.reference)).toHaveLength(1);
    f = await footprint(t, order.id);
    expect(f.payments.map((p) => p.status)).toEqual(['completed']);
    expect(f.transactions).toHaveLength(1);
    expect(f.tickets).toHaveLength(1);
  });

  it('a charge that lands after its order lapsed is sent straight back, and the order never reaches the kitchen or the ledger', async () => {
    const order = await placeOrder(t, diner(), venueId(), { customer: { name: 'Lana Late', email: 'lana.late@example.com' } });
    const token = `${SIM_PAY_TOKENS.timeout}:lana`;
    await expect(pay(t, diner(), order, token)).rejects.toMatchObject({ code: 'provider_error' });

    // While the payment is unconfirmed nobody can cancel the order out from under it.
    await expect(t.app.tenant(diner().orgId, anon(), (ctx) => ordering.cancelUnpaidOrder(ctx, order.trackingToken!))).rejects.toMatchObject({ code: 'conflict' });
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'cancelled', reason: 'Guest left' }))).rejects.toMatchObject({ code: 'conflict' });

    // The hold ends. The order is kept while its payment is unresolved, then given up on two hours later.
    t.clock.advanceMinutes(16);
    await drainJobs(t.app);
    expect((await footprint(t, order.id)).order.status).toBe('pending_payment');
    for (let i = 0; i < 13; i++) {
      t.clock.advanceMinutes(10);
      await drainJobs(t.app);
    }
    let f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'cancelled', payment_status: 'unpaid' });
    expect(f.payments.map((p) => [p.status, p.failure_reason])).toEqual([['failed', 'unconfirmed']]);

    // The guest's phone finally gets through with the same card token: the processor had taken the money.
    await expect(pay(t, diner(), order, token)).rejects.toMatchObject({ code: 'conflict', message: 'This order expired before the payment went through. The payment is being refunded; please order again.' });
    await drainJobs(t.app);
    const charge = t.sim.payment.captured().find((c) => c.reference === order.reference)!;
    expect(charge.refundedCents).toBe(charge.amountCents);
    expect(t.sim.payment.refunds.filter((r) => r.paymentRef === charge.externalRef)).toHaveLength(1);
    f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ status: 'cancelled', payment_status: 'refunded', transaction_id: null });
    expect(f.payments.map((p) => [p.status, p.refunded_cents])).toEqual([['refunded', 1100]]);
    expect(f.tickets).toHaveLength(0);
    expect(f.transactions).toHaveLength(0);
    await drainJobs(t.app);
    const mail = t.sim.email.sent.filter((x) => x.to === 'lana.late@example.com').map((x) => x.subject);
    expect(mail).toEqual([`A refund for order ${order.reference}`]);
    t.clock.set(QUIET_EVENING);
  });

  it('the card box ticked at checkout links the card as a per-org hash; unticked, no link exists; the raw identifier is stored nowhere', async () => {
    const ticked = await placeOrder(t, diner(), venueId(), { customer: { name: 'Amy Agrees', email: 'amy.agrees@example.com' }, consents: [{ purpose: 'card_recognition' }] });
    const unticked = await placeOrder(t, diner(), venueId(), { customer: { name: 'Bob Declines', email: 'bob.declines@example.com' } });
    await pay(t, diner(), ticked, okCard('amy-card'));
    await pay(t, diner(), unticked, okCard('bob-card'));

    const amy = (await footprint(t, ticked.id)).order.customer_id!;
    const bob = (await footprint(t, unticked.id)).order.customer_id!;
    const consent = await t.db.selectFrom('consents').selectAll().where('customer_id', '=', amy).where('purpose', '=', 'card_recognition').executeTakeFirstOrThrow();
    expect(consent).toMatchObject({ status: 'granted', source: 'checkout', source_detail: `order ${ticked.reference}` });
    expect(consent.wording_version).toBeTruthy();

    const amyCards = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('customer_id', '=', amy).where('kind', 'in', ['card_fingerprint', 'card_par']).execute();
    expect(amyCards).toHaveLength(1);
    expect(amyCards[0]!.value).toMatch(/^[0-9a-f]{64}$/);
    expect(amyCards[0]!.value).toBe(await identity.hashCardIdentifier(t.app, diner().orgId, 'card_fingerprint', 'sim-fp-amy-card'));
    const bobCards = await t.db.selectFrom('customer_identities').select('kind').where('customer_id', '=', bob).where('kind', 'in', ['card_fingerprint', 'card_par']).execute();
    expect(bobCards).toHaveLength(0);

    // The processor's payload carried a fingerprint and an account reference. Neither survives anywhere.
    const leaks = await sql<{ n: number }>`
      select (select count(*) from payments where raw::text ~ 'sim-fp-|sim-par-|fingerprint|payment_account_reference')
           + (select count(*) from transactions where source = 'online-order' and raw::text ~ 'sim-fp-|sim-par-|fingerprint|payment_account_reference')
           + (select count(*) from side_effects where result::text ~ 'sim-fp-|sim-par-|fingerprint|payment_account_reference')
           + (select count(*) from customer_identities where value ~ 'sim-fp-|sim-par-')
           + (select count(*) from events where properties::text ~ 'sim-fp-|sim-par-')
           + (select count(*) from audit_log where coalesce(before::text, '') || coalesce(after::text, '') ~ 'sim-fp-|sim-par-')
           + (select count(*) from jobs where payload::text ~ 'sim-fp-|sim-par-') as n`.execute(t.db);
    expect(Number(leaks.rows[0]!.n)).toBe(0);
    const kept = await t.db.selectFrom('payments').select(['raw', 'card_last4']).where('order_id', '=', ticked.id).executeTakeFirstOrThrow();
    expect(JSON.stringify(kept.raw)).toContain('card_brand');
    expect(kept.card_last4).toMatch(/^\d{4}$/);
    const view = await pay(t, diner(), ticked, okCard('amy-card'));
    expect(JSON.stringify(view)).not.toMatch(/sim-fp-|sim-par-/);
  });

  it('marketing boxes are recorded with the wording shown, only for the guest who ticked them', async () => {
    const wording = await t.app.tenant(diner().orgId, anon(), (ctx) => identity.currentWording(ctx, 'marketing_email'));
    const order = await placeOrder(t, diner(), venueId(), {
      customer: { name: 'Mia Marketing', email: 'mia@example.com', phone: '0412 345 678' },
      consents: [{ purpose: 'marketing_email', wordingVersion: wording.version }, { purpose: 'marketing_sms' }],
    });
    const customerId = order.customerId!;
    const rows = await t.db.selectFrom('consents').select(['purpose', 'status', 'wording_version', 'source']).where('customer_id', '=', customerId).orderBy('purpose').execute();
    expect(rows).toEqual([
      { purpose: 'marketing_email', status: 'granted', wording_version: wording.version, source: 'checkout' },
      { purpose: 'marketing_sms', status: 'granted', wording_version: expect.any(String), source: 'checkout' },
    ]);
    const log = await t.db.selectFrom('consent_events').select('purpose').where('customer_id', '=', customerId).execute();
    expect(log).toHaveLength(2);

    // A version the page could not have shown is refused, and so is a box with nobody to attach it to.
    await expect(placeOrder(t, diner(), venueId(), { consents: [{ purpose: 'marketing_email', wordingVersion: 'made-up-v9' }] })).rejects.toMatchObject({ code: 'invalid' });
    await expect(placeOrder(t, diner(), venueId(), { customer: { name: 'No Phone', email: 'nophone@example.com' }, consents: [{ purpose: 'marketing_sms' }] })).rejects.toMatchObject({ code: 'invalid' });

    // Consent comes from the guest: a staff member entering an order cannot tick a box for them.
    const manager = await diner().as('manager');
    const key = `test-${randomUUID()}`;
    await expect(
      placeOrder(t, diner(), venueId(), { idempotencyKey: key, customer: { name: 'Phoned In', email: 'phoned@example.com' }, consents: [{ purpose: 'marketing_email' }] }, manager),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await t.db.selectFrom('orders').select('id').where('idempotency_key', '=', key).execute()).toHaveLength(0);
    // Without the box, the same staff member can take the order.
    const phoned = await placeOrder(t, diner(), venueId(), { customer: { name: 'Phoned In', email: 'phoned@example.com' } }, manager);
    expect(phoned.status).toBe('pending_payment');
    const history = await t.db.selectFrom('order_status_history').select(['by_kind', 'by_id']).where('order_id', '=', phoned.id).executeTakeFirstOrThrow();
    expect(history).toEqual({ by_kind: 'staff', by_id: diner().staff.manager!.staffId });
  });

  it('a new guest is stamped with what brought them in, and checkout flags are stored and passed on', async () => {
    const sessionId = randomUUID();
    await t.app.tenant(diner().orgId, anon(sessionId), (ctx) =>
      events.touchSession(ctx, { sessionId, venueId: venueId(), landingPath: '/offer', utmSource: 'criota', creatorId: 'creator_wagyu_wes', campaignId: 'camp_spring_launch' }),
    );
    const order = await placeOrder(t, diner(), venueId(), { sessionId, customer: { name: 'Nia New', email: 'nia.new@example.com' }, flags: ['loyalty_join'] });
    const customer = await t.db.selectFrom('customers').selectAll().where('id', '=', order.customerId!).executeTakeFirstOrThrow();
    expect(customer).toMatchObject({
      first_name: 'Nia',
      last_name: 'New',
      acquisition_source: 'criota',
      acquisition_creator_id: 'creator_wagyu_wes',
      acquisition_campaign_id: 'camp_spring_launch',
      acquisition_landing_path: '/offer',
      first_seen_venue_id: venueId(),
    });
    const session = await t.db.selectFrom('visitor_sessions').select('customer_id').where('id', '=', sessionId).executeTakeFirstOrThrow();
    expect(session.customer_id).toBe(order.customerId);
    const row = await t.db.selectFrom('orders').select(['flags', 'session_id']).where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ flags: ['loyalty_join'], session_id: sessionId });

    await pay(t, diner(), order);
    expect(statusSeen.filter((s) => s.orderId === order.id).map((s) => s.flags)).toEqual([['loyalty_join'], ['loyalty_join']]);
    // The sale is attributed to the creator through the customer's first touch.
    const attribution = await t.db.selectFrom('transaction_attributions').select(['creator_id', 'model']).where('transaction_id', '=', (await footprint(t, order.id)).order.transaction_id!).execute();
    expect(attribution).toEqual([{ creator_id: 'creator_wagyu_wes', model: 'acquisition' }]);
  });

  it('a code is priced by its adjuster, committed once when the order is paid, and never on a declined card', async () => {
    const m = await menuOf(t, diner(), venueId());
    const burger = m.byName('Cheeseburger');
    const order = await placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: burger.id, qty: 1 }], codes: ['tenoff'] });
    expect(order).toMatchObject({ subtotalCents: 2600, discountCents: 1000, totalCents: 1600, taxCents: 145 });
    expect(order.adjustments).toEqual([{ adjuster: 'test-promo', code: 'TENOFF', label: 'Test promo: $10 off', amountCents: 1000 }]);

    await pay(t, diner(), order, SIM_PAY_TOKENS.decline);
    expect(adjuster.committed.filter((c) => c.orderId === order.id)).toHaveLength(0);

    const card = okCard();
    await pay(t, diner(), order, card);
    await pay(t, diner(), order, card);
    const f = await footprint(t, order.id);
    expect(adjuster.committed.filter((c) => c.orderId === order.id)).toEqual([{ orderId: order.id, customerId: f.order.customer_id, transactionId: f.order.transaction_id, code: 'TENOFF' }]);
    expect(f.transactions[0]).toMatchObject({ subtotal_cents: 2600, discount_cents: 1000, total_cents: 1600 });
    expect(t.sim.payment.captured().find((c) => c.reference === order.reference)!.amountCents).toBe(1600);

    await expect(placeOrder(t, diner(), venueId(), { codes: ['SPENT'] })).rejects.toMatchObject({ code: 'invalid', message: 'That code has already been used.' });
    await expect(placeOrder(t, diner(), venueId(), { codes: ['NOSUCHCODE'] })).rejects.toMatchObject({ code: 'invalid', message: 'That code is not valid.' });
  });

  it('an order a code covers in full is paid without a card and still reaches the ledger and the kitchen', async () => {
    const order = await placeOrder(t, diner(), venueId(), { codes: ['HUGE'] });
    expect(order).toMatchObject({ subtotalCents: 1100, discountCents: 1100, totalCents: 0 });
    const before = t.sim.payment.charges.length;
    const paid = await ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon() }, { trackingToken: order.trackingToken! });
    expect(paid.status).toBe('paid');
    expect(t.sim.payment.charges.length).toBe(before);
    const f = await footprint(t, order.id);
    expect(f.payments[0]).toMatchObject({ provider: 'none', amount_cents: 0, status: 'completed' });
    expect(f.transactions[0]).toMatchObject({ total_cents: 0, discount_cents: 1100, tender_type: 'none' });
    expect(f.tickets).toHaveLength(1);
  });

  it('an id from another org is not found: items, orders and tracking tokens', async () => {
    const group = t.fixture.group;
    const dinerItem = (await menuOf(t, diner(), venueId())).plain();
    const dinerOrder = await placeOrder(t, diner(), venueId());
    const groupVenue = group.venues.cbd!.id;

    // The diner's item in a cart at the group's venue.
    await expect(t.app.tenant(group.orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: groupVenue, lines: [{ menuItemId: dinerItem.id, qty: 1 }] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(placeOrder(t, group, groupVenue, { lines: [{ menuItemId: dinerItem.id, qty: 1 }] })).rejects.toMatchObject({ code: 'not_found' });
    // The diner's venue, asked for on the group's host.
    await expect(placeOrder(t, group, venueId())).rejects.toMatchObject({ code: 'not_found' });

    // The diner's order, from inside the group.
    const groupOwner = await group.as('owner');
    await expect(t.app.tenant(group.orgId, groupOwner, (ctx) => ordering.getOrder(ctx, dinerOrder.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, groupOwner, (ctx) => ordering.updateOrderStatus(ctx, { orderId: dinerOrder.id, status: 'accepted' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, anon(), (ctx) => ordering.trackOrder(ctx, dinerOrder.trackingToken!))).rejects.toMatchObject({ code: 'not_found' });
    await expect(ordering.payOrder(t.app, { orgId: group.orgId, principal: anon() }, { trackingToken: dinerOrder.trackingToken!, sourceToken: okCard() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(ordering.refundOrder(t.app, { orgId: group.orgId, principal: groupOwner }, { orderId: dinerOrder.id, reason: 'not mine', idempotencyKey: 'cross-org-1' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await footprint(t, dinerOrder.id)).order.status).toBe('pending_payment');

    // An order id is not a way in for a guest either: only the tracking token is.
    await expect(ordering.payOrder(t.app, { orgId: diner().orgId, principal: anon() }, { orderId: dinerOrder.id, sourceToken: okCard() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner().orgId, anon(), (ctx) => ordering.trackOrder(ctx, 'x'.repeat(32)))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('with the module switched off, ordering does not exist at that venue, and its data is untouched', async () => {
    const group = t.fixture.group;
    const venue = group.venues.newtown!.id;
    const existing = await placeOrder(t, group, venue);
    await t.app.tenant(group.orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venue, enabled: false }));

    const fries = (await menuOf(t, group, venue)).plain();
    const owner = await group.as('owner');
    const gone = { code: 'module_disabled', status: 404 };
    await expect(t.app.tenant(group.orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venue, lines: [{ menuItemId: fries.id, qty: 1 }] }))).rejects.toMatchObject(gone);
    await expect(t.app.tenant(group.orgId, anon(), (ctx) => ordering.getPickupSlots(ctx, { venueId: venue }))).rejects.toMatchObject(gone);
    await expect(placeOrder(t, group, venue)).rejects.toMatchObject(gone);
    await expect(t.app.tenant(group.orgId, anon(), (ctx) => ordering.trackOrder(ctx, existing.trackingToken!))).rejects.toMatchObject(gone);
    await expect(ordering.payOrder(t.app, { orgId: group.orgId, principal: anon() }, { trackingToken: existing.trackingToken!, sourceToken: okCard() })).rejects.toMatchObject(gone);
    await expect(t.app.tenant(group.orgId, owner, (ctx) => ordering.listOrders(ctx, { venueId: venue }))).rejects.toMatchObject(gone);
    await expect(t.app.tenant(group.orgId, owner, (ctx) => ordering.listLiveTickets(ctx, { venueId: venue }))).rejects.toMatchObject(gone);
    await expect(ordering.getCheckoutOptions(t.app, { orgId: group.orgId, principal: anon() }, venue)).rejects.toMatchObject(gone);
    expect(t.sim.payment.charges.filter((c) => c.reference === existing.reference)).toHaveLength(0);

    // Hidden, not deleted: switching it back on finds the order where it was.
    await t.app.tenant(group.orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venue, enabled: true }));
    const tracked = await t.app.tenant(group.orgId, anon(), (ctx) => ordering.trackOrder(ctx, existing.trackingToken!));
    expect(tracked).toMatchObject({ reference: existing.reference, status: 'pending_payment', awaitingPayment: true });
    // The other venues of the group were never affected.
    expect((await placeOrder(t, group, group.venues.cbd!.id)).status).toBe('pending_payment');
  });

  it('a signed-in guest orders as themself, and only they or the token holder can pay for it', async () => {
    const first = await placeOrder(t, diner(), venueId(), { customer: { name: 'Gus Guest', email: 'gus.guest@example.com', phone: '0400 123 123' } });
    const gus = { kind: 'guest' as const, customerId: first.customerId! };
    // No contact typed this time: the order is theirs, and the kitchen can still reach them.
    const order = await placeOrder(t, diner(), venueId(), { customer: {} }, gus);
    expect(order).toMatchObject({ customerId: first.customerId, customerName: 'Gus Guest', customerEmail: 'gus.guest@example.com', customerPhone: '+61400123123' });

    const stranger = { kind: 'guest' as const, customerId: (await placeOrder(t, diner(), venueId())).customerId! };
    await expect(ordering.payOrder(t.app, { orgId: diner().orgId, principal: stranger }, { orderId: order.id, sourceToken: okCard() })).rejects.toMatchObject({ code: 'not_found' });
    expect(t.sim.payment.charges.filter((c) => c.reference === order.reference)).toHaveLength(0);
    const paid = await ordering.payOrder(t.app, { orgId: diner().orgId, principal: gus }, { orderId: order.id, sourceToken: okCard() });
    expect(paid.status).toBe('paid');
    expect((await footprint(t, order.id)).transactions[0]!.customer_id).toBe(first.customerId);
    // A guest principal for a customer that does not exist here cannot order.
    await expect(placeOrder(t, diner(), venueId(), { customer: {} }, { kind: 'guest', customerId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
    // A kitchen screen is not a way to place orders.
    await expect(placeOrder(t, diner(), venueId(), {}, { kind: 'device', deviceId: randomUUID(), venueId: venueId(), purpose: 'kitchen' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('the browser may send the cart and checkout funnel events, and nothing that only the server can know', async () => {
    const sessionId = randomUUID();
    const fries = (await menuOf(t, diner(), venueId())).plain();
    const result = await t.app.tenant(diner().orgId, anon(sessionId), async (ctx) => {
      await events.touchSession(ctx, { sessionId, venueId: venueId(), landingPath: '/menu' });
      return events.collect(ctx, {
        sessionId,
        venueId: venueId(),
        events: [
          { name: 'cart.item_added', properties: { menu_item_id: fries.id, name: fries.name, qty: 2 } },
          { name: 'checkout.started', properties: { channel: 'pickup', item_count: 2 } },
          { name: 'cart.item_removed', properties: { menu_item_id: fries.id, name: fries.name } },
          // Forged: a browser claiming an order was paid, and a malformed cart event.
          { name: 'order.paid', properties: { order_id: randomUUID(), channel: 'pickup', total_cents: 1, discount_cents: 0, tip_cents: 0, identified: false } },
          { name: 'order.refunded', properties: { order_id: randomUUID(), channel: 'pickup', refunded_cents: 99999, full: true } },
          { name: 'cart.item_added', properties: { menu_item_id: 'not-a-uuid', name: 'x', qty: 1 } },
        ],
      });
    });
    expect(result).toEqual({ accepted: 3, dropped: 3 });
    const stored = await t.db.selectFrom('events').select(['name', 'source']).where('session_id', '=', sessionId).where('name', '!=', 'session.started').execute();
    expect(stored.map((e) => e.name).sort()).toEqual(['cart.item_added', 'cart.item_removed', 'checkout.started']);
    expect(stored.every((e) => e.source === 'web')).toBe(true);
    // The order funnel is declared end to end.
    const funnel = events.eventDictionary().filter((e) => e.funnel?.name === 'order').sort((a, b) => a.funnel!.step - b.funnel!.step);
    expect(funnel.map((e) => `${e.funnel!.step} ${e.name} ${e.sent_by}`)).toEqual([
      '1 session.started server',
      '2 menu.viewed browser',
      '3 cart.item_added browser',
      '4 checkout.started browser',
      '5 order.placed server',
      '6 order.paid server',
      '7 order.ready server',
      '8 order.completed server',
    ]);
  });

  it('checkout is rate limited per device', async () => {
    const opts = { ip: '203.0.113.77' };
    const attempt = () =>
      t.app.tenant(diner().orgId, anon(), (ctx) => ordering.createOrder(ctx, { venueId: venueId(), lines: [{ menuItemId: randomUUID(), qty: 1 }], idempotencyKey: `test-${randomUUID()}`, customer: { name: 'Bot', email: 'bot@example.com' } }), opts);
    // Twenty attempts from one address in ten minutes are heard out (and fail on their own merits); the next is turned away.
    for (let i = 0; i < 20; i++) await expect(attempt()).rejects.toMatchObject({ code: 'not_found' });
    await expect(attempt()).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
    // Another device is unaffected.
    expect((await placeOrder(t, diner(), venueId())).status).toBe('pending_payment');
  });

  it('a delivery order adds the fee the delivery module quoted, and ties the quote to the order', async () => {
    const quotes = new Map<string, { venueId: string; customerFeeCents: number; expiresAt: Date }>();
    const attached: Array<{ deliveryId: string; orderId: string }> = [];
    ordering.registerDeliveryPricing({
      async getQuote(_ctx, { deliveryId, venueId: v }) {
        const q = quotes.get(deliveryId);
        return q && q.venueId === v ? { customerFeeCents: q.customerFeeCents, expiresAt: q.expiresAt, dropoffEta: null } : null;
      },
      async attachToOrder(_ctx, args) {
        attached.push(args);
      },
    });
    const good = randomUUID();
    const stale = randomUUID();
    const elsewhere = randomUUID();
    quotes.set(good, { venueId: venueId(), customerFeeCents: 700, expiresAt: new Date('2026-10-01T08:10:00.000Z') });
    quotes.set(stale, { venueId: venueId(), customerFeeCents: 700, expiresAt: new Date('2026-10-01T07:59:00.000Z') });
    quotes.set(elsewhere, { venueId: t.fixture.group.venues.cbd!.id, customerFeeCents: 100, expiresAt: new Date('2026-10-01T08:10:00.000Z') });
    const burger = (await menuOf(t, diner(), venueId())).byName('Cheeseburger');
    const lines = [{ menuItemId: burger.id, qty: 1 }];
    const price = (deliveryId?: string) => t.app.tenant(diner().orgId, anon(), (ctx) => ordering.priceCart(ctx, { venueId: venueId(), channel: 'delivery', deliveryId, lines }));

    const cart = await price(good);
    // The fee is the quote's, never the browser's, and the tax is on the lot.
    expect(cart).toMatchObject({ subtotalCents: 2600, deliveryFeeCents: 700, totalCents: 3300, taxCents: 300, orderable: true });
    expect((await price(stale)).issues.map((i) => i.code)).toEqual(['delivery']);
    expect((await price(elsewhere)).issues.map((i) => i.code)).toEqual(['delivery']);
    await expect(price()).rejects.toMatchObject({ code: 'module_disabled' });
    await expect(placeOrder(t, diner(), venueId(), { channel: 'delivery', deliveryId: stale, lines })).rejects.toMatchObject({ code: 'invalid' });
    expect(attached).toHaveLength(0);

    const order = await placeOrder(t, diner(), venueId(), { channel: 'delivery', deliveryId: good, lines, ...({ deliveryFeeCents: 0 } as object) });
    expect(order).toMatchObject({ channel: 'delivery', deliveryFeeCents: 700, totalCents: 3300 });
    expect(attached).toEqual([{ deliveryId: good, orderId: order.id }]);
    await pay(t, diner(), order);
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ channel: 'delivery', delivery_fee_cents: 700, status: 'placed' });
    expect(f.transactions[0]).toMatchObject({ channel: 'delivery', total_cents: 3300, subtotal_cents: 2600 });
    expect(t.sim.payment.captured().find((c) => c.reference === order.reference)!.amountCents).toBe(3300);
    expect(statusSeen.filter((s) => s.orderId === order.id).map((s) => s.to)).toEqual(['pending_payment', 'placed']);
  });

  it('the checkout page gets the processor\'s client settings and the consent wordings, never a secret', async () => {
    const options = await ordering.getCheckoutOptions(t.app, { orgId: diner().orgId, principal: anon() }, venueId());
    expect(options.payment).toEqual({ provider: 'sim', applicationId: 'sim-app', locationRef: 'simloc-main', environment: 'sandbox' });
    expect(options.consentWordings.map((w) => w.purpose).sort()).toEqual(['ad_platform_sharing', 'card_recognition', 'marketing_email', 'marketing_sms']);
    expect(JSON.stringify(options)).not.toContain('sim-pay-oak-diner-main');
  });
});
