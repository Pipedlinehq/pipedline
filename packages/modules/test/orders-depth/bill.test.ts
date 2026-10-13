import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type Principal, drainJobs, setModule, taxIncluded } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { menu, offers, ordering } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, pay, placeOrder } from '../commerce/helpers';
import { quote as deliveryQuote } from '../commerce-2/helpers';
import { guestOf, newGuest, unique } from '../guests-offers/helpers';

/**
 * The bill (docs/CONSOLE_IA.md section 9, pattern 6 and pattern 12 meeting ordering): each line
 * priced on the order's own menu channel; the offers that apply by themselves and the codes a
 * guest types, checked by the offers module's rules and combined only when both sides allow it;
 * the surcharges in force for the day the order is for, as their own line with the legal notice;
 * the server's total standing whatever the browser sent; the quote and the final total agreeing
 * unless something changed in between. Every write is read back from the rows.
 *
 * Sydney moves to daylight time on Sunday 4 October 2026 at 02:00. The fixture venues serve lunch
 * Tuesday to Sunday 12:00–15:00 and dinner Tuesday to Saturday 17:30–22:00 (packages/fixtures/src/base.ts).
 */

/** Sunday 4 October 2026, 13:30 in Sydney (AEDT): lunch service. */
const SUNDAY_LUNCH = '2026-10-04T02:30:00.000Z';
/** Monday 5 October 2026, 13:30 in Sydney: the venue is closed on Mondays. */
const MONDAY_LUNCH = '2026-10-05T02:30:00.000Z';
/** Tuesday 6 October 2026, 19:00 in Sydney: dinner service. */
const TUESDAY_DINNER = '2026-10-06T08:00:00.000Z';
/** Saturday 3 October 2026, 19:00 in Sydney (AEST, before the change). */
const SATURDAY_DINNER = '2026-10-03T09:00:00.000Z';

const SUNDAY_NOTICE = 'A surcharge of 10% applies on Sundays.';
const GST = 1000;

describe('the bill: channel prices, offers and surcharges on totals', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const manager = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('manager'), fn);
  const host = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('host'), fn);
  const price = (input: Parameters<typeof ordering.priceCart>[1], principal: Principal = anon()) => t.app.tenant(diner().orgId, principal, (ctx) => ordering.priceCart(ctx, input));
  const saveOffer = (input: offers.OfferInput) => manager((ctx) => offers.saveOffer(ctx, input));
  const switchOff = (id: string) => manager((ctx) => offers.switchOffer(ctx, id, false));
  const issue = async (offerId: string, customerId: string) => (await t.app.tenant(diner().orgId, WORKER, (ctx) => offers.issueCode(ctx, { offerId, customerId, source: 'staff' }))).code.code;
  const uses = (offerId: string) => t.db.selectFrom('offer_uses').select(['order_id', 'transaction_id', 'customer_id', 'discount_cents', 'released_at']).where('offer_id', '=', offerId).orderBy('created_at').execute();
  const audits = (orderId: string, action: string) => t.db.selectFrom('audit_log').select(['action', 'after', 'actor_kind']).where('entity_type', '=', 'order').where('entity_id', '=', orderId).where('action', '=', action).execute();
  const burgerLine = async () => [{ menuItemId: (await menuOf(t, diner(), venueId())).byName('Cheeseburger').id, qty: 1 }];
  const automatic = (over: Partial<offers.OfferInput>) => saveOffer({ kind: 'manual', name: unique('Auto'), method: 'automatic', discountKind: 'fixed', valueCents: 1000, requiresClaim: false, ...over });

  /** Tests share one database: no automatic offer or surcharge an earlier test made is left on. */
  afterEach(async () => {
    const on = await manager((ctx) => offers.listOffers(ctx, { method: 'automatic' }));
    for (const o of on) await switchOff(o.id);
    for (const s of await manager((ctx) => offers.listSurcharges(ctx, { includeInactive: true }))) await manager((ctx) => offers.deleteSurcharge(ctx, s.id));
  });

  it('each line is priced on the order\'s own channel: the delivery price for a delivery, the pickup price for a pickup; an item hidden from Pickup cannot be ordered for pickup but can for delivery', async () => {
    t.clock.set(QUIET_EVENING);
    const barra = (await menuOf(t, diner(), venueId())).byName('Barramundi');
    expect(barra.priceCents).toBe(3800);
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'delivery', priceCents: 4300 }));
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'pickup', priceCents: 3600 }));
    const line = [{ menuItemId: barra.id, qty: 1 }];

    const pickup = await price({ venueId: venueId(), lines: line });
    expect(pickup.lines[0]).toMatchObject({ name: 'Barramundi, fennel, lemon', unitPriceCents: 3600, lineTotalCents: 3600 });
    expect(pickup).toMatchObject({ subtotalCents: 3600, totalCents: 3600, surcharges: [], adjustments: [] });
    const q = await deliveryQuote(t, diner(), venueId(), { subtotalCents: 4300 });
    const delivery = await price({ venueId: venueId(), channel: 'delivery', deliveryId: q.deliveryId, lines: line });
    expect(delivery.lines[0]).toMatchObject({ unitPriceCents: 4300, lineTotalCents: 4300 });
    expect(delivery.subtotalCents).toBe(4300);
    expect(delivery.totalCents).toBe(4300 + delivery.deliveryFeeCents);
    // The website's own menu still shows the item's own price; the delivery menu its own.
    expect((await menuOf(t, diner(), venueId())).byName('Barramundi').priceCents).toBe(3800);
    expect((await menuOf(t, diner(), venueId(), 'delivery')).byName('Barramundi').priceCents).toBe(4300);

    // A placed pickup order freezes the pickup price onto its line; a phone order is priced the same way.
    const order = await placeOrder(t, diner(), venueId(), { lines: line });
    expect(order.items[0]).toMatchObject({ unitPriceCents: 3600, lineTotalCents: 3600 });
    expect(order).toMatchObject({ subtotalCents: 3600, totalCents: 3600 });
    expect(await t.db.selectFrom('order_items').select('unit_price_cents').where('order_id', '=', order.id).execute()).toEqual([{ unit_price_cents: 3600 }]);
    const draft = await host((ctx) => ordering.createDraftOrder(ctx, { venueId: venueId(), lines: line, customer: { name: 'Phil Phone', phone: '0412 345 678' } }));
    expect(draft.items[0]).toMatchObject({ unitPriceCents: 3600 });

    // Hidden from Pickup: not found for a pickup, on the cart page and at checkout alike; a delivery still has it.
    await manager((ctx) => menu.setItemChannels(ctx, { itemId: barra.id, hide: ['pickup'] }));
    await expect(price({ venueId: venueId(), lines: line })).rejects.toMatchObject({ code: 'not_found' });
    await expect(placeOrder(t, diner(), venueId(), { lines: line })).rejects.toMatchObject({ code: 'not_found' });
    await expect(host((ctx) => ordering.planDraftOrder(ctx, { venueId: venueId(), lines: line, customer: { name: 'Phil Phone', phone: '0412 345 678' } }))).rejects.toMatchObject({ code: 'not_found' });
    const q2 = await deliveryQuote(t, diner(), venueId(), { subtotalCents: 4300 });
    expect((await price({ venueId: venueId(), channel: 'delivery', deliveryId: q2.deliveryId, lines: line })).lines[0]).toMatchObject({ unitPriceCents: 4300 });
    expect((await menuOf(t, diner(), venueId(), 'pickup')).all.map((i) => i.id)).not.toContain(barra.id);

    await manager((ctx) => menu.setItemChannels(ctx, { itemId: barra.id, show: ['pickup'] }));
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'delivery', priceCents: null }));
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'pickup', priceCents: null }));
    expect((await price({ venueId: venueId(), lines: line })).lines[0]!.unitPriceCents).toBe(3800);
  });

  it('an automatic offer comes off the total as its own line with its plain-words summary; paid, it is one use with the sale attributed, audited, and not two on replay', async () => {
    t.clock.set(QUIET_EVENING);
    const o = await automatic({ name: unique('Ten off tonight') });
    const label = `${o.name}: $10 off, applied automatically, not with other offers`;
    const lines = await burgerLine();

    const quote = await price({ venueId: venueId(), lines });
    expect(quote.adjustments).toEqual([{ adjuster: 'offers', code: `auto:${o.id}`, label, amountCents: 1000, ref: { offerId: o.id, auto: '1' } }]);
    expect(quote).toMatchObject({ subtotalCents: 2600, discountCents: 1000, surchargeCents: 0, totalCents: 1600, taxCents: taxIncluded(1600, GST), rejectedCodes: [] });
    expect(quote.breakdown.map((l) => [l.kind, l.label, l.sign * l.amountCents])).toEqual([
      ['subtotal', 'Subtotal', 2600],
      ['adjustment', label, -1000],
      ['total', 'Total', 1600],
      ['tax', 'Includes GST of', taxIncluded(1600, GST)],
    ]);
    // Typing the automatic offer's own code gives nothing extra: it is not a code.
    const typed = await price({ venueId: venueId(), lines, codes: [`auto:${o.id}`] });
    expect(typed.rejectedCodes).toEqual([{ code: `auto:${o.id}`, reason: 'That code is not valid.' }]);
    expect(typed.adjustments).toHaveLength(1);

    const order = await placeOrder(t, diner(), venueId(), { lines });
    expect(order).toMatchObject({ subtotalCents: 2600, discountCents: 1000, totalCents: 1600 });
    expect(order.adjustments).toEqual([{ adjuster: 'offers', code: `auto:${o.id}`, label, amountCents: 1000, automatic: true }]);
    expect(order.breakdown.find((l) => l.kind === 'adjustment')).toMatchObject({ label, amountCents: 1000, sign: -1 });
    const row = await t.db.selectFrom('orders').select(['promo_code', 'discount_cents', 'adjustments']).where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(row.promo_code).toBeNull(); // the typed-code column stays for typed codes
    expect(row.adjustments).toMatchObject([{ code: `auto:${o.id}`, amountCents: 1000 }]);
    // Nothing is a use until it is paid.
    expect(await uses(o.id)).toEqual([]);
    expect(await audits(order.id, 'order.offer_applied')).toEqual([]);

    const card = okCard();
    const paid = await pay(t, diner(), order, card);
    expect(paid.status).toBe('paid');
    const f = await footprint(t, order.id);
    expect(f.payments.map((p) => [p.status, p.amount_cents])).toEqual([['completed', 1600]]);
    expect(f.transactions[0]).toMatchObject({ total_cents: 1600, discount_cents: 1000, subtotal_cents: 2600 });
    expect(await uses(o.id)).toEqual([{ order_id: order.id, transaction_id: f.order.transaction_id, customer_id: f.order.customer_id, discount_cents: 1000, released_at: null }]);
    const audited = await audits(order.id, 'order.offer_applied');
    expect(audited).toHaveLength(1);
    expect(audited[0]!.after).toMatchObject({ reference: order.reference, code: `auto:${o.id}`, label, amountCents: 1000, automatic: true, offerId: o.id, transactionId: f.order.transaction_id });
    const applied = await t.db.selectFrom('events').select(['properties']).where('name', '=', 'offer.applied').where(sql<boolean>`properties->>'offer_id' = ${o.id}`).execute();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.properties).toMatchObject({ via: 'online', discount_cents: 1000 });

    // The same card again is the same payment: one use, one audit row, one sale.
    const again = await pay(t, diner(), order, card);
    expect(again).toMatchObject({ status: 'paid', replayed: true });
    expect(await uses(o.id)).toHaveLength(1);
    expect(await audits(order.id, 'order.offer_applied')).toHaveLength(1);
    expect((await footprint(t, order.id)).transactions).toHaveLength(1);

    // The guest's tracking page, the console and the kitchen docket all carry the line.
    const tracked = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.trackOrder(ctx, order.trackingToken!));
    expect(tracked.adjustments).toEqual([{ label, amountCents: 1000, automatic: true }]);
    expect(tracked.breakdown.map((l) => l.kind)).toEqual(['subtotal', 'adjustment', 'total', 'tax']);
    const console = await manager((ctx) => ordering.getOrder(ctx, order.id));
    expect(console.adjustments[0]).toMatchObject({ label, automatic: true });
    const board = await t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.listLiveTickets(ctx, { venueId: venueId() }));
    const ticket = board.tickets.find((x) => x.orderId === order.id)!;
    expect(ticket.bill.filter((l) => l.kind === 'adjustment')).toEqual([{ kind: 'adjustment', label, amountCents: 1000, sign: -1, code: `auto:${o.id}` }]);
    expect(ticket.currency).toBe('AUD');
  });

  it('a typed code is checked by the offer\'s own rules; two codes sit together only when each allows the other; an automatic offer with a per-guest limit is counted per guest', async () => {
    t.clock.set(QUIET_EVENING);
    const g = await newGuest(t, diner());
    const guest = guestOf(g.customerId);
    const lines = await burgerLine();
    const billInput: offers.OfferInput = { kind: 'manual', name: unique('Bill five'), discountKind: 'fixed', valueCents: 500, requiresClaim: false, codePrefix: 'BILL' };
    const mainsInput: offers.OfferInput = { kind: 'manual', name: unique('Mains three'), discountKind: 'fixed', valueCents: 300, appliesTo: 'category', category: 'Mains', requiresClaim: false, codePrefix: 'MAIN' };
    const bill = await saveOffer(billInput);
    const mains = await saveOffer(mainsInput);
    const codeBill = await issue(bill.id, g.customerId);
    const codeMains = await issue(mains.id, g.customerId);

    // Neither allows the other: the first code stands, the second is refused with the reason.
    const clash = await price({ venueId: venueId(), lines, codes: [codeBill, codeMains] }, guest);
    expect(clash.adjustments.map((a) => [a.code, a.amountCents])).toEqual([[codeBill, 500]]);
    expect(clash.rejectedCodes).toEqual([{ code: codeMains, reason: `That offer cannot be used together with ${bill.name}.` }]);
    expect(clash.totalCents).toBe(2100);
    await expect(placeOrder(t, diner(), venueId(), { lines, codes: [codeBill, codeMains], customer: {} }, guest)).rejects.toMatchObject({ code: 'invalid', message: `That offer cannot be used together with ${bill.name}.` });
    expect(await t.db.selectFrom('orders').select('id').where('customer_id', '=', g.customerId).execute()).toEqual([]);

    // Each allows the other's class: both come off, each its own line.
    await saveOffer({ ...billInput, id: bill.id, combineItem: true });
    await saveOffer({ ...mainsInput, id: mains.id, combineBill: true });
    const together = await price({ venueId: venueId(), lines, codes: [codeBill, codeMains] }, guest);
    expect(together.adjustments.map((a) => [a.code, a.amountCents])).toEqual([
      [codeBill, 500],
      [codeMains, 300],
    ]);
    expect(together).toMatchObject({ discountCents: 800, totalCents: 1800, rejectedCodes: [] });
    expect(together.breakdown.filter((l) => l.kind === 'adjustment').map((l) => l.code)).toEqual([codeBill, codeMains]);

    // A code whose offer is not on today (Sunday only, on a Thursday) is refused with the offer's words.
    const sunday = await saveOffer({ kind: 'manual', name: unique('Sunday roast'), discountKind: 'percent', percentOff: 10, requiresClaim: false, days: [0], codePrefix: 'SUN' });
    const codeSun = await issue(sunday.id, g.customerId);
    expect((await price({ venueId: venueId(), lines, codes: [codeSun] }, guest)).rejectedCodes).toEqual([{ code: codeSun, reason: 'That offer is not on Thursdays.' }]);

    // An automatic offer one per guest: this guest has it once, then not again; another guest still does.
    const once = await automatic({ name: unique('Once each'), valueCents: 200, perGuestLimit: 1 });
    const first = await placeOrder(t, diner(), venueId(), { lines, customer: {} }, guest);
    expect(first.adjustments.map((a) => a.code)).toEqual([`auto:${once.id}`]);
    expect(first.customerId).toBe(g.customerId);
    expect((await pay(t, diner(), first)).status).toBe('paid');
    expect(await uses(once.id)).toMatchObject([{ order_id: first.id, customer_id: g.customerId, discount_cents: 200 }]);
    const second = await placeOrder(t, diner(), venueId(), { lines, customer: {} }, guest);
    expect(second.adjustments).toEqual([]);
    expect(second.totalCents).toBe(2600);
    // The same person ordering anonymously with their email is still that guest.
    const byEmail = await placeOrder(t, diner(), venueId(), { lines, customer: { name: 'Ava Tester', email: g.email } });
    expect(byEmail.customerId).toBe(g.customerId);
    expect(byEmail.adjustments).toEqual([]);
    const other = await placeOrder(t, diner(), venueId(), { lines });
    expect(other.adjustments.map((a) => a.code)).toEqual([`auto:${once.id}`]);
  });

  it('a Sunday surcharge is on a Sunday order as its own line with the legal notice, on the quote, the order, the docket, the receipt and the till push, and not on a Monday or a Tuesday one', async () => {
    const s = await manager((ctx) => offers.saveSurcharge(ctx, { venueId: venueId(), name: 'Sunday surcharge', kind: 'sunday', percent: 10 }));
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venueId(), config: { kitchen_routing: ['screen', 'email'], kitchen_email: 'pass@oak-diner.example' } }));
    const lines = await burgerLine();
    const applied = { id: s.id, name: 'Sunday surcharge', percentBp: 1000, reason: 'Sunday', notice: SUNDAY_NOTICE, amountCents: 260 };

    t.clock.set(SUNDAY_LUNCH);
    const quote = await price({ venueId: venueId(), lines });
    expect(quote.surcharges).toEqual([applied]);
    expect(quote).toMatchObject({ subtotalCents: 2600, discountCents: 0, surchargeCents: 260, totalCents: 2860, taxCents: taxIncluded(2860, GST), surchargeNotices: [SUNDAY_NOTICE], orderable: true });
    expect(quote.breakdown.map((l) => [l.kind, l.label, l.sign * l.amountCents, l.notice ?? null])).toEqual([
      ['subtotal', 'Subtotal', 2600, null],
      ['surcharge', 'Sunday surcharge (10%, Sunday)', 260, SUNDAY_NOTICE],
      ['total', 'Total', 2860, null],
      ['tax', 'Includes GST of', taxIncluded(2860, GST), null],
    ]);
    // After discounts: a $10 offer first, then 10% of what is left.
    const o = await automatic({ name: unique('Sunday ten') });
    const discounted = await price({ venueId: venueId(), lines });
    expect(discounted).toMatchObject({ discountCents: 1000, surchargeCents: 160, totalCents: 2600 - 1000 + 160 });
    expect(discounted.breakdown.map((l) => l.kind)).toEqual(['subtotal', 'adjustment', 'surcharge', 'total', 'tax']);
    await switchOff(o.id);
    // The order page is told before anything is chosen.
    expect((await ordering.getCheckoutOptions(t.app, { orgId: diner().orgId, principal: anon() }, venueId())).surchargeNotice).toBe(SUNDAY_NOTICE);

    const order = await placeOrder(t, diner(), venueId(), { lines });
    expect(order).toMatchObject({ subtotalCents: 2600, surchargeCents: 260, totalCents: 2860, taxCents: taxIncluded(2860, GST), surchargeNotices: [SUNDAY_NOTICE] });
    expect(order.surcharges).toEqual([applied]);
    const row = await t.db.selectFrom('orders').select(['surcharge_cents', 'surcharges', 'total_cents']).where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ surcharge_cents: 260, surcharges: [applied], total_cents: 2860 });

    expect((await pay(t, diner(), order)).status).toBe('paid');
    const f = await footprint(t, order.id);
    expect(f.payments.map((p) => p.amount_cents)).toEqual([2860]);
    expect(f.transactions[0]).toMatchObject({ total_cents: 2860, subtotal_cents: 2600, discount_cents: 0 });
    // The kitchen docket: on the screen and in the kitchen's email, the line and the notice.
    const board = await t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => ordering.listLiveTickets(ctx, { venueId: venueId() }));
    const ticket = board.tickets.find((x) => x.orderId === order.id)!;
    expect(ticket.bill.find((l) => l.kind === 'surcharge')).toEqual({ kind: 'surcharge', label: 'Sunday surcharge (10%, Sunday)', amountCents: 260, sign: 1, notice: SUNDAY_NOTICE });
    await drainJobs(t.app);
    const mail = t.sim.email.sent.find((x) => x.to === 'pass@oak-diner.example' && x.subject?.includes(order.reference))!;
    expect(mail.body).toContain('Sunday surcharge (10%, Sunday)  $2.60');
    expect(mail.body).toContain(SUNDAY_NOTICE);
    // The guest's receipt and the console.
    const tracked = await t.app.tenant(diner().orgId, anon(), (ctx) => ordering.trackOrder(ctx, order.trackingToken!));
    expect(tracked).toMatchObject({ surcharges: [applied], surchargeCents: 260, surchargeNotices: [SUNDAY_NOTICE], totalCents: 2860 });
    expect((await manager((ctx) => ordering.getOrder(ctx, order.id))).surcharges).toEqual([applied]);

    // A phone order built on a Sunday carries it the same way.
    const draft = await host((ctx) => ordering.createDraftOrder(ctx, { venueId: venueId(), lines, customer: { name: 'Sunny Phone', phone: '0412 000 111' } }));
    expect(draft).toMatchObject({ surchargeCents: 260, totalCents: 2860 });
    expect(draft.surcharges).toEqual([applied]);
    // A pickup ordered on Saturday for a Sunday slot is a Sunday bill: the surcharge is for the day the order is for.
    t.clock.set(SATURDAY_DINNER);
    const ahead = await price({ venueId: venueId(), lines, slotStart: '2026-10-04T02:00:00.000Z' });
    expect(ahead.surcharges).toEqual([applied]);
    expect((await price({ venueId: venueId(), lines })).surcharges).toEqual([]);

    // Monday: none (the venue is closed, so the quote carries a timing issue, and no surcharge).
    t.clock.set(MONDAY_LUNCH);
    const monday = await price({ venueId: venueId(), lines });
    expect(monday).toMatchObject({ surcharges: [], surchargeCents: 0, totalCents: 2600 });
    expect(monday.issues.map((i) => i.code)).toEqual(['timing']);
    // Tuesday dinner: an order placed and paid carries none.
    t.clock.set(TUESDAY_DINNER);
    const tuesday = await placeOrder(t, diner(), venueId(), { lines });
    expect(tuesday).toMatchObject({ surcharges: [], surchargeCents: 0, totalCents: 2600, surchargeNotices: [] });
    expect((await pay(t, diner(), tuesday)).status).toBe('paid');
    expect((await footprint(t, tuesday.id)).transactions[0]).toMatchObject({ total_cents: 2600 });

    // With the offers plugin off at the venue there is no surcharge and no notice, whatever rows exist.
    t.clock.set(SUNDAY_LUNCH);
    await manager((ctx) => setModule(ctx, offers.offersModule, { venueId: venueId(), enabled: false }));
    expect((await price({ venueId: venueId(), lines })).surcharges).toEqual([]);
    expect((await ordering.getCheckoutOptions(t.app, { orgId: diner().orgId, principal: anon() }, venueId())).surchargeNotice).toBeNull();
    await manager((ctx) => setModule(ctx, offers.offersModule, { venueId: venueId(), enabled: true }));
    expect((await price({ venueId: venueId(), lines })).surcharges).toEqual([applied]);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venueId(), config: { kitchen_routing: ['screen'], kitchen_email: null } }));
  });

  it('a total, a price, a discount or a surcharge the browser sends is ignored: the server prices everything', async () => {
    t.clock.set(QUIET_EVENING);
    const lines = await burgerLine();
    const tampered = {
      lines: [{ ...lines[0]!, unitPriceCents: 1, lineTotalCents: 1 }],
      subtotalCents: 1,
      discountCents: 2599,
      surchargeCents: -500,
      surcharges: [],
      adjustments: [{ adjuster: 'offers', code: 'FAKE', label: 'Made up', amountCents: 2599, ref: {} }],
      taxCents: 0,
      totalCents: 1,
    };
    const quote = await price({ venueId: venueId(), ...tampered } as never);
    expect(quote).toMatchObject({ subtotalCents: 2600, discountCents: 0, surchargeCents: 0, totalCents: 2600, adjustments: [], surcharges: [] });
    const order = await placeOrder(t, diner(), venueId(), tampered as never);
    expect(order).toMatchObject({ subtotalCents: 2600, discountCents: 0, surchargeCents: 0, totalCents: 2600, adjustments: [], surcharges: [] });
    expect(order.items[0]).toMatchObject({ unitPriceCents: 2600 });
    expect((await pay(t, diner(), order)).status).toBe('paid');
    const f = await footprint(t, order.id);
    expect(f.payments.map((p) => p.amount_cents)).toEqual([2600]);
    expect(f.order).toMatchObject({ total_cents: 2600, surcharge_cents: 0, discount_cents: 0 });
  });

  it('the quote and the final total agree when nothing changed, and differ correctly when an offer ended in between', async () => {
    t.clock.set(QUIET_EVENING);
    const ends = new Date(Date.parse(QUIET_EVENING) + 30 * 60_000);
    const o = await automatic({ name: unique('Happy half hour'), discountKind: 'percent', percentOff: 20, valueCents: null, endsAt: ends });
    const lines = await burgerLine();

    const quote = await price({ venueId: venueId(), lines });
    expect(quote).toMatchObject({ discountCents: 520, totalCents: 2080 });
    const same = await placeOrder(t, diner(), venueId(), { lines });
    expect(same.totalCents).toBe(quote.totalCents);
    expect(same.adjustments.map((a) => [a.code, a.amountCents])).toEqual(quote.adjustments.map((a) => [a.code, a.amountCents]));
    expect((await pay(t, diner(), same)).status).toBe('paid');
    expect((await footprint(t, same.id)).payments.map((p) => p.amount_cents)).toEqual([2080]);

    // Priced while the offer was on, placed after it ended: checkout prices afresh and the quote is not trusted.
    const stale = await price({ venueId: venueId(), lines });
    expect(stale.totalCents).toBe(2080);
    const placedBefore = await placeOrder(t, diner(), venueId(), { lines });
    expect(placedBefore.totalCents).toBe(2080);
    t.clock.advanceMinutes(31);
    const later = await placeOrder(t, diner(), venueId(), { lines });
    expect(later).toMatchObject({ totalCents: 2600, discountCents: 0, adjustments: [] });
    expect((await price({ venueId: venueId(), lines })).totalCents).toBe(2600);
    // An order placed with the offer and paid a few minutes after it ended keeps the price the guest was shown, and its use is recorded.
    expect((await pay(t, diner(), placedBefore)).status).toBe('paid');
    expect((await footprint(t, placedBefore.id)).payments.map((p) => p.amount_cents)).toEqual([2080]);
    expect((await uses(o.id)).map((u) => u.order_id)).toEqual([same.id, placedBefore.id]);
  });
});
