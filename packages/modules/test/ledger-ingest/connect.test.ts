import { describe, expect, it } from 'vitest';
import { drainJobs, listPlugs, resolveConnection, type ConnectionRow } from '@ros/core';
import { simPosToken } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { ledger } from '@ros/modules';
import { POS_JOBS, ledgerRow, seededPos } from './helpers';

describe('connecting a POS', () => {
  const t = useTestEnv();
  const countConnections = async () => Number((await t.db.selectFrom('connections').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()).n);
  const input = (venueId: string, account: string, location: string, over: Partial<ledger.ConnectPosInput> = {}): ledger.ConnectPosInput => ({
    plugKey: 'sim-pos',
    venueId,
    externalAccountId: account,
    locationRef: location,
    credentials: { accessToken: simPosToken(account), webhookSecret: `whsec-${account}` },
    ...over,
  });

  it('the fixtures connect every venue to the simulated POS, and leave no work queued', async () => {
    const venues = [t.fixture.diner, t.fixture.group].flatMap((org) => Object.values(org.venues).map((v) => ({ org, venue: v })));
    expect(venues).toHaveLength(4);
    const locations = new Set<string>();
    for (const { org, venue } of venues) {
      const p = await seededPos(t, org.orgId, venue.id);
      locations.add(`${p.accountRef}/${p.locationRef}`);
      const row = await t.db.selectFrom('connections').select(['status', 'scopes']).where('id', '=', p.connectionId).executeTakeFirstOrThrow();
      expect(row).toEqual({ status: 'connected', scopes: ['transactions:read', 'orders:write'] });
      const cursors = await t.db.selectFrom('ingest_cursors').select(['stream', 'cursor']).where('connection_id', '=', p.connectionId).execute();
      expect(cursors).toEqual([{ stream: 'transactions', cursor: null }]);
    }
    expect(locations.size).toBe(4);
    const queued = await t.db.selectFrom('jobs').select('id').where('kind', 'in', POS_JOBS).execute();
    expect(queued).toEqual([]);
    // The plugs are in the catalogue; the simulated one is marked as such and Square is not.
    const plugs = listPlugs().filter((p) => p.adapters.pos);
    expect(plugs.map((p) => [p.key, !!p.simulated, p.venueScoped]).sort()).toEqual([['sim-pos', true, true], ['square', false, true]]);
  });

  it('a manager with no role at a venue cannot connect a POS there: the venue is not found', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager'); // cbd and newtown, not bondi
    const before = await countConnections();
    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.connectPos(ctx, input(group.venues.bondi!.id, 'acct-sneak', 'loc-sneak')))).rejects.toMatchObject({ code: 'not_found' });
    // Nor at a venue of another org, whatever id they supply.
    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.connectPos(ctx, input(t.fixture.diner.venueId, 'acct-sneak', 'loc-sneak')))).rejects.toMatchObject({ code: 'not_found' });
    expect(await countConnections()).toBe(before);
    expect(await t.db.selectFrom('connections').select('id').where('external_account_id', '=', 'acct-sneak').execute()).toEqual([]);
    expect(await t.db.selectFrom('secrets').select('id').where('purpose', '=', 'conn:sim-pos').where('org_id', '=', group.orgId).execute()).toHaveLength(3);
  });

  it('staff below manager, guests and visitors cannot connect a POS', async () => {
    const { diner } = t.fixture;
    const before = await countConnections();
    const args = input(diner.venueId, 'acct-x', 'loc-x');
    await expect(t.app.tenant(diner.orgId, await diner.as('host'), (ctx) => ledger.connectPos(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, await diner.as('kitchen'), (ctx) => ledger.connectPos(ctx, args))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(t.app.tenant(diner.orgId, { kind: 'anon' }, (ctx) => ledger.connectPos(ctx, args))).rejects.toMatchObject({ code: 'unauthenticated' });
    // The read-only accountant at the group can look, not connect.
    const accounts = await t.fixture.group.as('accounts');
    await expect(t.app.tenant(t.fixture.group.orgId, accounts, (ctx) => ledger.connectPos(ctx, input(t.fixture.group.venues.cbd!.id, 'acct-x', 'loc-x')))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await countConnections()).toBe(before);
  });

  it('a manager connects their own venue: credentials sealed, audited, history fetched by the job', async () => {
    const { group } = t.fixture;
    const manager = await group.as('manager');
    const venueId = group.venues.newtown!.id;
    const account = 'acct-second-till';
    const daysAgo = (n: number) => new Date(t.clock().getTime() - n * 86_400_000);
    const recent = t.sim.pos.createSale({ accountRef: account, locationRef: 'loc-bar', at: daysAgo(12) });
    const tooOld = t.sim.pos.createSale({ accountRef: account, locationRef: 'loc-bar', at: daysAgo(200) });
    const elsewhere = t.sim.pos.createSale({ accountRef: account, locationRef: 'loc-other-site', at: daysAgo(12) });

    // The person connecting is shown the account's locations to choose from.
    const offered = await ledger.listPosLocations(t.app, { plugKey: 'sim-pos', externalAccountId: account, credentials: { accessToken: simPosToken(account) } });
    expect(offered.map((l) => l.ref).sort()).toEqual(['loc-bar', 'loc-other-site']);
    await expect(ledger.listPosLocations(t.app, { plugKey: 'sim-pos', externalAccountId: account, credentials: { accessToken: 'wrong' } })).rejects.toMatchObject({ code: 'provider_error' });

    const view = await t.app.tenant(group.orgId, manager, (ctx) => ledger.connectPos(ctx, input(venueId, account, 'loc-bar', { backfillMonths: 3 })));
    expect(view).toMatchObject({ venueId, plugKey: 'sim-pos', status: 'connected', externalAccountId: account, locationRef: 'loc-bar', syncedThrough: t.clock(), historyFrom: null });
    expect(view.backfillingFrom!.toISOString()).toBe('2026-06-30T02:00:00.000Z');

    const row = await t.db.selectFrom('connections').selectAll().where('id', '=', view.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ org_id: group.orgId, venue_id: venueId, plug_key: 'sim-pos', status: 'connected', config: { locationRef: 'loc-bar' }, connected_by_staff_id: manager.staffId });
    // The token is in the sealed store and nowhere on the row or in the view.
    expect(JSON.stringify(row)).not.toContain(simPosToken(account));
    expect(JSON.stringify(view)).not.toContain(simPosToken(account));
    expect((await resolveConnection(t.app, row as unknown as ConnectionRow)).credentials.accessToken).toBe(simPosToken(account));
    const audited = await t.db.selectFrom('audit_log').select(['action', 'actor_id', 'venue_id']).where('entity_type', '=', 'connection').where('entity_id', '=', view.id).execute();
    expect(audited).toEqual([{ action: 'connection.created', actor_id: manager.staffId, venue_id: venueId }]);

    expect(await drainJobs(t.app, { kinds: POS_JOBS })).toMatchObject({ ran: 1, succeeded: 1 });
    const rows = await ledgerRow(t, recent.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: group.orgId, venue_id: venueId });
    expect(await ledgerRow(t, tooOld.id)).toEqual([]);
    // The account's other location is not this venue's, and its sales are not taken.
    expect(await ledgerRow(t, elsewhere.id)).toEqual([]);

    const listed = await t.app.tenant(group.orgId, manager, (ctx) => ledger.listPosConnections(ctx, { venueId }));
    expect(listed.map((c) => c.externalAccountId).sort()).toEqual(['acct-second-till', 'simpos-acct-oak-group']);
    expect(listed.find((c) => c.id === view.id)).toMatchObject({ backfillingFrom: null });
    expect(listed.find((c) => c.id === view.id)!.historyFrom!.toISOString()).toBe('2026-06-30T02:00:00.000Z');
  });

  it('one provider location feeds one venue', async () => {
    const { group } = t.fixture;
    const owner = await group.as('owner');
    const cbd = await seededPos(t, group.orgId, group.venues.cbd!.id);
    const before = await countConnections();
    await expect(t.app.tenant(group.orgId, owner, (ctx) => ledger.connectPos(ctx, input(group.venues.newtown!.id, cbd.accountRef, cbd.locationRef)))).rejects.toMatchObject({ code: 'conflict' });
    expect(await countConnections()).toBe(before);
  });

  it('refuses what is not a point of sale, and input that is not valid', async () => {
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ledger.connectPos(ctx, input(diner.venueId, 'acct-y', 'loc-y', { plugKey: 'sim-pay' })))).rejects.toMatchObject({ code: 'invalid' });
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ledger.connectPos(ctx, input(diner.venueId, 'acct-y', 'loc-y', { plugKey: 'nope' })))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ledger.connectPos(ctx, input(diner.venueId, 'acct-y', '')))).rejects.toThrow();
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ledger.connectPos(ctx, input(diner.venueId, 'acct-y', 'loc-y', { backfillMonths: 500 })))).rejects.toThrow();
    await expect(t.app.tenant(diner.orgId, owner, (ctx) => ledger.connectPos(ctx, input(diner.venueId, 'acct-y', 'loc-y', { scopes: ['everything'] })))).rejects.toMatchObject({ code: 'invalid' });
    expect(await t.db.selectFrom('connections').select('id').where('external_account_id', '=', 'acct-y').execute()).toEqual([]);
  });

  it('back-fill and status follow the same venue roles; another org\'s connection is not found', async () => {
    const { group, diner } = t.fixture;
    const manager = await group.as('manager');
    const bondi = await seededPos(t, group.orgId, group.venues.bondi!.id);
    const dinerPos = await seededPos(t, diner.orgId, diner.venueId);
    const jobsBefore = (await t.db.selectFrom('jobs').select('id').where('kind', '=', 'ledger.pos_ingest').execute()).length;

    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: bondi.connectionId, months: 3 }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: dinerPos.connectionId, months: 3 }))).rejects.toMatchObject({ code: 'not_found' });
    const accounts = await group.as('accounts');
    await expect(t.app.tenant(group.orgId, accounts, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: bondi.connectionId, months: 3 }))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await t.db.selectFrom('jobs').select('id').where('kind', '=', 'ledger.pos_ingest').execute()).length).toBe(jobsBefore);
    expect(await t.db.selectFrom('ingest_cursors').select('stream').where('connection_id', 'in', [bondi.connectionId, dinerPos.connectionId]).where('stream', '=', 'backfill').execute()).toEqual([]);

    // The manager sees the connections of their two venues; the accountant, read-only at all three, sees all.
    const mine = await t.app.tenant(group.orgId, manager, (ctx) => ledger.listPosConnections(ctx));
    expect(new Set(mine.map((c) => c.venueId))).toEqual(new Set([group.venues.cbd!.id, group.venues.newtown!.id]));
    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.listPosConnections(ctx, { venueId: group.venues.bondi!.id }))).rejects.toMatchObject({ code: 'not_found' });
    const all = await t.app.tenant(group.orgId, accounts, (ctx) => ledger.listPosConnections(ctx));
    expect(new Set(all.map((c) => c.venueId)).size).toBe(3);
    await expect(t.app.tenant(group.orgId, { kind: 'anon' }, (ctx) => ledger.listPosConnections(ctx))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('pointing a connection at a different location starts its sync again', async () => {
    const { diner } = t.fixture;
    const owner = await diner.as('owner');
    const p = await seededPos(t, diner.orgId, diner.venueId);
    await t.app.tenant(diner.orgId, owner, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: p.connectionId, months: 1 }));
    t.clock.advanceMinutes(90);
    const view = await t.app.tenant(diner.orgId, owner, (ctx) =>
      ledger.connectPos(ctx, { plugKey: 'sim-pos', venueId: diner.venueId, externalAccountId: p.accountRef, locationRef: 'simpos-loc-moved', credentials: { accessToken: simPosToken(p.accountRef), webhookSecret: p.secret } }),
    );
    expect(view).toMatchObject({ id: p.connectionId, locationRef: 'simpos-loc-moved', syncedThrough: t.clock(), backfillingFrom: null });
    // A sale at the old location is no longer this venue's.
    const old = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const moved = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: 'simpos-loc-moved' });
    await ledger.ingestConnection(t.app, { orgId: diner.orgId, connectionId: p.connectionId });
    expect(await ledgerRow(t, old.id)).toEqual([]);
    expect(await ledgerRow(t, moved.id)).toHaveLength(1);
  });
});
