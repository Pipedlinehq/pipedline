import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvals, menu, ordering } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { E2E_CLOCK_START } from './global-setup';
import { BASE, closeBrowser, closeDb, db, newVisitor, orgBySlug, signInStaff } from './helpers';

/**
 * Orders in the console: a new paid order is accepted from the live list, then part of it is
 * refunded from the order page through the confirmation dialog. The database is read back for
 * the order's status and history, the refund, the ledger row and the audit log.
 *
 * The order is placed the way a guest's browser would place it (createOrder then payOrder with a
 * simulated card), from this process, because the guest-facing checkout pages are not part of
 * the console. Everything the staff member does goes through the console UI.
 */

let order: { id: string; reference: string; totalCents: number };

beforeAll(async () => {
  const diner = await orgBySlug('oak-diner');
  // At the start of the e2e clock the venue is mid dinner service, so an ASAP pickup is allowed.
  const clock = fakeClock(new Date(new Date(E2E_CLOCK_START).getTime() + 60_000));
  const t = createTestApp(process.env.E2E_DATABASE_URL!, { clock, config: configFromEnv() });
  try {
    const sessionId = randomUUID();
    const anon = { kind: 'anon' as const, sessionId };
    const items = await t.app.tenant(diner.orgId, anon, async (ctx) => {
      const m = await menu.getPublicMenu(ctx, diner.venueId, { surface: 'online' });
      return m.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable && i.modifierGroups.every((g) => g.minSelections === 0));
    });
    expect(items.length).toBeGreaterThan(1);
    const created = await t.app.tenant(diner.orgId, anon, (ctx) =>
      ordering.createOrder(ctx, {
        venueId: diner.venueId,
        channel: 'pickup',
        lines: [
          { menuItemId: items[0]!.id, qty: 2 },
          { menuItemId: items[1]!.id, qty: 1 },
        ],
        idempotencyKey: `e2e-console-orders-${randomUUID()}`,
        customer: { name: 'Robin Refund', email: `robin.refund.${Date.now()}@example.com` },
        note: '<b>Please</b> knock twice',
        sessionId,
      }),
    );
    const paid = await ordering.payOrder(t.app, { orgId: diner.orgId, principal: anon }, { trackingToken: created.trackingToken!, sourceToken: 'tok_sim_ok:e2e-robin' });
    expect(paid.status).toBe('paid');
    order = { id: created.id, reference: created.reference, totalCents: created.totalCents };
  } finally {
    await t.close();
  }
});

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: orders', () => {
  it('a manager accepts a new order from the live list, then refunds part of it with a reason', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');

    await v.page.goto(`${BASE()}/console/orders`);
    const row = v.page.getByTestId(`order-${order.reference}`);
    await row.getByText('New', { exact: true }).waitFor();
    await row.getByRole('button', { name: 'Accept' }).click();
    await row.getByText('Accepted', { exact: true }).waitFor();

    const accepted = await db().selectFrom('orders').select(['status', 'accepted_at']).where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(accepted.status).toBe('accepted');
    expect(accepted.accepted_at).not.toBeNull();
    const history = await db().selectFrom('order_status_history').select(['from_status', 'to_status', 'by_kind']).where('order_id', '=', order.id).where('to_status', '=', 'accepted').executeTakeFirstOrThrow();
    expect(history).toEqual({ from_status: 'placed', to_status: 'accepted', by_kind: 'staff' });

    // The guest's note is shown as text, never as markup.
    await v.page.goto(`${BASE()}/console/orders/${order.id}`);
    await v.page.getByText('<b>Please</b> knock twice').waitFor();
    expect(await v.page.locator('main b', { hasText: 'Please' }).count()).toBe(0);

    await v.page.getByTestId('refund').click();
    const dialog = v.page.getByRole('dialog', { name: `Refund order ${order.reference}` });
    await dialog.getByText('cannot be undone').waitFor();
    await dialog.locator('input[name=amount]').fill('5.00');
    await dialog.locator('textarea[name=reason]').fill('One item was missing.');
    await dialog.getByRole('button', { name: 'Send refund' }).click();
    await dialog.getByText('Refunded $5.00').waitFor();

    const refund = await db().selectFrom('refunds').select(['amount_cents', 'status', 'reason', 'staff_id']).where('order_id', '=', order.id).executeTakeFirstOrThrow();
    expect(refund).toMatchObject({ amount_cents: 500, status: 'completed', reason: 'One item was missing.' });
    expect(refund.staff_id).not.toBeNull();
    const o = await db().selectFrom('orders').select(['payment_status', 'status', 'transaction_id']).where('id', '=', order.id).executeTakeFirstOrThrow();
    expect(o).toMatchObject({ payment_status: 'partially_refunded', status: 'accepted' });
    // The ledger row for the sale follows the refund.
    const txn = await db().selectFrom('transactions').select(['refunded_cents', 'total_cents']).where('id', '=', o.transaction_id!).executeTakeFirstOrThrow();
    expect(txn.refunded_cents).toBe(500);
    expect(txn.total_cents).toBe(order.totalCents);
    // Both the request and the outcome are on the audit log, with the staff member as the actor.
    const audits = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_id', '=', order.id).orderBy('occurred_at').execute();
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['order.refund_requested', 'order.refunded']));
    expect(audits.filter((a) => a.action.startsWith('order.refund')).every((a) => a.actor_kind === 'staff')).toBe(true);

    // Reloaded, the page offers only what is left.
    await v.page.goto(`${BASE()}/console/orders/${order.id}`);
    await v.page.getByText(`Up to $${((order.totalCents - 500) / 100).toFixed(2)} can go back`).waitFor();
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a front-of-house host can move the order along but is not offered a refund', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/orders/${order.id}`);
    await v.page.getByRole('heading', { name: `Order ${order.reference}` }).waitFor();
    expect(await v.page.getByTestId('refund').count()).toBe(0);
    expect(await v.page.getByRole('button', { name: 'Start preparing' }).count()).toBe(1);
    const before = await db().selectFrom('refunds').select('id').where('order_id', '=', order.id).execute();
    expect(before).toHaveLength(1);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('read-only staff see orders with no controls; another org\'s order is not found', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'accounts@oak-group.test');
    await v.page.goto(`${BASE()}/console/orders?view=all`);
    await v.page.getByRole('heading', { name: 'Orders' }).waitFor();
    expect(await v.page.getByRole('button', { name: /Accept|Start preparing|Mark ready|Complete|Reject/ }).count()).toBe(0);
    // The diner's order, asked for by id from the group's console, does not exist there.
    await v.page.goto(`${BASE()}/console/orders/${order.id}`);
    await v.page.getByText('That is not here').waitFor();
    expect(v.problems).toEqual([]);
    expect(await v.page.getByText('Robin Refund').count()).toBe(0);
    await v.context.close();
  });
});

describe('console: approvals', () => {
  it('a manager approves a waiting item after reading exactly what will happen; the decision is recorded', async () => {
    // Something asks for a yes the way a campaign or an assistant would: a pending approval in plain words.
    const diner = await orgBySlug('oak-diner');
    const t = createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(new Date(E2E_CLOCK_START)), config: configFromEnv() });
    let approvalId: string;
    const summary = `Send the "Friday special" email to 42 guests who agreed to marketing (${Date.now()})`;
    try {
      approvals.onApprovalDecided('e2e.console_demo', async () => {});
      const a = await t.app.tenant(diner.orgId, { kind: 'worker', job: 'e2e' }, (ctx) =>
        approvals.requestApproval(ctx, { kind: 'e2e.console_demo', subjectType: 'e2e', subjectId: randomUUID(), summary, venueId: diner.venueId }),
      );
      approvalId = a.id;
    } finally {
      await t.close();
    }

    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/approvals`);
    await v.page.getByText(summary).first().waitFor();
    await v.page.getByTestId(`approve-${approvalId}`).click();
    const dialog = v.page.getByRole('dialog', { name: 'Approve this?' }).filter({ hasText: summary });
    await dialog.locator('textarea[name=reason]').fill('Looks right');
    await dialog.getByRole('button', { name: 'Approve' }).click();
    await v.page.getByText('Nothing is waiting for you').waitFor();

    const row = await db().selectFrom('approvals').select(['status', 'decision_note', 'decided_by_staff_id']).where('id', '=', approvalId).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'approved', decision_note: 'Looks right' });
    expect(row.decided_by_staff_id).not.toBeNull();
    expect(await db().selectFrom('audit_log').select('actor_kind').where('entity_id', '=', approvalId).where('action', '=', 'approval.approved').executeTakeFirstOrThrow()).toEqual({ actor_kind: 'staff' });
    expect(v.problems).toEqual([]);
    await v.context.close();

    // A host is not a decider: the screen says so rather than offering buttons.
    const h = await newVisitor();
    await signInStaff(h.page, 'host@oak-diner.test');
    await h.page.goto(`${BASE()}/console/approvals`);
    await h.page.getByText('Your role does not include this').waitFor();
    expect(h.problems).toEqual([]);
    await h.context.close();
  });
});
