import { afterAll, describe, expect, it } from 'vitest';
import { setModule } from '@ros/core';
import { qr } from '@ros/modules';
import { closeBrowser, closeDb, db, orgBySlug } from './helpers';
import { addItem, asStaff, closeStaff, openCheckout, siteUrl, visitor, waitPriced } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
  await closeStaff();
});

async function tableCode(venueSlug: string, label: string): Promise<{ code: string; id: string; venueId: string }> {
  const { venues } = await orgBySlug('oak-group');
  const venueId = venues.find((v) => v.slug === venueSlug)!.id;
  const row = await db().selectFrom('qr_codes').select(['code', 'id']).where('venue_id', '=', venueId).where('kind', '=', 'table').where('label', '=', label).executeTakeFirstOrThrow();
  return { ...row, venueId };
}

async function payRound(page: import('playwright').Page, item: string): Promise<string> {
  await page.locator('header a:has-text("Order"), a:has-text("Order another round"), a:has-text("Order from Table")').filter({ visible: true }).first().waitFor();
  await addItem(page, item);
  await openCheckout(page);
  await page.click('label:has-text("Test card A")');
  await waitPriced(page);
  await page.click('form button[type=submit]');
  await page.waitForURL(/\/order\/t\//);
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1)!);
}

describe('venue site: QR at the table', () => {
  it('a scan lands on the in-venue menu with the table shown; the table orders two rounds on one session', async () => {
    const { code, id: qrId, venueId } = await tableCode('newtown', '3');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-group', `/q/${code}`));
    await v.page.waitForURL(/\/at\/newtown\/menu$/);
    expect(await v.page.getAttribute('[data-table-label]', 'data-table-label')).toBe('3');
    expect(await v.page.textContent('[aria-label="Your table"]')).toContain('You are at Table 3, Main room.');
    // Newtown keeps alcohol out of table ordering: staff bring the drink and make the call.
    const negroni = await db().selectFrom('menu_items').select('id').where('venue_id', '=', venueId).where('name', '=', 'Negroni').executeTakeFirstOrThrow();
    expect(await v.page.textContent(`[data-item="${negroni.id}"]`)).toContain('Order this from our staff.');

    // The session the scan started is the browser's session.
    const vs = (await v.context.cookies()).find((c) => c.name === 'ros_vs')!.value;
    const scan = await db().selectFrom('events').select(['name', 'properties']).where('session_id', '=', vs).where('name', '=', 'qr.scanned').executeTakeFirstOrThrow();
    expect(scan.properties).toMatchObject({ qr_code_id: qrId, table_label: '3', kind: 'table' });

    await v.page.click('a:has-text("Order from Table 3")');
    await v.page.waitForURL(/\/at\/newtown\/order$/);
    expect(await v.page.getAttribute('[data-order-venue]', 'data-channel')).toBe('dine-in-qr');
    expect(await v.page.locator('[data-order-item="Negroni"] button').count()).toBe(0);
    const first = await payRound(v.page, 'Salt and pepper squid');
    expect(await v.page.textContent('main')).toContain('table 3');

    await v.page.click('a:has-text("Order another round")');
    await v.page.waitForURL(/\/at\/newtown\/order$/);
    const second = await payRound(v.page, 'Fresh lemonade');

    const orders = await db().selectFrom('orders').select(['tracking_token', 'channel', 'table_label', 'table_session_id', 'payment_status', 'session_id', 'customer_id']).where('tracking_token', 'in', [first, second]).execute();
    expect(orders).toHaveLength(2);
    for (const o of orders) expect(o).toMatchObject({ channel: 'dine-in-qr', table_label: '3', payment_status: 'paid', session_id: vs, customer_id: null });
    expect(orders[0]!.table_session_id).not.toBeNull();
    expect(orders[0]!.table_session_id).toBe(orders[1]!.table_session_id);
    const session = await db().selectFrom('table_sessions').select(['venue_id', 'closed_at']).where('id', '=', orders[0]!.table_session_id!).executeTakeFirstOrThrow();
    expect(session).toEqual({ venue_id: venueId, closed_at: null });

    // Straight at the server, alcohol from the table is refused in words.
    const direct = await v.page.evaluate(async ({ venueId: vId, itemId }) => {
      const r = await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ venueId: vId, channel: 'dine-in-qr', lines: [{ menuItemId: itemId, qty: 1 }] }) });
      return r.json();
    }, { venueId, itemId: negroni.id });
    expect(direct.issues[0].message).toBe('Negroni cannot be ordered from the table. Ask our staff.');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a venue whose QR stage is "view" shows the table\'s menu but no table ordering', async () => {
    const { code, venueId } = await tableCode('cbd', '5');
    await asStaff('group', 'manager', (ctx) => setModule(ctx, qr.qrModule, { venueId, config: { stage: 'view' } }));
    const v = await visitor({ mobile: true });
    try {
      await v.page.goto(siteUrl('oak-group', `/q/${code}`));
      await v.page.waitForURL(/\/at\/cbd\/menu$/);
      const banner = (await v.page.textContent('[aria-label="Your table"]'))!;
      expect(banner).toContain('Ask our staff when you are ready to order.');
      expect(await v.page.locator('a:has-text("Order from Table")').count()).toBe(0);
      // The order page offers pickup, not the table.
      await v.page.goto(siteUrl('oak-group', '/at/cbd/order'));
      expect(await v.page.getAttribute('[data-order-venue]', 'data-channel')).toBe('pickup');
      // And the server refuses a table order from this code outright.
      const item = await db().selectFrom('menu_items').select('id').where('venue_id', '=', venueId).where('name', '=', 'Green salad').executeTakeFirstOrThrow();
      const r = await v.page.evaluate(
        async ({ vId, itemId }) => {
          const res = await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ venueId: vId, channel: 'dine-in-qr', lines: [{ menuItemId: itemId, qty: 1 }] }) });
          return { status: res.status, body: await res.json() };
        },
        { vId: venueId, itemId: item.id },
      );
      expect(r.status).toBe(404);
      expect(r.body.error.message).toBe('Ordering from the table is not available here.');
      expect(v.problems.filter((p) => !p.includes('/api/cart') && !/status of 404/.test(p))).toEqual([]);
    } finally {
      await asStaff('group', 'manager', (ctx) => setModule(ctx, qr.qrModule, { venueId, config: { stage: 'order' } }));
      await v.context.close();
    }
  });
});
