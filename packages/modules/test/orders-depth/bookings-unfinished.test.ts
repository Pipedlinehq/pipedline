import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type Principal, drainJobs, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { bookings, comms } from '@ros/modules';
import { YES, issueKey, rawToolCall, roomForKeys } from '../hub/helpers';

/**
 * "Didn't finish" for bookings (docs/COMMERCE_ADMIN_PATTERNS.md pattern 7). The bookings flow
 * records no "started" step, so the unfinished booking is the request the venue never answered
 * inside its window. Also here: the guest's no-show count on their booking rows. The fixture
 * clock is midday Wednesday 30 September 2026 in Sydney.
 */
const WORKER: Principal = { kind: 'worker', job: 'test' };
const ANON: Principal = { kind: 'anon' };
const NOW = '2026-09-30T02:00:00.000Z';

let n = 0;
const requestKey = () => `test-unfinished-${++n}-${'x'.repeat(12)}`;

describe('booking requests the venue did not answer', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const venueId = () => t.fixture.diner.venueId;
  const row = (id: string) => t.db.selectFrom('bookings').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  const byRef = (reference: string) => t.db.selectFrom('bookings').selectAll().where('reference', '=', reference).executeTakeFirstOrThrow();
  const messages = (id: string) => t.db.selectFrom('messages').selectAll().where('idempotency_key', 'like', `booking:${id}:%`).orderBy('queued_at').execute();
  const events = (id: string, name: string) => t.db.selectFrom('events').select(['name', 'properties']).where('name', '=', name).where(sql<boolean>`properties->>'booking_id' = ${id}`).execute();
  const audits = (id: string) => t.db.selectFrom('audit_log').select(['action', 'actor_kind', 'after']).where('entity_id', '=', id).orderBy('occurred_at').orderBy(sql`ctid`).execute();
  const detect = () => drainJobs(t.app, { kinds: ['bookings.detect_abandoned'] });
  const asHost = async <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(diner().orgId, await diner().as('host'), fn);
  const configure = (config: Record<string, unknown>) => t.app.tenant(diner().orgId, WORKER, (ctx) => setModule(ctx, bookings.bookingsModule, { venueId: venueId(), config: config as never }));
  const request = (over: Partial<Parameters<typeof bookings.requestBooking>[1]> = {}) =>
    t.app.tenant(diner().orgId, ANON, (ctx) => bookings.requestBooking(ctx, { venueId: venueId(), date: '2026-10-02', time: '19:00', partySize: 2, name: 'Wren Waiting', email: `wren.${++n}@example.com`, requestKey: requestKey(), ...over }));

  beforeAll(async () => {
    t.clock.set(NOW);
    await roomForKeys(t.app, t.fixture);
    await configure({ auto_confirm: false });
  });
  beforeEach(() => t.clock.set(NOW));

  it('a request still waiting when the window runs out (or its time arrives) is counted as unfinished; one answered in time is not', async () => {
    const waiting = await request();
    const answered = await request({ time: '19:30' });
    // Booked for tonight (7 pm Sydney, AEST): its time comes before the 24-hour window ends, so that is when it is checked.
    const soon = await request({ date: '2026-09-30', time: '19:00' });
    const waitingId = (await byRef(waiting.reference)).id;
    const answeredId = (await byRef(answered.reference)).id;
    const soonId = (await byRef(soon.reference)).id;
    const jobs = await t.db.selectFrom('jobs').select(['payload', 'run_at']).where('kind', '=', 'bookings.detect_abandoned').where('org_id', '=', diner().orgId).execute();
    const runAt = (id: string) => jobs.find((j) => (j.payload as { bookingId: string }).bookingId === id)!.run_at.toISOString();
    expect(runAt(waitingId)).toBe('2026-10-01T02:00:00.000Z');
    expect(runAt(soonId)).toBe('2026-09-30T09:00:00.000Z');

    await asHost((ctx) => bookings.confirmBooking(ctx, { bookingId: answeredId }));
    t.clock.advanceMinutes(6 * 60);
    await detect();
    expect((await row(waitingId)).abandoned_at).toBeNull();
    expect((await row(soonId)).abandoned_at).toBeNull();
    t.clock.advanceMinutes(60);
    await detect();
    expect((await row(soonId)).abandoned_at).toEqual(t.clock());
    t.clock.advanceMinutes(16 * 60);
    await detect();
    expect((await row(waitingId)).abandoned_at).toBeNull();
    t.clock.advanceMinutes(60);
    await detect();
    const marked = await row(waitingId);
    expect(marked.abandoned_at).toEqual(new Date('2026-10-01T02:00:00.000Z'));
    expect(marked.status).toBe('requested');
    expect(await events(waitingId, 'booking.abandoned')).toMatchObject([{ properties: { booking_id: waitingId, party_size: 2, hours_waiting: 24 } }]);
    expect((await row(answeredId)).abandoned_at).toBeNull();
    expect(await events(answeredId, 'booking.abandoned')).toEqual([]);

    const listed = await asHost((ctx) => bookings.listUnfinishedBookings(ctx, { venueId: venueId() }));
    expect(listed.map((b) => b.id).sort()).toEqual([soonId, waitingId].sort());
    expect(listed.find((b) => b.id === waitingId)).toMatchObject({ status: 'requested', nudgeSentAt: null, recoveredAt: null, noShowCount: 0 });
    // Kitchen may not see it; another organisation finds nothing.
    await expect(t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => bookings.listUnfinishedBookings(ctx, { venueId: venueId() }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => bookings.listUnfinishedBookings(ctx, { venueId: venueId() }))).rejects.toMatchObject({ code: 'not_found' });
    // The window is a setting.
    await configure({ auto_confirm: false, request_window_hours: 2 });
    const quick = await request({ time: '20:00' });
    const quickId = (await byRef(quick.reference)).id;
    t.clock.advanceMinutes(121);
    await detect();
    expect((await row(quickId)).abandoned_at).not.toBeNull();
    await configure({ auto_confirm: false, request_window_hours: 24 });
  });

  it('the one nudge: transactional, about the request, no consent, never twice, suppression honoured, roles', async () => {
    const req = await request({ email: `nia.${++n}@example.com` });
    const id = (await byRef(req.reference)).id;
    await expect(asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: id }))).rejects.toMatchObject({ code: 'invalid' });
    t.clock.advanceMinutes(24 * 60);
    await detect();
    await expect(t.app.tenant(diner().orgId, await diner().as('kitchen'), (ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: id }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(t.fixture.group.orgId, await t.fixture.group.as('manager'), (ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: id }))).rejects.toMatchObject({ code: 'not_found' });

    const r = await asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: id }));
    expect(r).toMatchObject({ via: 'email', status: 'queued' });
    expect(r.booking).toMatchObject({ nudgeStatus: 'queued', status: 'requested' });
    const m = await messages(id);
    expect(m.map((x) => x.template_key)).toEqual(['booking.requested', 'booking.unanswered']);
    expect(m[1]).toMatchObject({ kind: 'transactional', status: 'queued', idempotency_key: `booking:${id}:unanswered` });
    const after = await row(id);
    expect(after.nudge_sent_at).toEqual(t.clock());
    expect(after.nudge_message_id).toBe(m[1]!.id);
    expect(await t.db.selectFrom('consents').select('id').where('customer_id', '=', after.customer_id!).execute()).toEqual([]);
    expect((await audits(id)).map((a) => a.action)).toEqual(['bookings.requested', 'bookings.nudge_sent']);
    expect(await events(id, 'booking.nudged')).toMatchObject([{ properties: { via: 'email', status: 'queued' } }]);
    await drainJobs(t.app, { kinds: ['comms.send'] });
    const sent = t.sim.email.sent.filter((e) => e.to === after.guest_email);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.subject).toBe('Your booking request at Oak Diner is still waiting');
    expect(sent[1]!.body).toContain('has not been confirmed yet');
    expect(sent[1]!.body).toContain('/booking/');
    await expect(asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: id }))).rejects.toMatchObject({ code: 'conflict' });
    expect(await messages(id)).toHaveLength(2);

    // A bounced address is not written to; that still counts as the one nudge.
    const bounced = await request({ email: `bounce.${++n}@example.com`, time: '18:00' });
    const bouncedId = (await byRef(bounced.reference)).id;
    t.clock.advanceMinutes(24 * 60);
    await detect();
    const bouncedEmail = (await row(bouncedId)).guest_email!;
    await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.addSuppression(ctx, 'email', bouncedEmail, 'bounced_hard'));
    expect(await asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: bouncedId }))).toMatchObject({ status: 'suppressed', reason: 'bounced_hard' });
    expect((await row(bouncedId)).nudge_status).toBe('suppressed:bounced_hard');
    await expect(asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: bouncedId }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('Recovered flips when the request is confirmed after all; a declined one is purged after three months with the guest\'s details removed', async () => {
    const late = await request({ time: '18:30' });
    const lateId = (await byRef(late.reference)).id;
    const gone = await request({ time: '20:30' });
    const goneId = (await byRef(gone.reference)).id;
    t.clock.advanceMinutes(24 * 60);
    await detect();
    expect((await row(lateId)).abandoned_at).not.toBeNull();

    const confirmed = await asHost((ctx) => bookings.confirmBooking(ctx, { bookingId: lateId }));
    expect(confirmed).toMatchObject({ status: 'confirmed', recoveredAt: t.clock() });
    expect(await events(lateId, 'booking.recovered')).toMatchObject([{ properties: { booking_id: lateId, party_size: 2 } }]);
    await expect(asHost((ctx) => bookings.nudgeUnfinishedBooking(ctx, { bookingId: lateId }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await asHost((ctx) => bookings.listUnfinishedBookings(ctx, { venueId: venueId() }))).find((b) => b.id === lateId)).toMatchObject({ recoveredAt: t.clock() });

    await asHost((ctx) => bookings.declineBooking(ctx, { bookingId: goneId, reason: 'Fully booked.' }));
    t.clock.advanceDays(60);
    await tickSchedules(t.app, { only: ['bookings.purge_unfinished'] });
    await drainJobs(t.app, { kinds: ['bookings.purge_unfinished'] });
    expect((await row(goneId)).purged_at).toBeNull();
    t.clock.advanceDays(33);
    await tickSchedules(t.app, { only: ['bookings.purge_unfinished'] });
    await drainJobs(t.app, { kinds: ['bookings.purge_unfinished'] });
    const purged = await row(goneId);
    expect(purged).toMatchObject({ status: 'declined', guest_name: null, guest_email: null, guest_phone: null, guest_note: null, customer_id: null, party_size: 2 });
    expect(purged.purged_at).not.toBeNull();
    expect((await audits(goneId)).map((a) => a.action)).toContain('bookings.unfinished_purged');
    expect(await events(goneId, 'booking.purged')).toHaveLength(1);
    expect((await asHost((ctx) => bookings.listUnfinishedBookings(ctx, { venueId: venueId() }))).map((b) => b.id)).not.toContain(goneId);
    // The recovered one is kept whole.
    expect((await row(lateId)).purged_at).toBeNull();
    expect((await row(lateId)).guest_name).toBe('Wren Waiting');
  });

  it('a guest\'s no-show count shows on their booking rows, read-only, across the organisation', async () => {
    const email = `noshow.${++n}@example.com`;
    // A phone booking for today at 12:30 (it is midday): the party never comes.
    const first = await asHost((ctx) => bookings.addBooking(ctx, { venueId: venueId(), date: '2026-09-30', time: '12:30', partySize: 3, name: 'Nat Noshow', email }));
    expect(first.noShowCount).toBe(0);
    t.clock.advanceMinutes(90);
    await asHost((ctx) => bookings.markNoShow(ctx, { bookingId: first.id }));
    // Their next booking says so.
    const next = await asHost((ctx) => bookings.addBooking(ctx, { venueId: venueId(), date: '2026-10-03', time: '19:00', partySize: 2, name: 'Nat Noshow', email }));
    expect(next.noShowCount).toBe(1);
    expect((await asHost((ctx) => bookings.getBooking(ctx, { bookingId: next.id }))).noShowCount).toBe(1);
    const day = await asHost((ctx) => bookings.listBookings(ctx, { venueId: venueId(), date: '2026-10-03' }));
    expect(day.bookings.find((b) => b.id === next.id)!.noShowCount).toBe(1);
    expect((await asHost((ctx) => bookings.findBookingByReference(ctx, { venueId: venueId(), reference: next.reference }))).noShowCount).toBe(1);
    // Another guest's row is untouched.
    const other = await asHost((ctx) => bookings.addBooking(ctx, { venueId: venueId(), date: '2026-10-03', time: '19:30', partySize: 2, name: 'Oli Other', email: `oli.${++n}@example.com` }));
    expect(other.noShowCount).toBe(0);
  });

  it('the assistant: bookings_list carries where it came from, the no-show count and the unfinished mark; booking_nudge asks first and sends once', async () => {
    // Only an owner may let a key make changes; the owner holds every role, so the host's check is the service test above.
    const writer = await issueKey(t.app, diner().orgId, await diner().as('owner'), { scopes: ['bookings:read', 'bookings:write'], canWrite: true });
    const req = await request({ date: '2026-10-07', time: '19:00', email: `tool.${++n}@example.com`, channel: 'assistant' });
    const id = (await byRef(req.reference)).id;
    t.clock.advanceMinutes(24 * 60);
    await detect();

    const listed = await rawToolCall(t.app, writer.key, 'bookings_list', { date: '2026-10-07' });
    const rows = (listed.answer!.structured as { bookings: Array<Record<string, unknown>> }).bookings;
    expect(rows.find((b) => b.booking_id === id)).toMatchObject({ came_from: 'Inside assistants', no_shows_before: 0, unfinished: { nudge: 'not sent', recovered: false } });

    const ask = await rawToolCall(t.app, writer.key, 'booking_nudge', { booking: req.reference });
    expect(ask.asking!.question).toBe(`Send the guest one email about booking request ${req.reference} (2 people, Wed 7 Oct at 7:00 pm) at Oak Diner, which has been waiting for a yes since Wed 30 Sep at 12:00 pm? It says the request is still waiting and how to cancel. It is the only nudge they will get.`);
    expect(await messages(id)).toHaveLength(1);
    const yes = await rawToolCall(t.app, writer.key, 'booking_nudge', { booking: req.reference }, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false, structured: { booking_id: id, reference: req.reference, via: 'email', nudge_status: 'queued' } });
    expect(await messages(id)).toHaveLength(2);
    const again = await rawToolCall(t.app, writer.key, 'booking_nudge', { booking: req.reference }, { inputResponses: YES, requestState: ask.asking!.requestState });
    expect(again.answer?.isError).toBe(true);
    expect(await messages(id)).toHaveLength(2);
    expect((await audits(id)).filter((a) => a.action === 'bookings.nudge_sent')).toMatchObject([{ actor_kind: 'agent' }]);
    const twice = await rawToolCall(t.app, writer.key, 'booking_nudge', { booking: req.reference });
    expect(twice.asking).toBeNull();
    expect(twice.answer?.isError).toBe(true);
  });
});
