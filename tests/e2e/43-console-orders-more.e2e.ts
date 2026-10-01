import { mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ordering } from '@ros/modules';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff, waitForMessage } from './helpers';
import { SHOTS, closeOpsApp, devPost, opsApp, pairKitchenScreen, realProblems, showKitchenTicket } from './ops-helpers';

/**
 * Orders, beyond the happy path: a new order turned down from the console and from the kitchen
 * screen (the refund follows by itself and the guest is told why), the order's timeline listing
 * every refund, and orders flagged for a person to look at.
 */

interface DevOrder {
  orderId: string;
  reference: string;
}

const run = Date.now().toString(36);
const placeOrder = (venueId: string, over: Record<string, unknown> = {}) => devPost<DevOrder>('order', { venueId, ...over });
const orderRow = (id: string) => db().selectFrom('orders').select(['status', 'payment_status', 'rejected_reason', 'total_cents', 'attention_at', 'attention_reason']).where('id', '=', id).executeTakeFirstOrThrow();
const refundsOf = (id: string) => db().selectFrom('refunds').select(['id', 'amount_cents', 'status', 'reason', 'staff_id']).where('order_id', '=', id).orderBy('created_at').execute();

beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

afterAll(async () => {
  await closeBrowser();
  await closeOpsApp();
  await closeDb();
});

describe('console and kitchen: turning an order down', () => {
  it('a manager rejects a new paid order from the live list: it is refunded in full by itself and the guest is told the reason', async () => {
    const diner = await orgBySlug('oak-diner');
    const email = `reject.console.${run}@example.com`;
    const order = await placeOrder(diner.venueId, { guestName: 'Rita Rejected', guestEmail: email });
    const reason = 'We have sold out of the burrata tonight.';

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders`);
    const row = v.page.getByTestId(`order-${order.reference}`);
    await row.getByText('New', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Reject' }).click();
    const dialog = v.page.getByRole('dialog', { name: `Reject order ${order.reference}` });
    await dialog.getByText('is refunded in full').waitFor();
    await dialog.locator('textarea[name=reason]').fill(reason);
    await dialog.getByRole('button', { name: 'Reject and refund' }).click();
    // A rejected order leaves the live list, and its dialog with it. The outcome is still said.
    await v.page.getByTestId('console-flash').getByText(`Order ${order.reference} rejected. The guest has been told why and their payment is being refunded.`).waitFor();
    await v.page.screenshot({ path: `${SHOTS}/console-flash.png` });
    await row.waitFor({ state: 'detached' });

    const rejected = await orderRow(order.orderId);
    expect(rejected).toMatchObject({ status: 'rejected', rejected_reason: reason });
    const history = await db().selectFrom('order_status_history').select(['from_status', 'to_status', 'by_kind']).where('order_id', '=', order.orderId).where('to_status', '=', 'rejected').executeTakeFirstOrThrow();
    expect(history).toEqual({ from_status: 'placed', to_status: 'rejected', by_kind: 'staff' });

    // The refund is a consequence, made by the worker with a key of its own: one refund, the whole amount.
    const refunds = await eventually(async () => {
      const rows = await refundsOf(order.orderId);
      return rows.length && rows.every((r) => r.status === 'completed') ? rows : null;
    }, 'the refund that follows a rejection', 30_000);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ amount_cents: rejected.total_cents, status: 'completed', staff_id: null });
    expect((await orderRow(order.orderId)).payment_status).toBe('refunded');
    const txn = await db().selectFrom('transactions').select(['refunded_cents', 'total_cents', 'status']).where('order_id', '=', order.orderId).executeTakeFirstOrThrow();
    expect(txn.refunded_cents).toBe(txn.total_cents);

    // The guest hears why, in the venue's own words.
    const told = await waitForMessage(email, (m) => m.body.includes(reason));
    expect(told.body).toMatch(/refunded in full/i);

    // The kitchen no longer has it.
    const ticket = await db().selectFrom('kitchen_tickets').select('status').where('order_id', '=', order.orderId).executeTakeFirst();
    expect(ticket?.status).toBe('cancelled');

    // The order's own page tells the story in order, the refund included.
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    const refundLine = v.page.locator('[data-testid=order-timeline] [data-kind=refund]');
    await refundLine.first().waitFor();
    expect(await refundLine.count()).toBe(1);
    expect(await refundLine.first().innerText()).toContain(`Refunded $${(rejected.total_cents / 100).toFixed(2)}`);
    expect(await refundLine.first().innerText()).toContain('Sent automatically');
    expect(await refundLine.first().innerText()).toContain(reason);
    // Nothing more can be done to it.
    expect(await v.page.getByRole('button', { name: /Accept|Reject|Cancel order|Refund/ }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('the kitchen screen rejects a new order with a reason the guest can read; the refund follows', async () => {
    const diner = await orgBySlug('oak-diner');
    const email = `reject.kitchen.${run}@example.com`;
    const v = await newVisitor();
    await v.page.setViewportSize({ width: 1280, height: 800 });
    await pairKitchenScreen(v.page, diner.venueId, `Reject screen ${run}`);
    const order = await placeOrder(diner.venueId, { guestName: 'Kim Kitchenreject', guestEmail: email });
    const ticket = await eventually(() => db().selectFrom('kitchen_tickets').select(['id', 'ticket_number']).where('order_id', '=', order.orderId).executeTakeFirst(), 'the kitchen ticket');
    await showKitchenTicket(v.page, ticket.id);

    await v.page.locator(`[data-testid=ticket][data-ticket-id="${ticket.id}"] [data-action=reject]`).click();
    const panel = v.page.getByRole('dialog', { name: `Reject order #${ticket.ticket_number}?` });
    await panel.getByText('The guest is refunded in full and sees the reason you choose.').waitFor();
    const reason = 'The kitchen is too busy to take this order right now.';
    await panel.getByRole('button', { name: reason }).click();
    await v.page.getByText(`Order #${ticket.ticket_number} rejected. The guest is refunded and told why.`).waitFor();

    const rejected = await orderRow(order.orderId);
    expect(rejected).toMatchObject({ status: 'rejected', rejected_reason: reason });
    // It was the screen, not a person, that turned it down, and the record says so.
    const history = await db().selectFrom('order_status_history').select(['to_status', 'by_kind']).where('order_id', '=', order.orderId).where('to_status', '=', 'rejected').executeTakeFirstOrThrow();
    expect(history.by_kind).toBe('device');
    const refunds = await eventually(async () => {
      const rows = await refundsOf(order.orderId);
      return rows.length && rows.every((r) => r.status === 'completed') ? rows : null;
    }, 'the refund that follows the kitchen rejecting', 30_000);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amount_cents).toBe(rejected.total_cents);
    expect((await orderRow(order.orderId)).payment_status).toBe('refunded');
    await waitForMessage(email, (m) => m.body.includes(reason));
    // The ticket leaves the screen on its next poll.
    await v.page.locator(`[data-testid=ticket][data-ticket-id="${ticket.id}"]`).waitFor({ state: 'detached', timeout: 15_000 });
    expect(realProblems(v.problems)).toEqual([]);
    await v.context.close();
  });

  it('on an 800px-tall tablet every button fits its ticket, and a long ticket scrolls inside the card with its next step still on screen', async () => {
    const group = await orgBySlug('oak-group');
    const cbd = group.venues.find((x) => x.slug === 'cbd')!;
    const v = await newVisitor();
    await v.page.setViewportSize({ width: 1280, height: 800 });
    await pairKitchenScreen(v.page, cbd.id, `Tablet ${run}`);
    const note = 'Severe peanut allergy at this table, please check every sauce. Birthday: candle on the dessert, and the grandparents would like theirs served first if at all possible. Thank you so much!';
    const menuNames = (await db().selectFrom('menu_items as i').innerJoin('menu_sections as s', 's.id', 'i.section_id').innerJoin('menus as m', 'm.id', 's.menu_id').select('i.name').where('m.venue_id', '=', cbd.id).where('i.is_alcohol', '=', false).execute()).map((r) => r.name);
    // As many different dishes as the dev tool will take, so the ticket is longer than the card.
    let long: DevOrder | null = null;
    for (const n of [8, 6, 4, 3]) {
      long = await placeOrder(cbd.id, { guestName: 'Lena Longticket', note, items: menuNames.slice(0, n) }).catch(() => null);
      if (long) break;
    }
    long ??= await placeOrder(cbd.id, { guestName: 'Lena Longticket', note });
    const ticket = await eventually(() => db().selectFrom('kitchen_tickets').select(['id']).where('order_id', '=', long!.orderId).executeTakeFirst(), 'the long ticket');
    await showKitchenTicket(v.page, ticket.id);
    await v.page.screenshot({ path: `${SHOTS}/kitchen-800-long-ticket.png`, caret: 'initial' });

    const layout = await v.page.evaluate(() => {
      const out: Array<{ id: string; clipped: string[]; outside: string[]; bodyScrolls: boolean; bodyHeight: number; more: boolean }> = [];
      for (const card of document.querySelectorAll<HTMLElement>('[data-testid=ticket]')) {
        const box = card.getBoundingClientRect();
        const clipped: string[] = [];
        const outside: string[] = [];
        for (const b of card.querySelectorAll<HTMLElement>('button')) {
          const r = b.getBoundingClientRect();
          const label = b.textContent?.trim() ?? '';
          if (b.scrollWidth > b.clientWidth + 1) clipped.push(label);
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5 || r.bottom > window.innerHeight + 0.5) outside.push(label);
        }
        const body = card.querySelector<HTMLElement>('[data-testid=ticket-body]')!;
        out.push({ id: card.dataset.ticketId!, clipped, outside, bodyScrolls: body.scrollHeight > body.clientHeight + 4, bodyHeight: body.clientHeight, more: !!card.querySelector('[data-testid=ticket-more]') });
      }
      return { cards: out, pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 1 };
    });
    expect(layout.pageScrolls).toBe(false);
    expect(layout.cards.length).toBeGreaterThan(0);
    for (const c of layout.cards) {
      expect(c.clipped, `a button's label is cut off on ticket ${c.id}`).toEqual([]);
      expect(c.outside, `a button is outside its card on ticket ${c.id}`).toEqual([]);
      // The scrolling part never collapses to nothing, and says so when there is more below.
      expect(c.bodyHeight).toBeGreaterThanOrEqual(90);
      expect(c.more).toBe(c.bodyScrolls);
    }
    const mine = layout.cards.find((c) => c.id === ticket.id)!;
    expect(mine.bodyScrolls).toBe(true);
    // The guest's note is at the top of the card's scrolling part, in view without scrolling.
    const noteBox = await v.page.locator(`[data-ticket-id="${ticket.id}"] [data-testid=ticket-note]`).boundingBox();
    const bodyBox = await v.page.locator(`[data-ticket-id="${ticket.id}"] [data-testid=ticket-body]`).boundingBox();
    expect(noteBox!.y).toBeGreaterThanOrEqual(bodyBox!.y - 1);
    expect(noteBox!.y).toBeLessThan(bodyBox!.y + bodyBox!.height);
    expect(realProblems(v.problems)).toEqual([]);
    await v.context.close();
  });
});

describe('console: the order timeline and orders that need attention', () => {
  it('the timeline lists each refund in order: a part refund a manager sent, then the rest sent automatically when the order is cancelled', async () => {
    const diner = await orgBySlug('oak-diner');
    const order = await placeOrder(diner.venueId, { guestName: 'Tim Timeline', guestEmail: `timeline.${run}@example.com` });
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    await v.page.getByTestId('advance').getByRole('button', { name: 'Accept' }).click();
    await v.page.getByRole('button', { name: 'Start preparing' }).waitFor();

    await v.page.getByTestId('refund').click();
    const refund = v.page.getByRole('dialog', { name: `Refund order ${order.reference}` });
    await refund.locator('input[name=amount]').fill('2.00');
    await refund.locator('textarea[name=reason]').fill('A sauce was left out.');
    await refund.getByRole('button', { name: 'Send refund' }).click();
    await refund.getByText('Refunded $2.00').waitFor();
    await refund.getByRole('button', { name: 'Close' }).last().click();

    const lines = v.page.locator('[data-testid=order-timeline] [data-kind=refund]');
    await lines.first().waitFor();
    expect(await lines.count()).toBe(1);
    expect(await lines.first().innerText()).toMatch(/Refunded \$2\.00[\s\S]*Sent by Morgan Manager[\s\S]*A sauce was left out\./);

    await v.page.getByRole('button', { name: 'Cancel order' }).click();
    const cancel = v.page.getByRole('dialog', { name: `Cancel order ${order.reference}` });
    await cancel.getByText('goes back to their card').waitFor();
    await cancel.locator('textarea[name=reason]').fill('The kitchen had to close early tonight.');
    await cancel.getByRole('button', { name: 'Cancel and refund' }).click();
    await eventually(async () => {
      const rows = await refundsOf(order.orderId);
      return rows.length === 2 && rows.every((r) => r.status === 'completed');
    }, 'the automatic refund of the rest', 30_000);

    const o = await orderRow(order.orderId);
    const rows = await refundsOf(order.orderId);
    expect(rows.map((r) => r.amount_cents)).toEqual([200, o.total_cents - 200]);
    expect(rows[0]!.staff_id).not.toBeNull();
    expect(rows[1]!.staff_id).toBeNull();

    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    await lines.nth(1).waitFor();
    await v.page.screenshot({ path: `${SHOTS}/console-order-timeline.png`, fullPage: true });
    const texts = await lines.allInnerTexts();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Refunded $2.00');
    expect(texts[1]).toContain(`Refunded $${((o.total_cents - 200) / 100).toFixed(2)}`);
    expect(texts[1]).toContain('Sent automatically');
    expect(texts[1]).toContain('The kitchen had to close early tonight.');
    // In the order things happened: created, placed, accepted, the two refunds.
    const kinds = await v.page.locator('[data-testid=order-timeline] li').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')}:${e.textContent}`));
    expect(kinds.findIndex((k) => k.startsWith('step:Accepted'))).toBeLessThan(kinds.findIndex((k) => k.startsWith('refund:')));
    // Kitchen staff see what happened to the money as well, without the guest's contact details.
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('an order flagged for staff shows why on the orders screen; a manager marks it dealt with; front of house can read but not clear it', async () => {
    const diner = await orgBySlug('oak-diner');
    const order = await placeOrder(diner.venueId, { guestName: 'Fay Flagged', guestEmail: `flagged.${run}@example.com` });
    const reason = `The courier could not find the address and brought the food back (${run}).`;
    // The system flags an order (a failed delivery, an absorbed discount); it is not something staff do.
    const app = await opsApp();
    await app.tenant(diner.orgId, { kind: 'worker', job: 'e2e.flag' }, (ctx) => ordering.flagOrderForStaff(ctx, { orderId: order.orderId, reason }));
    expect((await orderRow(order.orderId)).attention_at).not.toBeNull();

    const host = await newVisitor();
    await signInStaff(host.page, 'host@oak-diner.test');
    await host.page.goto(`${BASE()}/console/orders`);
    await host.page.getByTestId('attention-banner').getByRole('link', { name: 'See what and why' }).click();
    await host.page.waitForURL(/view=attention/);
    const hostRow = host.page.getByTestId(`attention-${order.reference}`);
    await hostRow.getByRole('cell', { name: reason }).waitFor();
    expect(await hostRow.getByRole('button').count()).toBe(0);
    expect(host.problems).toEqual([]);
    await host.context.close();

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    await v.page.getByTestId('order-attention').getByText(reason).waitFor();
    await v.page.goto(`${BASE()}/console/orders?view=attention`);
    const row = v.page.getByTestId(`attention-${order.reference}`);
    await row.getByRole('cell', { name: reason }).waitFor();
    await v.page.screenshot({ path: `${SHOTS}/console-orders-attention.png`, fullPage: true });
    await v.page.getByTestId(`clear-attention-${order.reference}`).click();
    const dialog = v.page.getByRole('dialog', { name: `Mark ${order.reference} as dealt with?` });
    await dialog.getByText(reason).waitFor();
    await dialog.getByRole('button', { name: 'Mark as dealt with' }).click();
    await v.page.getByTestId('console-flash').getByText(`Order ${order.reference} is marked as dealt with.`).waitFor();
    await row.waitFor({ state: 'detached' });

    const cleared = await orderRow(order.orderId);
    expect(cleared.attention_at).toBeNull();
    // The words of the flag are kept, on the order and on the audit log.
    expect(cleared.attention_reason).toBe(reason);
    const audit = await db().selectFrom('audit_log').select(['actor_kind', 'before']).where('action', '=', 'order.attention_cleared').where('entity_id', '=', order.orderId).executeTakeFirstOrThrow();
    expect(audit.actor_kind).toBe('staff');
    expect((audit.before as { reason: string }).reason).toBe(reason);
    await v.page.goto(`${BASE()}/console/orders/${order.orderId}`);
    await v.page.getByRole('heading', { name: `Order ${order.reference}` }).waitFor();
    expect(await v.page.getByTestId('order-attention').count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
