import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { BASE, chooseVenue, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { closeOpsApp, devPost } from './ops-helpers';

/**
 * The console's shared pieces, wave 1 (docs/CONSOLE_IA.md section 9): saved views with filter
 * tokens in the URL, the bulk-action bar with a confirm that repeats the verb, and the save bar
 * that guards unsaved changes. Every write is read back from the database.
 */

afterAll(async () => {
  await closeOpsApp();
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);

interface DevOrder {
  orderId: string;
  reference: string;
}
const placeOrder = (venueId: string, over: Record<string, unknown> = {}) => devPost<DevOrder>('order', { venueId, ...over });

/** The dialog that is open, after its button was pressed; waits for it to close or to show the words. */
async function pressInDialog(page: Page, button: string): Promise<void> {
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: button, exact: true }).click();
}

describe('console: saved views', () => {
  it('a manager saves the filters as a view at one venue, renames it, and the other venue does not see it; default views have no rename or delete; delete removes the row', async () => {
    const group = await orgBySlug('oak-group');
    const cbd = group.venues.find((v) => v.slug === 'cbd')!;
    const newtown = group.venues.find((v) => v.slug === 'newtown')!;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-group.test');
    await v.page.goto(`${BASE()}/console/orders`);
    await chooseVenue(v.page, 'Oak Group CBD');

    // A default view: nothing to rename or delete.
    await v.page.goto(`${BASE()}/console/orders?view=all`);
    await v.page.getByTestId('views-orders').waitFor();
    expect(await v.page.getByTestId('rename-view').count()).toBe(0);
    expect(await v.page.getByTestId('delete-view').count()).toBe(0);
    expect(await v.page.getByTestId('views-orders').getAttribute('data-dirty')).toBe('false');

    // Filtering makes the view dirty; the tokens say what is in force.
    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&channel=pickup`);
    await v.page.getByTestId('view-tokens').waitFor();
    expect(await v.page.getByTestId('views-orders').getAttribute('data-dirty')).toBe('true');
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain('Pickup');
    const name = `Pickups ${run}`;
    await v.page.getByTestId('save-view-as').click();
    await v.page.locator('dialog[open] input[name=name]').fill(name);
    await pressInDialog(v.page, 'Save view');
    await v.page.waitForURL(/view=saved%3A|view=saved:/);
    const row = await eventually(() => db().selectFrom('console_views').selectAll().where('org_id', '=', group.orgId).where('name', '=', name).executeTakeFirst(), 'the saved view row');
    expect(row).toMatchObject({ venue_id: cbd.id, page: 'orders', filters: { channel: 'pickup' } });
    expect(row.created_by_id).not.toBeNull();
    // It is a tab now, current, and the list is the filtered one.
    const tab = v.page.locator(`[data-testid=view-tab-saved][data-view-key="saved:${row.id}"]`);
    expect(await tab.getAttribute('aria-current')).toBe('page');
    expect(await v.page.getByTestId('views-orders').getAttribute('data-dirty')).toBe('false');
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain('Pickup');

    // Rename, read back.
    await v.page.getByTestId('rename-view').click();
    await v.page.locator('dialog[open] input[name=name]').fill(`Pickups renamed ${run}`);
    await pressInDialog(v.page, 'Rename view');
    await eventually(async () => (await db().selectFrom('console_views').select('name').where('id', '=', row.id).executeTakeFirstOrThrow()).name === `Pickups renamed ${run}`, 'renamed');
    await v.page.getByTestId('console-flash').getByText(/Renamed to/).waitFor();
    const audited = await db().selectFrom('audit_log').select('action').where('entity_id', '=', row.id).orderBy('occurred_at').execute();
    expect(audited.map((a) => a.action)).toEqual(['console.view_saved', 'console.view_renamed']);

    // The venue next door has its own views: none of these.
    await chooseVenue(v.page, 'Oak Group Newtown');
    await v.page.goto(`${BASE()}/console/orders`);
    await v.page.getByTestId('views-orders').waitFor();
    expect(await v.page.locator(`[data-view-key="saved:${row.id}"]`).count()).toBe(0);
    expect(await db().selectFrom('console_views').select('id').where('venue_id', '=', newtown.id).where('page', '=', 'orders').execute()).toEqual([]);

    // Back at CBD, delete it: the confirm repeats the verb, the row goes, the page lands on its first view.
    await chooseVenue(v.page, 'Oak Group CBD');
    await v.page.goto(`${BASE()}/console/orders?view=saved:${row.id}`);
    await v.page.getByTestId('delete-view').click();
    const dialog = v.page.locator('dialog[open]');
    expect(await dialog.innerText()).toContain(`Delete “Pickups renamed ${run}”?`);
    await dialog.getByRole('button', { name: 'Delete view', exact: true }).click();
    await v.page.waitForURL((u) => u.pathname === '/console/orders' && !u.search.includes('saved'));
    await eventually(async () => (await db().selectFrom('console_views').select('id').where('id', '=', row.id).executeTakeFirst()) === undefined, 'view deleted');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('filter tokens in the URL reproduce the list: a channel keeps only that channel, a reference finds one order, a default view keeps only its status', async () => {
    const diner = await orgBySlug('oak-diner');
    const order = await placeOrder(diner.venueId, { guestName: `Vera Views ${run}`, guestEmail: `views.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&channel=pickup`);
    await v.page.locator('[data-testid^=order-]').first().waitFor();
    const channels = await v.page.locator('[data-testid^=order-] td:nth-child(2) span').first().innerText();
    expect(channels).toMatch(/Pickup/);
    const rows = await v.page.locator('[data-testid^=order-]').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => /Pickup/.test(r))).toBe(true);

    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&q=${order.reference}`);
    await v.page.getByTestId(`order-${order.reference}`).waitFor();
    expect(await v.page.locator('[data-testid^=order-]').count()).toBe(1);
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain(order.reference);

    // "Needs accepting" is only new orders.
    await v.page.goto(`${BASE()}/console/orders?view=accepting`);
    await v.page.getByTestId(`order-${order.reference}`).waitFor();
    const badges = await v.page.locator('[data-testid^=order-] td:nth-last-child(1) span').allInnerTexts();
    expect(badges.some((b) => b === 'New')).toBe(true);
    expect(badges.some((b) => /Accepted|Preparing|Ready|Completed/.test(b))).toBe(false);
    // The view keeps working as a link anyone at the venue can be sent: the same address, the same rows.
    const again = await newVisitor();
    await signInStaff(again.page, 'host@oak-diner.test');
    await again.page.goto(`${BASE()}/console/orders?view=all&f=1&q=${order.reference}`);
    await again.page.getByTestId(`order-${order.reference}`).waitFor();
    expect(await again.page.locator('[data-testid^=order-]').count()).toBe(1);
    expect(v.problems).toEqual([]);
    expect(again.problems).toEqual([]);
    await v.context.close();
    await again.context.close();
  });
});

describe('console: bulk actions and the save bar', () => {
  it('a manager selects two new orders and accepts both from the bar: the dialog repeats the verb, both rows change, the toast says so', async () => {
    const diner = await orgBySlug('oak-diner');
    const a = await placeOrder(diner.venueId, { guestName: `Bulk One ${run}`, guestEmail: `bulk1.${run}@example.com` });
    const b = await placeOrder(diner.venueId, { guestName: `Bulk Two ${run}`, guestEmail: `bulk2.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders?view=accepting`);
    await v.page.getByTestId(`select-${a.orderId}`).check();
    await v.page.getByTestId(`select-${b.orderId}`).check();
    const bar = v.page.getByTestId('bulk-orders-bar');
    await bar.waitFor();
    expect(await v.page.getByTestId('bulk-orders-count').innerText()).toBe('2 selected');
    await v.page.getByTestId('bulk-orders-accepted').click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.waitFor();
    expect(await dialog.locator('h2').innerText()).toBe('Accept 2 orders?');
    expect(await dialog.getByTestId('bulk-orders-confirm').innerText()).toBe('Accept orders');
    await dialog.getByTestId('bulk-orders-confirm').click();
    await v.page.getByTestId('console-flash').getByText('2 orders accepted.').waitFor();
    for (const o of [a, b]) {
      const row = await eventually(async () => {
        const r = await db().selectFrom('orders').select(['status', 'accepted_at']).where('id', '=', o.orderId).executeTakeFirstOrThrow();
        return r.status === 'accepted' ? r : null;
      }, `order ${o.reference} accepted`);
      expect(row.accepted_at).not.toBeNull();
      const history = await db().selectFrom('order_status_history').select(['from_status', 'to_status', 'by_kind']).where('order_id', '=', o.orderId).where('to_status', '=', 'accepted').executeTakeFirstOrThrow();
      expect(history).toEqual({ from_status: 'placed', to_status: 'accepted', by_kind: 'staff' });
    }
    // The bar is gone with the selection, and the two orders have left "Needs accepting".
    await v.page.waitForFunction((ids) => ids.every((id) => !document.querySelector(`[data-testid="select-${id}"]`)), [a.orderId, b.orderId]);
    expect(await bar.count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('the save bar: a changed setting brings up Discard and Save, a link asks before leaving, Stay keeps the change, Discard puts it back and nothing is saved', async () => {
    const diner = await orgBySlug('oak-diner');
    const config = async () => (await db().selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'bookings').executeTakeFirstOrThrow()).config as Record<string, unknown>;
    const before = await config();
    const v = await newVisitor();
    await signInStaff(v.page, 'owner@oak-diner.test');
    await v.page.goto(`${BASE()}/console/bookings/settings`);
    const form = v.page.getByTestId('settings-bookings');
    const field = form.locator('input[name="cfg.max_party_size_online"]');
    const original = await field.inputValue();
    expect(await v.page.getByTestId('save-bar').count()).toBe(0);
    // One Save button, where it always was.
    expect(await form.getByRole('button', { name: 'Save booking rules' }).count()).toBe(1);

    await field.fill(String(Number(original) + 1));
    await v.page.getByTestId('save-bar').waitFor();
    expect(await form.getAttribute('data-dirty')).toBe('true');
    // Still exactly one Save button, now in the bar.
    expect(await form.getByRole('button', { name: 'Save booking rules' }).count()).toBe(1);

    // A link in the sidebar asks first; Stay keeps the page and the change.
    await v.page.locator('nav[aria-label=Console] a', { hasText: 'Home' }).first().click();
    const leave = v.page.getByTestId('leave-dialog');
    await leave.waitFor();
    expect(await leave.innerText()).toContain('Leave without saving?');
    expect(new URL(v.page.url()).pathname).toBe('/console/bookings/settings');
    await leave.getByRole('button', { name: 'Stay' }).click();
    await leave.waitFor({ state: 'hidden' });
    expect(await field.inputValue()).toBe(String(Number(original) + 1));

    // Discard puts the field back and the bar goes. Nothing reached the record.
    await v.page.getByTestId('save-bar').getByRole('button', { name: 'Discard' }).click();
    await v.page.getByTestId('save-bar').waitFor({ state: 'hidden' });
    expect(await field.inputValue()).toBe(original);
    expect(await config()).toEqual(before);

    // Changed again and leaving on purpose: the link is followed.
    await field.fill(String(Number(original) + 1));
    await v.page.getByTestId('save-bar').waitFor();
    await v.page.locator('nav[aria-label=Console] a', { hasText: 'Home' }).first().click();
    await leave.waitFor();
    await leave.getByRole('button', { name: 'Leave without saving' }).click();
    await v.page.waitForURL((u) => u.pathname === '/console');
    expect(await config()).toEqual(before);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
