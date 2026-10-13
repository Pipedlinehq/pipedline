import { afterAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { localParts } from '@ros/core';
import { auth, offers } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';
import { closeOpsApp, devGet, opsApp, staffAs } from './ops-helpers';
import { addItem, asStaff, closeStaff, openCheckout, siteUrl, unique, visitor, waitPriced } from './site-helpers';

/**
 * Offers and surcharges on the bill, end to end (docs/CONSOLE_IA.md section 9, pattern 6 meeting
 * ordering): a venue sets a day surcharge and an automatic offer; a guest sees the surcharge's
 * legal line on the menu and the order page, both lines on the priced cart, pays, and finds both
 * on the receipt; the console docket and the kitchen screen's ticket show both; the use is on
 * record with the sale. Every figure is read back from the database.
 */

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
  await closeStaff();
});

const run = Date.now().toString(36);
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const card = (page: Page, ticketId: string) => page.locator(`[data-testid=ticket][data-ticket-id="${ticketId}"]`);

/** Pages through the kitchen screen until the ticket is in view (it arrives by polling). */
async function showTicket(page: Page, ticketId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const prev = page.locator('button[aria-label="Previous page"]');
  const next = page.locator('button[aria-label="Next page"]');
  while (Date.now() < deadline) {
    if (await card(page, ticketId).isVisible()) return;
    while (await prev.isEnabled()) await prev.click();
    for (let i = 0; i < 20; i++) {
      if (await card(page, ticketId).isVisible()) return;
      if (!(await next.isEnabled())) break;
      await next.click();
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`ticket ${ticketId} never appeared on the screen`);
}

describe('venue site: offers and surcharges on the bill', () => {
  it('a guest sees the surcharge line and an automatic offer on the order page, pays, and the receipt, the console docket and the kitchen ticket show both', async () => {
    const diner = await orgBySlug('oak-diner');
    // The app's clock starts on a Friday evening in Sydney and cannot be jumped (ops-dev clock),
    // so a named-day surcharge for today's venue-local weekday stands in for a Sunday one.
    const { now } = await devGet<{ now: string }>('clock');
    const weekday = localParts(new Date(now), 'Australia/Sydney').weekday;
    const day = DAY_NAMES[weekday]!;
    const surchargeName = `${day} surcharge ${run}`;
    const surcharge = await asStaff('diner', 'manager', (ctx) => offers.saveSurcharge(ctx, { venueId: diner.venueId, name: surchargeName, kind: 'days', percent: 10, days: [weekday] }));
    expect(surcharge.notice).toBe(`A surcharge of 10% applies on ${day}s.`);
    const offer = await asStaff('diner', 'manager', (ctx) => offers.saveOffer(ctx, { kind: 'manual', name: `Fries night ${run}`, method: 'automatic', discountKind: 'fixed', valueCents: 300, requiresClaim: false }));
    const offerLabel = `${offer.name}: $3 off, applied automatically, not with other offers`;
    const surchargeLabel = `${surchargeName} (10%, ${day})`;
    const email = unique('sue');
    const v = await visitor();
    try {
      // The menu page carries the legal line.
      await v.page.goto(siteUrl('oak-diner', '/menu'));
      await v.page.waitForSelector('[data-surcharge-notice]');
      expect(await v.page.locator('[data-surcharge-notice]').first().innerText()).toContain(surcharge.notice);

      // The order page: the notice before anything is chosen; both lines once the server has priced the cart.
      await v.page.goto(siteUrl('oak-diner', '/order'));
      expect(await v.page.locator('[data-surcharge-notice]').first().innerText()).toContain(surcharge.notice);
      await addItem(v.page, 'Fries, aioli');
      await v.page.waitForSelector(`[data-adjustment="auto:${offer.id}"]`);
      const adjustment = v.page.locator(`[data-adjustment="auto:${offer.id}"]`);
      expect(await adjustment.getAttribute('data-automatic')).toBe('yes');
      expect(await adjustment.innerText()).toContain(offerLabel);
      expect(await adjustment.innerText()).toContain('$3.00');
      const line = v.page.locator(`[data-surcharge="${surcharge.id}"]`);
      expect(await line.innerText()).toContain(surchargeLabel);
      // Fries $11.00, $3 off, then 10% of $8.00.
      expect(await line.innerText()).toContain('$0.80');
      expect(await v.page.locator('[data-total]').innerText()).toBe('$8.80');

      await openCheckout(v.page);
      await v.page.fill('input[name=name]', 'Sue Surcharge');
      await v.page.fill('input[name=email]', email);
      await v.page.click('label:has-text("Test card A")');
      await waitPriced(v.page);
      expect(await v.page.locator('form button[type=submit]').innerText()).toContain('$8.80');
      await v.page.click('form button[type=submit]');
      await v.page.waitForURL(/\/order\/t\//);

      // The receipt: both lines and the notice.
      await v.page.waitForSelector(`[data-surcharge="${surcharge.id}"]`);
      expect(await v.page.locator('[data-adjustment]').innerText()).toContain(offerLabel);
      expect(await v.page.locator(`[data-surcharge="${surcharge.id}"]`).innerText()).toContain('$0.80');
      expect(await v.page.locator('[data-surcharge-notice]').first().innerText()).toContain(surcharge.notice);

      // Read it all back.
      const order = await db().selectFrom('orders').selectAll().where('customer_email', '=', email).executeTakeFirstOrThrow();
      expect(order).toMatchObject({ status: 'placed', payment_status: 'paid', subtotal_cents: 1100, discount_cents: 300, surcharge_cents: 80, total_cents: 880, promo_code: null });
      expect(order.surcharges).toMatchObject([{ id: surcharge.id, name: surchargeName, percentBp: 1000, reason: day, notice: surcharge.notice, amountCents: 80 }]);
      expect(order.adjustments).toMatchObject([{ adjuster: 'offers', code: `auto:${offer.id}`, label: offerLabel, amountCents: 300 }]);
      const payment = await db().selectFrom('payments').select(['status', 'amount_cents']).where('order_id', '=', order.id).execute();
      expect(payment).toEqual([{ status: 'completed', amount_cents: 880 }]);
      const use = await eventually(() => db().selectFrom('offer_uses').select(['transaction_id', 'discount_cents', 'released_at']).where('order_id', '=', order.id).where('offer_id', '=', offer.id).executeTakeFirst(), 'the offer use');
      expect(use).toEqual({ transaction_id: order.transaction_id, discount_cents: 300, released_at: null });
      const audit = await db().selectFrom('audit_log').select(['after']).where('entity_id', '=', order.id).where('action', '=', 'order.offer_applied').execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]!.after).toMatchObject({ code: `auto:${offer.id}`, amountCents: 300, automatic: true });
      expect(v.problems).toEqual([]);

      // The console docket shows both, with the notice under the figures.
      const c = await newVisitor();
      await signInStaff(c.page, 'manager@oak-diner.test');
      await c.page.goto(`${BASE()}/console/orders/${order.id}`);
      await c.page.getByTestId('order-surcharge').waitFor();
      expect(await c.page.getByTestId('order-adjustment').innerText()).toContain(offerLabel);
      expect(await c.page.getByTestId('order-adjustment').innerText()).toContain('$3.00');
      expect(await c.page.getByTestId('order-surcharge').innerText()).toContain(surchargeLabel);
      expect(await c.page.getByTestId('order-surcharge').innerText()).toContain('$0.80');
      expect(await c.page.getByTestId('order-surcharge-notice').innerText()).toBe(surcharge.notice);
      expect(c.problems).toEqual([]);
      await c.context.close();

      // The kitchen screen's ticket prints the same lines at its foot.
      const ticket = await db().selectFrom('kitchen_tickets').select('id').where('order_id', '=', order.id).executeTakeFirstOrThrow();
      const screen = await newVisitor();
      await screen.page.setViewportSize({ width: 1280, height: 800 });
      const m = await staffAs('manager@oak-diner.test', 'oak-diner');
      const pairing = await (await opsApp()).tenant(m.orgId, m.principal, (ctx) => auth.createDevicePairing(ctx, { venueId: diner.venueId, name: `Pass screen ${run}`, purpose: 'kitchen' }));
      await screen.page.goto(`${BASE()}/kitchen`);
      await screen.page.waitForLoadState('networkidle');
      await screen.page.fill('input[name=code]', pairing.code.toLowerCase());
      await screen.page.click('button[type=submit]');
      await screen.page.waitForSelector('[data-testid=kitchen-screen]');
      await showTicket(screen.page, ticket.id);
      const bill = card(screen.page, ticket.id).getByTestId('ticket-bill');
      await bill.waitFor();
      expect(await bill.locator('[data-bill-line=adjustment]').innerText()).toContain(offerLabel);
      expect(await bill.locator('[data-bill-line=surcharge]').innerText()).toContain(surchargeLabel);
      expect(await bill.locator('[data-bill-line=surcharge]').innerText()).toContain('$0.80');
      expect(await bill.locator('[data-bill-notice]').innerText()).toBe(surcharge.notice);
      expect(screen.problems).toEqual([]);
      await screen.context.close();
    } finally {
      // Nothing of this is left for the scenarios that follow.
      await asStaff('diner', 'manager', (ctx) => offers.switchOffer(ctx, offer.id, false));
      await asStaff('diner', 'manager', (ctx) => offers.deleteSurcharge(ctx, surcharge.id));
      await v.context.close();
    }
  });
});
