import { beforeAll, describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { menu, ordering } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, pay, placeOrder, registerTestAdjuster } from './helpers';

registerTestAdjuster();

describe('cart pricing', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const price = (input: Parameters<typeof ordering.priceCart>[1], org = diner()) => t.app.tenant(org.orgId, anon(), (ctx) => ordering.priceCart(ctx, input));
  const config = (venue: string, org: typeof t.fixture.diner, cfg: Partial<ordering.OrderingConfig>) =>
    t.app.tenant(org.orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: venue, config: cfg }));
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('prices items, modifiers and quantities from the menu, with the tax the org\'s settings say', async () => {
    const m = await menuOf(t, diner(), venueId());
    const rump = m.byName('Wagyu rump');
    const coffee = m.byName('Flat white');
    const lines = [
      { menuItemId: rump.id, qty: 2, modifierIds: [m.modifier(rump, 'Cook temperature', 'Rare'), m.modifier(rump, 'Choose a side', 'Truffle fries')] },
      { menuItemId: coffee.id, qty: 1, modifierIds: [m.modifier(coffee, 'Milk', 'Oat')], note: '  extra hot  ' },
    ];
    const cart = await price({ venueId: venueId(), lines });
    expect(cart.lines.map((l) => [l.name, l.qty, l.unitPriceCents, l.lineTotalCents])).toEqual([
      ['Wagyu rump 250g', 2, 5100, 10200],
      ['Flat white', 1, 580, 580],
    ]);
    expect(cart.lines[1]).toMatchObject({ note: 'extra hot', category: 'Drinks', allergens: ['milk'] });
    expect(cart.lines[0]!.modifiers.map((x) => `${x.group}: ${x.name} +${x.priceDeltaCents}`)).toEqual(['Cook temperature: Rare +0', 'Choose a side: Truffle fries +300']);
    // Australia: prices include GST, so the tax is the part of the total that is tax.
    expect(cart).toMatchObject({ subtotalCents: 10780, taxCents: 980, totalCents: 10780, taxInclusive: true, currency: 'AUD', itemCount: 3, prepMinutes: 16, orderable: true, issues: [] });
    expect(cart.timing).toMatchObject({ requestedAsap: true, estimateMinutes: 20 });

    // An org whose prices exclude tax: the same cart, tax added on top.
    await t.db.updateTable('orgs').set({ tax_inclusive: false }).where('id', '=', diner().orgId).execute();
    const exclusive = await price({ venueId: venueId(), lines });
    expect(exclusive).toMatchObject({ subtotalCents: 10780, taxCents: 1078, totalCents: 11858, taxInclusive: false });
    await t.db.updateTable('orgs').set({ tax_inclusive: true }).where('id', '=', diner().orgId).execute();
  });

  it('a problem the guest can fix comes back as an issue on the cart, and the same cart is refused at checkout', async () => {
    const m = await menuOf(t, diner(), venueId());
    const rump = m.byName('Wagyu rump');
    const burger = m.byName('Cheeseburger');
    const extras = burger.modifierGroups.find((g) => g.name === 'Add extras')!.modifiers.map((x) => x.id);

    // A required choice left out, and more extras than the group allows.
    const cart = await price({
      venueId: venueId(),
      lines: [
        { menuItemId: rump.id, qty: 1, modifierIds: [m.modifier(rump, 'Cook temperature', 'Medium')] },
        { menuItemId: burger.id, qty: 1, modifierIds: extras },
      ],
    });
    expect(cart.orderable).toBe(false);
    expect(cart.issues.map((i) => [i.code, i.lineIndex])).toEqual([
      ['modifier_required', 0],
      ['modifier_limit', 1],
    ]);
    expect(cart.issues[0]!.message).toBe('Choose an option for "Choose a side" on Wagyu rump 250g.');
    await expect(placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: rump.id, qty: 1, modifierIds: [m.modifier(rump, 'Cook temperature', 'Medium')] }] })).rejects.toMatchObject({
      code: 'invalid',
      message: 'Choose an option for "Choose a side" on Wagyu rump 250g.',
    });

    // A modifier that belongs to a different item is not one of this item's choices at all.
    await expect(price({ venueId: venueId(), lines: [{ menuItemId: burger.id, qty: 1, modifierIds: [m.modifier(rump, 'Cook temperature', 'Rare')] }] })).rejects.toMatchObject({ code: 'not_found' });

    // The most of one item per order, across lines.
    const manager = await diner().as('manager');
    await t.app.tenant(diner().orgId, manager, (ctx) => menu.updateItem(ctx, burger.id, { maxPerOrder: 3 }));
    const many = await price({ venueId: venueId(), lines: [{ menuItemId: burger.id, qty: 2 }, { menuItemId: burger.id, qty: 2, modifierIds: [extras[0]!] }] });
    expect(many.issues).toEqual([{ code: 'max_per_order', lineIndex: 1, message: 'At most 3 of Cheeseburger, pickles, fries per order.' }]);
    expect((await price({ venueId: venueId(), lines: [{ menuItemId: burger.id, qty: 3 }] })).orderable).toBe(true);

    // A sold-out option.
    const kitchen = await diner().as('kitchen');
    const oat = m.modifier(m.byName('Flat white'), 'Milk', 'Oat');
    await t.app.tenant(diner().orgId, kitchen, (ctx) => menu.setModifierAvailability(ctx, { modifierId: oat, available: false }));
    const noOat = await price({ venueId: venueId(), lines: [{ menuItemId: m.byName('Flat white').id, qty: 1, modifierIds: [oat] }] });
    expect(noOat.issues.map((i) => i.code)).toEqual(['unavailable']);
  });

  it('an 86\'d item cannot be ordered on any surface, and is back when its time passes', async () => {
    const m = await menuOf(t, diner(), venueId());
    const squid = m.byName('Salt and pepper squid');
    const kitchen = await diner().as('kitchen');
    const r = await t.app.tenant(diner().orgId, kitchen, (ctx) => menu.setItemAvailability(ctx, { itemId: squid.id, available: false, until: 'end_of_service' }));
    // Dinner on a Thursday closes at 10 pm.
    expect(r.until!.toISOString()).toBe('2026-10-01T12:00:00.000Z');

    for (const surface of ['online', 'in_venue'] as const) {
      const shown = (await menuOf(t, diner(), venueId(), surface)).byName('Salt and pepper squid');
      expect(shown.isAvailable).toBe(false);
    }
    const cart = await price({ venueId: venueId(), lines: [{ menuItemId: squid.id, qty: 1 }] });
    expect(cart.issues).toEqual([{ code: 'unavailable', lineIndex: 0, message: 'Salt and pepper squid is sold out.' }]);
    await expect(placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: squid.id, qty: 1 }] })).rejects.toMatchObject({ code: 'invalid', message: 'Salt and pepper squid is sold out.' });
    const none = await t.db.selectFrom('order_items').select('id').where('menu_item_id', '=', squid.id).where('name_snapshot', '=', 'Salt and pepper squid').execute();
    const before = none.length;

    // Tomorrow's lunch: the 86 has lapsed on its own, for a scheduled order now and for the menu then.
    const tomorrow = await price({ venueId: venueId(), lines: [{ menuItemId: squid.id, qty: 1 }], slotStart: '2026-10-02T02:30:00.000Z' });
    expect(tomorrow.orderable).toBe(true);
    t.clock.set('2026-10-02T02:00:00.000Z');
    expect((await menuOf(t, diner(), venueId())).byName('Salt and pepper squid').isAvailable).toBe(true);
    const order = await placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: squid.id, qty: 1 }] });
    expect(order.status).toBe('pending_payment');
    expect((await t.db.selectFrom('order_items').select('id').where('menu_item_id', '=', squid.id).execute()).length).toBe(before + 1);
    t.clock.set(QUIET_EVENING);
  });

  it('a venue can keep alcohol out of online orders and set a minimum order', async () => {
    const cbd = t.fixture.group.venues.cbd!.id;
    const m = await menuOf(t, t.fixture.group, cbd);
    const ale = m.byName('Pale ale');
    const fries = m.plain();
    const lines = [{ menuItemId: ale.id, qty: 1 }, { menuItemId: fries.id, qty: 1 }];
    expect((await price({ venueId: cbd, lines }, t.fixture.group)).orderable).toBe(true);

    await config(cbd, t.fixture.group, { exclude_alcohol: true, min_order_cents: 3000 });
    const cart = await price({ venueId: cbd, lines }, t.fixture.group);
    expect(cart.issues).toEqual([
      { code: 'alcohol_excluded', lineIndex: 0, message: 'Pale ale is not available to order online.' },
      { code: 'min_order', message: 'The smallest order here is $30.00.' },
    ]);
    await expect(placeOrder(t, t.fixture.group, cbd, { lines })).rejects.toMatchObject({ code: 'invalid' });
    // The setting is this venue's own: the same cart is fine at the group's other venue.
    const newtown = t.fixture.group.venues.newtown!.id;
    const n = await menuOf(t, t.fixture.group, newtown);
    expect((await price({ venueId: newtown, lines: [{ menuItemId: n.byName('Pale ale').id, qty: 1 }, { menuItemId: n.plain().id, qty: 1 }] }, t.fixture.group)).orderable).toBe(true);
    await config(cbd, t.fixture.group, { exclude_alcohol: false, min_order_cents: 0 });
  });

  it('a tip is the guest\'s choice within the venue\'s limit, charged and recorded separately', async () => {
    const m = await menuOf(t, diner(), venueId());
    const lines = [{ menuItemId: m.byName('Cheeseburger').id, qty: 1 }];
    const tooMuch = await price({ venueId: venueId(), lines, tipCents: 2000 });
    expect(tooMuch.issues.map((i) => i.code)).toEqual(['tip']);
    expect(tooMuch.tipping).toEqual({ enabled: true, presets: [5, 10, 15] });

    const order = await placeOrder(t, diner(), venueId(), { lines, tipCents: 300 });
    expect(order).toMatchObject({ subtotalCents: 2600, tipCents: 300, totalCents: 2900, taxCents: 236 });
    await pay(t, diner(), order, okCard());
    const charge = t.sim.payment.captured().find((c) => c.reference === order.reference)!;
    expect(charge).toMatchObject({ amountCents: 2600, tipCents: 300 });
    const f = await footprint(t, order.id);
    expect(f.payments[0]).toMatchObject({ amount_cents: 2600, tip_cents: 300 });
    expect(f.transactions[0]).toMatchObject({ total_cents: 2900, tip_cents: 300, subtotal_cents: 2600 });

    await config(venueId(), diner(), { tipping_enabled: false });
    expect((await price({ venueId: venueId(), lines, tipCents: 300 })).issues).toEqual([{ code: 'tip', message: 'Tips cannot be added to orders here.' }]);
    await config(venueId(), diner(), { tipping_enabled: true });
  });

  it('codes on the cart page: applied, capped at what is left, or turned away with the reason', async () => {
    const m = await menuOf(t, diner(), venueId());
    const lines = [{ menuItemId: m.byName('Cheeseburger').id, qty: 1 }];
    const cart = await price({ venueId: venueId(), lines, codes: ['TenOff', 'tenoff', 'NOPE', 'spent'] });
    expect(cart).toMatchObject({ subtotalCents: 2600, discountCents: 1000, totalCents: 1600, orderable: true });
    expect(cart.adjustments.map((a) => [a.adjuster, a.code, a.amountCents])).toEqual([['test-promo', 'TENOFF', 1000]]);
    expect(cart.rejectedCodes).toEqual([
      { code: 'NOPE', reason: 'That code is not valid.' },
      { code: 'spent', reason: 'That code has already been used.' },
    ]);

    // An adjuster cannot take off more than the order, whatever it claims; a second code has nothing left to act on.
    const capped = await price({ venueId: venueId(), lines, codes: ['HUGE', 'TENOFF'] });
    expect(capped).toMatchObject({ discountCents: 2600, totalCents: 0, taxCents: 0 });
    expect(capped.rejectedCodes).toEqual([{ code: 'TENOFF', reason: 'That code gives nothing on this order.' }]);

    await config(venueId(), diner(), { promo_codes_enabled: false });
    const off = await price({ venueId: venueId(), lines, codes: ['TENOFF'] });
    expect(off).toMatchObject({ discountCents: 0, totalCents: 2600 });
    expect(off.rejectedCodes).toEqual([{ code: 'TENOFF', reason: 'Codes cannot be used on orders here.' }]);
    await config(venueId(), diner(), { promo_codes_enabled: true });
  });

  it('each venue of a group prices from its own menu; the pickup-only venue takes pickup orders and has no table ordering', async () => {
    const group = t.fixture.group;
    const cbd = await menuOf(t, group, group.venues.cbd!.id);
    const newtown = await menuOf(t, group, group.venues.newtown!.id);
    const bondi = await menuOf(t, group, group.venues.bondi!.id);
    expect(cbd.byName('Wagyu rump').priceCents).toBe(5000);
    expect(newtown.byName('Wagyu rump').priceCents).toBe(4800);
    expect(bondi.all.some((i) => i.name.startsWith('Beef tartare'))).toBe(false);
    expect(newtown.all.some((i) => i.name.startsWith('Beef tartare'))).toBe(true);

    // One venue's item is not on another venue's menu, even inside the same org.
    await expect(price({ venueId: group.venues.newtown!.id, lines: [{ menuItemId: cbd.plain().id, qty: 1 }] }, group)).rejects.toMatchObject({ code: 'not_found' });

    const atCbd = await price({ venueId: group.venues.cbd!.id, lines: [{ menuItemId: cbd.plain().id, qty: 2 }] }, group);
    expect(atCbd.totalCents).toBe(2600);

    // Bondi: pickup only. An order goes through the whole flow there.
    const order = await placeOrder(t, group, group.venues.bondi!.id, { lines: [{ menuItemId: bondi.plain().id, qty: 1 }] });
    const paid = await pay(t, group, order);
    expect(paid.status).toBe('paid');
    const f = await footprint(t, order.id);
    expect(f.order).toMatchObject({ venue_id: group.venues.bondi!.id, channel: 'pickup', status: 'placed' });
    expect(f.transactions[0]).toMatchObject({ venue_id: group.venues.bondi!.id, total_cents: 1100 });
    expect(f.tickets[0]!.venue_id).toBe(group.venues.bondi!.id);
    expect(t.sim.payment.captured().find((c) => c.reference === order.reference)!.accountRef).toBe('simpay-oak-group-bondi');

    // No tables there: a table order is not something that venue has, and a venue with pickup off has no pickup.
    await expect(price({ venueId: group.venues.bondi!.id, channel: 'dine-in-qr', qrCode: 'abcdefghij', lines: [{ menuItemId: bondi.plain().id, qty: 1 }] }, group)).rejects.toMatchObject({ code: 'not_found' });
    await config(group.venues.newtown!.id, group, { pickup_enabled: false });
    await expect(price({ venueId: group.venues.newtown!.id, lines: [{ menuItemId: newtown.plain().id, qty: 1 }] }, group)).rejects.toMatchObject({ code: 'module_disabled' });
    await config(group.venues.newtown!.id, group, { pickup_enabled: true });
  });
});
