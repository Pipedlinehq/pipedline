import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError, defineTool, sql } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { hub, tenancy } from '@ros/modules';
import { NO, YES, connectLegacy, connectModern, issueKey, rawToolCall, roomForKeys } from './helpers';

// A change whose `propose` wrongly writes. The first call must still change nothing.
defineTool({
  name: 'test_hub_eager_write',
  module: 'tenancy',
  title: 'Eager write',
  description: 'A badly written change: it writes while it is only meant to say what it would do.',
  effect: 'write',
  scope: 'testhub:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ date: z.string() }),
  output: z.object({ done: z.boolean() }),
  async propose({ ctx, venueId }, input) {
    await tenancy.setHourException(ctx, venueId!, { date: input.date, closed: true, reason: 'written by propose' });
    return { question: `Close on ${input.date}?`, commit: async () => ({ done: true }) };
  },
});

// A change that is refused, or breaks, at the moment it is made.
defineTool({
  name: 'test_hub_fails_late',
  module: 'tenancy',
  title: 'Fails late',
  description: 'Writes, and then fails.',
  effect: 'write',
  scope: 'testhub:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ date: z.string(), how: z.enum(['refused', 'broken', 'misshapen']) }),
  output: z.object({ done: z.boolean() }),
  async propose({ ctx, venueId }, input) {
    return {
      question: `Close on ${input.date}, then fail (${input.how})?`,
      commit: async () => {
        await tenancy.setHourException(ctx, venueId!, { date: input.date, closed: true, reason: 'written before failing' });
        if (input.how === 'refused') throw new AppError('conflict', 'That day is locked.');
        if (input.how === 'broken') throw new Error('deadlock detected in relation hour_exceptions');
        return { done: 'yes' } as never;
      },
    };
  },
});

// A change whose transaction fails at the very end, at COMMIT: from the application's side
// that is the one moment at which it cannot know whether the change landed.
defineTool({
  name: 'test_hub_commit_breaks',
  module: 'tenancy',
  title: 'Commit breaks',
  description: 'Does its work, and then the commit itself fails.',
  effect: 'write',
  scope: 'testhub:write',
  minRole: 'manager',
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  async propose({ ctx }) {
    return {
      question: 'Do the thing whose commit breaks?',
      commit: async () => {
        await sql`insert into zz_hub_deferred (id) values (1)`.execute(ctx.db);
        return { done: true };
      },
    };
  },
});

describe('hub: a change waits for the person to say yes', () => {
  const t = useTestEnv();
  let writer: { key: string; id: string };
  let other: { key: string; id: string };

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
    const owner = await t.fixture.diner.as('owner');
    writer = await issueKey(t.app, t.fixture.diner.orgId, owner, { scopes: ['venue:read', 'venue:write', 'testhub:write'], canWrite: true });
    other = await issueKey(t.app, t.fixture.diner.orgId, owner, { scopes: ['venue:read', 'venue:write', 'testhub:write'], canWrite: true });
  });

  const exceptions = (date: string) => t.db.selectFrom('hour_exceptions').select(['date', 'closed', 'reason']).where('venue_id', '=', t.fixture.diner.venueId).where('date', '=', date).execute();
  const hoursAudits = (date: string) =>
    t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('org_id', '=', t.fixture.diner.orgId)
      .where('action', '=', 'hours.exception_set')
      .execute()
      .then((rows) => rows.filter((r) => (r.after as { date?: string } | null)?.date === date));
  /** Starts a test's own stretch of time, so its rows can be told from an earlier test's. */
  const mark = () => {
    t.clock.advance(1000);
    return t.clock();
  };
  /** What happened to a key's calls to one tool since `from`, sorted (rows within one instant have no order). */
  const outcomes = (keyId: string, from: Date, tool = 'hours_set_exception') =>
    t.db
      .selectFrom('agent_calls')
      .select(['outcome', 'effect'])
      .where('key_id', '=', keyId)
      .where('tool', '=', tool)
      .where('occurred_at', '>=', from)
      .execute()
      .then((rows) => rows.map((r) => r.outcome).sort());
  const notes = (keyId: string) => t.db.selectFrom('agent_confirmations').selectAll().where('key_id', '=', keyId).orderBy('created_at').execute();

  it('the happy path: the person is asked in plain words, says yes, the row changes, and audit and agent_calls say who did it', async () => {
    const from = mark();
    const s = await connectModern(t.app, writer.key, { answer: () => 'yes' });
    const r = await s.call('hours_set_exception', { date: '2026-10-20', closed: true, reason: 'Private event' });
    await s.close();

    expect(s.asked).toEqual(['On 2026-10-20, close Oak Diner for the whole day (Private event)? This replaces any earlier change for that date. The weekly hours stay as they are.']);
    expect(r.isError).toBe(false);
    expect(r.structured).toEqual({ date: '2026-10-20', closed: true, opens: null, closes: null });

    expect(await exceptions('2026-10-20')).toEqual([{ date: '2026-10-20', closed: true, reason: 'Private event' }]);
    const audited = await hoursAudits('2026-10-20');
    expect(audited).toHaveLength(1);
    // The change is the assistant's, acting as this key, from the address the request came from.
    expect(audited[0]).toMatchObject({ actor_kind: 'agent', actor_id: writer.id, entity_id: t.fixture.diner.venueId, ip: '203.0.113.9' });
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'confirmed']);
    const [note] = await notes(writer.id);
    expect(note).toMatchObject({ tool: 'hours_set_exception', org_id: t.fixture.diner.orgId });
    expect(note!.spent_at).not.toBeNull();
    expect(note!.expires_at.toISOString()).toBe(new Date(t.clock().getTime() + 10 * 60_000).toISOString());
    // Neither the arguments nor the question is kept: digests only.
    expect(JSON.stringify(note)).not.toContain('Private event');
  });

  it('the first call changes nothing: it answers with the question and a signed note', async () => {
    const from = mark();
    const first = await rawToolCall(t.app, other.key, 'hours_set_exception', { date: '2026-10-21', closed: true });
    expect(first.answer).toBeNull();
    expect(first.asking!.question).toBe('On 2026-10-21, close Oak Diner for the whole day? This replaces any earlier change for that date. The weekly hours stay as they are.');
    expect(first.asking!.requestState).toMatch(/^v1\./);
    expect(await exceptions('2026-10-21')).toEqual([]);
    expect(await hoursAudits('2026-10-21')).toEqual([]);
    expect(await outcomes(other.id, from)).toEqual(['asked']);
    expect((await notes(other.id)).map((n) => n.spent_at)).toEqual([null]);

    // Even a tool whose `propose` wrongly writes changes nothing on the first call.
    const eager = await rawToolCall(t.app, other.key, 'test_hub_eager_write', { date: '2026-11-01' });
    expect(eager.asking!.question).toBe('Close on 2026-11-01?');
    expect(await exceptions('2026-11-01')).toEqual([]);
  });

  it('declined, unticked or cancelled: nothing changes, and a declined question cannot be answered again with a yes', async () => {
    const from = mark();
    for (const [says, date] of [['no', '2026-10-22'], ['unticked', '2026-10-23'], ['cancel', '2026-10-24']] as const) {
      const s = await connectModern(t.app, writer.key, { answer: () => says });
      const r = await s.call('hours_set_exception', { date, closed: true });
      await s.close();
      expect(s.asked).toHaveLength(1);
      expect(r).toMatchObject({ isError: true, text: 'Nothing was changed: you did not confirm it.' });
      expect(await exceptions(date)).toEqual([]);
    }
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'asked', 'asked', 'declined', 'declined', 'declined']);

    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-25', closed: true });
    const state = first.asking!.requestState;
    const no = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-25', closed: true }, { inputResponses: NO, requestState: state });
    expect(no.answer).toMatchObject({ isError: true, text: 'Nothing was changed: you did not confirm it.' });
    const flipped = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-25', closed: true }, { inputResponses: YES, requestState: state });
    expect(flipped.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has already been used; ask again to do it again.' });
    expect(await exceptions('2026-10-25')).toEqual([]);
  });

  it('expired: a yes that arrives after the venue\'s time limit changes nothing', async () => {
    const from = mark();
    const args = { date: '2026-10-26', closed: true };
    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    t.clock.advanceMinutes(11);
    const late = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(late.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has expired; ask again.' });
    expect(await exceptions('2026-10-26')).toEqual([]);
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'expired']);
    // Asked again, inside the limit, it goes through.
    const again = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    t.clock.advanceMinutes(9);
    const ok = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, { inputResponses: YES, requestState: again.asking!.requestState });
    expect(ok.answer).toMatchObject({ isError: false, structured: { date: '2026-10-26', closed: true } });
    expect(await exceptions('2026-10-26')).toHaveLength(1);
  });

  it('reused: a note is spent once; a second yes with it changes nothing', async () => {
    const from = mark();
    const args = { date: '2026-10-27', closed: false, opens: '15:00', closes: '18:00' };
    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    const yes = { inputResponses: YES, requestState: first.asking!.requestState };
    // Two answers racing on one note: exactly one of them makes the change.
    const [a, b] = await Promise.all([rawToolCall(t.app, writer.key, 'hours_set_exception', args, yes), rawToolCall(t.app, writer.key, 'hours_set_exception', args, yes)]);
    expect([a.answer!.isError, b.answer!.isError].sort()).toEqual([false, true]);
    const third = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, yes);
    for (const refused of [a, b, third].filter((x) => x.answer!.isError)) {
      expect(refused.answer!.text).toBe('Nothing was changed. That confirmation has already been used; ask again to do it again.');
    }
    expect(await exceptions('2026-10-27')).toHaveLength(1);
    expect(await hoursAudits('2026-10-27')).toHaveLength(1);
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'confirmed', 'spent', 'spent']);
  });

  it('arguments changed: a yes to one thing cannot be spent on another', async () => {
    const from = mark();
    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-28', closed: true });
    const state = first.asking!.requestState;
    const swapped = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-29', closed: true }, { inputResponses: YES, requestState: state });
    expect(swapped.answer).toMatchObject({ isError: true, text: 'Nothing was changed. The details are not the ones you were asked about; ask again.' });
    // Nor on another tool.
    const otherTool = await rawToolCall(t.app, writer.key, 'test_hub_eager_write', { date: '2026-10-28' }, { inputResponses: YES, requestState: state });
    expect(otherTool.answer).toMatchObject({ isError: true, text: 'Nothing was changed. The details are not the ones you were asked about; ask again.' });
    // An answer with no note at all: the person was never asked.
    const bare = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-10-28', closed: true }, { inputResponses: YES });
    expect(bare.answer).toMatchObject({ isError: true, text: 'Nothing was changed. The details are not the ones you were asked about; ask again.' });
    for (const date of ['2026-10-28', '2026-10-29']) expect(await exceptions(date)).toEqual([]);
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'stale', 'stale']);
    // The note itself was not spent by the attempts: the question the person was really asked still stands.
    const honest = await rawToolCall(t.app, writer.key, 'hours_set_exception', { closed: true, date: '2026-10-28' }, { inputResponses: YES, requestState: state });
    expect(honest.answer!.isError).toBe(false);
    expect(await exceptions('2026-10-28')).toHaveLength(1);
  });

  it('a note belongs to the key it was given to, and a forged or altered one is refused', async () => {
    const args = { date: '2026-10-30', closed: true };
    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    const state = first.asking!.requestState;
    // Carried to another key, even one with the same permissions in the same organisation.
    const carried = await rawToolCall(t.app, other.key, 'hours_set_exception', args, { inputResponses: YES, requestState: state });
    expect(carried.answer).toBeNull();
    expect(carried.error).toMatchObject({ code: -32602 });
    // Altered: the body re-encoded with a later expiry, the signature kept.
    const [v, body, mac] = state.split('.');
    const decoded = JSON.parse(Buffer.from(body!, 'base64url').toString());
    const forged = `${v}.${Buffer.from(JSON.stringify({ ...decoded, exp: decoded.exp + 9999 })).toString('base64url')}.${mac}`;
    const altered = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, { inputResponses: YES, requestState: forged });
    expect(altered.error).toMatchObject({ code: -32602 });
    const invented = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, { inputResponses: YES, requestState: 'v1.e30.AAAA' });
    expect(invented.error).toMatchObject({ code: -32602 });
    expect(await exceptions('2026-10-30')).toEqual([]);
  });

  it('state changed since asked: the question is rebuilt and must read the same, or nothing changes', async () => {
    const { diner } = t.fixture;
    const from = mark();
    const args = { date: '2026-11-03', closed: true };
    const first = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    expect(first.asking!.question).toContain('close Oak Diner for');
    // Between the question and the answer, the venue is renamed in the console.
    await t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => tenancy.updateVenue(ctx, diner.venueId, { name: 'Oak Diner & Bar' }));
    const yes = await rawToolCall(t.app, writer.key, 'hours_set_exception', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: true, text: 'Nothing was changed. Something about this changed after you were asked; ask again to see it as it is now.' });
    expect(await exceptions('2026-11-03')).toEqual([]);
    expect(await outcomes(writer.id, from)).toEqual(['asked', 'changed']);
    // Asked again, the person sees it as it is now.
    const again = await rawToolCall(t.app, writer.key, 'hours_set_exception', args);
    expect(again.asking!.question).toContain('close Oak Diner & Bar for');
    await t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => tenancy.updateVenue(ctx, diner.venueId, { name: 'Oak Diner' }));
  });

  it('an assistant that cannot ask is offered reads only, and a change it tries anyway is refused with where to make it', async () => {
    const from = mark();
    const legacy = await connectLegacy(t.app, writer.key);
    expect(await legacy.names()).not.toContain('hours_set_exception');
    await expect(legacy.call('hours_set_exception', { date: '2026-11-04', closed: true })).rejects.toThrow();
    await legacy.close();

    const mute = await connectModern(t.app, writer.key, { canAsk: false });
    expect(await mute.names()).not.toContain('hours_set_exception');
    expect(mute.instructions).toContain('cannot make changes');
    await mute.close();
    const tried = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-11-04', closed: true }, { canAsk: false });
    expect(tried.asking).toBeNull();
    expect(tried.answer?.isError ?? true).toBe(true);
    // Even carrying a yes it wrote for itself.
    const selfYes = await rawToolCall(t.app, writer.key, 'hours_set_exception', { date: '2026-11-04', closed: true }, { canAsk: false, inputResponses: YES });
    expect(selfYes.answer?.isError ?? true).toBe(true);

    // The tool runner itself refuses, with the console's address, whatever the list said.
    const caller = (await hub.resolveAgentKey(t.app, writer.key))!;
    const offered = hub.offeredTools(caller, { canAsk: true }).find((o) => o.tool.name === 'hours_set_exception')!;
    const refused = await hub.runTool(t.app, caller, offered, { date: '2026-11-04', closed: true }, { canAsk: false, mint: async () => 'unused' });
    expect(refused).toEqual({
      ok: false,
      message:
        'Nothing was changed. This assistant cannot put a question to you, and no change is made here that you have not been asked about. ' +
        'You can do this in the console at http://console.rosplatform.test/console, or use an assistant that can ask you to confirm.',
    });
    expect(await outcomes(writer.id, from)).toEqual(['cannot_ask']);
    expect(await exceptions('2026-11-04')).toEqual([]);
  });

  it('a key that was not allowed to make changes is never offered one, whatever scopes it holds', async () => {
    const { diner } = t.fixture;
    const readOnly = await issueKey(t.app, diner.orgId, await diner.as('owner'), { scopes: ['venue:read', 'venue:write'] });
    const s = await connectModern(t.app, readOnly.key, { answer: () => 'yes' });
    expect(await s.names()).not.toContain('hours_set_exception');
    await expect(s.call('hours_set_exception', { date: '2026-11-05', closed: true })).rejects.toThrow();
    await s.close();
    const raw = await rawToolCall(t.app, readOnly.key, 'hours_set_exception', { date: '2026-11-05', closed: true }, { inputResponses: YES });
    expect(raw.answer?.isError ?? true).toBe(true);
    expect(await exceptions('2026-11-05')).toEqual([]);
  });

  it('a change that is refused or breaks while it is being made is rolled back whole, and the person is told nothing was changed', async () => {
    const from = mark();
    const run = async (how: string, date: string) => {
      const s = await connectModern(t.app, writer.key, { answer: () => 'yes' });
      const r = await s.call('test_hub_fails_late', { date, how });
      await s.close();
      return r;
    };
    expect(await run('refused', '2026-11-06')).toMatchObject({ isError: true, text: 'Nothing was changed: That day is locked.' });
    const broken = await run('broken', '2026-11-07');
    expect(broken).toMatchObject({ isError: true, text: 'Nothing was changed. The venue system could not answer just now. Try again in a moment.' });
    expect(broken.text).not.toMatch(/deadlock|hour_exceptions/);
    // The change was written and its answer did not fit its declared shape: it is not kept, and nothing undeclared is shown.
    expect(await run('misshapen', '2026-11-08')).toMatchObject({ isError: true, text: 'Nothing was changed. The venue system could not answer just now. Try again in a moment.' });
    for (const date of ['2026-11-06', '2026-11-07', '2026-11-08']) expect(await exceptions(date)).toEqual([]);
    expect(await outcomes(writer.id, from, 'test_hub_fails_late')).toEqual(['asked', 'asked', 'asked', 'failed', 'failed', 'refused']);
    // Rolled back whole: the note was not spent either, so nothing is left half-done.
    const left = (await notes(writer.id)).filter((n) => n.tool === 'test_hub_fails_late');
    expect(left.map((n) => n.spent_at)).toEqual([null, null, null]);

    // A service that validates its own input says why, and nothing changes.
    const s = await connectModern(t.app, writer.key, { answer: () => 'yes' });
    const noTimes = await s.call('hours_set_exception', { date: '2026-11-09', closed: false });
    await s.close();
    expect(noTimes.isError).toBe(true);
    expect(noTimes.text).toMatch(/^Nothing was changed/);
    expect(await exceptions('2026-11-09')).toEqual([]);
  });

  it('an outcome that cannot be confirmed says so: a commit that does not come back is never reported as done, nor as not done', async () => {
    const from = mark();
    // A table whose rows are checked only at COMMIT, and always refused there.
    await sql`create table zz_hub_deferred (id integer primary key)`.execute(t.db);
    await sql`grant insert, select on zz_hub_deferred to app_tenant`.execute(t.db);
    await sql`create function zz_hub_refuse() returns trigger language plpgsql as $$ begin raise exception 'connection lost at commit'; end $$`.execute(t.db);
    await sql`create constraint trigger zz_hub_refuse after insert on zz_hub_deferred deferrable initially deferred for each row execute function zz_hub_refuse()`.execute(t.db);

    const s = await connectModern(t.app, writer.key, { answer: () => 'yes' });
    const r = await s.call('test_hub_commit_breaks', {});
    await s.close();
    expect(s.asked).toEqual(['Do the thing whose commit breaks?']);
    expect(r).toMatchObject({ isError: true, text: 'It could not be confirmed whether that was done. Check the console at http://console.rosplatform.test/console before trying again.', structured: null });
    expect(r.text).not.toMatch(/nothing was changed|connection lost/i);
    expect(await outcomes(writer.id, from, 'test_hub_commit_breaks')).toEqual(['asked', 'unsure']);
  });

  it('old confirmation notes are pruned a day after they expire', async () => {
    const before = (await notes(writer.id)).length;
    expect(before).toBeGreaterThan(3);
    t.clock.advanceDays(2);
    expect(await hub.pruneConfirmations(t.app, t.fixture.diner.orgId)).toBeGreaterThanOrEqual(before);
    expect(await notes(writer.id)).toEqual([]);
    expect(await hub.pruneConfirmations(t.app, t.fixture.diner.orgId)).toBe(0);
  });
});
