import { beforeAll, describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { YES, issueKey, rawToolCall, roomForKeys } from '../hub/helpers';
import { unique } from './helpers';

/**
 * The assistant tools for guest lists, offers and surcharges, through the hub: the first call
 * changes nothing and asks; a yes commits once; the same yes again changes nothing more.
 */
describe('guest lists and offers: assistant tools', () => {
  const t = useTestEnv();
  let key: { key: string; id: string };

  beforeAll(async () => {
    await roomForKeys(t.app, t.fixture);
    const owner = await t.fixture.diner.as('owner');
    key = await issueKey(t.app, t.fixture.diner.orgId, owner, { scopes: ['guest_lists:read', 'guest_lists:write', 'offers:read', 'offers:write'], canWrite: true });
  });

  const segments = (name: string) => t.db.selectFrom('segments').select(['id', 'definition', 'is_system']).where('org_id', '=', t.fixture.diner.orgId).where('name', '=', name).execute();
  const offersNamed = (name: string) => t.db.selectFrom('offers').select(['id', 'method', 'audience', 'segment_id', 'days', 'services', 'is_active']).where('org_id', '=', t.fixture.diner.orgId).where('name', '=', name).execute();
  const surcharges = (name: string) => t.db.selectFrom('surcharges').select(['id', 'kind', 'percent_bp', 'venue_id']).where('org_id', '=', t.fixture.diner.orgId).where('name', '=', name).execute();

  it('guest_list_set: asks with the rule in words and a count, changes nothing, commits once, and a replayed yes changes nothing more', async () => {
    const name = unique('Lapsed emailers');
    const args = { name, rule: 'last visit more than 60 days ago AND said yes to email' };
    const first = await rawToolCall(t.app, key.key, 'guest_list_set', args);
    expect(first.answer).toBeNull();
    expect(first.asking!.question).toMatch(new RegExp(`^Create the guest list "${name}" with the rule "last visit more than 60 days ago and said yes to email is yes" \\(guests who last visit was more than 60 days ago and said yes to email; \\d+ guests today\\)\\?`));
    expect(await segments(name)).toEqual([]);

    const yes = await rawToolCall(t.app, key.key, 'guest_list_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false });
    expect(yes.answer!.structured).toMatchObject({ name, rule: 'last visit more than 60 days ago and said yes to email is yes' });
    const rows = await segments(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ definition: { query: 'last visit more than 60 days ago and said yes to email is yes' }, is_system: false });

    const replay = await rawToolCall(t.app, key.key, 'guest_list_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(replay.answer).toMatchObject({ isError: true, text: 'Nothing was changed. That confirmation has already been used; ask again to do it again.' });
    expect(await segments(name)).toHaveLength(1);

    // A bad rule is refused before anyone is asked; a built-in list cannot be changed.
    const bad = await rawToolCall(t.app, key.key, 'guest_list_set', { name: unique('bad'), rule: 'visits > 3' });
    expect(bad.asking).toBeNull();
    expect(bad.answer?.isError ?? !!bad.error).toBe(true);
    const builtIn = (await t.db.selectFrom('segments').select('id').where('org_id', '=', t.fixture.diner.orgId).where('name', '=', 'Regulars').executeTakeFirstOrThrow()).id;
    const locked = await rawToolCall(t.app, key.key, 'guest_list_set', { name: 'Regulars', rule: 'visits is 1', list_id: builtIn });
    expect(locked.asking).toBeNull();
    expect(JSON.stringify(locked)).toContain('built-in list');

    // The preview reads: counts and first names only.
    const preview = await rawToolCall(t.app, key.key, 'guest_list_preview', { list: name });
    expect(preview.answer).toMatchObject({ isError: false });
    const out = preview.answer!.structured as { guests: number; can_email: number; sample_first_names: string[]; words: string };
    expect(out.guests).toBeGreaterThanOrEqual(out.can_email);
    expect(out.words).toMatch(/^Guests who /);
    expect(JSON.stringify(out)).not.toMatch(/@/);
    const tryRule = await rawToolCall(t.app, key.key, 'guest_list_preview', { rule: 'suburb is Nowhere-in-particular' });
    expect((tryRule.answer!.structured as { guests: number }).guests).toBe(0);
  });

  it('offer_set and offer_switch: the question repeats the offer in plain words; one commit; a replay changes nothing', async () => {
    const name = unique('Tuesday pasta night');
    const args = { name, method: 'automatic', gives: 'percent_off', amount: 15, applies_to: 'category', category: 'Mains', who: 'list', list: 'Lapsed 60+ days', days: [2, 3, 4], services: ['dinner'], per_guest_limit: 1 };
    const first = await rawToolCall(t.app, key.key, 'offer_set', args);
    expect(first.answer).toBeNull();
    expect(first.asking!.question).toBe(`Create the offer "${name}": 15% off any main for Lapsed 60+ days, Tuesday to Thursday dinner, one per guest, applied automatically, not with other offers, applied automatically at checkout and matched from the till, switched on now?`);
    expect(await offersNamed(name)).toEqual([]);

    const yes = await rawToolCall(t.app, key.key, 'offer_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer).toMatchObject({ isError: false });
    expect(yes.answer!.structured).toMatchObject({ name, status: 'active', method: 'automatic', summary: 'Tuesday pasta night'.length ? expect.stringContaining('15% off any main for Lapsed 60+ days') : '' });
    const rows = await offersNamed(name);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'automatic', audience: 'list', days: [2, 3, 4], services: ['dinner'], is_active: true });
    expect(rows[0]!.segment_id).not.toBeNull();

    const replay = await rawToolCall(t.app, key.key, 'offer_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(replay.answer).toMatchObject({ isError: true });
    expect(await offersNamed(name)).toHaveLength(1);

    // Switch it off: asked, then done once.
    const off = await rawToolCall(t.app, key.key, 'offer_switch', { offer: name, on: false });
    expect(off.asking!.question).toBe(`Switch off the offer "${name}"? It stops applying and no new codes are issued; codes guests already hold stay good.`);
    expect((await offersNamed(name))[0]!.is_active).toBe(true);
    const offYes = await rawToolCall(t.app, key.key, 'offer_switch', { offer: name, on: false }, { inputResponses: YES, requestState: off.asking!.requestState });
    expect(offYes.answer!.structured).toMatchObject({ status: 'off' });
    expect((await offersNamed(name))[0]!.is_active).toBe(false);
    const audits = await t.db.selectFrom('audit_log').select('action').where('entity_id', '=', rows[0]!.id).orderBy('occurred_at').execute();
    expect(audits.map((a) => a.action)).toEqual(['offer.created', 'offer.switched']);

    // The summary read tool carries status, method and the words.
    const summary = await rawToolCall(t.app, key.key, 'offers_summary', { status: 'off' });
    const listed = (summary.answer!.structured as { offers: Array<{ name: string; status: string; method: string; summary: string }> }).offers.find((o) => o.name === name)!;
    expect(listed).toMatchObject({ status: 'off', method: 'automatic' });
    expect(listed.summary).toContain('15% off any main for Lapsed 60+ days');
  });

  it('surcharge_set: asks with the legal line, commits once, replays nothing, and refuses a card surcharge before asking', async () => {
    const name = unique('Public holiday surcharge');
    const args = { name, kind: 'public_holiday', percent: 15, dates: ['2026-10-05'] };
    const first = await rawToolCall(t.app, key.key, 'surcharge_set', args);
    expect(first.asking!.question).toBe(`Set up "${name}": 15% on the bill after discounts on public holidays, at this venue? Menus and dockets will carry the line "A surcharge of 15% applies on public holidays."`);
    expect(await surcharges(name)).toEqual([]);
    const yes = await rawToolCall(t.app, key.key, 'surcharge_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(yes.answer!.structured).toMatchObject({ name, percent: '15%', notice: 'A surcharge of 15% applies on public holidays.', switched_on: true });
    expect(await surcharges(name)).toMatchObject([{ kind: 'public_holiday', percent_bp: 1500, venue_id: t.fixture.diner.venueId }]);
    const replay = await rawToolCall(t.app, key.key, 'surcharge_set', args, { inputResponses: YES, requestState: first.asking!.requestState });
    expect(replay.answer).toMatchObject({ isError: true });
    expect(await surcharges(name)).toHaveLength(1);

    const card = await rawToolCall(t.app, key.key, 'surcharge_set', { name: 'Card surcharge', kind: 'sunday', percent: 1.5 });
    expect(card.asking).toBeNull();
    expect(JSON.stringify(card)).toContain('1 October 2026');
    expect(await surcharges('Card surcharge')).toEqual([]);

    const list = await rawToolCall(t.app, key.key, 'surcharges_list', {});
    const out = list.answer!.structured as { surcharges: Array<{ name: string }>; note: string };
    expect(out.surcharges.map((s) => s.name)).toContain(name);
    expect(out.note).toContain('1 October 2026');
  });
});
