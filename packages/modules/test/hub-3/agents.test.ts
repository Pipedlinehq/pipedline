import { describe, expect, it } from 'vitest';
import { type LlmRequest, drainJobs, markConnectionHealth, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { analytics, approvals, hub, ordering } from '@ros/modules';
import { paidOrder } from '../commerce/helpers';
import { WORKER, agentApprovals, agentCalls, agentRuns, setAgent } from './helpers';

/**
 * The two agents built on the runner. `weekly_digest`: the digest's figures reach the owner's
 * inbox unchanged, and a model answer with a changed figure is thrown away. `ops_watch`: a
 * deterministic note of what needs someone, and a proposal where a tool exists.
 */
describe('hub: weekly_digest and ops_watch', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const venueId = () => diner().venueId;
  const digestMessages = (orgId: string) => t.db.selectFrom('messages').select(['id', 'to_address', 'status', 'kind', 'payload', 'idempotency_key']).where('org_id', '=', orgId).where('template_key', '=', 'hub.weekly_digest').orderBy('to_address').execute();
  const ownerEmails = async (orgId: string) => (await t.db.selectFrom('staff').select('email').where('org_id', '=', orgId).where('is_owner', '=', true).where('status', '!=', 'disabled').orderBy('email').execute()).map((s) => s.email);

  /** Test-only direct writes: wipe an agent's history, and clear the orders the fixture leaves waiting. */
  const forget = async (agentKey: string) => {
    await t.db.deleteFrom('agent_calls').where('hosted_agent_key', '=', agentKey).execute();
    await t.db.deleteFrom('agent_runs').where('agent_key', '=', agentKey).execute();
  };
  const settleSeededOrders = async () => {
    await t.db.updateTable('orders').set({ status: 'completed' }).where('venue_id', '=', venueId()).where('status', '=', 'placed').execute();
    await t.db.updateTable('orders').set({ attention_at: null }).where('venue_id', '=', venueId()).execute();
    await t.db.updateTable('connections').set({ status: 'connected', last_error: null }).where('org_id', '=', diner().orgId).where('status', '=', 'unhealthy').execute();
  };

  /** A model that writes the note from the findings it was given, copying their figures. */
  const honest = (req: LlmRequest<unknown>) => {
    const f = JSON.parse(req.input) as hub.NoteFacts;
    const sales = f.headline.find((h) => h.what.toLowerCase().includes('net sales'))!;
    const orders = f.headline.find((h) => h.what.toLowerCase() === 'orders')!;
    return {
      subject: `${f.business}: the week of ${f.week}`,
      paragraphs: [
        `Net sales for the week of ${f.week} came to ${sales.this_week} from ${orders.this_week} orders${sales.usual ? `, against a usual ${sales.usual} (${sales.change})` : ''}.`,
        f.movers[0] ? `${f.movers[0].name} moved most: ${f.movers[0].this_week} against a usual ${f.movers[0].usual}.` : 'Nothing else stood out.',
      ],
    };
  };

  it('the figure check: copied figures pass; a changed, re-signed, rescaled or spelled-out figure does not', () => {
    const facts: hub.NoteFacts = {
      business: 'Oak Diner',
      week: '21 Sep to 27 Sep 2026',
      recorded: 'Week of 21 Sep to 27 Sep 2026: net sales $48,210 from 1,204 orders, 12% above the usual $43,000 for these weekdays (outside normal variation).',
      headline: [{ what: 'Net sales', this_week: '$48,210', usual: '$43,000', change: '+12%', direction: 'up', reads_as: 'good', standing: 'outside normal variation' }],
      movers: [{ kind: 'item', name: 'Steak frites', this_week: '$6,120', usual: '$5,000', change: '+$1,120', direction: 'up' }],
      caveats: ['61.5% of sales in the period are tied to a known customer; the new and returning counts describe only those.'],
    };
    const ok = 'Net sales came to $48,210 from 1,204 orders in the week of 21 Sep to 27 Sep 2026, up 12% on the usual $43,000. Steak frites was up $1,120 (+$1,120) at $6,120, and 61.5% of sales were to known guests.';
    expect(hub.checkFigures(ok, facts)).toEqual([]);
    expect(hub.checkFigures('Net sales came to $48,211.', facts)).toEqual(['"$48,211" is not a figure from the digest']);
    expect(hub.checkFigures('Net sales came to $48,210, about $6,887 a day.', facts)).toEqual(['"$6,887" is not a figure from the digest']);
    // The sign is part of the figure.
    expect(hub.checkFigures('Net sales moved -12%.', facts)).toEqual(['"-12%" is not a figure from the digest']);
    expect(hub.checkFigures('Net sales moved −12%.', facts)).toHaveLength(1);
    // The same digits with another unit are another figure.
    expect(hub.checkFigures('There were $1,204 in sales.', facts)).toHaveLength(1);
    expect(hub.checkFigures('Sales were up 43,000.', facts)).toHaveLength(1);
    // A figure written so it cannot be read back is refused.
    expect(hub.checkFigures('Net sales were about $48k.', facts).length).toBeGreaterThan(0);
    expect(hub.checkFigures('Net sales were nearly fifty thousand dollars.', facts).length).toBeGreaterThan(0);
    expect(hub.checkFigures('Sales rose twelve percent.', facts).length).toBeGreaterThan(0);
    expect(hub.checkFigures('A good week, well above the usual.', facts)).toEqual([]);
  });

  it('weekly_digest in shadow: reads the digest through the tool, writes the note, records it, sends nothing', async () => {
    await setAgent(t, diner(), venueId(), hub.weeklyDigestAgent.key, 'shadow');
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, honest);
    const out = await hub.runWeeklyDigest(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect(out).toMatchObject({ status: 'succeeded', mode: 'shadow' });
    expect(out.summary).toBe('Shadow: wrote the note for the week of 21 Sep to 27 Sep. Nothing was sent.');

    // The digest it read is the stored one, and every figure in the note is in it.
    const stored = await t.db.selectFrom('insight_digests').select(['payload', 'summary']).where('org_id', '=', diner().orgId).where('period', '=', 'week').where('venue_id', 'is', null).where('period_start', '=', '2026-09-21' as never).executeTakeFirstOrThrow();
    const digest = stored.payload as unknown as analytics.Digest;
    const run = (await agentRuns(t, diner().orgId, 'weekly_digest')).find((r) => r.id === out.runId)!;
    const note = (run.output as { notes: hub.DigestNoteResult[] }).notes[0]!;
    expect(note).toMatchObject({ target: null, week: { from: '2026-09-21', to: '2026-09-27' }, recorded: stored.summary, recipients: 0, sent: false });
    const net = digest.headline.find((h) => h.metric === 'net_sales')!;
    const orders = digest.headline.find((h) => h.metric === 'orders')!;
    expect(net.value).toBeGreaterThan(0);
    expect(note.note).toContain(hub.figure('cents', net.value!));
    expect(note.note).toContain(`from ${hub.figure('count', orders.value!)} orders`);
    expect(run.tokens_in).toBeGreaterThan(0);

    // Nothing went anywhere.
    expect(await digestMessages(diner().orgId)).toHaveLength(0);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((m) => m.subject?.includes('the week of'))).toHaveLength(0);
    // What it called, as itself: one read. The model saw findings, and no guest.
    expect((await agentCalls(t, diner().orgId, 'weekly_digest')).map((c) => [c.tool, c.effect, c.outcome, c.actor_kind])).toEqual([['insights_digest', 'read', 'answered', 'hosted_agent']]);
    const sent = t.sim.llm.calls.filter((c) => c.purpose === hub.WEEKLY_DIGEST_PURPOSE).at(-1)!;
    expect(sent.orgId).toBe(diner().orgId);
    expect(sent.input).not.toMatch(/@|\+61|04\d\d ?\d{3}/);
  });

  it('weekly_digest switched on: the owners get the note by transactional email, once, with the recorded figures beneath', async () => {
    await setAgent(t, diner(), venueId(), hub.weeklyDigestAgent.key, 'supervised');
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, honest);
    const owners = await ownerEmails(diner().orgId);
    expect(owners.length).toBeGreaterThan(0);

    const out = await hub.runWeeklyDigest(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect(out).toMatchObject({ status: 'succeeded', mode: 'supervised' });
    expect(out.summary).toBe(`Sent the note for the week of 21 Sep to 27 Sep to ${owners.length} ${owners.length === 1 ? 'owner' : 'owners'}.`);
    let rows = await digestMessages(diner().orgId);
    expect(rows.map((m) => m.to_address)).toEqual(owners);
    expect(rows.every((m) => m.kind === 'transactional' && m.status === 'queued')).toBe(true);

    await drainJobs(t.app);
    const stored = await t.db.selectFrom('insight_digests').select(['summary']).where('org_id', '=', diner().orgId).where('period', '=', 'week').where('venue_id', 'is', null).where('period_start', '=', '2026-09-21' as never).executeTakeFirstOrThrow();
    for (const address of owners) {
      const mail = t.sim.email.sent.filter((m) => m.to === address && m.subject === 'Oak Diner: the week of 21 Sep to 27 Sep 2026');
      expect(mail).toHaveLength(1);
      expect(mail[0]!.body).toContain('Net sales for the week of 21 Sep to 27 Sep 2026 came to $');
      // The digest's own sentence, built by template, is in the email as recorded.
      expect(mail[0]!.body).toContain(`The figures as recorded:\n${stored.summary}`);
    }
    rows = await digestMessages(diner().orgId);
    expect(rows.every((m) => m.status === 'sent')).toBe(true);

    // Run again for the same week: one message per owner, still.
    await hub.runWeeklyDigest(t.app, { orgId: diner().orgId, trigger: 'test-again' });
    await drainJobs(t.app);
    expect(await digestMessages(diner().orgId)).toHaveLength(owners.length);
    expect(t.sim.email.sent.filter((m) => m.subject === 'Oak Diner: the week of 21 Sep to 27 Sep 2026')).toHaveLength(owners.length);
    // No guest was written to, and nothing waited for approval: the note goes to the owners themselves.
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(0);
  });

  it('a model answer with a changed figure is rejected: the run fails, nothing is queued or sent', async () => {
    await setAgent(t, group(), Object.values(group().venues)[0]!.id, hub.weeklyDigestAgent.key, 'autonomous');
    for (const v of Object.values(group().venues)) await setAgent(t, group(), v.id, hub.weeklyDigestAgent.key, 'autonomous');
    let honestNote = '';
    let tamperedNote = '';
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, (req) => {
      const good = honest(req);
      honestNote = good.paragraphs[0]!;
      // One digit of the sales figure changed: $48,210 becomes $48,211 (or the like).
      const figure = /\$[\d,]*\d/.exec(honestNote)![0];
      const last = Number(figure.slice(-1));
      const changed = `${figure.slice(0, -1)}${(last + 1) % 10}`;
      tamperedNote = honestNote.replace(figure, changed);
      return { ...good, paragraphs: [tamperedNote, ...good.paragraphs.slice(1)] };
    });
    const before = t.sim.email.sent.length;
    const out = await hub.runWeeklyDigest(t.app, { orgId: group().orgId, trigger: 'test' });
    expect(tamperedNote).not.toBe(honestNote);
    expect(out).toMatchObject({ status: 'failed', mode: 'autonomous' });
    const run = (await agentRuns(t, group().orgId, 'weekly_digest')).find((r) => r.id === out.runId)!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/is not a figure from the digest/);
    expect((run.output as { rejected: string[] }).rejected).toHaveLength(1);
    // Nothing was queued, nothing was sent, and the tampered text is stored nowhere.
    expect(await digestMessages(group().orgId)).toHaveLength(0);
    await drainJobs(t.app);
    expect(t.sim.email.sent.length).toBe(before);
    expect(JSON.stringify(run.output)).not.toContain(tamperedNote);

    // The same model, honest: the note goes, to the group's owners, for the whole organisation.
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, honest);
    const ok = await hub.runWeeklyDigest(t.app, { orgId: group().orgId, trigger: 'test' });
    expect(ok.status).toBe('succeeded');
    expect((await digestMessages(group().orgId)).map((m) => m.to_address)).toEqual(await ownerEmails(group().orgId));
    // And none of it reached the other organisation.
    expect((await t.db.selectFrom('messages').select('id').where('org_id', '=', diner().orgId).where('idempotency_key', 'like', `%${group().orgId}%`).execute()).length).toBe(0);
  });

  it('on at some venues only: one note per venue it is on at, from that venue\'s digest', async () => {
    const [first, ...rest] = Object.values(group().venues);
    expect(rest.length).toBeGreaterThan(0);
    for (const v of rest) await setAgent(t, group(), v.id, hub.weeklyDigestAgent.key, 'off');
    await setAgent(t, group(), first!.id, hub.weeklyDigestAgent.key, 'shadow');
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, honest);
    const out = await hub.runWeeklyDigest(t.app, { orgId: group().orgId, trigger: 'test' });
    expect(out.status).toBe('succeeded');
    const notes = (out.output as { notes: hub.DigestNoteResult[] }).notes;
    expect(notes.map((n) => [n.target, n.venue])).toEqual([[first!.slug, first!.name]]);
    const venueDigest = await t.db.selectFrom('insight_digests').select('summary').where('org_id', '=', group().orgId).where('venue_id', '=', first!.id).where('period', '=', 'week').where('period_start', '=', '2026-09-21' as never).executeTakeFirstOrThrow();
    expect(notes[0]!.recorded).toBe(venueDigest.summary);
  });

  it('the weekly schedule: from Monday morning, once, and only for organisations that switched the agent on', async () => {
    // Fixture time is Wednesday: this week's note has not gone for the diner's Monday yet in this test's eyes.
    await forget('weekly_digest');
    for (const v of Object.values(group().venues)) await setAgent(t, group(), v.id, hub.weeklyDigestAgent.key, 'off');
    await setAgent(t, diner(), venueId(), hub.weeklyDigestAgent.key, 'shadow');
    t.sim.llm.respond(hub.WEEKLY_DIGEST_PURPOSE, honest);

    // Monday 5 October 2026, 06:30 in Sydney (daylight time): too early.
    t.clock.set('2026-10-04T19:30:00.000Z');
    expect(await hub.weeklyDigestDue(t.app, diner().orgId)).toBe(false);
    // 07:10: due.
    t.clock.set('2026-10-04T20:10:00.000Z');
    expect(await hub.weeklyDigestDue(t.app, diner().orgId)).toBe(true);
    expect(await hub.weeklyDigestDue(t.app, group().orgId)).toBe(false);

    await tickSchedules(t.app, { only: ['hub.weekly_digest'] });
    const queued = await t.db.selectFrom('jobs').select(['org_id']).where('kind', '=', 'hub.weekly_digest').where('status', '=', 'queued').execute();
    expect(queued.map((j) => j.org_id)).toEqual([diner().orgId]);
    await drainJobs(t.app, { kinds: ['hub.weekly_digest'] });
    const runs = await agentRuns(t, diner().orgId, 'weekly_digest');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'succeeded', mode: 'shadow' });
    expect((runs[0]!.output as { week: { from: string; to: string } }).week).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(runs[0]!.trigger).toMatch(/^schedule:hub\.weekly_digest:/);

    // The next hour, and the next day: nothing more this week.
    t.clock.advanceMinutes(60);
    expect(await hub.weeklyDigestDue(t.app, diner().orgId)).toBe(false);
    await tickSchedules(t.app, { only: ['hub.weekly_digest'] });
    await drainJobs(t.app, { kinds: ['hub.weekly_digest'] });
    expect(await agentRuns(t, diner().orgId, 'weekly_digest')).toHaveLength(1);
    // The following Monday it is due again.
    t.clock.set('2026-10-11T21:00:00.000Z');
    expect(await hub.weeklyDigestDue(t.app, diner().orgId)).toBe(true);
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('ops_watch: a deterministic note of what needs someone; shadow proposes nothing, supervised queues one approval per waiting order', async () => {
    t.clock.set('2026-10-01T08:00:00.000Z');
    await settleSeededOrders();
    await setAgent(t, diner(), venueId(), hub.opsWatchAgent.key, 'shadow');
    const llmCalls = t.sim.llm.calls.length;

    // Nothing wrong yet.
    const quiet = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect(quiet).toHaveLength(1);
    expect(quiet[0]!.summary).toBe('Oak Diner, 18:00: nothing needs attention.');

    // A service stops working, a paid order sits unaccepted, an order is flagged, a job dies.
    const conn = await t.db.selectFrom('connections').select(['id', 'plug_key']).where('org_id', '=', diner().orgId).where('status', '=', 'connected').orderBy('plug_key').limit(1).executeTakeFirstOrThrow();
    await markConnectionHealth(t.app, conn.id, { ok: false, error: 'The saved access token has expired.' });
    const waiting = await paidOrder(t, diner(), venueId());
    const flagged = await paidOrder(t, diner(), venueId());
    await t.app.tenant(diner().orgId, WORKER, (ctx) => ordering.updateOrderStatus(ctx, { orderId: flagged.id, status: 'accepted' }));
    await t.app.tenant(diner().orgId, WORKER, (ctx) => ordering.flagOrderForStaff(ctx, { orderId: flagged.id, reason: 'The courier could not be booked.' }));
    await t.db.insertInto('jobs').values({ org_id: diner().orgId, kind: 'delivery.dispatch', status: 'dead', attempts: 8, max_attempts: 8, finished_at: t.clock(), last_error: 'gone' }).execute();
    // The other organisation's dead job is not this one's business.
    await t.db.insertInto('jobs').values({ org_id: group().orgId, kind: 'comms.send', status: 'dead', attempts: 8, max_attempts: 8, finished_at: t.clock() }).execute();
    t.clock.advanceMinutes(12);

    const [shadow] = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect(shadow).toMatchObject({ status: 'succeeded', mode: 'shadow' });
    const note = shadow!.output as hub.OpsWatchOutput & { actions: hub.ActionResult[] };
    expect(note.counts).toEqual({ unhealthy_connections: 1, flagged_orders: 1, waiting_orders: 1, quiet: false, dead_jobs: 1 });
    expect(note.findings).toEqual([
      `${conn.plug_key} has stopped working: The saved access token has expired. Reconnect it in the console.`,
      `Order ${waiting.reference} ($11.00) was paid 12 minutes ago and nobody has accepted it.`,
      `Order ${flagged.reference} is flagged for staff: The courier could not be booked.`,
      '1 background task has failed for good (delivery.dispatch). The platform team can see why; nothing more will be tried without them.',
    ]);
    expect(note.proposed).toEqual([{ order: waiting.reference, status: 'shadow', approvalId: null }]);
    expect(shadow!.summary).toContain('Shadow: would have asked a manager to accept 1 waiting order; nothing was queued.');
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(0);
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', waiting.id).executeTakeFirstOrThrow()).status).toBe('placed');
    // The note is on the run record, where the console reads it.
    const manager = await diner().as('manager');
    const listed = await t.app.tenant(diner().orgId, manager, (ctx) => hub.listAgentRuns(ctx, { agentKey: 'ops_watch', limit: 1 }));
    expect(listed[0]).toMatchObject({ agentName: 'Operations watch', mode: 'shadow', summary: shadow!.summary });

    // Supervised: the same note, and the waiting order is proposed for acceptance.
    await setAgent(t, diner(), venueId(), hub.opsWatchAgent.key, 'supervised');
    const [first] = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect((first!.output as hub.OpsWatchOutput).proposed).toMatchObject([{ order: waiting.reference, status: 'queued' }]);
    const pending = await agentApprovals(t, diner().orgId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.summary).toBe(`Operations watch proposes: Accept order ${waiting.reference} at Oak Diner (1 item, $11.00, pickup)? The kitchen will be told to start on it.`);
    // A quarter of an hour later it does not ask twice.
    t.clock.advanceMinutes(15);
    const [second] = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect((second!.output as hub.OpsWatchOutput).proposed).toMatchObject([{ order: waiting.reference, status: 'waiting', approvalId: pending[0]!.id }]);
    expect(await agentApprovals(t, diner().orgId)).toHaveLength(1);
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', waiting.id).executeTakeFirstOrThrow()).status).toBe('placed');

    // The manager says yes: the order is accepted and the kitchen has its ticket.
    await t.app.tenant(diner().orgId, manager, (ctx) => approvals.decideApproval(ctx, pending[0]!.id, { decision: 'approved' }));
    expect((await t.db.selectFrom('orders').select('status').where('id', '=', waiting.id).executeTakeFirstOrThrow()).status).toBe('accepted');
    const [after] = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect((after!.output as hub.OpsWatchOutput).counts.waiting_orders).toBe(0);
    expect((after!.output as hub.OpsWatchOutput).proposed).toEqual([]);

    // No model was involved at any point.
    expect(t.sim.llm.calls.length).toBe(llmCalls);
    // It ran for this organisation only.
    expect(await agentRuns(t, group().orgId, 'ops_watch')).toHaveLength(0);
    await markConnectionHealth(t.app, conn.id, { ok: true });
    await t.db.deleteFrom('jobs').where('status', '=', 'dead').execute();
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('ops_watch: open, past the middle of service, no sale today when the same weekday usually has some', async () => {
    const manager = await diner().as('manager');
    const status = () => t.app.tenant(diner().orgId, manager, (ctx) => hub.opsStatus(ctx, { venueId: venueId() }));
    const hours = await t.db.selectFrom('trading_hours').select(['day_of_week', 'opens_at', 'closes_at']).where('venue_id', '=', venueId()).where('day_of_week', '=', 3).orderBy('opens_at').execute();
    expect(hours.length).toBeGreaterThan(0);

    // Wednesday 7 October 2026, a week after the fixture's last sale, at 20:30 in Sydney (daylight time).
    await settleSeededOrders();
    t.clock.set('2026-10-07T09:30:00.000Z');
    const s = await status();
    expect(s.localTime).toBe('2026-10-07 20:30');
    expect(s.trading).toMatchObject({ openNow: true, midService: true, salesToday: 0 });
    // The oracle: sales by 20:30 on each of the last four Wednesdays, counted straight from the ledger.
    const oracle: number[] = [];
    for (const day of ['2026-09-30', '2026-09-23', '2026-09-16', '2026-09-09']) {
      const offset = day < '2026-10-04' ? '+10:00' : '+11:00';
      const r = await t.db
        .selectFrom('transactions')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('venue_id', '=', venueId())
        .where('status', 'in', ['completed', 'refunded', 'partially_refunded'])
        .where('occurred_at', '>=', new Date(`${day}T00:00:00${offset}`))
        .where('occurred_at', '<=', new Date(`${day}T20:30:00${offset}`))
        .executeTakeFirstOrThrow();
      oracle.push(Number(r.n));
    }
    expect(s.trading.usualByNow).toEqual(oracle);
    expect(oracle.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(s.trading.quiet).toBe(true);
    expect(s.findings).toEqual([`No sale has been recorded today by 20:30, mid-service. On the last 4 of this weekday there were ${oracle.join(', ')} by this time. Either the venue is not trading or sales are not reaching the ledger: check the till connection.`]);

    // The agent reports it; there is no tool that fixes it, so it proposes nothing.
    await setAgent(t, diner(), venueId(), hub.opsWatchAgent.key, 'supervised');
    const [run] = await hub.runOpsWatch(t.app, { orgId: diner().orgId, trigger: 'test' });
    expect((run!.output as hub.OpsWatchOutput).counts.quiet).toBe(true);
    expect((run!.output as hub.OpsWatchOutput).proposed).toEqual([]);
    expect(run!.summary).toContain('No sale has been recorded today by 20:30');

    // Before the venue opens that day, it is not a finding; nor once a sale has come in.
    t.clock.set('2026-10-06T20:00:00.000Z');
    expect((await status()).trading).toMatchObject({ midService: false, quiet: false });
    t.clock.set('2026-10-07T09:20:00.000Z');
    await paidOrder(t, diner(), venueId());
    t.clock.set('2026-10-07T09:30:00.000Z');
    expect((await status()).trading).toMatchObject({ midService: true, salesToday: 1, quiet: false });

    // Another organisation's manager, or someone below manager here: not for them.
    const other = await group().as('manager');
    await expect(t.app.tenant(group().orgId, other, (ctx) => hub.opsStatus(ctx, { venueId: venueId() }))).rejects.toMatchObject({ code: 'not_found' });
    const kitchen = await diner().as('kitchen');
    await expect(t.app.tenant(diner().orgId, kitchen, (ctx) => hub.opsStatus(ctx, { venueId: venueId() }))).rejects.toMatchObject({ code: 'forbidden' });
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('the ops schedule enqueues only for organisations with the agent on, and each venue gets its own run', async () => {
    const [first, second, ...others] = Object.values(group().venues);
    for (const v of others) await setAgent(t, group(), v.id, hub.opsWatchAgent.key, 'off');
    await setAgent(t, diner(), venueId(), hub.opsWatchAgent.key, 'off');
    await setAgent(t, group(), first!.id, hub.opsWatchAgent.key, 'shadow');
    await setAgent(t, group(), second!.id, hub.opsWatchAgent.key, 'supervised');
    await forget('ops_watch');
    t.clock.advanceMinutes(20);
    await tickSchedules(t.app, { only: ['hub.ops_watch'] });
    const queued = await t.db.selectFrom('jobs').select('org_id').where('kind', '=', 'hub.ops_watch').where('status', '=', 'queued').execute();
    expect(queued.map((j) => j.org_id)).toEqual([group().orgId]);
    // Ticking twice in the same quarter hour queues nothing more.
    await tickSchedules(t.app, { only: ['hub.ops_watch'] });
    expect(await t.db.selectFrom('jobs').select('id').where('kind', '=', 'hub.ops_watch').where('status', '=', 'queued').execute()).toHaveLength(1);
    await drainJobs(t.app, { kinds: ['hub.ops_watch'] });
    const runs = await agentRuns(t, group().orgId, 'ops_watch');
    expect(runs.map((r) => [r.venue_id, r.mode]).sort()).toEqual([[first!.id, 'shadow'], [second!.id, 'supervised']].sort());
    expect(await agentRuns(t, diner().orgId, 'ops_watch')).toHaveLength(0);
    t.clock.set('2026-09-30T02:00:00.000Z');
  });
});
