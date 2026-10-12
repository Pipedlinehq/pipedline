import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type Principal, drainJobs, setModule } from '@ros/core';
import { menu, ordering } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff, siteUrl, waitForMessage } from './helpers';
import { closeOpsApp, devPost, opsApp } from './ops-helpers';

/**
 * Orders, wave 2 (docs/CONSOLE_IA.md section 9; patterns 2, 7 and 10): the three status axes
 * and "Came from" as badges and filters; "Didn't finish" with the one nudge sent from the console
 * and the Recovered mark when the guest pays after all; a phone order built by hand, its pay
 * link, and the guest paying the whole amount on the venue's own page. Every write is read back.
 */

afterAll(async () => {
  await closeOpsApp();
  await closeBrowser();
  await closeDb();
});

const run = Date.now().toString(36);
const WORKER: Principal = { kind: 'worker', job: 'e2e' };

interface DevOrder {
  orderId: string;
  reference: string;
}
const placeOrder = (venueId: string, over: Record<string, unknown> = {}) => devPost<DevOrder>('order', { venueId, ...over });
const orderRow = (id: string) => db().selectFrom('orders').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

/** The items a plain form can pick: available, no required choice. */
async function plainItems(orgId: string, venueId: string) {
  const app = await opsApp();
  return app.tenant(orgId, { kind: 'anon' }, async (ctx) => {
    const m = await menu.getPublicMenu(ctx, venueId, { surface: 'online' });
    return m.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable && i.modifierGroups.every((g) => g.minSelections === 0));
  });
}

describe('console: order status axes and "Came from"', () => {
  it('a paid website order shows its four badges, and each axis is a filter token that keeps or drops it', async () => {
    const diner = await orgBySlug('oak-diner');
    const order = await placeOrder(diner.venueId, { guestName: `Axel Axes ${run}`, guestEmail: `axes.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&money=paid&source=website`);
    const row = v.page.getByTestId(`order-${order.reference}`);
    await row.waitFor();
    expect(await row.getAttribute('data-kitchen')).toBe('new');
    expect(await row.getAttribute('data-money')).toBe('paid');
    expect(await row.getAttribute('data-source')).toBe('website');
    expect(await row.locator('[data-axis=kitchen]').innerText()).toBe('New');
    expect(await row.locator('[data-axis=money]').innerText()).toBe('Paid');
    expect(await row.locator('[data-axis=leaves]').innerText()).toBe('Pickup');
    expect(await row.locator('[data-axis=source]').innerText()).toBe('Website');
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain('Paid');
    expect(await v.page.getByTestId('view-tokens').innerText()).toContain('Website');

    // A kitchen axis it is not on drops it; "Came from" the phone drops it.
    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&kitchen=collected`);
    await v.page.getByTestId('views-orders').waitFor();
    expect(await v.page.getByTestId(`order-${order.reference}`).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/orders?view=all&f=1&source=phone`);
    await v.page.getByTestId('views-orders').waitFor();
    expect(await v.page.getByTestId(`order-${order.reference}`).count()).toBe(0);
    // The default views are there, "Unpaid" among them.
    const tabs = await v.page.locator('[data-testid^=view-tab-]').allInnerTexts();
    for (const label of ['Needs accepting', 'In the kitchen', 'Ready', 'Today', 'All', 'Unpaid', "Didn't finish", 'Phone and function orders']) expect(tabs).toContain(label);

    // The order's own page carries the same badges and where it came from.
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    const axes = v.page.getByTestId('order-axes');
    await axes.waitFor();
    expect(await axes.locator('[data-axis=source]').innerText()).toBe('Website');
    expect(await v.page.getByText('Came from', { exact: true }).count()).toBe(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});

describe("console: didn't finish", () => {
  it('an unpaid order with a contact is listed after the threshold; a host sends the one nudge from the console; the guest pays and the row says Recovered', async () => {
    const diner = await orgBySlug('oak-diner');
    const app = await opsApp();
    // The threshold is a setting; one minute keeps the wait short.
    await app.tenant(diner.orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: diner.venueId, config: { abandoned_after_minutes: 1 } as never }));
    const email = `left.${run}@example.com`;
    const items = await plainItems(diner.orgId, diner.venueId);
    const sessionId = randomUUID();
    const anon: Principal = { kind: 'anon', sessionId };
    const started = await app.tenant(diner.orgId, anon, (ctx) =>
      ordering.createOrder(ctx, { venueId: diner.venueId, channel: 'pickup', lines: [{ menuItemId: items[0]!.id, qty: 1 }], idempotencyKey: `e2e-unfinished-${randomUUID()}`, customer: { name: 'Lee Left', email }, sessionId }),
    );
    try {
      // Not yet: the check runs at the threshold. Then it is marked, and the record says so.
      expect((await orderRow(started.id)).abandoned_at).toBeNull();
      const marked = await eventually(
        async () => {
          await drainJobs(app, { kinds: ['ordering.detect_abandoned'] });
          const r = await orderRow(started.id);
          return r.abandoned_at ? r : null;
        },
        'the order counted as unfinished',
        90_000,
      );
      expect(marked.status).toBe('pending_payment');
      const abandonedEvent = await db().selectFrom('events').select('name').where('name', '=', 'order.abandoned').where(sql<boolean>`properties->>'order_id' = ${started.id}`).execute();
      expect(abandonedEvent).toHaveLength(1);

      const v = await newVisitor();
      await signInStaff(v.page, 'host@oak-diner.test');
      await v.page.goto(`${BASE()}/console/orders?view=unfinished`);
      const row = v.page.getByTestId(`unfinished-${started.reference}`);
      await row.waitFor();
      expect(await row.getByTestId(`email-status-${started.reference}`).innerText()).toContain('Not sent');
      expect(await row.getByTestId(`recovery-status-${started.reference}`).innerText()).toContain('Not recovered');
      expect(await row.innerText()).toContain('Can still be paid');

      await row.getByTestId(`nudge-${started.reference}`).click();
      const dialog = v.page.locator('dialog[open]');
      await dialog.waitFor();
      expect(await dialog.innerText()).toContain('the only nudge they will get');
      await dialog.getByRole('button', { name: 'Send the nudge', exact: true }).click();
      // Said in the dialog, or in the flash if the refresh took the dialog away first.
      await v.page.getByText(/A nudge about order .* is on its way by email/).first().waitFor();
      const nudged = await eventually(async () => {
        const r = await orderRow(started.id);
        return r.nudge_sent_at ? r : null;
      }, 'the nudge recorded');
      expect(nudged.nudge_status).toBe('queued');
      const message = await db().selectFrom('messages').selectAll().where('idempotency_key', '=', `order:${started.id}:nudge`).executeTakeFirstOrThrow();
      expect(message).toMatchObject({ kind: 'transactional', template_key: 'order.nudge', to_address: email, customer_id: nudged.customer_id });
      const sent = await waitForMessage(email, (m) => /was not finished/.test(m.subject ?? ''));
      expect(sent.body).toContain(`Finish paying here:`);
      expect(sent.body).toContain(`/order/t/${nudged.tracking_token}`);
      expect(sent.body).not.toMatch(/unsubscribe/i);
      const audited = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_id', '=', started.id).where('action', '=', 'order.nudge_sent').execute();
      expect(audited).toEqual([{ action: 'order.nudge_sent', actor_kind: 'staff' }]);
      // No consent was recorded for the guest because of it.
      expect(await db().selectFrom('consents').select('id').where('customer_id', '=', nudged.customer_id!).execute()).toEqual([]);
      // The row now says the nudge went, and offers no second one.
      await v.page.reload();
      await row.waitFor();
      expect(await row.getByTestId(`email-status-${started.reference}`).innerText()).toContain('Sent');
      expect(await row.getByTestId(`nudge-${started.reference}`).count()).toBe(0);

      // The guest comes back and pays: recovered.
      const paid = await ordering.payOrder(app, { orgId: diner.orgId, principal: anon }, { trackingToken: started.trackingToken!, sourceToken: `tok_sim_ok:e2e-left-${run}` });
      expect(paid.status).toBe('paid');
      expect((await orderRow(started.id)).recovered_at).not.toBeNull();
      await v.page.reload();
      await row.waitFor();
      expect(await row.getAttribute('data-recovered')).toBe('true');
      expect(await row.getByTestId(`recovery-status-${started.reference}`).innerText()).toContain('Recovered');
      expect(v.problems).toEqual([]);
      await v.context.close();
    } finally {
      await app.tenant(diner.orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: diner.venueId, config: { abandoned_after_minutes: 10 } as never }));
    }
  });
});

describe('console: phone and function orders', () => {
  it('a manager builds an order by hand with a custom item, sends the pay link, and the guest pays the whole amount on the venue\'s own page', async () => {
    const diner = await orgBySlug('oak-diner');
    const email = `fran.${run}@example.com`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders?view=drafts`);
    await v.page.getByRole('button', { name: 'New phone or function order' }).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.waitFor();
    await dialog.getByTestId('draft-name').fill(`Fran Function ${run}`);
    await dialog.getByTestId('draft-email').fill(email);
    await dialog.getByTestId('draft-wanted').fill('2026-10-09T18:30');
    await dialog.getByTestId('draft-item-0').selectOption({ index: 1 });
    const itemId = await dialog.getByTestId('draft-item-0').inputValue();
    await dialog.getByTestId('draft-qty-0').fill('2');
    await dialog.getByTestId('draft-custom-name').fill('Birthday cake');
    await dialog.getByTestId('draft-custom-price').fill('45.00');
    await dialog.getByRole('button', { name: 'Build the order' }).click();
    await dialog.getByText(/Order \w+ built: \$/).waitFor();

    const item = await db().selectFrom('menu_items').select('price_cents').where('id', '=', itemId).executeTakeFirstOrThrow();
    const draft = await eventually(() => db().selectFrom('orders').selectAll().where('customer_email', '=', email).executeTakeFirst(), 'the draft row');
    expect(draft).toMatchObject({ status: 'draft', payment_status: 'unpaid', source: 'phone', channel: 'pickup', item_count: 3, total_cents: item.price_cents * 2 + 4500, promised_at: new Date('2026-10-09T07:30:00.000Z') });
    const lines = await db().selectFrom('order_items').select(['menu_item_id', 'name_snapshot', 'unit_price_cents', 'qty']).where('order_id', '=', draft.id).orderBy('line_no').execute();
    expect(lines[1]).toEqual({ menu_item_id: null, name_snapshot: 'Birthday cake', unit_price_cents: 4500, qty: 1 });
    expect(lines[0]).toMatchObject({ menu_item_id: itemId, unit_price_cents: item.price_cents, qty: 2 });
    expect(await db().selectFrom('audit_log').select('action').where('entity_id', '=', draft.id).execute()).toEqual([{ action: 'order.draft_created' }]);

    // It sits in the drafts view as due, from the phone; the pay link goes from the row.
    await v.page.keyboard.press('Escape');
    await v.page.goto(`${BASE()}/console/orders?view=drafts`);
    const row = v.page.getByTestId(`draft-${draft.reference}`);
    await row.waitFor();
    expect(await row.locator('[data-axis=money]').innerText()).toBe('Due');
    expect(await row.locator('[data-axis=kitchen]').innerText()).toBe('Not with the kitchen yet');
    await row.getByTestId(`paylink-${draft.reference}`).click();
    const confirm = v.page.locator('dialog[open]');
    await confirm.waitFor();
    expect(await confirm.innerText()).toContain('pays the full');
    await confirm.getByRole('button', { name: 'Send the pay link', exact: true }).click();
    await v.page.getByText(/A pay link for order .* is on its way by email/).first().waitFor();
    const linked = await eventually(async () => {
      const r = await orderRow(draft.id);
      return r.pay_link_sent_at ? r : null;
    }, 'the pay link recorded');
    expect(linked.status).toBe('pending_payment');
    const mail = await waitForMessage(email, (m) => /^Pay for your order/.test(m.subject ?? ''));
    const payUrl = /Pay here: (\S+)/.exec(mail.body)![1]!;
    expect(payUrl).toContain(`/order/t/${linked.tracking_token}`);
    expect(mail.body).toContain('Birthday cake');

    // The guest opens the link on the venue's site and pays with a test card: the same checkout every online order uses.
    const g = await newVisitor();
    await g.page.goto(siteUrl('oak-diner', new URL(payUrl).pathname));
    await g.page.getByRole('heading', { name: /^Pay \$/ }).waitFor();
    await g.page.click('label:has-text("Test card A")');
    await g.page.getByRole('button', { name: /^Pay \$/ }).click();
    await g.page.locator('h1[data-status=placed]').waitFor();
    const paid = await eventually(async () => {
      const r = await orderRow(draft.id);
      return r.payment_status === 'paid' ? r : null;
    }, 'the phone order paid');
    expect(paid).toMatchObject({ status: 'placed', payment_status: 'paid', source: 'phone', paid_by: null });
    expect(await db().selectFrom('payments').select(['provider', 'status', 'amount_cents']).where('order_id', '=', draft.id).execute()).toEqual([{ provider: 'sim-pay', status: 'completed', amount_cents: draft.total_cents }]);
    expect(await db().selectFrom('transactions').select(['total_cents', 'tender_type']).where('order_id', '=', draft.id).execute()).toEqual([{ total_cents: draft.total_cents, tender_type: 'card' }]);
    expect(await db().selectFrom('kitchen_tickets').select('id').where('order_id', '=', draft.id).execute()).toHaveLength(1);
    expect(g.problems).toEqual([]);
    await g.context.close();

    // Back in the console: paid, from the phone, in the kitchen's list, with the steps on its timeline.
    await v.page.goto(`${BASE()}/console/orders/${draft.id}`);
    const axes = v.page.getByTestId('order-axes');
    await axes.waitFor();
    expect(await axes.locator('[data-axis=money]').innerText()).toBe('Paid');
    expect(await axes.locator('[data-axis=source]').innerText()).toBe('Phone');
    expect(await axes.locator('[data-axis=kitchen]').innerText()).toBe('New');
    const timeline = v.page.getByTestId('order-timeline');
    await timeline.waitFor();
    const words = await timeline.innerText();
    expect(words).toContain('Built by staff');
    expect(words).toContain('Pay link sent');
    expect(await v.page.getByText('Custom item', { exact: true }).count()).toBe(1);
    expect(await v.page.getByTestId('draft-actions').count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a host may not add a custom item: the form has no custom item fields, and the service refuses one anyway', async () => {
    const diner = await orgBySlug('oak-diner');
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders?view=drafts`);
    await v.page.getByRole('button', { name: 'New phone or function order' }).click();
    const dialog = v.page.locator('dialog[open]');
    await dialog.waitFor();
    expect(await dialog.getByTestId('draft-custom-name').count()).toBe(0);
    await v.page.keyboard.press('Escape');
    // The Bookings "Didn't finish" view is there too, and says why it is empty or what it holds.
    await v.page.goto(`${BASE()}/console/bookings?view=unfinished`);
    await v.page.getByTestId('views-bookings').waitFor();
    expect(await v.page.getByText(/Booking requests the venue did not answer in time|Every request was answered in time/).count()).toBeGreaterThan(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
    // The service refuses the custom item for the host too, before anything is written.
    const app = await opsApp();
    const user = await db().selectFrom('users').select('id').where('email', '=', 'host@oak-diner.test').executeTakeFirstOrThrow();
    const staff = await db().selectFrom('staff').select('id').where('org_id', '=', diner.orgId).where('email', '=', 'host@oak-diner.test').executeTakeFirstOrThrow();
    const hostPrincipal: Principal = { kind: 'staff', staffId: staff.id, userId: user.id, isOwner: false, venueRoles: { [diner.venueId]: 'front_of_house' } };
    await expect(
      app.tenant(diner.orgId, hostPrincipal, (ctx) => ordering.createDraftOrder(ctx, { venueId: diner.venueId, customItems: [{ name: 'Cake', priceCents: 1000 }], customer: { name: `No Custom ${run}` } })),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await db().selectFrom('orders').select('id').where('customer_name', '=', `No Custom ${run}`).execute()).toEqual([]);
  });
});
