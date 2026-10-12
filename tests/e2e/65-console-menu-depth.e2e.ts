import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

/**
 * Menu depth (docs/CONSOLE_IA.md section 9, wave 2, patterns 11 and 12), through the console in a
 * real browser: a scheduled menu and the preview-as-of, "sold out until" with its choices, where
 * an item shows (singly and in bulk), and a delivery price. Every change is read back from the
 * database. The e2e clock is Friday 2 October 2026, 19:30 in Sydney (AEST, +10; daylight time
 * starts on the 4th).
 */

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

/** Items that are on right now at the venue, to 86 and to hide. */
async function availableItems(venueId: string, n: number) {
  return db()
    .selectFrom('menu_items')
    .select(['id', 'name', 'shown_on'])
    .where('venue_id', '=', venueId)
    .where('deleted_at', 'is', null)
    .where('is_available', '=', true)
    .orderBy('name')
    .limit(n)
    .execute();
}

async function pressInDialog(page: Page, button: string): Promise<void> {
  await page.locator('dialog[open]').getByRole('button', { name: button, exact: true }).click();
}

describe('console: menu depth', () => {
  it('a manager schedules a menu to go live and retire in the venue\'s own time; it shows as Scheduled now and Live in a preview as of later', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const name = `Summer ${run}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu`);
    await v.page.getByRole('button', { name: 'New menu' }).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.locator('input[name=name]').fill(name);
    // Tuesday 1 December 2026, 8:00 in Sydney (daylight time, +11) = 21:00Z the evening before.
    await dialog.locator('input[name=liveFrom]').fill('2026-12-01T08:00');
    await dialog.locator('input[name=liveUntil]').fill('2027-03-01T00:00');
    await pressInDialog(v.page, 'Create menu');
    await dialog.getByText(`${name} created.`).waitFor();

    const row = await db().selectFrom('menus').select(['id', 'live_from', 'live_until', 'venue_id']).where('name', '=', name).where('deleted_at', 'is', null).executeTakeFirstOrThrow();
    expect(row.venue_id).toBe(venueId);
    expect(row.live_from!.toISOString()).toBe('2026-11-30T21:00:00.000Z');
    expect(row.live_until!.toISOString()).toBe('2027-02-28T13:00:00.000Z');

    // Scheduled now; the "Scheduled" view lists it; a preview as of December shows it live.
    await v.page.goto(`${BASE()}/console/menu?view=scheduled`);
    const state = v.page.locator(`[data-testid=menu-state-${row.id}]`);
    await state.waitFor();
    expect(await state.getAttribute('data-schedule')).toBe('scheduled');
    await state.getByText('Scheduled').waitFor();
    await state.getByText(/goes live/).waitFor();
    await v.page.locator('[data-testid=as-of] input[name=asOf]').fill('2026-12-15T12:00');
    await v.page.locator('[data-testid=as-of]').getByRole('button', { name: 'Preview' }).click();
    await v.page.waitForURL(/asOf=/);
    await v.page.getByTestId('as-of-note').waitFor();
    const later = v.page.locator(`[data-testid=menu-state-${row.id}]`);
    // In the preview the "Scheduled" view no longer holds it (it is live then); the All view does.
    await v.page.goto(`${BASE()}/console/menu?asOf=2026-12-15T12:00`);
    await later.waitFor();
    expect(await later.getAttribute('data-schedule')).toBe('live');
    await v.page.goto(`${BASE()}/console/menu?asOf=2027-04-01T12:00`);
    await later.waitFor();
    expect(await later.getAttribute('data-schedule')).toBe('retired');
    await later.getByText('Retired').waitFor();
    // Nothing can be changed from a preview: no 86 buttons.
    expect(await v.page.getByRole('button', { name: '86 it' }).count()).toBe(0);

    const audit = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_type', '=', 'menu_menu').where('entity_id', '=', row.id).orderBy('occurred_at').execute();
    expect(audit.map((a) => a.action)).toEqual(['menu.menu_created']);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('86 until tomorrow and until a chosen time: the row says when it is back and the row in the database carries that instant', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const [item] = await availableItems(venueId, 1);
    const v = await newVisitor();
    await signInStaff(v.page, 'kitchen@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu?q=${encodeURIComponent(item!.name)}`);
    const row = v.page.locator(`[data-testid=item-row-${item!.id}]`);
    await row.getByText('Available').waitFor();

    // Until tomorrow: Saturday 3 October's lunch opens at 12:00 Sydney (AEST, +10).
    await row.locator('select[name=until]').selectOption('tomorrow');
    await row.getByRole('button', { name: '86 it' }).click();
    await row.getByText("86'd").waitFor();
    await row.locator(`[data-testid=item-back-${item!.id}]`).getByText('back Sat 3 Oct, 12:00 pm').waitFor();
    const off = await db().selectFrom('menu_items').select(['is_available', 'unavailable_until']).where('id', '=', item!.id).executeTakeFirstOrThrow();
    expect(off.is_available).toBe(false);
    expect(off.unavailable_until!.toISOString()).toBe('2026-10-03T02:00:00.000Z');
    await row.getByRole('button', { name: 'Bring back' }).click();
    await eventually(() => db().selectFrom('menu_items').select('id').where('id', '=', item!.id).where('is_available', '=', true).executeTakeFirst(), 'the item back on');

    // Until a time of the person's own, in the venue's zone: Monday 5 October 17:00 Sydney (daylight time, +11) = 06:00Z.
    await row.getByText('Available').waitFor();
    await row.locator('select[name=until]').selectOption('at');
    await row.locator('input[name=untilAt]').fill('2026-10-05T17:00');
    await row.getByRole('button', { name: '86 it' }).click();
    await row.locator(`[data-testid=item-back-${item!.id}]`).getByText('back Mon 5 Oct, 5:00 pm').waitFor();
    const at = await db().selectFrom('menu_items').select(['unavailable_until']).where('id', '=', item!.id).executeTakeFirstOrThrow();
    expect(at.unavailable_until!.toISOString()).toBe('2026-10-05T06:00:00.000Z');
    const event = await db().selectFrom('events').select('properties').where('name', '=', 'item.availability_changed').where('venue_id', '=', venueId).orderBy('occurred_at', 'desc').executeTakeFirstOrThrow();
    expect(event.properties).toMatchObject({ menu_item_id: item!.id, available: false, until: '2026-10-05T06:00:00.000Z', by: 'staff' });
    await row.getByRole('button', { name: 'Bring back' }).click();
    await eventually(() => db().selectFrom('menu_items').select('id').where('id', '=', item!.id).where('is_available', '=', true).executeTakeFirst(), 'the item back on again');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('where it shows: "Hide from…" on two selected items takes them off one channel and nothing else; the item page ticks and unticks a channel', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const picked = await availableItems(venueId, 2);
    expect(picked).toHaveLength(2);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu`);
    for (const i of picked) await v.page.locator(`[data-testid=select-${i.id}]`).check();
    await v.page.getByTestId('bulk-menu-bar').waitFor();
    expect(await v.page.getByTestId('bulk-menu-count').innerText()).toBe('2 selected');
    await v.page.getByTestId('bulk-menu-hide').click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.getByText('Hide 2 items from a channel?').waitFor();
    await dialog.locator('select[name=choice]').selectOption('delivery');
    await pressInDialog(v.page, 'Hide items');
    await eventually(async () => {
      const rows = await db().selectFrom('menu_items').select(['id', 'shown_on']).where('id', 'in', picked.map((i) => i.id)).execute();
      return rows.length === 2 && rows.every((r) => !r.shown_on.includes('delivery') && r.shown_on.includes('website')) ? rows : null;
    }, 'both rows hidden from delivery');
    await v.page.getByTestId('console-flash').getByText('2 items now hidden from Delivery.').waitFor();
    for (const i of picked) {
      const row = v.page.locator(`[data-testid=item-row-${i.id}]`);
      await row.waitFor();
      expect(await row.getAttribute('data-shown-on')).not.toContain('delivery');
      await row.locator(`[data-testid=item-where-${i.id}]`).getByText(/not on Delivery/).waitFor();
    }
    // The "Hidden from Delivery" filter finds exactly them.
    await v.page.goto(`${BASE()}/console/menu?f=1&where=off%3Adelivery`);
    for (const i of picked) await v.page.locator(`[data-testid=item-row-${i.id}]`).waitFor();
    expect(await v.page.locator('[data-testid^=item-row-]').count()).toBe(2);

    // Back on, from the item's own page: tick Delivery and save.
    await v.page.goto(`${BASE()}/console/menu/items/${picked[0]!.id}`);
    await v.page.locator('input[name=shownOn][value=delivery]').check();
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Item saved.').waitFor();
    const first = await db().selectFrom('menu_items').select(['shown_on', 'is_visible_online']).where('id', '=', picked[0]!.id).executeTakeFirstOrThrow();
    expect(first.shown_on).toContain('delivery');
    expect(first.is_visible_online).toBe(true);
    // And the other with the bulk bar's "Show on…".
    await v.page.goto(`${BASE()}/console/menu?f=1&where=off%3Adelivery`);
    await v.page.locator(`[data-testid=select-${picked[1]!.id}]`).check();
    await v.page.getByTestId('bulk-menu-show').click();
    await v.page.locator('dialog[open] select[name=choice]').selectOption('delivery');
    await pressInDialog(v.page, 'Show item');
    await eventually(async () => (await db().selectFrom('menu_items').select('shown_on').where('id', '=', picked[1]!.id).executeTakeFirstOrThrow()).shown_on.includes('delivery'), 'the second row back on delivery');
    const audits = await db().selectFrom('audit_log').select(['action', 'after']).where('entity_id', '=', picked[1]!.id).where('action', '=', 'menu.item_updated').orderBy('occurred_at').execute();
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect((audits.at(-1)!.after as { shownOn: string[] }).shownOn).toContain('delivery');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a delivery price on the item page is one row per channel, shown in the list, and cleared by emptying the box', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const [item] = await availableItems(venueId, 1);
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/menu/items/${item!.id}`);
    await v.page.locator('input[name=deliveryPrice]').fill('21.00');
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Item saved.').waitFor();
    const prices = await db().selectFrom('menu_item_prices').select(['channel', 'price_cents', 'venue_id']).where('item_id', '=', item!.id).execute();
    expect(prices).toEqual([{ channel: 'delivery', price_cents: 2100, venue_id: venueId }]);

    await v.page.goto(`${BASE()}/console/menu?q=${encodeURIComponent(item!.name)}`);
    await v.page.locator(`[data-testid=item-where-${item!.id}]`).getByText('Delivery $21.00').waitFor();

    // Saving again with the same price is still one row; emptying the box takes it off.
    await v.page.goto(`${BASE()}/console/menu/items/${item!.id}`);
    expect(await v.page.locator('input[name=deliveryPrice]').inputValue()).toBe('21.00');
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Item saved.').waitFor();
    expect(await db().selectFrom('menu_item_prices').select('id').where('item_id', '=', item!.id).execute()).toHaveLength(1);
    await v.page.locator('input[name=deliveryPrice]').fill('');
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Item saved.').waitFor();
    await eventually(async () => (await db().selectFrom('menu_item_prices').select('id').where('item_id', '=', item!.id).execute()).length === 0, 'the delivery price taken off');
    await v.page.locator('input[name=deliveryPrice]').fill('abc');
    await v.page.getByRole('button', { name: 'Save item' }).click();
    await v.page.getByText('Delivery price: Give a price in dollars, such as 24.50.').waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
