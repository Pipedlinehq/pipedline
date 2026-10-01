import { beforeAll, describe, expect, it } from 'vitest';
import { type Principal, getTool, setModule } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { specials, tenancy } from '@ros/modules';
import { YES, connectModern, issueKey, rawToolCall, roomForKeys } from '../hub/helpers';

/**
 * The specials board, the worked example of docs/PLUGINS.md. Every write is read back from the
 * database, and the negative cases of docs/THREAT_MODEL.md section 11 that apply are here:
 * wrong role, another organisation's id, module off, a replayed confirmation, and the price.
 */
const WORKER = { kind: 'worker' as const, job: 'test' };
const ANON: Principal = { kind: 'anon' };
const TODAY = '2026-09-30'; // FIXTURE_NOW is midday on this day in Sydney.

describe('specials: the board', () => {
  const t = useTestEnv();

  const rows = (venueId: string) => t.db.selectFrom('specials').selectAll().where('venue_id', '=', venueId).orderBy('created_at').execute();
  const audits = (orgId: string, action: string) => t.db.selectFrom('audit_log').select(['actor_kind', 'entity_id', 'venue_id', 'after']).where('org_id', '=', orgId).where('action', '=', action).execute();
  const events = (orgId: string, name: string) => t.db.selectFrom('events').select(['venue_id', 'properties']).where('org_id', '=', orgId).where('name', '=', name).execute();
  const board = (orgId: string, venueId: string) => t.app.tenant(orgId, ANON, (ctx) => specials.getCurrentSpecials(ctx, venueId));

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
  });

  it('the fixture board: a guest sees what runs today, staff also see what is scheduled, and each venue has its own', async () => {
    const { diner, group } = t.fixture;
    expect(await board(diner.orgId, diner.venueId)).toEqual({
      heading: 'Specials',
      specials: [{ id: expect.any(String), name: 'Slow-roasted lamb shoulder', description: 'For two, with roast potatoes and mint sauce.', price: '$64.00', priceCents: 6400, lastDay: '2026-10-02' }],
    });
    const listed = await t.app.tenant(diner.orgId, await diner.as('kitchen'), (ctx) => specials.listSpecials(ctx, { venueId: diner.venueId }));
    expect(listed.map((s) => [s.name, s.status]).sort()).toEqual([
      ['Oyster hour', 'upcoming'],
      ['Slow-roasted lamb shoulder', 'running'],
    ]);

    // A special posted at one venue of a group is not on another venue's board.
    const manager = await group.as('manager');
    await t.app.tenant(group.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: group.venues.cbd!.id, name: 'CBD lunch bowl', priceCents: 1650 }));
    expect((await board(group.orgId, group.venues.cbd!.id)).specials.map((s) => s.name)).toContain('CBD lunch bowl');
    expect((await board(group.orgId, group.venues.newtown!.id)).specials.map((s) => s.name)).not.toContain('CBD lunch bowl');
    // That manager has no role at Bondi: the venue is not found for them, not forbidden.
    await expect(t.app.tenant(group.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: group.venues.bondi!.id, name: 'Bondi bowl', priceCents: 1650 }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a manager posts a special: the row, the audit entry and the event are there, and the price is the one typed', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const made = await t.app.tenant(diner.orgId, manager, (ctx) =>
      specials.postSpecial(ctx, { venueId: diner.venueId, name: '  Fish pie ', description: 'With peas.', priceCents: 1850, startsOn: TODAY, endsOn: '2026-10-06' }),
    );
    expect(made).toMatchObject({ name: 'Fish pie', priceCents: 1850, startsOn: TODAY, endsOn: '2026-10-06', status: 'running', endedAt: null });

    const row = await t.db.selectFrom('specials').selectAll().where('id', '=', made.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: diner.orgId, venue_id: diner.venueId, name: 'Fish pie', description: 'With peas.', price_cents: 1850, starts_on: TODAY, ends_on: '2026-10-06', ended_at: null, created_by_kind: 'staff', created_by_id: manager.staffId });
    expect((await audits(diner.orgId, 'specials.posted')).find((a) => a.entity_id === made.id)).toMatchObject({ actor_kind: 'staff', venue_id: diner.venueId, after: { name: 'Fish pie', priceCents: 1850, startsOn: TODAY, endsOn: '2026-10-06' } });
    expect((await events(diner.orgId, 'special.posted')).find((e) => (e.properties as { special_id: string }).special_id === made.id)).toMatchObject({ venue_id: diner.venueId, properties: { price_cents: 1850, days: 7 } });
    expect((await board(diner.orgId, diner.venueId)).specials.find((s) => s.id === made.id)).toMatchObject({ price: '$18.50', priceCents: 1850 });

    // The same special for the same first day is one special.
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: diner.venueId, name: 'fish PIE', priceCents: 1, startsOn: TODAY }))).rejects.toMatchObject({ code: 'conflict' });
    expect((await rows(diner.venueId)).filter((r) => r.name.toLowerCase() === 'fish pie')).toHaveLength(1);
  });

  it('wrong role: staff below manager are forbidden, a guest and a visitor are told to sign in, and nothing is written', async () => {
    const { diner } = t.fixture;
    const before = (await rows(diner.venueId)).length;
    const input = { venueId: diner.venueId, name: 'Free lobster', priceCents: 0 };
    for (const who of ['host', 'kitchen'] as const) {
      await expect(t.app.tenant(diner.orgId, await diner.as(who), (ctx) => specials.postSpecial(ctx, input))).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    }
    const guest = await t.db.selectFrom('customers').select('id').where('org_id', '=', diner.orgId).limit(1).executeTakeFirstOrThrow();
    for (const who of [ANON, { kind: 'guest', customerId: guest.id }] as Principal[]) {
      await expect(t.app.tenant(diner.orgId, who, (ctx) => specials.postSpecial(ctx, input))).rejects.toMatchObject({ code: 'unauthenticated' });
      await expect(t.app.tenant(diner.orgId, who, (ctx) => specials.listSpecials(ctx, { venueId: diner.venueId }))).rejects.toMatchObject({ code: 'unauthenticated' });
    }
    const lamb = (await rows(diner.venueId)).find((r) => r.name === 'Slow-roasted lamb shoulder')!;
    await expect(t.app.tenant(diner.orgId, await diner.as('host'), (ctx) => specials.endSpecial(ctx, { specialId: lamb.id }))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await rows(diner.venueId)).length).toBe(before);
    expect((await t.db.selectFrom('specials').select('ended_at').where('id', '=', lamb.id).executeTakeFirstOrThrow()).ended_at).toBeNull();
    // The tool's own gate says the same thing as the service function behind it.
    const post = getTool('special_post')!;
    if (post.effect !== 'write') throw new Error('special_post is a write');
    expect(post.minRole).toBe('manager');
    await expect(t.app.tenant(diner.orgId, await diner.as('host'), (ctx) => post.propose({ ctx, venueId: diner.venueId }, { name: 'Free lobster', price_cents: 0 }))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('another organisation\'s ids are not found: its venue, its special, its board', async () => {
    const { diner, group } = t.fixture;
    const manager = await diner.as('manager');
    const theirs = (await rows(group.venues.cbd!.id))[0]!;
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: group.venues.cbd!.id, name: 'Planted', priceCents: 100 }))).rejects.toMatchObject({ code: 'not_found', status: 404 });
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => specials.listSpecials(ctx, { venueId: group.venues.cbd!.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner.orgId, manager, (ctx) => specials.endSpecial(ctx, { specialId: theirs.id }))).rejects.toMatchObject({ code: 'not_found' });
    // Even the diner's owner, and even the public read made on the diner's own site.
    await expect(t.app.tenant(diner.orgId, await diner.as('owner'), (ctx) => specials.endSpecial(ctx, { specialId: theirs.id }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(board(diner.orgId, group.venues.cbd!.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.db.selectFrom('specials').select('ended_at').where('id', '=', theirs.id).executeTakeFirstOrThrow()).ended_at).toBeNull();
    expect((await rows(group.venues.cbd!.id)).some((r) => r.name === 'Planted')).toBe(false);
  });

  it('the price is integer cents from a manager; nothing else is accepted and no guest-facing call takes one', async () => {
    const { diner } = t.fixture;
    const manager = await diner.as('manager');
    const post = (extra: Record<string, unknown>) => t.app.tenant(diner.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: diner.venueId, name: 'Priced oddly', ...extra } as never));
    await expect(post({ priceCents: 18.5 })).rejects.toThrow();
    await expect(post({ priceCents: -1 })).rejects.toThrow();
    await expect(post({ priceCents: '1850' })).rejects.toThrow();
    await expect(post({})).rejects.toThrow();
    // An argument the function does not have (an organisation, a status) is refused, not ignored.
    await expect(post({ priceCents: 1850, orgId: t.fixture.group.orgId })).rejects.toThrow();
    expect((await rows(diner.venueId)).some((r) => r.name === 'Priced oddly')).toBe(false);
    // The guest-facing read takes a venue id and nothing else.
    expect(specials.getCurrentSpecials.length).toBe(2);

    // A venue that hides prices: guests get none, staff still do, and the stored price is untouched.
    await t.app.tenant(diner.orgId, manager, (ctx) => tenancy.configurePlugin(ctx, { venueId: diner.venueId, plugin: 'specials', config: { show_prices: false, heading: 'Today only' } }));
    const hidden = await board(diner.orgId, diner.venueId);
    expect(hidden.heading).toBe('Today only');
    expect(hidden.specials.length).toBeGreaterThan(0);
    for (const s of hidden.specials) expect(s).toMatchObject({ price: null, priceCents: null });
    expect(JSON.stringify(hidden)).not.toContain('6400');
    expect((await t.app.tenant(diner.orgId, manager, (ctx) => specials.listSpecials(ctx, { venueId: diner.venueId }))).find((s) => s.name === 'Slow-roasted lamb shoulder')!.priceCents).toBe(6400);
    await t.app.tenant(diner.orgId, manager, (ctx) => tenancy.configurePlugin(ctx, { venueId: diner.venueId, plugin: 'specials', config: { show_prices: true, heading: 'Specials' } }));
  });

  it('the venue\'s settings are limits the code obeys: how many, how long, and no days that have passed', async () => {
    const { group } = t.fixture;
    const venueId = group.venues.newtown!.id;
    const manager = await group.as('manager');
    const post = (name: string, extra: Record<string, unknown> = {}) => t.app.tenant(group.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId, name, priceCents: 1200, ...extra }));
    await t.app.tenant(group.orgId, manager, (ctx) => tenancy.configurePlugin(ctx, { venueId, plugin: 'specials', config: { max_running: 3, max_days: 7 } }));

    await expect(post('Too long', { startsOn: TODAY, endsOn: '2026-10-07' })).rejects.toMatchObject({ code: 'invalid', message: 'A special may run for at most 7 days here. That is 8.' });
    await expect(post('Yesterday', { startsOn: '2026-09-29' })).rejects.toMatchObject({ code: 'invalid', message: 'Those days have already passed.' });
    await expect(post('Backwards', { startsOn: '2026-10-03', endsOn: '2026-10-02' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(post('No such day', { startsOn: '2026-02-30' })).rejects.toThrow();
    // Two are seeded; the third fits and the fourth does not.
    await post('Third');
    await expect(post('Fourth')).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('the most allowed here') });
    expect((await rows(venueId)).map((r) => r.name)).toEqual(['Slow-roasted lamb shoulder', 'Oyster hour', 'Third']);
    // The other venue of the same organisation keeps its own limit.
    await t.app.tenant(group.orgId, manager, (ctx) => specials.postSpecial(ctx, { venueId: group.venues.cbd!.id, name: 'CBD fourth', priceCents: 900 }));
  });

  it('"today" is the venue\'s own calendar day, not the server\'s', async () => {
    const { group } = t.fixture;
    const venueId = group.venues.bondi!.id;
    expect((await board(group.orgId, venueId)).specials.map((s) => s.name)).toEqual(['Slow-roasted lamb shoulder']);
    // 15:00 UTC on 30 September is 01:00 on 1 October in Sydney.
    t.clock.set('2026-09-30T15:00:00.000Z');
    expect((await board(group.orgId, venueId)).specials.map((s) => s.name)).toEqual(['Slow-roasted lamb shoulder', 'Oyster hour']);
    // The day after the lamb's last day and the oysters' only day: the board is empty and nothing was deleted.
    t.clock.set('2026-10-02T15:00:00.000Z');
    expect((await board(group.orgId, venueId)).specials).toEqual([]);
    const all = await t.app.tenant(group.orgId, await group.as('owner'), (ctx) => specials.listSpecials(ctx, { venueId, show: 'all' }));
    expect(all.map((s) => s.status)).toEqual(['over', 'over']);
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('through an assistant: listed with the key\'s scope, a post is asked first in plain words, and a replayed yes posts once', async () => {
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    const reader = await issueKey(t.app, diner.orgId, owner, { scopes: ['specials:read'] });
    const writer = await issueKey(t.app, diner.orgId, owner, { scopes: ['specials:read', 'specials:write'], canWrite: true });
    const named = (name: string) => t.db.selectFrom('specials').selectAll().where('venue_id', '=', diner.venueId).where('name', '=', name).execute();

    // The read scope alone: one tool, and no price or field the output shape does not name.
    const r = await connectModern(t.app, reader.key);
    expect((await r.names()).filter((n) => n.startsWith('special'))).toEqual(['specials_list']);
    const list = (await r.call('specials_list')).structured as { specials: Array<Record<string, unknown>>; running_today: number };
    expect(list.specials.find((s) => s.name === 'Slow-roasted lamb shoulder')).toEqual({
      special_id: expect.any(String),
      name: 'Slow-roasted lamb shoulder',
      description: 'For two, with roast potatoes and mint sauce.',
      price: '$64.00',
      price_cents: 6400,
      first_day: TODAY,
      last_day: '2026-10-02',
      status: 'running',
    });
    await r.close();
    // A key that may change things but whose assistant cannot ask its person is offered no write.
    const mute = await connectModern(t.app, writer.key, { canAsk: false });
    expect((await mute.names()).filter((n) => n.startsWith('special'))).toEqual(['specials_list']);
    await mute.close();

    // The first call changes nothing and returns the question, with the price in words.
    const args = { name: 'Beef cheek', description: 'Braised overnight.', price_cents: 3250, ends_on: '2026-10-01' };
    const first = await rawToolCall(t.app, writer.key, 'special_post', args);
    expect(first.asking!.question).toBe('Post "Beef cheek" at $32.50 on the specials board at Oak Diner, from 2026-09-30 to 2026-10-01 (2 days)? Guests see it on those days.');
    expect(await named('Beef cheek')).toEqual([]);

    // A yes carried to different arguments (a cheaper price) changes nothing.
    const swapped = await rawToolCall(t.app, writer.key, 'special_post', { ...args, price_cents: 1 }, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(swapped.answer).toMatchObject({ isError: true, text: 'Nothing was changed. The details are not the ones you were asked about; ask again.' });
    expect(await named('Beef cheek')).toEqual([]);

    // The yes to the question that was shown: posted, at the price that was shown.
    const yes = await rawToolCall(t.app, writer.key, 'special_post', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false, structured: { name: 'Beef cheek', price: '$32.50', price_cents: 3250, first_day: TODAY, last_day: '2026-10-01', status: 'running' } });
    expect(await named('Beef cheek')).toMatchObject([{ price_cents: 3250, starts_on: TODAY, ends_on: '2026-10-01', created_by_kind: 'agent', created_by_id: writer.id }]);

    // The same yes again: spent. One row, one audit entry, one event.
    const again = await rawToolCall(t.app, writer.key, 'special_post', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(again.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has already been used; ask again to do it again.' });
    const [posted] = await named('Beef cheek');
    expect(await named('Beef cheek')).toHaveLength(1);
    expect((await audits(diner.orgId, 'specials.posted')).filter((a) => a.entity_id === posted!.id)).toMatchObject([{ actor_kind: 'agent' }]);
    expect((await events(diner.orgId, 'special.posted')).filter((e) => (e.properties as { special_id: string }).special_id === posted!.id)).toHaveLength(1);
    // Asking afresh for the same special is refused before anyone is asked: it is already there.
    const dup = await rawToolCall(t.app, writer.key, 'special_post', args);
    expect(dup.asking).toBeNull();
    expect(dup.answer).toMatchObject({ isError: true, text: '"Beef cheek" is already on the board from 2026-09-30.' });

    // A no changes nothing.
    const no = await connectModern(t.app, writer.key, { answer: () => 'no' });
    expect(await no.call('special_post', { name: 'Declined dish', price_cents: 900 })).toMatchObject({ isError: true, text: 'Nothing was changed: you did not confirm it.' });
    expect(no.asked).toEqual(['Post "Declined dish" at $9.00 on the specials board at Oak Diner, on 2026-09-30? Guests see it on that day.']);
    await no.close();
    expect(await named('Declined dish')).toEqual([]);

    // What the hub recorded about these calls names the tool and the outcome, never the arguments.
    const calls = await t.db.selectFrom('agent_calls').selectAll().where('key_id', '=', writer.id).execute();
    expect(calls.map((c) => `${c.tool}/${c.outcome}`).sort()).toEqual(['special_post/asked', 'special_post/asked', 'special_post/confirmed', 'special_post/declined', 'special_post/refused', 'special_post/spent', 'special_post/stale']);
    expect(JSON.stringify(calls)).not.toMatch(/Beef cheek|3250/);
  });

  it('taking a special down: by name through an assistant, once, with the audit entry and the event; a second end is no second effect', async () => {
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    const writer = await issueKey(t.app, diner.orgId, owner, { scopes: ['specials:read', 'specials:write'], canWrite: true });
    const made = await t.app.tenant(diner.orgId, owner, (ctx) => specials.postSpecial(ctx, { venueId: diner.venueId, name: 'Pumpkin soup', priceCents: 1400, endsOn: '2026-10-03' }));
    const stored = () => t.db.selectFrom('specials').select(['ended_at']).where('id', '=', made.id).executeTakeFirstOrThrow();

    const first = await rawToolCall(t.app, writer.key, 'special_end', { special: 'pumpkin soup' });
    expect(first.asking!.question).toBe('Take "Pumpkin soup" ($14.00, 2026-09-30 to 2026-10-03) off the specials board now? Guests stop seeing it straight away.');
    expect((await stored()).ended_at).toBeNull();
    const yes = await rawToolCall(t.app, writer.key, 'special_end', { special: 'pumpkin soup' }, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false, structured: { special_id: made.id, status: 'ended' } });
    expect((await stored()).ended_at).toEqual(t.clock());
    expect((await board(diner.orgId, diner.venueId)).specials.map((s) => s.name)).not.toContain('Pumpkin soup');

    // The yes replayed, and the function called again directly: nothing more happens.
    const again = await rawToolCall(t.app, writer.key, 'special_end', { special: 'pumpkin soup' }, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(again.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has already been used; ask again to do it again.' });
    const at = (await stored()).ended_at;
    t.clock.advanceMinutes(5);
    expect(await t.app.tenant(diner.orgId, owner, (ctx) => specials.endSpecial(ctx, { specialId: made.id }))).toMatchObject({ status: 'ended', endedAt: at });
    expect((await stored()).ended_at).toEqual(at);
    expect((await audits(diner.orgId, 'specials.ended')).filter((a) => a.entity_id === made.id)).toMatchObject([{ actor_kind: 'agent', venue_id: diner.venueId, after: { status: 'ended' } }]);
    expect((await events(diner.orgId, 'special.ended')).filter((e) => (e.properties as { special_id: string }).special_id === made.id)).toMatchObject([{ properties: { early: true } }]);
    // It is no longer one the tool can find, and the name is free to post again.
    expect((await rawToolCall(t.app, writer.key, 'special_end', { special: made.id })).answer).toMatchObject({ isError: true, text: expect.stringContaining('No special running or scheduled here') });
    await t.app.tenant(diner.orgId, owner, (ctx) => specials.postSpecial(ctx, { venueId: diner.venueId, name: 'Pumpkin soup', priceCents: 1500 }));
    t.clock.set('2026-09-30T02:00:00.000Z');
  });

  it('in the plugin list an assistant reads: what it is, what it needs, and every setting described', async () => {
    const { diner } = t.fixture;
    const plugins = await t.app.tenant(diner.orgId, await diner.as('manager'), (ctx) => tenancy.listPlugins(ctx, diner.venueId));
    const mine = plugins.find((p) => p.key === 'specials')!;
    expect(mine).toMatchObject({
      name: 'Specials board',
      kind: 'plugin',
      on: true,
      canSwitch: true,
      assistantMayChange: true,
      settingsApplyTo: 'venue',
      settings: { heading: 'Specials', show_prices: true, max_running: 10, max_days: 31 },
    });
    expect(mine.purpose).toMatch(/^Daily or weekly specials/);
    expect(mine.needs).toHaveLength(1);
    const props = (mine.settingsSchema as { properties: Record<string, { description?: string; default?: unknown; type?: string; minimum?: number; maximum?: number }> }).properties;
    expect(Object.keys(props).sort()).toEqual(['heading', 'max_days', 'max_running', 'show_prices']);
    for (const p of Object.values(props)) expect(p.description).toMatch(/\w{3,}/);
    expect(props.max_running).toMatchObject({ type: 'integer', default: 10, minimum: 1, maximum: 50 });

    // A setting it does not have, and a value it does not accept, are refused in words; nothing is saved.
    const manager = await diner.as('manager');
    const configure = (config: Record<string, unknown>) => t.app.tenant(diner.orgId, manager, (ctx) => tenancy.configurePlugin(ctx, { venueId: diner.venueId, plugin: 'specials', config }));
    await expect(configure({ colour: 'red' })).rejects.toMatchObject({ code: 'invalid', message: 'Specials board has no setting called "colour". Its settings are: heading, show_prices, max_running, max_days.' });
    await expect(configure({ max_running: 0 })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/^Those settings for Specials board are not valid\. max_running: /) });
    expect((await t.db.selectFrom('venue_modules').select('config').where('venue_id', '=', diner.venueId).where('module_key', '=', 'specials').executeTakeFirstOrThrow()).config).toMatchObject({ max_running: 10 });
  });

  // Last: it switches the module off at the diner.
  it('module off: every function answers not-found, the tools are not offered, and the data is kept for when it is switched back on', async () => {
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    const key = await issueKey(t.app, diner.orgId, owner, { scopes: ['specials:read', 'specials:write', 'venue:read'], canWrite: true });
    const before = await rows(diner.venueId);
    const lamb = before.find((r) => r.name === 'Slow-roasted lamb shoulder')!;
    await t.app.tenant(diner.orgId, owner, (ctx) => tenancy.disablePlugin(ctx, { venueId: diner.venueId, plugin: 'specials' }));

    const off = { code: 'module_disabled', status: 404, message: 'That is not available at this venue.' };
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => specials.postSpecial(ctx, { venueId: diner.venueId, name: 'While off', priceCents: 100 }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => specials.listSpecials(ctx, { venueId: diner.venueId }))).rejects.toMatchObject(off);
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => specials.endSpecial(ctx, { specialId: lamb.id }))).rejects.toMatchObject(off);
    await expect(board(diner.orgId, diner.venueId)).rejects.toMatchObject(off);
    const s = await connectModern(t.app, key.key, { answer: () => 'yes' });
    const names = await s.names();
    expect(names).toContain('venue_status');
    expect(names.filter((n) => n.startsWith('special'))).toEqual([]);
    await expect(s.call('specials_list')).rejects.toThrow(/not found/);
    await s.close();
    // Nothing was deleted or changed by switching it off.
    expect(await rows(diner.venueId)).toEqual(before);

    await t.app.tenant(diner.orgId, WORKER, (ctx) => setModule(ctx, specials.specialsModule, { venueId: diner.venueId, enabled: true }));
    expect((await board(diner.orgId, diner.venueId)).specials.map((x) => x.name)).toContain('Slow-roasted lamb shoulder');
  });
});
