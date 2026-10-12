import { describe, expect, it } from 'vitest';
import { type StaffPrincipal, type ToolDef, drainJobs, getTool, json } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { comms } from '@ros/modules';

/**
 * Alerts to the team (pattern 13): a rule queues a transactional message to the right staff
 * member and nobody else, honours quiet hours, is never addressed to a guest; "send a test" sends
 * one; the dispatcher raises alerts from the activity stream once per event; role checks; the
 * tools propose without changing anything and commit once.
 */
describe('comms: alerts to the team', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const run = <T>(orgId: string, p: StaffPrincipal, fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(orgId, p, fn);
  const WORKER = { kind: 'worker' as const, job: 'test' };
  const messagesFor = (prefix: string) => t.db.selectFrom('messages').select(['id', 'to_address', 'kind', 'customer_id', 'status', 'channel', 'template_key', 'idempotency_key', 'next_attempt_at', 'payload']).where('idempotency_key', 'like', `${prefix}%`).orderBy('to_address').execute();

  it('a rule for a role queues one transactional email per person holding it, never to a guest; a rule for one person reaches only them; a text needs a phone', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    // Kitchen is one person at the diner (Kai); the manager role is one person (Morgan). Owners: whoever the fixture made.
    const roleRule = await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'order.new', channel: 'email', recipient: { kind: 'role', role: 'kitchen' } }));
    expect(roleRule).toMatchObject({ event: 'order.new', channel: 'email', enabled: true, recipient: { kind: 'role', role: 'kitchen' } });
    const row = await t.db.selectFrom('alert_rules').selectAll().where('id', '=', roleRule.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner().orgId, venue_id: venueId, recipient_kind: 'role', recipient: 'kitchen', created_by_id: diner().staff.manager!.staffId });

    const sent = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'order.new', title: 'New order to accept', body: 'A pickup order for $42.00 is waiting.', link: 'http://console.rosplatform.test/console/orders?view=accepting', idempotencyKey: 'alert:test-1' }));
    expect(sent.queued).toBe(1);
    const msgs = await messagesFor('alert:test-1');
    expect(msgs.map((m) => m.to_address)).toEqual(['kitchen@oak-diner.test']);
    expect(msgs[0]).toMatchObject({ kind: 'transactional', customer_id: null, status: 'queued', channel: 'email', template_key: 'alerts.team' });
    expect(msgs[0]!.payload).toMatchObject({ title: 'New order to accept' });
    // The same alert again changes nothing: one message.
    const again = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'order.new', title: 'New order to accept', body: 'x', link: 'http://x', idempotencyKey: 'alert:test-1' }));
    expect(again.queued).toBe(0);
    expect((await messagesFor('alert:test-1')).length).toBe(1);
    // Delivered through the outbox like any transactional message: the simulated provider gets it.
    await drainJobs(t.app);
    expect(t.sim.email.sent.some((m) => m.to === 'kitchen@oak-diner.test' && m.subject === 'New order to accept')).toBe(true);
    expect((await t.db.selectFrom('messages').select('status').where('id', '=', msgs[0]!.id).executeTakeFirstOrThrow()).status).toBe('sent');

    // One person, by email; a text to them is refused until they have a phone.
    const host = diner().staff.host!;
    await expect(run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'booking.new', channel: 'sms', recipient: { kind: 'staff', staffId: host.staffId } }))).rejects.toMatchObject({ code: 'invalid' });
    await t.db.updateTable('staff').set({ phone: '+61400000111' }).where('id', '=', host.staffId).execute();
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'booking.new', channel: 'sms', recipient: { kind: 'staff', staffId: host.staffId } }));
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'booking.new', channel: 'email', recipient: { kind: 'staff', staffId: host.staffId } }));
    // Daytime at the venue: no quiet hours in force.
    t.clock.set('2026-09-30T02:00:00.000Z');
    const booked = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'booking.new', title: 'Booking request to confirm', body: 'A table for 4 was requested.', link: 'http://x', idempotencyKey: 'alert:test-2' }));
    expect(booked.queued).toBe(2);
    expect(booked.heldUntil).toBeNull();
    const two = await messagesFor('alert:test-2');
    expect(two.map((m) => [m.channel, m.to_address]).sort()).toEqual([['email', 'host@oak-diner.test'], ['sms', '+61400000111']]);
    for (const m of two) expect(m.customer_id).toBeNull();
    // No guest address anywhere in the alerts.
    const guests = await t.db.selectFrom('customers').select('primary_email').where('org_id', '=', diner().orgId).where('primary_email', 'is not', null).execute();
    const guestAddresses = new Set(guests.map((g) => g.primary_email!.toLowerCase()));
    for (const m of [...msgs, ...two]) expect(guestAddresses.has(m.to_address.toLowerCase())).toBe(false);
  });

  it('quiet hours hold a booking alert until they end, in venue time, and let an order alert through at once', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'review.posted', channel: 'email', recipient: { kind: 'role', role: 'manager' } }));
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'order.new', channel: 'email', recipient: { kind: 'role', role: 'manager' } }));
    const settings = await run(diner().orgId, manager, (ctx) => comms.setAlertSettings(ctx, { quietHours: { start: '22:00', end: '07:00' } }));
    expect(settings.quietHours).toEqual({ start: '22:00', end: '07:00' });
    expect((await run(diner().orgId, manager, (ctx) => comms.getAlertSettings(ctx))).quietHours).toEqual({ start: '22:00', end: '07:00' });
    // 23:30 Sydney (AEST, UTC+10) on 30 September: 13:30Z.
    t.clock.set('2026-09-30T13:30:00.000Z');
    const held = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'review.posted', title: 'New 2-star review', body: 'x', link: 'http://x', idempotencyKey: 'alert:quiet-1' }));
    expect(held.queued).toBe(1);
    // 07:00 the next morning Sydney time is 21:00Z on 30 September (AEST).
    expect(held.heldUntil?.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    const [m] = await messagesFor('alert:quiet-1');
    expect(m!.next_attempt_at?.toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(m!.status).toBe('queued');
    const now = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'order.new', title: 'New order', body: 'x', link: 'http://x', idempotencyKey: 'alert:quiet-2' }));
    expect(now.heldUntil).toBeNull();
    const [o] = await messagesFor('alert:quiet-2');
    expect(o!.next_attempt_at?.toISOString()).toBe('2026-09-30T13:30:00.000Z');
    // The held one does not go until its time.
    await drainJobs(t.app);
    expect((await t.db.selectFrom('messages').select('status').where('id', '=', m!.id).executeTakeFirstOrThrow()).status).toBe('queued');
    t.clock.set('2026-09-30T21:01:00.000Z');
    await drainJobs(t.app);
    expect((await t.db.selectFrom('messages').select('status').where('id', '=', m!.id).executeTakeFirstOrThrow()).status).toBe('sent');
    // Switched off, quiet hours hold nothing.
    await run(diner().orgId, manager, (ctx) => comms.setAlertSettings(ctx, { quietHours: null }));
    t.clock.set('2026-10-01T13:30:00.000Z');
    const open = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'review.posted', title: 'x', body: 'x', link: 'http://x', idempotencyKey: 'alert:quiet-3' }));
    expect(open.heldUntil).toBeNull();
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('"send a test" queues exactly one message through one rule, to its recipients, now, and is audited', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    const rule = await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'digest.weekly', channel: 'email', recipient: { kind: 'staff', staffId: diner().staff.manager!.staffId } }));
    const r = await run(diner().orgId, manager, (ctx) => comms.sendTestAlert(ctx, { ruleId: rule.id }));
    expect(r.queued).toBe(1);
    const msgs = await messagesFor(`alert:test:${rule.id}`);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatchObject({ to_address: 'manager@oak-diner.test', kind: 'transactional', customer_id: null });
    expect(msgs[0]!.payload).toMatchObject({ title: 'Test alert from Oak Diner: the weekly digest' });
    expect((await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', rule.id).execute()).map((a) => a.action)).toContain('alerts.test_sent');
    // A rule that is off still tests (that is what a test is for), but delivers nothing when it is raised for real.
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'digest.weekly', channel: 'email', recipient: { kind: 'staff', staffId: diner().staff.manager!.staffId }, enabled: false }));
    const off = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.notifyTeam(ctx, { venueId, event: 'digest.weekly', title: 'x', body: 'x', link: 'http://x', idempotencyKey: 'alert:off-1' }));
    expect(off.queued).toBe(0);
    // Not for a host; not for another organisation's manager.
    await expect(run(diner().orgId, await diner().as('host'), (ctx) => comms.sendTestAlert(ctx, { ruleId: rule.id }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => comms.sendTestAlert(ctx, { ruleId: rule.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => comms.removeAlertRule(ctx, rule.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(run(diner().orgId, await diner().as('host'), (ctx) => comms.listAlertRules(ctx, { venueId }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(run(group().orgId, await group().as('manager'), (ctx) => comms.setAlertRule(ctx, { venueId, event: 'order.new', channel: 'email', recipient: { kind: 'role', role: 'manager' } }))).rejects.toMatchObject({ code: 'not_found' });
    await run(diner().orgId, manager, (ctx) => comms.removeAlertRule(ctx, rule.id));
    expect(await t.db.selectFrom('alert_rules').select('id').where('id', '=', rule.id).executeTakeFirst()).toBeUndefined();
  });

  it('the dispatcher raises an alert from the activity stream once per event and moves its watermark; a second pass sends nothing more', async () => {
    const manager = await group().as('manager');
    const cbd = group().venues.cbd!.id;
    // With no rule anywhere there is nothing to consider; the watermark still moves to now.
    const first = await comms.dispatchAlerts(t.app, group().orgId);
    expect(first.considered).toBe(0);
    expect(first.readThrough.getTime()).toBe(t.clock().getTime());
    await run(group().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId: cbd, event: 'order.new', channel: 'email', recipient: { kind: 'role', role: 'manager' } }));
    await run(group().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId: cbd, event: 'booking.cancelled', channel: 'email', recipient: { kind: 'role', role: 'manager' } }));
    const at = new Date(t.clock().getTime() + 60_000);
    t.clock.advanceMinutes(2);
    // Two events a venue's modules would record: a paid order and a cancelled booking, plus one nobody asked to hear about.
    await t.db
      .insertInto('events')
      .values([
        { org_id: group().orgId, venue_id: cbd, name: 'order.paid', occurred_at: at, source: 'server', properties: json({ order_id: '11111111-1111-4111-8111-111111111111', channel: 'pickup', total_cents: 4200 }) },
        { org_id: group().orgId, venue_id: cbd, name: 'booking.cancelled', occurred_at: at, source: 'server', properties: json({ booking_id: '22222222-2222-4222-8222-222222222222', party_size: 4, by: 'guest', was: 'confirmed', minutes_before: 180 }) },
        { org_id: group().orgId, venue_id: cbd, name: 'review.received', occurred_at: at, source: 'server', properties: json({ review_id: '33333333-3333-4333-8333-333333333333', rating: 2, source: 'sim' }) },
      ])
      .execute();
    const second = await comms.dispatchAlerts(t.app, group().orgId);
    expect(second.considered).toBe(3);
    expect(second.queued).toBe(2);
    const msgs = await t.db.selectFrom('messages').select(['to_address', 'payload', 'idempotency_key']).where('org_id', '=', group().orgId).where('template_key', '=', 'alerts.team').orderBy('idempotency_key').execute();
    expect(msgs.length).toBe(2);
    expect(msgs.map((m) => m.to_address)).toEqual(['manager@oak-group.test', 'manager@oak-group.test']);
    const titles = msgs.map((m) => (m.payload as { title: string }).title).sort();
    expect(titles).toEqual(['Booking cancelled', 'New order to accept']);
    expect((msgs.find((m) => (m.payload as { title: string }).title === 'New order to accept')!.payload as { body: string }).body).toBe('A pickup order for $42.00 has been paid and is waiting for the kitchen to accept it.');
    const cursor = await t.db.selectFrom('alert_cursors').select('read_through').where('org_id', '=', group().orgId).executeTakeFirstOrThrow();
    expect(cursor.read_through.getTime()).toBe(t.clock().getTime());
    const third = await comms.dispatchAlerts(t.app, group().orgId);
    expect(third.considered).toBe(0);
    expect((await t.db.selectFrom('messages').select('id').where('org_id', '=', group().orgId).where('template_key', '=', 'alerts.team').execute()).length).toBe(2);
    // Another venue of the same org with no rules: nothing, even for the same event.
    await t.db.insertInto('events').values({ org_id: group().orgId, venue_id: group().venues.newtown!.id, name: 'order.paid', occurred_at: new Date(t.clock().getTime() + 1000), source: 'server', properties: json({ order_id: '44444444-4444-4444-8444-444444444444', channel: 'pickup', total_cents: 100 }) }).execute();
    t.clock.advanceMinutes(1);
    expect((await comms.dispatchAlerts(t.app, group().orgId)).queued).toBe(0);
  });

  it('the daily digest goes to its recipients once per venue per day, from the digest hour, with the digest\'s own sentence', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    await run(diner().orgId, manager, (ctx) => comms.setAlertRule(ctx, { venueId, event: 'digest.daily', channel: 'email', recipient: { kind: 'role', role: 'manager' } }));
    // 06:30 Sydney: too early.
    t.clock.set('2026-09-29T20:30:00.000Z');
    expect(await comms.sendDailyDigests(t.app, diner().orgId)).toEqual({ venues: 0, queued: 0 });
    // 07:30 Sydney on 30 September: yesterday is the 29th.
    t.clock.set('2026-09-29T21:30:00.000Z');
    expect(await comms.sendDailyDigests(t.app, diner().orgId)).toEqual({ venues: 1, queued: 1 });
    const [m] = await messagesFor(`alert:digest.daily:${venueId}:2026-09-29`);
    expect(m).toMatchObject({ to_address: 'manager@oak-diner.test', kind: 'transactional', customer_id: null });
    expect((m!.payload as { title: string; body: string }).title).toBe('Oak Diner: yesterday in numbers');
    expect((m!.payload as { body: string }).body).toMatch(/^Tuesday 29 Sep 2026: /);
    // Again the same day: nothing more.
    t.clock.set('2026-09-30T00:30:00.000Z');
    expect(await comms.sendDailyDigests(t.app, diner().orgId)).toEqual({ venues: 0, queued: 0 });
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('the tools: alerts_summary reads; alert_set proposes in words, changes nothing until commit, and commits once', async () => {
    const manager = await diner().as('manager');
    const venueId = diner().venueId;
    const summaryTool = getTool('alerts_summary') as ToolDef & { run: (t: { ctx: never; venueId: string }, input: unknown) => Promise<unknown> };
    const setTool = getTool('alert_set') as ToolDef & { propose: (t: { ctx: never; venueId: string }, input: unknown) => Promise<{ question: string; commit: () => Promise<unknown> }> };
    expect(summaryTool).toMatchObject({ effect: 'read', scope: 'alerts:read', minRole: 'manager', venueScoped: true });
    expect(setTool).toMatchObject({ effect: 'write', scope: 'alerts:write', minRole: 'manager', venueScoped: true });
    const before = await t.db.selectFrom('alert_rules').select('id').where('venue_id', '=', venueId).where('event', '=', 'delivery.problem').execute();
    const question = await run(diner().orgId, manager, async (ctx) => (await setTool.propose({ ctx: ctx as never, venueId }, setTool.input.parse({ event: 'delivery.problem', channel: 'email', recipient: { kind: 'staff', name: 'Kai Kitchen' } }))).question);
    expect(question).toBe('Send an email to Kai Kitchen whenever this happens at Oak Diner: a delivery problem (a delivery could not be made: no courier, failed, returned or cancelled)?');
    expect(await t.db.selectFrom('alert_rules').select('id').where('venue_id', '=', venueId).where('event', '=', 'delivery.problem').execute()).toEqual(before);
    const out = await run(diner().orgId, manager, async (ctx) => {
      const p = await setTool.propose({ ctx: ctx as never, venueId }, setTool.input.parse({ event: 'delivery.problem', channel: 'email', recipient: { kind: 'staff', name: 'Kai Kitchen' } }));
      return setTool.output.parse(await p.commit()) as Record<string, unknown>;
    });
    expect(out).toMatchObject({ event: 'delivery.problem', channel: 'email', to: 'Kai Kitchen', enabled: true, venue: 'Oak Diner' });
    const rules = await t.db.selectFrom('alert_rules').selectAll().where('venue_id', '=', venueId).where('event', '=', 'delivery.problem').execute();
    expect(rules.length).toBe(1);
    expect(rules[0]).toMatchObject({ recipient_kind: 'staff', recipient: diner().staff.kitchen!.staffId, enabled: true });
    // Committing the same proposal again is the same rule, not a second one.
    await run(diner().orgId, manager, async (ctx) => (await setTool.propose({ ctx: ctx as never, venueId }, setTool.input.parse({ event: 'delivery.problem', channel: 'email', recipient: { kind: 'staff', name: 'Kai Kitchen' } }))).commit());
    expect((await t.db.selectFrom('alert_rules').select('id').where('venue_id', '=', venueId).where('event', '=', 'delivery.problem').execute()).length).toBe(1);
    const summary = await run(diner().orgId, manager, (ctx) => summaryTool.run({ ctx: ctx as never, venueId }, {}));
    const shaped = summaryTool.output.parse(summary) as { events: Array<{ event: string; rules: Array<{ to: string }> }>; summary: string };
    expect(shaped.events.find((e) => e.event === 'delivery.problem')!.rules.map((r) => r.to)).toEqual(['Kai Kitchen']);
    expect(shaped.summary).toMatch(/never to guests/);
    // An unknown name is refused before any question is built.
    await expect(run(diner().orgId, manager, (ctx) => setTool.propose({ ctx: ctx as never, venueId }, setTool.input.parse({ event: 'order.new', channel: 'email', recipient: { kind: 'staff', name: 'Nobody Here' } })))).rejects.toThrow(/No team member/);
  });
});
