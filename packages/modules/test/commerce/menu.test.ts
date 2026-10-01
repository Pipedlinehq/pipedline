import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type CanonicalTransaction, getTool } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ledger, menu } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, menuOf, paidOrder } from './helpers';

describe('menu', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const venueId = () => t.fixture.diner.venueId;
  const as = async <T>(org: typeof t.fixture.diner, who: Parameters<typeof org.as>[0], fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org.orgId, await org.as(who), fn);
  const publicMenu = (opts: { surface?: menu.MenuSurface; at?: string } = {}, org = diner(), venue = venueId()) =>
    t.app.tenant(org.orgId, anon(), (ctx) => menu.getPublicMenu(ctx, venue, { surface: opts.surface, at: opts.at ? new Date(opts.at) : undefined }));
  const names = (m: menu.PublicMenu) => m.menus.map((x) => x.name);
  const itemNames = (m: menu.PublicMenu) => m.menus.flatMap((x) => x.sections.flatMap((s) => s.items.map((i) => i.name)));
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('the public menu is what is being served: availability windows, hidden sections, per-surface visibility and removals', async () => {
    const base = await publicMenu();
    expect(base).toMatchObject({ venueId: venueId(), currency: 'AUD', taxInclusive: true });
    expect(names(base)).toEqual(['All day']);
    expect(base.menus[0]!.sections.map((s) => s.name)).toEqual(['Starters', 'Mains', 'Sides', 'Desserts', 'Drinks']);
    const rump = base.menus[0]!.sections[1]!.items[0]!;
    expect(rump).toMatchObject({ name: 'Wagyu rump 250g', priceCents: 4800, isAvailable: true, dietaryTags: ['gf'], prepMinutes: 16, isAlcohol: false, description: 'Grain-fed, marble score 7.' });
    expect(rump.modifierGroups.map((g) => [g.name, g.selectionType, g.isRequired, g.modifiers.length])).toEqual([
      ['Cook temperature', 'single', true, 5],
      ['Choose a side', 'single', true, 4],
    ]);
    // The POS's catalogue ids are the venue's business, not the public's.
    expect(JSON.stringify(base)).not.toContain('simcat-');

    // A breakfast menu with a window: not served at 6 pm, served at 8 am, and only on its days.
    const breakfast = await as(diner(), 'manager', (ctx) => menu.createMenu(ctx, { venueId: venueId(), name: 'Breakfast', availableFrom: '07:00', availableTo: '11:00', sortOrder: 1 }));
    const section = await as(diner(), 'manager', (ctx) => menu.createSection(ctx, { menuId: breakfast.id, name: 'Eggs' }));
    const eggs = await as(diner(), 'manager', (ctx) => menu.createItem(ctx, { sectionId: section.id, name: 'Eggs on toast', priceCents: 1800, allergens: ['egg', 'gluten'] }));
    expect(names(await publicMenu())).toEqual(['All day']);
    const friday8am = '2026-10-01T22:00:00.000Z';
    const morning = await publicMenu({ at: friday8am });
    expect(names(morning)).toEqual(['All day', 'Breakfast']);
    expect(morning.menus[1]!.sections[0]!.items.map((i) => [i.name, i.priceCents, i.allergens])).toEqual([['Eggs on toast', 1800, ['egg', 'gluten']]]);
    await as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, breakfast.id, { availableDays: [6] }));
    expect(names(await publicMenu({ at: friday8am }))).toEqual(['All day']);
    expect(names(await publicMenu({ at: '2026-10-02T22:00:00.000Z' }))).toEqual(['All day', 'Breakfast']);

    // A late menu that runs past midnight belongs to the day it started on.
    const late = await as(diner(), 'manager', (ctx) => menu.createMenu(ctx, { venueId: venueId(), name: 'Late', availableDays: [4], availableFrom: '22:00', availableTo: '02:00', sortOrder: 2 }));
    const lateSection = await as(diner(), 'manager', (ctx) => menu.createSection(ctx, { menuId: late.id, name: 'Supper' }));
    await as(diner(), 'manager', (ctx) => menu.createItem(ctx, { sectionId: lateSection.id, name: 'Toastie', priceCents: 1400 }));
    expect(names(await publicMenu({ at: '2026-10-01T12:30:00.000Z' }))).toContain('Late'); // Thursday 10:30 pm
    expect(names(await publicMenu({ at: '2026-10-01T15:00:00.000Z' }))).toContain('Late'); // Friday 1:00 am, still Thursday's
    expect(names(await publicMenu({ at: '2026-10-02T15:00:00.000Z' }))).not.toContain('Late'); // Saturday 1:00 am
    await expect(as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, late.id, { availableTo: null }))).rejects.toMatchObject({ code: 'invalid' });

    // Hidden online but shown in the venue; a hidden section; an inactive menu.
    await as(diner(), 'manager', (ctx) => menu.updateItem(ctx, eggs.id, { isVisibleOnline: false }));
    await as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, breakfast.id, { availableDays: [0, 1, 2, 3, 4, 5, 6] }));
    expect(itemNames(await publicMenu({ at: friday8am, surface: 'online' }))).not.toContain('Eggs on toast');
    expect(itemNames(await publicMenu({ at: friday8am, surface: 'in_venue' }))).toContain('Eggs on toast');
    await as(diner(), 'manager', (ctx) => menu.updateSection(ctx, section.id, { isVisible: false }));
    expect(itemNames(await publicMenu({ at: friday8am, surface: 'in_venue' }))).not.toContain('Eggs on toast');
    await as(diner(), 'manager', (ctx) => menu.updateSection(ctx, section.id, { isVisible: true }));
    await as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, breakfast.id, { isActive: false }));
    expect(names(await publicMenu({ at: friday8am, surface: 'in_venue' }))).toEqual(['All day']);
    await as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, breakfast.id, { isActive: true }));

    // Removing is soft: gone from every surface, still there for the orders and receipts that point at it.
    const order = await paidOrder(t, diner(), venueId(), { lines: [{ menuItemId: (await menuOf(t, diner(), venueId())).byName('Lemon sorbet').id, qty: 1 }] });
    const sorbet = order.items[0]!.menuItemId!;
    await as(diner(), 'manager', (ctx) => menu.deleteItem(ctx, sorbet));
    expect(itemNames(await publicMenu())).not.toContain('Lemon sorbet');
    const row = await t.db.selectFrom('menu_items').select(['name', 'deleted_at']).where('id', '=', sorbet).executeTakeFirstOrThrow();
    expect(row.name).toBe('Lemon sorbet');
    expect(row.deleted_at).not.toBeNull();
    expect(await as(diner(), 'manager', (ctx) => ordering_items(ctx, order.id))).toEqual([{ menu_item_id: sorbet, name_snapshot: 'Lemon sorbet' }]);
    await expect(as(diner(), 'manager', (ctx) => menu.updateItem(ctx, sorbet, { priceCents: 1 }))).rejects.toMatchObject({ code: 'not_found' });

    await as(diner(), 'manager', (ctx) => menu.deleteSection(ctx, section.id));
    expect(names(await publicMenu({ at: friday8am, surface: 'in_venue' }))).toEqual(['All day']);
    await as(diner(), 'manager', (ctx) => menu.deleteMenu(ctx, late.id));
    expect(names(await publicMenu({ at: '2026-10-01T12:30:00.000Z' }))).toEqual(['All day']);
    expect((await t.db.selectFrom('menu_items').select('deleted_at').where('name', 'in', ['Toastie', 'Eggs on toast']).execute()).every((r) => r.deleted_at !== null)).toBe(true);
    const editor = await as(diner(), 'manager', (ctx) => menu.getMenuEditor(ctx, venueId()));
    expect(editor.menus.map((x) => x.name)).toEqual(['All day', 'Breakfast']);
  });

  it('editing the menu needs a manager at that venue; every change is audited and recorded', async () => {
    const m = await menuOf(t, diner(), venueId());
    const burger = m.byName('Cheeseburger');
    const groupItem = (await menuOf(t, group(), group().venues.bondi!.id)).plain();

    await expect(as(diner(), 'kitchen', (ctx) => menu.updateItem(ctx, burger.id, { priceCents: 100 }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(as(diner(), 'host', (ctx) => menu.updateItem(ctx, burger.id, { priceCents: 100 }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner().orgId, anon(), (ctx) => menu.updateItem(ctx, burger.id, { priceCents: 100 }))).rejects.toMatchObject({ code: 'unauthenticated' });
    // The group's manager has no role at Bondi; the diner's manager cannot see the group's items at all.
    await expect(as(group(), 'manager', (ctx) => menu.updateItem(ctx, groupItem.id, { priceCents: 100 }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(diner(), 'manager', (ctx) => menu.updateItem(ctx, groupItem.id, { priceCents: 100 }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(diner(), 'manager', (ctx) => menu.createMenu(ctx, { venueId: group().venues.cbd!.id, name: 'Not mine' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(diner(), 'manager', (ctx) => menu.updateItem(ctx, burger.id, { priceCents: -5 }))).rejects.toThrow();
    expect((await t.db.selectFrom('menu_items').select('price_cents').where('id', 'in', [burger.id, groupItem.id]).execute()).map((r) => r.price_cents).sort()).toEqual([1100, 2600]);

    const updated = await as(diner(), 'manager', (ctx) => menu.updateItem(ctx, burger.id, { priceCents: 2800, name: 'Cheeseburger <b>deluxe</b>' }));
    expect(updated).toMatchObject({ priceCents: 2800, name: 'Cheeseburger <b>deluxe</b>' });
    // Venue-written text is data. It comes back exactly as written; showing it as text is the page's job.
    expect((await menuOf(t, diner(), venueId())).byName('Cheeseburger <b>deluxe</b>').priceCents).toBe(2800);
    const audit = await t.db.selectFrom('audit_log').select(['action', 'actor_id', 'before', 'after']).where('entity_type', '=', 'menu_item').where('entity_id', '=', burger.id).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'menu.item_updated', actor_id: diner().staff.manager!.staffId });
    expect([(audit[0]!.before as { priceCents: number }).priceCents, (audit[0]!.after as { priceCents: number }).priceCents]).toEqual([2600, 2800]);
    const edits = await t.db.selectFrom('events').select('properties').where('name', '=', 'menu.edited').where(sql<boolean>`properties->>'entity_id' = ${burger.id}`).execute();
    expect(edits.map((e) => e.properties)).toEqual([{ entity: 'item', action: 'updated', entity_id: burger.id, price_changed: true }]);

    // Modifier groups: a single-choice required group always asks for exactly one.
    const sauces = await as(diner(), 'manager', (ctx) => menu.createModifierGroup(ctx, { venueId: venueId(), name: 'Sauce', selectionType: 'single', isRequired: true, maxSelections: 4 }));
    expect(sauces).toMatchObject({ minSelections: 1, maxSelections: 1, isRequired: true });
    await as(diner(), 'manager', (ctx) => menu.createModifier(ctx, { groupId: sauces.id, name: 'Pepper', priceDeltaCents: 200 }));
    const jus = await as(diner(), 'manager', (ctx) => menu.createModifier(ctx, { groupId: sauces.id, name: 'Jus', isDefault: true, sortOrder: 1 }));
    await expect(as(diner(), 'manager', (ctx) => menu.createModifierGroup(ctx, { venueId: venueId(), name: 'Bad', selectionType: 'multi', minSelections: 3, maxSelections: 2 }))).rejects.toMatchObject({ code: 'invalid' });
    const fries = m.plain();
    await as(diner(), 'manager', (ctx) => menu.setItemModifierGroups(ctx, fries.id, [sauces.id]));
    const withSauce = (await menuOf(t, diner(), venueId())).plain();
    expect(withSauce.modifierGroups.map((g) => [g.name, g.isRequired, g.modifiers.map((x) => [x.name, x.priceDeltaCents, x.isDefault])])).toEqual([['Sauce', true, [['Pepper', 200, false], ['Jus', 0, true]]]]);
    // Another venue's group cannot be attached, even within the same org.
    const cbdGroup = await t.db.selectFrom('modifier_groups').select('id').where('venue_id', '=', group().venues.cbd!.id).executeTakeFirstOrThrow();
    const newtownItem = (await menuOf(t, group(), group().venues.newtown!.id)).plain();
    await expect(as(group(), 'manager', (ctx) => menu.setItemModifierGroups(ctx, newtownItem.id, [cbdGroup.id]))).rejects.toMatchObject({ code: 'not_found' });

    await as(diner(), 'manager', (ctx) => menu.deleteModifier(ctx, jus.id));
    expect((await menuOf(t, diner(), venueId())).plain().modifierGroups[0]!.modifiers.map((x) => x.name)).toEqual(['Pepper']);
    await as(diner(), 'manager', (ctx) => menu.deleteModifierGroup(ctx, sauces.id));
    expect((await menuOf(t, diner(), venueId())).plain().modifierGroups).toEqual([]);
  });

  it('the 86 button: kitchen staff take an item off and put it back, on every surface at once, on the record', async () => {
    const m = await menuOf(t, diner(), venueId());
    const risotto = m.byName('Mushroom risotto');
    const off = await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: risotto.id, available: false }));
    expect(off).toMatchObject({ available: false, until: null, name: 'Mushroom risotto' });
    expect(await t.db.selectFrom('menu_items').select(['is_available', 'unavailable_until']).where('id', '=', risotto.id).executeTakeFirstOrThrow()).toEqual({ is_available: false, unavailable_until: null });
    // With no time set it stays off until someone puts it back, tomorrow included.
    for (const at of [undefined, '2026-10-03T03:00:00.000Z']) {
      for (const surface of ['online', 'in_venue'] as const) {
        const shown = (await publicMenu({ surface, at })).menus[0]!.sections.flatMap((s) => s.items).find((i) => i.id === risotto.id)!;
        expect(shown.isAvailable).toBe(false);
      }
    }
    // The clock moves between taps, as it would: the record below is read back in time order.
    t.clock.advance(1000);
    await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: risotto.id, available: true }));
    expect((await menuOf(t, diner(), venueId())).byName('Mushroom risotto').isAvailable).toBe(true);
    t.clock.advance(1000);

    // Until a given time.
    await as(diner(), 'host', (ctx) => menu.setItemAvailability(ctx, { itemId: risotto.id, available: false, until: '2026-10-01T09:30:00.000Z' }));
    expect((await publicMenu({ at: '2026-10-01T09:00:00.000Z' })).menus[0]!.sections.flatMap((s) => s.items).find((i) => i.id === risotto.id)!.isAvailable).toBe(false);
    expect((await publicMenu({ at: '2026-10-01T09:30:00.000Z' })).menus[0]!.sections.flatMap((s) => s.items).find((i) => i.id === risotto.id)!.isAvailable).toBe(true);

    const audits = await t.db.selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_type', '=', 'menu_item').where('entity_id', '=', risotto.id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(audits.map((a) => a.action)).toEqual(['menu.item_86', 'menu.item_restored', 'menu.item_86']);
    const evs = await t.db.selectFrom('events').select('properties').where('name', '=', 'item.availability_changed').where(sql<boolean>`properties->>'menu_item_id' = ${risotto.id}`).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(evs.map((e) => [(e.properties as { available: boolean }).available, (e.properties as { until: string | null }).until, (e.properties as { by: string }).by])).toEqual([
      [false, null, 'staff'],
      [true, null, 'staff'],
      [false, '2026-10-01T09:30:00.000Z', 'staff'],
    ]);

    // Read-only staff and the public cannot press it; another org's item is not found.
    const cbdItem = (await menuOf(t, group(), group().venues.cbd!.id)).plain();
    await expect(as(group(), 'accounts', (ctx) => menu.setItemAvailability(ctx, { itemId: cbdItem.id, available: false }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(group().orgId, anon(), (ctx) => menu.setItemAvailability(ctx, { itemId: cbdItem.id, available: false }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: cbdItem.id, available: false }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await menuOf(t, group(), group().venues.cbd!.id)).plain().isAvailable).toBe(true);

    // "End of service" on a closed day means the end of that day.
    t.clock.set('2026-10-05T01:00:00.000Z'); // Monday midday, closed
    const monday = await as(group(), 'manager', (ctx) => menu.setItemAvailability(ctx, { itemId: cbdItem.id, available: false, until: 'end_of_service' }));
    expect(monday.until!.toISOString()).toBe('2026-10-05T13:00:00.000Z'); // midnight, now on daylight time
    t.clock.set(QUIET_EVENING);
  });

  it('the ledger learns which menu item a sale line is from the POS catalogue id', async () => {
    const m = await menuOf(t, diner(), venueId());
    const rump = m.byName('Wagyu rump');
    const fries = m.plain();
    const sale: CanonicalTransaction = {
      source: 'sim',
      externalRef: 'menu-catalog-1',
      occurredAt: new Date('2026-09-30T09:30:00Z'),
      channel: 'dine-in',
      status: 'completed',
      subtotalCents: 7200,
      discountCents: 0,
      taxCents: 655,
      tipCents: 0,
      totalCents: 7200,
      refundedCents: 0,
      currency: 'AUD',
      lines: [
        { lineNo: 1, externalItemId: 'simcat-main-mains-0', name: 'WAGYU RUMP', qty: 1, unitPriceCents: 4800, modifiers: [], discountCents: 0, taxCents: 436, totalCents: 4800 },
        { lineNo: 2, externalItemId: menu.menuItemRef(fries.id), name: 'Fries', qty: 1, unitPriceCents: 1100, modifiers: [], discountCents: 0, taxCents: 100, totalCents: 1100 },
        { lineNo: 3, externalItemId: 'not-in-our-menu', name: 'Misc', qty: 1, unitPriceCents: 1300, modifiers: [], discountCents: 0, taxCents: 118, totalCents: 1300 },
        // Another venue's catalogue id means nothing here.
        { lineNo: 4, externalItemId: 'simcat-cbd-mains-0', name: 'Other venue', qty: 1, unitPriceCents: 0, modifiers: [], discountCents: 0, taxCents: 0, totalCents: 0 },
      ],
      identityHints: [],
    };
    const recorded = await t.app.tenant(diner().orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, sale, { venueId: venueId() }));
    const lines = await t.db.selectFrom('transaction_lines').select(['line_no', 'menu_item_id', 'category_snapshot']).where('transaction_id', '=', recorded.transaction.id).orderBy('line_no').execute();
    expect(lines).toEqual([
      { line_no: 1, menu_item_id: rump.id, category_snapshot: 'Mains' },
      { line_no: 2, menu_item_id: fries.id, category_snapshot: 'Sides' },
      { line_no: 3, menu_item_id: null, category_snapshot: null },
      { line_no: 4, menu_item_id: null, category_snapshot: null },
    ]);

    // An item taken off the menu still resolves: the sale happened.
    await as(diner(), 'manager', (ctx) => menu.deleteItem(ctx, rump.id));
    const later = await t.app.tenant(diner().orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, { ...sale, externalRef: 'menu-catalog-2', lines: [sale.lines[0]!], totalCents: 4800, subtotalCents: 4800 }, { venueId: venueId() }));
    const line = await t.db.selectFrom('transaction_lines').select('menu_item_id').where('transaction_id', '=', later.transaction.id).executeTakeFirstOrThrow();
    expect(line.menu_item_id).toBe(rump.id);
  });

  it('an update changes only the fields it names', async () => {
    const m = await as(diner(), 'manager', (ctx) => menu.createMenu(ctx, { venueId: venueId(), name: 'Sunday roast', availableDays: [0], isActive: false, sortOrder: 7 }));
    const renamed = await as(diner(), 'manager', (ctx) => menu.updateMenu(ctx, m.id, { name: 'Sunday lunch' }));
    expect(renamed).toMatchObject({ name: 'Sunday lunch', isActive: false, availableDays: [0], sortOrder: 7 });
    const row = await t.db.selectFrom('menus').select(['name', 'is_active', 'available_days', 'sort_order']).where('id', '=', m.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ name: 'Sunday lunch', is_active: false, available_days: [0], sort_order: 7 });
    await as(diner(), 'manager', (ctx) => menu.deleteMenu(ctx, m.id));
  });

  it('assistant tools: menu_list reads the menu; menu_set_availability changes nothing until it is committed', async () => {
    const list = getTool('menu_list')!;
    const set = getTool('menu_set_availability')!;
    expect(list).toMatchObject({ effect: 'read', scope: 'menu:read', module: 'menu' });
    expect(set).toMatchObject({ effect: 'write', scope: 'menu:write', minRole: 'kitchen' });
    if (list.effect !== 'read' || set.effect !== 'write') throw new Error('unexpected tool kinds');
    const kitchen = await diner().as('kitchen');
    const run = <T>(fn: (tc: { ctx: Parameters<Parameters<typeof t.app.tenant>[2]>[0]; venueId: string }) => Promise<T>) => t.app.tenant(diner().orgId, kitchen, (ctx) => fn({ ctx, venueId: venueId() }));

    const out = list.output.parse(await run((tc) => list.run(tc, list.input.parse({ search: 'barramundi' }))));
    expect(out.item_count).toBe(1);
    const barra = out.menus[0].sections[0].items[0];
    expect(barra).toMatchObject({ name: 'Barramundi, fennel, lemon', price: '$38.00', price_cents: 3800, available: true, back_at: null, allergens: ['fish', 'milk'], alcohol: false });
    expect(JSON.stringify(out)).not.toContain('simcat-');

    const proposal = await run((tc) => set.propose(tc, set.input.parse({ item: 'barramundi, fennel, lemon', available: false })));
    expect(proposal.question).toBe(
      'Mark "Barramundi, fennel, lemon" as sold out at Oak Diner until the end of this service? It will show as unavailable on the website, the QR menu and in ordering straight away.',
    );
    expect((await menuOf(t, diner(), venueId())).byName('Barramundi').isAvailable).toBe(true);
    // The hub asks again when the person says yes, and commits only if the question still reads the same.
    const done = set.output.parse(
      await run(async (tc) => {
        const again = await set.propose(tc, set.input.parse({ item: barra.item_id, available: false }));
        expect(again.question).toBe(proposal.question);
        return again.commit();
      }),
    );
    expect(done).toEqual({ item_id: barra.item_id, name: 'Barramundi, fennel, lemon', available: false, back_at: '2026-10-01T12:00:00.000Z' });
    expect((await menuOf(t, diner(), venueId())).byName('Barramundi').isAvailable).toBe(false);
    const soldOut = list.output.parse(await run((tc) => list.run(tc, list.input.parse({ only_unavailable: true }))));
    expect(soldOut.menus.flatMap((x: { sections: Array<{ items: Array<{ name: string }> }> }) => x.sections.flatMap((s) => s.items.map((i) => i.name)))).toContain('Barramundi, fennel, lemon');

    await expect(run((tc) => set.propose(tc, set.input.parse({ item: 'Unicorn steak', available: false })))).rejects.toMatchObject({ code: 'invalid' });
    const back = await run(async (tc) => (await set.propose(tc, set.input.parse({ item: barra.item_id, available: true }))).commit());
    expect(back).toMatchObject({ available: true, back_at: null });
  });
});

/** The frozen lines of an order, read through a tenant transaction to show they survive a menu removal. */
async function ordering_items(ctx: Parameters<Parameters<ReturnType<typeof useTestEnv>['app']['tenant']>[2]>[0], orderId: string) {
  return ctx.db.selectFrom('order_items').select(['menu_item_id', 'name_snapshot']).where('order_id', '=', orderId).execute();
}
