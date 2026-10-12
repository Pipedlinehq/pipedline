import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { getTool } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { guestPlugin, menu } from '@ros/modules';
import { QUIET_EVENING, anon, menuOf } from './helpers';

/**
 * The menu depth pass (docs/CONSOLE_IA.md section 9, wave 2, patterns 11 and 12): scheduled menus
 * and sections, "sold out until", where an item shows, and a price per channel. Every write is
 * read back from the rows, the public menu, the orderable items, the audit log and the guest
 * plugin's own menu_read tool.
 *
 * Sydney moves to daylight time on Sunday 4 October 2026 (02:00 → 03:00): AEST (+10) before,
 * AEDT (+11) after. The fixture evening (QUIET_EVENING) is Thursday 1 October, 6 pm, before it.
 */
describe('menu depth: schedules, sold out until, where it shows, channel prices', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const venueId = () => t.fixture.diner.venueId;
  const as = async <T>(org: typeof t.fixture.diner, who: Parameters<typeof org.as>[0], fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org.orgId, await org.as(who), fn);
  const manager = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => as(diner(), 'manager', fn);
  const publicMenu = (opts: { surface?: menu.MenuSurface; at?: string } = {}, org = diner(), venue = venueId()) =>
    t.app.tenant(org.orgId, anon(), (ctx) => menu.getPublicMenu(ctx, venue, { surface: opts.surface, at: opts.at ? new Date(opts.at) : undefined }));
  const names = (m: menu.PublicMenu) => m.menus.map((x) => x.name);
  const items = (m: menu.PublicMenu) => m.menus.flatMap((x) => x.sections.flatMap((s) => s.items));
  const itemNames = (m: menu.PublicMenu) => items(m).map((i) => i.name);
  const itemRow = (id: string) => t.db.selectFrom('menu_items').select(['is_available', 'unavailable_until', 'shown_on', 'is_visible_online', 'is_visible_in_venue']).where('id', '=', id).executeTakeFirstOrThrow();
  /** The guest plugin's own menu_read tool, called the way its endpoint calls it. */
  const menuRead = async (at?: string) => {
    const tool = guestPlugin.menuReadTool;
    type Read = { menus: Array<{ menu: string; sections: Array<{ items: Array<{ name: string; price_cents: number }> }> }> };
    const out = tool.output.parse(await tool.run({ app: t.app, ip: '198.51.100.77', limits: guestPlugin.GUEST_LIMITS }, { venue_id: venueId(), ...(at ? { at } : {}) })) as Read;
    return out.menus.flatMap((m) => m.sections.flatMap((s) => s.items.map((i) => ({ menu: m.menu, name: i.name, price_cents: i.price_cents }))));
  };
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('a scheduled menu is absent before its go-live instant and present from it, in the venue\'s zone, on both sides of daylight saving; a retired one is gone from its retire instant', async () => {
    // Saturday 10 October, 8:00 in Sydney is after the change to daylight time: 21:00Z the night before.
    const brunch = await manager((ctx) => menu.createMenu(ctx, { venueId: venueId(), name: 'Brunch', liveFrom: '2026-10-10T08:00', liveUntil: '2026-11-01T00:00', sortOrder: 5 }));
    expect(brunch.liveFrom!.toISOString()).toBe('2026-10-09T21:00:00.000Z');
    expect(brunch.liveUntil!.toISOString()).toBe('2026-10-31T13:00:00.000Z');
    const section = await manager((ctx) => menu.createSection(ctx, { menuId: brunch.id, name: 'Eggs' }));
    await manager((ctx) => menu.createItem(ctx, { sectionId: section.id, name: 'Eggs benedict', priceCents: 2400 }));
    const row = await t.db.selectFrom('menus').select(['live_from', 'live_until']).where('id', '=', brunch.id).executeTakeFirstOrThrow();
    expect(row.live_from!.toISOString()).toBe('2026-10-09T21:00:00.000Z');

    expect(names(await publicMenu())).not.toContain('Brunch');
    expect(names(await publicMenu({ at: '2026-10-09T20:59:59.000Z' }))).not.toContain('Brunch');
    expect(names(await publicMenu({ at: '2026-10-09T21:00:00.000Z' }))).toContain('Brunch');
    expect(names(await publicMenu({ at: '2026-10-20T01:00:00.000Z' }))).toContain('Brunch');
    // Retire: present up to the instant, gone from it.
    expect(names(await publicMenu({ at: '2026-10-31T12:59:59.000Z' }))).toContain('Brunch');
    expect(names(await publicMenu({ at: '2026-10-31T13:00:00.000Z' }))).not.toContain('Brunch');
    // Every surface reads the same rows: the QR menu, ordering and assistants agree.
    for (const surface of ['qr', 'pickup', 'delivery', 'assistants', 'in_venue'] as const) {
      expect(names(await publicMenu({ surface, at: '2026-10-09T20:59:59.000Z' }))).not.toContain('Brunch');
      expect(names(await publicMenu({ surface, at: '2026-10-09T21:00:00.000Z' }))).toContain('Brunch');
    }
    expect((await menuRead('2026-10-09T20:59:59.000Z')).map((i) => i.menu)).not.toContain('Brunch');
    expect((await menuRead('2026-10-09T21:00:00.000Z')).map((i) => i.menu)).toContain('Brunch');
    // Ordering: not served before, served after.
    const eggs = items(await publicMenu({ at: '2026-10-10T00:00:00.000Z' })).find((i) => i.name === 'Eggs benedict')!;
    const before = await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [eggs.id], { surface: 'pickup', at: new Date('2026-10-09T20:59:59.000Z') }));
    const after = await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [eggs.id], { surface: 'pickup', at: new Date('2026-10-09T21:00:00.000Z') }));
    expect(before.get(eggs.id)!.isServed).toBe(false);
    expect(after.get(eggs.id)!.isServed).toBe(true);

    // A go-live before daylight saving starts is worked out at +10: Saturday 3 October 8:00 = 22:00Z the night before.
    const early = await manager((ctx) => menu.updateMenu(ctx, brunch.id, { liveFrom: '2026-10-03T08:00' }));
    expect(early.liveFrom!.toISOString()).toBe('2026-10-02T22:00:00.000Z');
    expect(names(await publicMenu({ at: '2026-10-02T21:59:59.000Z' }))).not.toContain('Brunch');
    expect(names(await publicMenu({ at: '2026-10-02T22:00:00.000Z' }))).toContain('Brunch');

    // The console's states: scheduled now, live as of a later time, retired as of a later one still.
    const now = await manager((ctx) => menu.getMenuEditor(ctx, venueId()));
    expect(now.menus.find((m) => m.id === brunch.id)!.schedule).toBe('scheduled');
    const later = await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { asOf: new Date('2026-10-20T01:00:00.000Z') }));
    expect(later.menus.find((m) => m.id === brunch.id)!.schedule).toBe('live');
    const gone = await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { asOf: new Date('2026-11-02T01:00:00.000Z') }));
    expect(gone.menus.find((m) => m.id === brunch.id)!.schedule).toBe('retired');
    expect((await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { schedule: 'scheduled' }))).menus.map((m) => m.name)).toEqual(['Brunch']);
    expect((await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { schedule: 'live' }))).menus.map((m) => m.name)).toEqual(['All day']);

    // A section can be scheduled on its own inside a live menu.
    const allDay = now.menus.find((m) => m.name === 'All day')!;
    const winter = await manager((ctx) => menu.createSection(ctx, { menuId: allDay.id, name: 'Winter warmers', liveFrom: '2026-06-01T00:00', liveUntil: '2026-10-02T00:00' }));
    await manager((ctx) => menu.createItem(ctx, { sectionId: winter.id, name: 'Lamb shank', priceCents: 3600 }));
    expect(itemNames(await publicMenu())).toContain('Lamb shank'); // Thursday 1 Oct, still winter
    expect(itemNames(await publicMenu({ at: '2026-10-01T14:00:00.000Z' }))).not.toContain('Lamb shank'); // Friday 2 Oct 00:00 AEST: retired
    await expect(manager((ctx) => menu.updateSection(ctx, winter.id, { liveUntil: '2026-05-01T00:00' }))).rejects.toMatchObject({ code: 'invalid' });
    await expect(manager((ctx) => menu.createMenu(ctx, { venueId: venueId(), name: 'Bad', liveFrom: 'Saturday 8am' }))).rejects.toThrow();

    const audits = await t.db.selectFrom('audit_log').select(['action', 'after']).where('entity_type', '=', 'menu_menu').where('entity_id', '=', brunch.id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(audits.map((a) => a.action)).toEqual(['menu.menu_created', 'menu.menu_updated']);
    expect((audits[0]!.after as { liveFrom: string }).liveFrom).toBe('2026-10-09T21:00:00.000Z');
  });

  it('sold out until: each choice returns the item exactly when it should and never early, with nothing to run', async () => {
    const m = await menuOf(t, diner(), venueId());
    const rump = m.byName('Wagyu rump');
    const availableAt = async (at: string) => items(await publicMenu({ at })).find((i) => i.id === rump.id)!;

    // End of service: Thursday dinner closes at 22:00 Sydney (12:00Z).
    const eos = await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: 'end_of_service' }));
    expect(eos.until!.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(await availableAt('2026-10-01T11:59:59.000Z')).toMatchObject({ isAvailable: false, availableFrom: new Date('2026-10-01T12:00:00.000Z') });
    expect(await availableAt('2026-10-01T12:00:00.000Z')).toMatchObject({ isAvailable: true, availableFrom: null });
    // Nothing ran: the row still says off; the readers compare the time themselves.
    expect(await itemRow(rump.id)).toMatchObject({ is_available: false, unavailable_until: new Date('2026-10-01T12:00:00.000Z') });
    t.clock.set('2026-10-01T12:00:00.000Z');
    expect((await menuOf(t, diner(), venueId())).byName('Wagyu rump').isAvailable).toBe(true);
    const list = getTool('menu_list')!;
    if (list.effect !== 'read') throw new Error('menu_list is a read tool');
    const listed = list.output.parse(await as(diner(), 'kitchen', (ctx) => list.run({ ctx, venueId: venueId() }, list.input.parse({ search: 'wagyu' }))));
    expect(listed.menus[0].sections[0].items[0]).toMatchObject({ available: true, back_at: null, sold_out_until: null });
    t.clock.set(QUIET_EVENING);

    // Tomorrow: Friday's lunch opens at 12:00 Sydney (02:00Z).
    const tomorrow = await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: 'tomorrow' }));
    expect(tomorrow.until!.toISOString()).toBe('2026-10-02T02:00:00.000Z');
    expect((await availableAt('2026-10-02T01:59:59.000Z')).isAvailable).toBe(false);
    expect((await availableAt('2026-10-02T02:00:00.000Z')).isAvailable).toBe(true);
    const soldOut = list.output.parse(await as(diner(), 'kitchen', (ctx) => list.run({ ctx, venueId: venueId() }, list.input.parse({ only_unavailable: true }))));
    expect(soldOut.menus[0].sections[0].items[0]).toMatchObject({ name: 'Wagyu rump 250g', available: false, back_at: '2026-10-02T02:00:00.000Z', sold_out_until: '2026-10-02T02:00:00.000Z' });
    expect(menu.backWords(tomorrow.until, t.clock(), 'Australia/Sydney')).toBe('back Fri 2 Oct, 12:00 pm');

    // Tomorrow on a Sunday evening: Monday is closed, so it is Monday's midnight (now daylight time).
    t.clock.set('2026-10-04T07:00:00.000Z');
    const monday = await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: 'tomorrow' }));
    expect(monday.until!.toISOString()).toBe('2026-10-04T13:00:00.000Z');
    t.clock.set(QUIET_EVENING);

    // A time of the person's own: back then exactly; a time already passed is refused.
    const at = await as(diner(), 'host', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: '2026-10-03T09:30:00+10:00' }));
    expect(at.until!.toISOString()).toBe('2026-10-02T23:30:00.000Z');
    expect((await availableAt('2026-10-02T23:29:59.000Z')).isAvailable).toBe(false);
    expect((await availableAt('2026-10-02T23:30:00.000Z')).isAvailable).toBe(true);
    expect(menu.backWords(at.until, t.clock(), 'Australia/Sydney')).toBe('back Sat 3 Oct, 9:30 am');
    await expect(as(diner(), 'host', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: '2026-09-01T09:30:00.000Z' }))).rejects.toMatchObject({ code: 'invalid' });

    // Until someone puts it back: still off a month on.
    const forever = await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: 'until_changed' }));
    expect(forever.until).toBeNull();
    expect((await availableAt('2026-11-01T08:00:00.000Z')).isAvailable).toBe(false);
    expect(menu.backWords(null, t.clock(), 'Australia/Sydney')).toBe('until put back');
    await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: true }));
    expect((await availableAt(QUIET_EVENING)).isAvailable).toBe(true);
    // The console's "sold out" view agrees with the readers: an 86 whose time has passed is not in it.
    await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: false, until: '2026-10-01T08:30:00.000Z' }));
    expect((await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { availability: 'off' }))).menus.flatMap((x) => x.sections.flatMap((s) => s.items)).map((i) => i.id)).toContain(rump.id);
    t.clock.set('2026-10-01T08:30:00.000Z');
    expect((await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { availability: 'off' }))).menus.flatMap((x) => x.sections.flatMap((s) => s.items)).map((i) => i.id)).not.toContain(rump.id);
    t.clock.set(QUIET_EVENING);
    await as(diner(), 'kitchen', (ctx) => menu.setItemAvailability(ctx, { itemId: rump.id, available: true }));

    const events = await t.db.selectFrom('events').select('properties').where('name', '=', 'item.availability_changed').where(sql<boolean>`properties->>'menu_item_id' = ${rump.id}`).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    // In time order: the Sunday one was recorded with the clock moved to Sunday, so it is last.
    expect(events.map((e) => (e.properties as { until: string | null }).until)).toEqual(['2026-10-01T12:00:00.000Z', '2026-10-02T02:00:00.000Z', '2026-10-02T23:30:00.000Z', null, null, '2026-10-01T08:30:00.000Z', null, '2026-10-04T13:00:00.000Z']);
  });

  it('where it shows: per channel on the public menu, ordering and the guest plugin\'s menu_read; defaults from the section and the venue; the two old switches stay in step', async () => {
    const m = await menuOf(t, diner(), venueId());
    const burger = m.byName('Cheeseburger');
    const squid = m.byName('Salt and pepper squid');
    expect((await itemRow(burger.id)).shown_on).toEqual(['website', 'qr', 'pickup', 'delivery', 'assistants']);

    // Hide the burger from delivery: gone there, present everywhere else, including the older names.
    const hid = await manager((ctx) => menu.setItemChannels(ctx, { itemId: burger.id, hide: ['delivery'] }));
    expect(hid.shownOn).toEqual(['website', 'qr', 'pickup', 'assistants']);
    expect(await itemRow(burger.id)).toMatchObject({ shown_on: ['website', 'qr', 'pickup', 'assistants'], is_visible_online: true, is_visible_in_venue: true });
    expect(itemNames(await publicMenu({ surface: 'delivery' }))).not.toContain(burger.name);
    for (const surface of ['website', 'qr', 'pickup', 'assistants', 'online', 'in_venue'] as const) expect(itemNames(await publicMenu({ surface })), surface).toContain(burger.name);
    const orderable = await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [burger.id], { surface: 'delivery' }));
    expect(orderable.has(burger.id)).toBe(false);
    expect((await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [burger.id], { surface: 'pickup' }))).has(burger.id)).toBe(true);

    // Inside assistants: the guest plugin's tool reads the assistants channel.
    expect((await menuRead()).map((i) => i.name)).toContain('Salt and pepper squid');
    await manager((ctx) => menu.setItemChannels(ctx, { itemId: squid.id, hide: ['assistants'] }));
    expect((await menuRead()).map((i) => i.name)).not.toContain('Salt and pepper squid');
    expect(itemNames(await publicMenu({ surface: 'website' }))).toContain('Salt and pepper squid');
    await manager((ctx) => menu.setItemChannels(ctx, { itemId: squid.id, show: ['assistants'] }));
    expect((await menuRead()).map((i) => i.name)).toContain('Salt and pepper squid');

    // The console's filters.
    const hiddenFromDelivery = await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { hiddenFrom: 'delivery' }));
    expect(hiddenFromDelivery.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).map((i) => i.name)).toEqual([burger.name]);
    const onDelivery = await manager((ctx) => menu.getMenuEditor(ctx, venueId(), { shownOn: 'delivery' }));
    expect(onDelivery.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).map((i) => i.name)).not.toContain(burger.name);

    // "Show on… / Hide from…" over several rows, as the bulk bar does it: each row changes.
    const fries = m.plain();
    for (const id of [fries.id, squid.id]) await manager((ctx) => menu.setItemChannels(ctx, { itemId: id, hide: ['pickup'] }));
    expect((await itemRow(fries.id)).shown_on).toEqual(['website', 'qr', 'delivery', 'assistants']);
    expect((await itemRow(squid.id)).shown_on).toEqual(['website', 'qr', 'delivery', 'assistants']);
    expect(itemNames(await publicMenu({ surface: 'pickup' }))).not.toContain('Fries, aioli');
    for (const id of [fries.id, squid.id]) await manager((ctx) => menu.setItemChannels(ctx, { itemId: id, show: ['pickup'] }));
    expect((await itemRow(fries.id)).shown_on).toEqual(['website', 'qr', 'pickup', 'delivery', 'assistants']);
    await expect(manager((ctx) => menu.setItemChannels(ctx, { itemId: fries.id }))).rejects.toThrow();

    // The two older switches: hiding "online" takes the four online channels; the QR menu stays.
    await manager((ctx) => menu.updateItem(ctx, burger.id, { isVisibleOnline: false }));
    expect(await itemRow(burger.id)).toMatchObject({ shown_on: ['qr'], is_visible_online: false, is_visible_in_venue: true });
    await manager((ctx) => menu.updateItem(ctx, burger.id, { shownOn: ['website', 'qr', 'pickup'] }));
    expect(await itemRow(burger.id)).toMatchObject({ shown_on: ['website', 'qr', 'pickup'], is_visible_online: true, is_visible_in_venue: true });
    // A writer that only knows the old column still gets the right answer.
    await t.db.updateTable('menu_items').set({ is_visible_in_venue: false }).where('id', '=', burger.id).execute();
    expect((await itemRow(burger.id)).shown_on).toEqual(['website', 'pickup']);
    expect(itemNames(await publicMenu({ surface: 'qr' }))).not.toContain(burger.name);
    await manager((ctx) => menu.updateItem(ctx, burger.id, { shownOn: ['website', 'qr', 'pickup', 'delivery', 'assistants'] }));

    // Defaults for a new item: the venue's, then the section's, then the item's own.
    const editor = await manager((ctx) => menu.getMenuEditor(ctx, venueId()));
    expect(editor.settings.newItemsShownOn).toEqual(['website', 'qr', 'pickup', 'delivery', 'assistants']);
    const settings = await manager((ctx) => menu.updateMenuSettings(ctx, { venueId: venueId(), newItemsShownOn: ['website', 'qr', 'pickup'] }));
    expect(settings.newItemsShownOn).toEqual(['website', 'qr', 'pickup']);
    expect((await t.db.selectFrom('menu_settings').select('new_items_shown_on').where('venue_id', '=', venueId()).executeTakeFirstOrThrow()).new_items_shown_on).toEqual(['website', 'qr', 'pickup']);
    const sides = editor.menus[0]!.sections.find((s) => s.name === 'Sides')!;
    const a = await manager((ctx) => menu.createItem(ctx, { sectionId: sides.id, name: 'Slaw', priceCents: 900 }));
    expect(a.shownOn).toEqual(['website', 'qr', 'pickup']);
    await manager((ctx) => menu.updateSection(ctx, sides.id, { shownOn: ['qr'] }));
    const b = await manager((ctx) => menu.createItem(ctx, { sectionId: sides.id, name: 'Greens', priceCents: 900 }));
    expect(b.shownOn).toEqual(['qr']);
    const c = await manager((ctx) => menu.createItem(ctx, { sectionId: sides.id, name: 'Chips', priceCents: 900, shownOn: ['delivery', 'website'] }));
    expect(c.shownOn).toEqual(['website', 'delivery']);
    expect(await itemRow(c.id)).toMatchObject({ is_visible_online: true, is_visible_in_venue: false });
    expect(a.shownOn).toEqual(['website', 'qr', 'pickup']); // the section's new default did not touch an existing item
    await manager((ctx) => menu.updateSection(ctx, sides.id, { shownOn: null }));
    await manager((ctx) => menu.updateMenuSettings(ctx, { venueId: venueId(), newItemsShownOn: ['website', 'qr', 'pickup', 'delivery', 'assistants'] }));
    for (const id of [a.id, b.id, c.id]) await manager((ctx) => menu.deleteItem(ctx, id));

    const audit = await t.db.selectFrom('audit_log').select(['action', 'before', 'after']).where('entity_type', '=', 'menu_item').where('entity_id', '=', squid.id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(audit.map((x) => x.action)).toEqual(['menu.item_updated', 'menu.item_updated', 'menu.item_updated', 'menu.item_updated']);
    expect(audit[0]!.after).toEqual({ name: 'Salt and pepper squid', shownOn: ['website', 'qr', 'pickup', 'delivery'] });
    expect(await t.db.selectFrom('audit_log').select('action').where('action', '=', 'menu.settings_updated').where('entity_id', '=', venueId()).execute()).toHaveLength(2);
  });

  it('a price per channel is what that channel\'s menu shows and what ordering is given; the other channels keep the item\'s own price', async () => {
    const m = await menuOf(t, diner(), venueId());
    const barra = m.byName('Barramundi');
    expect(barra.priceCents).toBe(3800);
    const set = await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'delivery', priceCents: 4300 }));
    expect(set.channelPrices).toEqual({ delivery: 4300 });
    expect(await t.db.selectFrom('menu_item_prices').select(['channel', 'price_cents', 'venue_id']).where('item_id', '=', barra.id).execute()).toEqual([{ channel: 'delivery', price_cents: 4300, venue_id: venueId() }]);

    const priceOn = async (surface: menu.MenuSurface) => items(await publicMenu({ surface })).find((i) => i.id === barra.id)!.priceCents;
    expect(await priceOn('delivery')).toBe(4300);
    expect(await priceOn('pickup')).toBe(3800);
    expect(await priceOn('website')).toBe(3800);
    expect(await priceOn('qr')).toBe(3800);
    expect((await publicMenu({ surface: 'delivery' })).channel).toBe('delivery');
    const forDelivery = await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [barra.id], { surface: 'delivery' }));
    const forPickup = await t.app.tenant(diner().orgId, anon(), (ctx) => menu.getOrderableItems(ctx, venueId(), [barra.id], { surface: 'pickup' }));
    expect(forDelivery.get(barra.id)!.priceCents).toBe(4300);
    expect(forPickup.get(barra.id)!.priceCents).toBe(3800);
    expect(await t.app.tenant(diner().orgId, anon(), (ctx) => menu.priceFor(ctx, barra.id, 'delivery'))).toEqual({ itemId: barra.id, channel: 'delivery', priceCents: 4300, basePriceCents: 3800 });
    expect((await t.app.tenant(diner().orgId, anon(), (ctx) => menu.priceFor(ctx, barra.id, 'online'))).priceCents).toBe(3800);
    // Assistants see their own channel's price (none set: the item's own).
    expect((await menuRead()).find((i) => i.name.startsWith('Barramundi'))!.price_cents).toBe(3800);

    // Set twice is one row; the item form's channelPrices path works the same; null takes it off.
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'delivery', priceCents: 4400 }));
    expect(await t.db.selectFrom('menu_item_prices').select('price_cents').where('item_id', '=', barra.id).execute()).toEqual([{ price_cents: 4400 }]);
    const viaForm = await manager((ctx) => menu.updateItem(ctx, barra.id, { channelPrices: { pickup: 3600, delivery: null } }));
    expect(viaForm.channelPrices).toEqual({ pickup: 3600 });
    expect(await priceOn('pickup')).toBe(3600);
    expect(await priceOn('delivery')).toBe(3800);
    await manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'pickup', priceCents: null }));
    expect(await t.db.selectFrom('menu_item_prices').select('id').where('item_id', '=', barra.id).execute()).toEqual([]);
    expect((await menuOf(t, diner(), venueId(), 'pickup')).byName('Barramundi').priceCents).toBe(3800);

    const audits = await t.db.selectFrom('audit_log').select(['action', 'before', 'after']).where('action', '=', 'menu.item_channel_price').where('entity_id', '=', barra.id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(audits).toHaveLength(3);
    expect(audits[0]!.after).toEqual({ name: 'Barramundi, fennel, lemon', channel: 'delivery', priceCents: 4300, basePriceCents: 3800 });
    expect(audits[1]!.before).toEqual({ name: 'Barramundi, fennel, lemon', channel: 'delivery', priceCents: 4300, basePriceCents: 3800 });
    // Another org's or venue's id, and a bad price, are refused.
    const cbd = (await menuOf(t, group(), group().venues.cbd!.id)).plain();
    await expect(manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: cbd.id, channel: 'delivery', priceCents: 100 }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(diner(), 'manager', (ctx) => menu.priceFor(ctx, cbd.id, 'delivery'))).rejects.toMatchObject({ code: 'not_found' });
    await expect(manager((ctx) => menu.setItemChannelPrice(ctx, { itemId: barra.id, channel: 'delivery', priceCents: -1 }))).rejects.toThrow();
  });

  it('roles and other organisations: scheduling, where it shows, channel prices and settings need a manager at that venue; another org\'s rows are not found', async () => {
    const editor = await manager((ctx) => menu.getMenuEditor(ctx, venueId()));
    const allDay = editor.menus.find((x) => x.name === 'All day')!;
    const section = allDay.sections[0]!;
    const item = section.items[0]!;
    for (const who of ['kitchen', 'host'] as const) {
      await expect(as(diner(), who, (ctx) => menu.updateMenu(ctx, allDay.id, { liveFrom: '2027-01-01T08:00' }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as(diner(), who, (ctx) => menu.updateSection(ctx, section.id, { liveUntil: '2027-01-01T08:00' }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as(diner(), who, (ctx) => menu.setItemChannels(ctx, { itemId: item.id, hide: ['delivery'] }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as(diner(), who, (ctx) => menu.setItemChannelPrice(ctx, { itemId: item.id, channel: 'delivery', priceCents: 100 }))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(as(diner(), who, (ctx) => menu.updateMenuSettings(ctx, { venueId: venueId(), newItemsShownOn: ['qr'] }))).rejects.toMatchObject({ code: 'forbidden' });
    }
    await expect(t.app.tenant(diner().orgId, anon(), (ctx) => menu.getMenuSettings(ctx, venueId()))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await as(diner(), 'kitchen', (ctx) => menu.getMenuSettings(ctx, venueId()))).newItemsShownOn).toHaveLength(5);
    // The group's manager has no role at Bondi; the diner's manager cannot see the group's rows at all.
    const bondi = group().venues.bondi!.id;
    const bondiMenu = await t.db.selectFrom('menus').select('id').where('venue_id', '=', bondi).executeTakeFirstOrThrow();
    await expect(as(group(), 'manager', (ctx) => menu.updateMenu(ctx, bondiMenu.id, { liveFrom: '2027-01-01T08:00' }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(as(group(), 'manager', (ctx) => menu.updateMenuSettings(ctx, { venueId: bondi, newItemsShownOn: ['qr'] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(manager((ctx) => menu.updateMenu(ctx, bondiMenu.id, { liveFrom: '2027-01-01T08:00' }))).rejects.toMatchObject({ code: 'not_found' });
    const cbdItem = (await menuOf(t, group(), group().venues.cbd!.id)).plain();
    await expect(manager((ctx) => menu.setItemChannels(ctx, { itemId: cbdItem.id, hide: ['qr'] }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(manager((ctx) => menu.updateMenuSettings(ctx, { venueId: bondi, newItemsShownOn: ['qr'] }))).rejects.toMatchObject({ code: 'not_found' });
    expect(await t.db.selectFrom('menus').select('live_from').where('id', '=', bondiMenu.id).executeTakeFirstOrThrow()).toEqual({ live_from: null });
    expect(await t.db.selectFrom('menu_settings').select('venue_id').where('venue_id', '=', bondi).execute()).toEqual([]);
  });

  it('assistant tools: menu_list carries schedule, sold-out-until and channels; each write proposes without changing anything, commits once, and a replayed commit changes nothing more', async () => {
    const list = getTool('menu_list')!;
    const schedule = getTool('menu_schedule')!;
    const showOn = getTool('menu_show_on')!;
    const price = getTool('menu_set_channel_price')!;
    const set = getTool('menu_set_availability')!;
    expect(schedule).toMatchObject({ effect: 'write', scope: 'menu:write', minRole: 'manager', module: 'menu' });
    expect(showOn).toMatchObject({ effect: 'write', scope: 'menu:write', minRole: 'manager' });
    expect(price).toMatchObject({ effect: 'write', scope: 'menu:write', minRole: 'manager' });
    if (list.effect !== 'read' || schedule.effect !== 'write' || showOn.effect !== 'write' || price.effect !== 'write' || set.effect !== 'write') throw new Error('unexpected tool kinds');
    const run = async <T>(who: 'manager' | 'kitchen', fn: (tc: { ctx: Parameters<Parameters<typeof t.app.tenant>[2]>[0]; venueId: string }) => Promise<T>) => as(diner(), who, (ctx) => fn({ ctx, venueId: venueId() }));
    const m = await menuOf(t, diner(), venueId());
    const risotto = m.byName('Mushroom risotto');

    // menu_schedule: propose, nothing written; commit; replay.
    const ask = await run('manager', (tc) => schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_until: '2027-06-01 00:00' })));
    expect(ask.question).toBe('Set the "All day" menu at Oak Diner to retire on 2027-06-01 at 00:00 (Oak Diner\'s own time)? Guests see it only while it is live.');
    const allDayId = (await t.db.selectFrom('menus').select('id').where('venue_id', '=', venueId()).where('name', '=', 'All day').executeTakeFirstOrThrow()).id;
    expect((await t.db.selectFrom('menus').select('live_until').where('id', '=', allDayId).executeTakeFirstOrThrow()).live_until).toBeNull();
    const done = schedule.output.parse(await run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_until: '2027-06-01 00:00' }))).commit()));
    expect(done).toMatchObject({ menu: 'All day', section: null, schedule: 'live', live_until: '2027-05-31T14:00:00.000Z' });
    expect((await t.db.selectFrom('menus').select('live_until').where('id', '=', allDayId).executeTakeFirstOrThrow()).live_until!.toISOString()).toBe('2027-05-31T14:00:00.000Z');
    await run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_until: '2027-06-01 00:00' }))).commit());
    expect((await t.db.selectFrom('menus').select('live_until').where('id', '=', allDayId).executeTakeFirstOrThrow()).live_until!.toISOString()).toBe('2027-05-31T14:00:00.000Z');
    expect(await t.db.selectFrom('audit_log').select('id').where('action', '=', 'menu.menu_updated').where('entity_id', '=', allDayId).execute()).toHaveLength(2);
    // A section, by name within the menu; then cleared.
    const sectionAsk = await run('manager', (tc) => schedule.propose(tc, schedule.input.parse({ menu: 'All day', section: 'Desserts', live_from: '2026-10-10T08:00' })));
    expect(sectionAsk.question).toContain('the "Desserts" section of the "All day" menu');
    const sectionDone = schedule.output.parse(await run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', section: 'Desserts', live_from: '2026-10-10T08:00' }))).commit()));
    expect(sectionDone).toMatchObject({ section: 'Desserts', schedule: 'scheduled', live_from: '2026-10-09T21:00:00.000Z' });
    expect(itemNames(await publicMenu())).not.toContain('Lemon sorbet');
    await run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', section: 'Desserts', live_from: null }))).commit());
    expect(itemNames(await publicMenu())).toContain('Lemon sorbet');
    await run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_until: null }))).commit());
    await expect(run('manager', (tc) => schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_from: '2027-01-01 00:00', live_until: '2026-12-01 00:00' })))).resolves.toBeTruthy();
    await expect(run('manager', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_from: '2027-01-01 00:00', live_until: '2026-12-01 00:00' }))).commit())).rejects.toMatchObject({ code: 'invalid' });
    await expect(run('manager', (tc) => schedule.propose(tc, schedule.input.parse({ menu: 'Nope', live_from: null })))).rejects.toMatchObject({ code: 'invalid' });
    expect(() => schedule.input.parse({ menu: 'All day' })).toThrow();
    await expect(run('kitchen', async (tc) => (await schedule.propose(tc, schedule.input.parse({ menu: 'All day', live_until: null }))).commit())).rejects.toMatchObject({ code: 'forbidden' });

    // menu_show_on: an item, then a section's default.
    const hideAsk = await run('manager', (tc) => showOn.propose(tc, showOn.input.parse({ item: 'Mushroom risotto', hide: ['delivery', 'assistants'] })));
    expect(hideAsk.question).toBe('For "Mushroom risotto" at Oak Diner, hide it from Delivery, Inside assistants? It will then show on: Website, QR menu, Pickup.');
    expect((await itemRow(risotto.id)).shown_on).toHaveLength(5);
    const hidden = showOn.output.parse(await run('manager', async (tc) => (await showOn.propose(tc, showOn.input.parse({ item: 'Mushroom risotto', hide: ['delivery', 'assistants'] }))).commit()));
    expect(hidden).toEqual({ target: 'item', id: risotto.id, name: 'Mushroom risotto', shown_on: ['website', 'qr', 'pickup'] });
    expect((await menuRead()).map((i) => i.name)).not.toContain('Mushroom risotto');
    await run('manager', async (tc) => (await showOn.propose(tc, showOn.input.parse({ item: risotto.id, hide: ['delivery', 'assistants'] }))).commit());
    expect((await itemRow(risotto.id)).shown_on).toEqual(['website', 'qr', 'pickup']);
    const sectionShow = showOn.output.parse(await run('manager', async (tc) => (await showOn.propose(tc, showOn.input.parse({ section: 'Sides', hide: ['qr'] }))).commit()));
    expect(sectionShow).toMatchObject({ target: 'section', name: 'Sides', shown_on: ['website', 'pickup', 'delivery', 'assistants'] });
    expect((await t.db.selectFrom('menu_sections').select('shown_on').where('id', '=', sectionShow.id).executeTakeFirstOrThrow()).shown_on).toEqual(['website', 'pickup', 'delivery', 'assistants']);
    await expect(run('manager', (tc) => showOn.propose(tc, showOn.input.parse({ item: 'Mushroom risotto', show: ['qr'], hide: ['qr'] })))).rejects.toMatchObject({ code: 'invalid' });
    expect(() => showOn.input.parse({ item: 'Mushroom risotto', section: 'Sides', show: ['qr'] })).toThrow();
    await run('manager', async (tc) => (await showOn.propose(tc, showOn.input.parse({ item: risotto.id, show: ['delivery', 'assistants'] }))).commit());
    await run('manager', async (tc) => (await showOn.propose(tc, showOn.input.parse({ section: 'Sides', show: ['qr'] }))).commit());

    // menu_set_channel_price.
    const priceAsk = await run('manager', (tc) => price.propose(tc, price.input.parse({ item: 'Mushroom risotto', channel: 'delivery', price_cents: 3400 })));
    expect(priceAsk.question).toBe(`Charge $34.00 for "Mushroom risotto" on Delivery at Oak Diner (its usual price is ${new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(risotto.priceCents / 100)})? The Delivery menu shows it and Delivery orders are charged it.`);
    expect(await t.db.selectFrom('menu_item_prices').select('id').where('item_id', '=', risotto.id).execute()).toEqual([]);
    const priced = price.output.parse(await run('manager', async (tc) => (await price.propose(tc, price.input.parse({ item: 'Mushroom risotto', channel: 'delivery', price_cents: 3400 }))).commit()));
    expect(priced).toEqual({ item_id: risotto.id, name: 'Mushroom risotto', channel: 'delivery', price_cents: 3400, price: '$34.00', usual_price_cents: risotto.priceCents });
    await run('manager', async (tc) => (await price.propose(tc, price.input.parse({ item: risotto.id, channel: 'delivery', price_cents: 3400 }))).commit());
    expect(await t.db.selectFrom('menu_item_prices').select('price_cents').where('item_id', '=', risotto.id).execute()).toEqual([{ price_cents: 3400 }]);
    expect(items(await publicMenu({ surface: 'delivery' })).find((i) => i.id === risotto.id)!.priceCents).toBe(3400);
    await expect(run('kitchen', async (tc) => (await price.propose(tc, price.input.parse({ item: risotto.id, channel: 'delivery', price_cents: 1 }))).commit())).rejects.toMatchObject({ code: 'forbidden' });

    // menu_list carries it all.
    const out = list.output.parse(await run('kitchen', (tc) => list.run(tc, list.input.parse({ search: 'risotto' }))));
    const listedMenu = out.menus[0];
    expect(listedMenu).toMatchObject({ menu: 'All day', active: true, schedule: 'live', live_from: null, live_until: null });
    expect(listedMenu.sections[0].items[0]).toMatchObject({ name: 'Mushroom risotto', shown_on: ['website', 'qr', 'pickup', 'delivery', 'assistants'], channel_prices: [{ channel: 'delivery', price: '$34.00', price_cents: 3400 }], sold_out_until: null });
    expect(out.new_items_shown_on).toEqual(['website', 'qr', 'pickup', 'delivery', 'assistants']);
    expect(list.output.parse(await run('kitchen', (tc) => list.run(tc, list.input.parse({ shown_on: 'delivery', search: 'risotto' })))).item_count).toBe(1);
    const off = price.output.parse(await run('manager', async (tc) => (await price.propose(tc, price.input.parse({ item: risotto.id, channel: 'delivery', price_cents: null }))).commit()));
    expect(off).toMatchObject({ price_cents: null, price: null });

    // menu_set_availability gained the choices; the older two still read the same.
    const tomorrowAsk = await run('kitchen', (tc) => set.propose(tc, set.input.parse({ item: 'Mushroom risotto', available: false, until: 'tomorrow' })));
    expect(tomorrowAsk.question).toBe('Mark "Mushroom risotto" as sold out at Oak Diner until tomorrow (back Fri 2 Oct 2026, 12:00 pm)? It will show as unavailable on the website, the QR menu and in ordering straight away.');
    expect((await itemRow(risotto.id)).is_available).toBe(true);
    const tomorrowDone = set.output.parse(await run('kitchen', async (tc) => (await set.propose(tc, set.input.parse({ item: 'Mushroom risotto', available: false, until: 'tomorrow' }))).commit()));
    expect(tomorrowDone).toEqual({ item_id: risotto.id, name: 'Mushroom risotto', available: false, back_at: '2026-10-02T02:00:00.000Z' });
    const atAsk = await run('kitchen', (tc) => set.propose(tc, set.input.parse({ item: 'Mushroom risotto', available: false, until: '2026-10-03T09:30:00+10:00' })));
    expect(atAsk.question).toBe('Mark "Mushroom risotto" as sold out at Oak Diner until Sat 3 Oct 2026, 9:30 am? It will show as unavailable on the website, the QR menu and in ordering straight away.');
    const oldAsk = await run('kitchen', (tc) => set.propose(tc, set.input.parse({ item: 'Mushroom risotto', available: false })));
    expect(oldAsk.question).toBe('Mark "Mushroom risotto" as sold out at Oak Diner until the end of this service? It will show as unavailable on the website, the QR menu and in ordering straight away.');
    await run('kitchen', async (tc) => (await set.propose(tc, set.input.parse({ item: risotto.id, available: true }))).commit());
    expect((await itemRow(risotto.id)).is_available).toBe(true);
  });
});
