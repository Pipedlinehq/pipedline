import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, closeDb, db } from './helpers';
import { addItem, closeStaff, openCheckout, siteUrl, unique, visitor, waitPriced } from './site-helpers';

afterAll(async () => {
  await closeBrowser();
  await closeDb();
  await closeStaff();
});

describe('venue site: delivery at checkout', () => {
  it('a guest checks an address, sees the fee the server charges, pays, and follows the delivery', async () => {
    const email = unique('del');
    const v = await visitor({ mobile: true });
    await v.page.goto(siteUrl('oak-diner', '/order'));
    await addItem(v.page, 'Wagyu rump 250g');
    await openCheckout(v.page);
    await v.page.check('input[name=fulfilment][value=delivery]');
    // Before an address is checked there is no fee, and the order cannot be placed.
    expect(await v.page.textContent('[data-delivery-fee]')).toContain('Check your address');
    expect(await v.page.locator('form button[type=submit]').isDisabled()).toBe(true);

    const countDeliveries = async () => Number((await db().selectFrom('deliveries').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
    const before = await countDeliveries();
    // An address outside every zone is refused in words.
    await v.page.selectOption('select[aria-label="Test address"]', { index: 3 });
    await v.page.click('button:has-text("Check this address")');
    await v.page.waitForSelector('[role=alert]:has-text("outside our delivery area")');
    expect(await countDeliveries()).toBe(before);

    // A nearby one is quoted.
    await v.page.selectOption('select[aria-label="Test address"]', { index: 1 });
    await v.page.fill('input[name=delivery-notes]', 'Buzz 4');
    await v.page.click('button:has-text("Check this address")');
    const quoteId = (await (await v.page.waitForSelector('[data-quote]')).getAttribute('data-quote'))!;
    await v.page.waitForFunction(() => /^\d+$/.test(document.querySelector('[data-delivery-fee]')?.getAttribute('data-delivery-fee') ?? ''));
    const shownFee = Number(await v.page.getAttribute('[data-delivery-fee]', 'data-delivery-fee'));
    const quoted = await db().selectFrom('deliveries').select(['status', 'customer_fee_cents', 'order_id', 'dropoff_notes']).where('id', '=', quoteId).executeTakeFirstOrThrow();
    expect(quoted).toEqual({ status: 'quoted', customer_fee_cents: shownFee, order_id: null, dropoff_notes: 'Buzz 4' });

    await v.page.fill('input[name=name]', 'Del Ivery');
    await v.page.fill('input[name=email]', email);
    await v.page.fill('input[name=phone]', '0400 111 222');
    await v.page.click('label:has-text("Test card A")');
    await waitPriced(v.page);
    await v.page.click('form button[type=submit]');
    await v.page.waitForURL(/\/order\/t\//);

    const order = await db().selectFrom('orders').select(['id', 'channel', 'payment_status', 'delivery_fee_cents', 'subtotal_cents', 'total_cents']).where('customer_email', '=', email).executeTakeFirstOrThrow();
    expect(order).toMatchObject({ channel: 'delivery', payment_status: 'paid', delivery_fee_cents: shownFee, subtotal_cents: 4800 });
    expect(order.total_cents).toBe(4800 + shownFee);
    const d = await db().selectFrom('deliveries').select(['order_id', 'status']).where('id', '=', quoteId).executeTakeFirstOrThrow();
    expect(d.order_id).toBe(order.id);

    // The tracking page shows the delivery half, in words, with no address on it.
    const panel = v.page.locator('[data-delivery-status]');
    expect(await panel.getAttribute('data-delivery-status')).toBe(d.status);
    expect(await panel.textContent()).toContain('Delivery:');
    expect(await v.page.textContent('main')).not.toContain('12 Test Lane');
    expect(v.problems.filter((p) => !p.includes('/api/delivery/quote') && !p.includes('status of 422'))).toEqual([]);
    await v.context.close();
  });
});
