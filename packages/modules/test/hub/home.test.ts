import { describe, expect, it } from 'vitest';
import { type StaffPrincipal, type ToolDef, addDays, getTool, localDate } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { approvals, bookings, hub, menu, ordering, reviews } from '@ros/modules';
import { paidOrder } from '../commerce/helpers';

/**
 * Home (pattern 8): each needs-attention count is the owning module's own list for the same
 * filters its page uses; a dismissed card stays dismissed for that person only; a suggestion
 * approved runs the tool's commit exactly once; dismissals carry a reason and stop the suggestion
 * coming back; the tools are pinned to the same functions.
 */
describe('hub: Home needs-attention, cards and suggestions', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const run = <T>(orgId: string, p: StaffPrincipal, fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(orgId, p, fn);

  it('every count matches the owning module\'s list for the fixture, and each link names the view with the same rows', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    const n = await run(diner().orgId, manager, (ctx) => hub.needsAttention(ctx, { venueId }));
    const today = localDate(t.clock(), 'Australia/Sydney');
    const expected = await run(diner().orgId, manager, async (ctx) => ({
      orders_to_accept: (await ordering.listOrders(ctx, { venueId, statuses: ['placed'], limit: 200 })).length,
      orders_flagged: (await ordering.listOrders(ctx, { venueId, needsAttention: true, limit: 200 })).length,
      bookings_to_confirm: (await bookings.listBookings(ctx, { venueId, date: today, to: addDays(today, 59), status: ['requested'] })).bookings.length,
      approvals_waiting: (await approvals.listApprovals(ctx, { status: 'pending' })).filter((a) => a.venueId === null || a.venueId === venueId).length,
      reviews_to_reply: (await reviews.listReviews(ctx, { venueId, onlyUnanswered: true, limit: 200 })).length,
      items_sold_out: (await menu.getMenuEditor(ctx, venueId, { availability: 'off' })).menus.reduce((s, m) => s + m.sections.reduce((x, sec) => x + sec.items.length, 0), 0),
    }));
    expect(Object.fromEntries(n.items.map((i) => [i.key, i.count]))).toEqual(expected);
    expect(Object.fromEntries(n.items.map((i) => [i.key, i.href]))).toEqual({
      orders_to_accept: '/console/orders?view=accepting',
      orders_flagged: '/console/orders?view=attention',
      bookings_to_confirm: '/console/bookings?view=confirming',
      approvals_waiting: '/console/approvals',
      reviews_to_reply: '/console/reviews?show=unanswered',
      items_sold_out: '/console/menu?view=soldout',
    });
    // The fixture leaves something waiting, so the strip is not empty, and the words carry the count.
    expect(n.open.length).toBeGreaterThan(0);
    for (const i of n.items) expect(i.label.startsWith(`${i.count} `)).toBe(true);
    expect(n.summary).toBe(n.open.map((i) => i.label).join(' · '));

    // A kitchen role sees orders and the menu, not the book (guests' names) or approvals (managers); nothing is shown as zero in their place.
    const kitchen = await diner().as('kitchen');
    const k = await run(diner().orgId, kitchen, (ctx) => hub.needsAttention(ctx, { venueId }));
    expect(k.items.map((i) => i.key)).toEqual(['orders_to_accept', 'orders_flagged', 'reviews_to_reply', 'items_sold_out']);
    // Another organisation's venue is not found; a venue the manager has no role at too.
    await expect(run(group().orgId, await group().as('manager'), (ctx) => hub.needsAttention(ctx, { venueId }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => hub.needsAttention(ctx, { venueId: group().venues.bondi!.id }))).rejects.toMatchObject({ code: 'not_found' });
    // Bondi is pickup only: no bookings there, so the count is left out rather than zero.
    const owner = await group().as('owner');
    const bondi = await run(group().orgId, owner, (ctx) => hub.needsAttention(ctx, { venueId: group().venues.bondi!.id }));
    expect(bondi.items.some((i) => i.key === 'bookings_to_confirm')).toBe(false);
    // The tool is the same function.
    const tool = getTool('needs_attention') as ToolDef & { run: (t: { ctx: never; venueId: string }, input: unknown) => Promise<unknown> };
    expect(tool).toMatchObject({ effect: 'read', scope: 'ops:read', venueScoped: true });
    const shaped = tool.output.parse(await run(diner().orgId, manager, (ctx) => tool.run({ ctx: ctx as never, venueId }, {}))) as { items: Array<{ key: string; count: number; console_path: string }> };
    expect(shaped.items.map((i) => [i.key, i.count, i.console_path])).toEqual(n.items.map((i) => [i.key, i.count, i.href]));
  });

  it('a card put away stays away for that person only, and a card that does not exist is not found', async () => {
    const manager = await diner().as('manager');
    const owner = await diner().as('owner');
    const before = await run(diner().orgId, manager, (ctx) => hub.homeCards(ctx));
    expect(before.map((c) => c.key)).toEqual(hub.HOME_CARDS.map((c) => c.key));
    await run(diner().orgId, manager, (ctx) => hub.dismissCard(ctx, { card: 'guide.alerts' }));
    await run(diner().orgId, manager, (ctx) => hub.dismissCard(ctx, { card: 'guide.alerts' }));
    const rows = await t.db.selectFrom('home_dismissals').selectAll().where('org_id', '=', diner().orgId).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff_id: diner().staff.manager!.staffId, card_key: 'guide.alerts' });
    expect((await run(diner().orgId, manager, (ctx) => hub.homeCards(ctx))).map((c) => c.key)).toEqual(hub.HOME_CARDS.map((c) => c.key).filter((k) => k !== 'guide.alerts'));
    expect((await run(diner().orgId, owner, (ctx) => hub.homeCards(ctx))).map((c) => c.key)).toEqual(hub.HOME_CARDS.map((c) => c.key));
    await expect(run(diner().orgId, manager, (ctx) => hub.dismissCard(ctx, { card: 'guide.nothing' }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a paid order left waiting becomes a suggestion; approving it runs order_decide\'s commit exactly once; a second approval is refused; dismissing another carries the reason', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    // Clear what the fixture leaves waiting so the suggestions are about these two orders.
    await t.db.updateTable('orders').set({ status: 'completed' }).where('venue_id', '=', venueId).where('status', '=', 'placed').execute();
    const a = await paidOrder(t, diner(), venueId);
    const b = await paidOrder(t, diner(), venueId);
    t.clock.advanceMinutes(12);
    const list = await run(diner().orgId, manager, (ctx) => hub.suggestions(ctx, { venueId }));
    const forA = list.find((s) => s.key === `ops.accept_order:${a.reference}`)!;
    const forB = list.find((s) => s.key === `ops.accept_order:${b.reference}`)!;
    expect(forA).toBeDefined();
    expect(forB).toBeDefined();
    expect(forA.action).toEqual({ tool: 'order_decide', input: { order: a.reference, decision: 'accept' }, verb: 'Accept it' });
    expect(list.length).toBeLessThanOrEqual(hub.SUGGESTION_CAP);

    const approved = await run(diner().orgId, manager, (ctx) => hub.approveSuggestion(ctx, { venueId, key: forA.key }));
    expect(approved.question).toMatch(new RegExp(`Accept order ${a.reference}`));
    const order = await t.db.selectFrom('orders').select(['status', 'accepted_at']).where('id', '=', a.id).executeTakeFirstOrThrow();
    expect(order.status).toBe('accepted');
    expect(order.accepted_at).not.toBeNull();
    const history = await t.db.selectFrom('order_status_history').select(['to_status']).where('order_id', '=', a.id).where('to_status', '=', 'accepted').execute();
    expect(history).toHaveLength(1);
    const decision = await t.db.selectFrom('home_suggestion_decisions').selectAll().where('venue_id', '=', venueId).where('suggestion_key', '=', forA.key).executeTakeFirstOrThrow();
    expect(decision).toMatchObject({ decision: 'approved', decided_by_id: diner().staff.manager!.staffId });
    expect(decision.reason).toMatch(/Accept order/);
    // Exactly once: the order is no longer waiting, so the suggestion is gone; and the decision row blocks a replay.
    await expect(run(diner().orgId, manager, (ctx) => hub.approveSuggestion(ctx, { venueId, key: forA.key }))).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.db.selectFrom('order_status_history').select('id').where('order_id', '=', a.id).where('to_status', '=', 'accepted').execute()).length).toBe(1);
    expect((await run(diner().orgId, manager, (ctx) => hub.suggestions(ctx, { venueId }))).some((s) => s.key === forA.key)).toBe(false);
    const audited = await t.db.selectFrom('audit_log').select(['action', 'after']).where('org_id', '=', diner().orgId).where('action', '=', 'home.suggestion_approved').execute();
    expect(audited.length).toBe(1);
    expect(audited[0]!.after).toMatchObject({ key: forA.key, tool: 'order_decide' });

    // Dismiss the other with a reason: it stays dismissed for the venue, and the order is untouched.
    await run(diner().orgId, manager, (ctx) => hub.dismissSuggestion(ctx, { venueId, key: forB.key, reason: 'The kitchen is on it.' }));
    const dismissed = await t.db.selectFrom('home_suggestion_decisions').selectAll().where('suggestion_key', '=', forB.key).executeTakeFirstOrThrow();
    expect(dismissed).toMatchObject({ decision: 'dismissed', reason: 'The kitchen is on it.' });
    expect((await run(diner().orgId, manager, (ctx) => hub.suggestions(ctx, { venueId }))).some((s) => s.key === forB.key)).toBe(false);
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status).toBe('placed');
    // Decided: approving the dismissed one is refused as a conflict, and the order is still untouched.
    await expect(run(diner().orgId, manager, (ctx) => hub.approveSuggestion(ctx, { venueId, key: forB.key }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', b.id).executeTakeFirstOrThrow()).status).toBe('placed');
    // Roles and orgs.
    await expect(run(diner().orgId, await diner().as('host'), (ctx) => hub.suggestions(ctx, { venueId }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => hub.approveSuggestion(ctx, { venueId, key: forB.key }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('the suggestion_dismiss tool proposes in words, changes nothing until commit, and a replay of the commit finds the suggestion gone', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    await t.db.updateTable('orders').set({ status: 'completed' }).where('venue_id', '=', venueId).where('status', '=', 'placed').execute();
    const c = await paidOrder(t, diner(), venueId);
    t.clock.advanceMinutes(12);
    const tool = getTool('suggestion_dismiss') as ToolDef & { propose: (t: { ctx: never; venueId: string }, input: unknown) => Promise<{ question: string; commit: () => Promise<unknown> }> };
    expect(tool).toMatchObject({ effect: 'write', scope: 'ops:write', minRole: 'manager', venueScoped: true });
    const key = `ops.accept_order:${c.reference}`;
    const q = await run(diner().orgId, manager, async (ctx) => (await tool.propose({ ctx: ctx as never, venueId }, tool.input.parse({ key, reason: 'Already on the pass' }))).question);
    expect(q).toBe(`Put away the suggestion "Accept order ${c.reference}" at Oak Diner (reason: Already on the pass)? It will not be shown again. Nothing else changes.`);
    expect(await t.db.selectFrom('home_suggestion_decisions').select('id').where('suggestion_key', '=', key).executeTakeFirst()).toBeUndefined();
    const out = await run(diner().orgId, manager, async (ctx) => tool.output.parse(await (await tool.propose({ ctx: ctx as never, venueId }, tool.input.parse({ key, reason: 'Already on the pass' }))).commit()));
    expect(out).toEqual({ key, dismissed: true, venue: 'Oak Diner' });
    expect((await t.db.selectFrom('home_suggestion_decisions').selectAll().where('suggestion_key', '=', key).executeTakeFirstOrThrow()).reason).toBe('Already on the pass');
    await expect(run(diner().orgId, manager, (ctx) => tool.propose({ ctx: ctx as never, venueId }, tool.input.parse({ key })))).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', c.id).executeTakeFirstOrThrow()).status).toBe('placed');
  });
});
