import { afterAll, describe, expect, it } from 'vitest';
import { menu, ordering } from '@ros/modules';
import { closeBrowser, closeDb, db, eventually, orgBySlug, waitForMessage } from './helpers';
import { addItem, asStaff, closeStaff, openCheckout, siteUrl, unique, visitor, waitPriced } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
  await closeStaff();
});

const orderByToken = (token: string) => db().selectFrom('orders').selectAll().where('tracking_token', '=', token).executeTakeFirstOrThrow();
const tokenFrom = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);

describe('venue site: ordering for pickup', () => {
  it('a guest browses, orders for pickup with one consent ticked, pays, and watches the order move without refreshing', async () => {
    const { orgId } = await orgBySlug('oak-diner');
    const email = unique('pat');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', '/menu'));
    await v.page.locator('header a:has-text("Order")').filter({ visible: true }).first().click();
    await v.page.waitForURL(/\/order$/);
    await addItem(v.page, 'Wagyu rump 250g', ['Medium rare', 'Truffle fries']);
    await addItem(v.page, 'Fries, aioli');
    await openCheckout(v.page);
    await v.page.fill('input[name=name]', 'Pat Pickup');
    await v.page.fill('input[name=email]', email);

    // The consent boxes: separate, unticked, each with the current wording and its version.
    const boxes = v.page.locator('[data-consent]');
    expect(await boxes.count()).toBe(4);
    for (const box of await boxes.all()) {
      expect(await box.locator('input').isChecked()).toBe(false);
      expect(await box.getAttribute('data-wording-version')).toBe('v1');
    }
    expect(await v.page.textContent('[data-consent=marketing_email]')).toContain('Email me offers and news from this venue.');
    await v.page.check('[data-consent=marketing_email] input');
    await v.page.click('label:has-text("Test card A")');
    await waitPriced(v.page);
    const shownTotal = await v.page.textContent('[data-total]');
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);
    const token = tokenFrom(v.page.url());
    expect(await v.page.textContent('h1')).toContain('Sent to the kitchen');

    // Read it all back.
    const order = await orderByToken(token);
    expect(order).toMatchObject({ status: 'placed', payment_status: 'paid', channel: 'pickup', customer_email: email, customer_name: 'Pat Pickup' });
    expect(shownTotal).toBe(`$${(order.total_cents / 100).toFixed(2)}`);
    // Server prices: rump 48.00 + truffle fries 3.00, fries 11.00.
    expect(order.subtotal_cents).toBe(4800 + 300 + 1100);
    const payment = await db().selectFrom('payments').selectAll().where('order_id', '=', order.id).execute();
    expect(payment.map((p) => p.status)).toEqual(['completed']);
    const txn = await db().selectFrom('transactions').select(['id', 'total_cents', 'customer_id']).where('id', '=', order.transaction_id!).executeTakeFirstOrThrow();
    expect(txn.total_cents).toBe(order.total_cents);
    expect(await db().selectFrom('kitchen_tickets').select('id').where('order_id', '=', order.id).execute()).toHaveLength(1);
    const consent = await db().selectFrom('consents').selectAll().where('customer_id', '=', order.customer_id!).where('org_id', '=', orgId).execute();
    expect(consent.map((c) => [c.purpose, c.status, c.wording_version, c.source])).toEqual([['marketing_email', 'granted', 'v1', 'checkout']]);
    const confirmation = await waitForMessage(email, (m) => m.body.includes(order.reference));
    expect(confirmation.body).toContain(token);
    const funnel = await eventually(async () => {
      const rows = await db().selectFrom('events').select('name').where('session_id', '=', order.session_id!).execute();
      const names = new Set(rows.map((r) => r.name));
      return ['menu.viewed', 'item.viewed', 'cart.item_added', 'checkout.started', 'order.placed', 'order.paid'].every((n) => names.has(n)) ? names : null;
    }, 'the order funnel events');
    expect(funnel.has('page.viewed')).toBe(true);

    // The kitchen accepts it; the guest's page changes by itself.
    await asStaff('diner', 'manager', (ctx) => ordering.updateOrderStatus(ctx, { orderId: order.id, status: 'accepted' }));
    await v.page.waitForFunction(() => document.querySelector('h1')?.getAttribute('data-status') === 'accepted', null, { timeout: 20_000 });
    expect(await v.page.locator('[aria-current=step]').textContent()).toContain('Accepted');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a declined card is said plainly, the order waits, and another card pays for it', async () => {
    const email = unique('dee');
    const v = await visitor();
    await v.page.goto(siteUrl('oak-diner', '/order'));
    await addItem(v.page, 'Burrata, heirloom tomato, basil');
    await openCheckout(v.page);
    await v.page.fill('input[name=name]', 'Dee Declined');
    await v.page.fill('input[name=email]', email);
    await v.page.click('label:has-text("Test card that is declined")');
    await waitPriced(v.page);
    await v.page.click('form button[type=submit]');
    await v.page.waitForSelector('[role=alert]:has-text("declined")');
    expect(await v.page.textContent('[role=status]:has-text("waiting for payment")')).toContain('Nothing has gone to the kitchen yet');
    const pending = await db().selectFrom('orders').selectAll().where('customer_email', '=', email).executeTakeFirstOrThrow();
    expect(pending).toMatchObject({ status: 'pending_payment', payment_status: 'failed' });
    expect(await db().selectFrom('kitchen_tickets').select('id').where('order_id', '=', pending.id).execute()).toHaveLength(0);

    await v.page.click('label:has-text("Test card B")');
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);
    const paid = await orderByToken(tokenFrom(v.page.url()));
    expect(paid.id).toBe(pending.id);
    expect(paid.payment_status).toBe('paid');
    const payments = await db().selectFrom('payments').select(['status', 'failure_reason']).where('order_id', '=', paid.id).orderBy('created_at').execute();
    expect(payments).toEqual([
      { status: 'failed', failure_reason: 'card_declined' },
      { status: 'completed', failure_reason: null },
    ]);
    expect(await db().selectFrom('events').select('name').where('name', '=', 'payment.failed').where('session_id', '=', paid.session_id!).execute()).toHaveLength(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('when the processor does not answer, trying the same card again charges once', async () => {
    const email = unique('tim');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', '/order'));
    await addItem(v.page, 'Green salad');
    await openCheckout(v.page);
    await v.page.fill('input[name=name]', 'Tim Timeout');
    await v.page.fill('input[name=email]', email);
    await v.page.click('label:has-text("processor does not answer")');
    await waitPriced(v.page);
    await v.page.click('form button[type=submit]');
    await v.page.waitForSelector('[role=alert]:has-text("same card")');
    expect(await v.page.textContent('form button[type=submit]')).toBe('Try the same card again');
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);
    const order = await orderByToken(tokenFrom(v.page.url()));
    expect(order.payment_status).toBe('paid');
    const completed = await db().selectFrom('payments').select('id').where('order_id', '=', order.id).where('status', '=', 'completed').execute();
    expect(completed).toHaveLength(1);
    expect(await db().selectFrom('transactions').select('id').where('id', '=', order.transaction_id!).execute()).toHaveLength(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an item the kitchen has 86\'d is shown sold out and cannot be ordered, even from a stale cart', async () => {
    const { venueId } = await orgBySlug('oak-diner');
    const item = await db().selectFrom('menu_items').select(['id', 'name']).where('venue_id', '=', venueId).where('name', '=', 'Kingfish crudo, finger lime').executeTakeFirstOrThrow();
    const v = await visitor();
    try {
      // The guest put it in their cart earlier.
      await v.page.goto(siteUrl('oak-diner', '/order'));
      await addItem(v.page, item.name);
      // Then the kitchen runs out.
      await asStaff('diner', 'manager', (ctx) => menu.setItemAvailability(ctx, { itemId: item.id, available: false }));

      await v.page.goto(siteUrl('oak-diner', '/menu'));
      const row = v.page.locator(`[data-item="${item.id}"]`);
      expect(await row.getAttribute('data-available')).toBe('no');
      expect(await row.textContent()).toContain('Sold out');

      await v.page.goto(siteUrl('oak-diner', '/order'));
      const orderRow = v.page.locator(`[data-order-item="${item.name}"]`);
      expect(await orderRow.locator('button').count()).toBe(0);
      expect(await orderRow.textContent()).toContain('Sold out');
      await v.page.waitForSelector(`[data-cart-line="${item.name}"] [role=alert]`);
      expect(await v.page.textContent(`[data-cart-line="${item.name}"] [role=alert]`)).toBe(`${item.name} is sold out.`);
      await openCheckout(v.page);
      expect(await v.page.locator('form button[type=submit]').isDisabled()).toBe(true);

      // Straight at the server, the answer is the same.
      const direct = await v.page.evaluate(async (menuItemId) => {
        const r = await fetch('/api/order', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ venueId: document.querySelector('[data-order-venue]')?.getAttribute('data-order-venue'), channel: 'pickup', lines: [{ menuItemId, qty: 1 }], idempotencyKey: crypto.randomUUID() + crypto.randomUUID(), customer: { name: 'Sly', email: 'sly@example.com' } }),
        });
        return { status: r.status, body: await r.json() };
      }, item.id);
      expect(direct.status).toBe(422);
      expect(direct.body.error.message).toBe(`${item.name} is sold out.`);
      expect(await db().selectFrom('orders').select('id').where('customer_email', '=', 'sly@example.com').execute()).toHaveLength(0);
      expect(v.problems.filter((p) => !p.includes('/api/order') && !p.includes('status of 422'))).toEqual([]);
    } finally {
      await asStaff('diner', 'manager', (ctx) => menu.setItemAvailability(ctx, { itemId: item.id, available: true }));
      await v.context.close();
    }
  });
});
