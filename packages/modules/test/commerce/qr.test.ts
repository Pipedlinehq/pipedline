import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { drainJobs, setModule, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ordering, qr } from '@ros/modules';
import { QUIET_EVENING, WORKER, anon, footprint, menuOf, okCard, paidOrder, pay, placeOrder } from './helpers';

describe('QR codes and table ordering', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const venueId = () => t.fixture.diner.venueId;
  const as = async <T>(org: typeof t.fixture.diner, who: Parameters<typeof org.as>[0], fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(org.orgId, await org.as(who), fn);
  const scan = (code: string, sessionId?: string, org = diner()) => t.app.tenant(org.orgId, anon(), (ctx) => qr.resolveQrCode(ctx, { code, sessionId, deviceClass: 'mobile' }));
  const qrConfig = (org: typeof t.fixture.diner, venue: string, cfg: Partial<qr.QrConfig>) => t.app.tenant(org.orgId, WORKER, (ctx) => setModule(ctx, qr.qrModule, { venueId: venue, config: cfg }));
  /** The seeded code for a table at a venue, read straight from the database. */
  const codeFor = async (venue: string, label: string | null, kind: 'table' | 'menu' | 'counter' | 'campaign' = 'table') => {
    let q = t.db.selectFrom('qr_codes').select(['id', 'code']).where('venue_id', '=', venue).where('kind', '=', kind);
    if (label) q = q.where('label', '=', label);
    return q.executeTakeFirstOrThrow();
  };
  const tableOrder = (org: typeof t.fixture.diner, venue: string, code: string, over: Parameters<typeof placeOrder>[3] = {}) => placeOrder(t, org, venue, { channel: 'dine-in-qr', qrCode: code, customer: {}, ...over });
  beforeAll(() => t.clock.set(QUIET_EVENING));

  it('codes are random, one per table, managed by a manager, and only ever lead somewhere on the venue\'s own site', async () => {
    const codes = await as(diner(), 'manager', (ctx) => qr.listQrCodes(ctx, { venueId: venueId() }));
    const tables = codes.filter((c) => c.kind === 'table');
    expect(tables.map((c) => Number(c.label)).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(codes.map((c) => c.kind).filter((k) => k !== 'table').sort()).toEqual(['campaign', 'counter', 'menu']);
    expect(codes.every((c) => /^[a-z2-9]{10}$/.test(c.code) && c.path === `/q/${c.code}`)).toBe(true);
    expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);

    // A print run for tables that already have codes changes nothing; a new table gets one.
    const again = await as(diner(), 'manager', (ctx) => qr.createTableCodes(ctx, { venueId: venueId(), labels: ['1', '2', '13'] }));
    expect(again.map((c) => c.label)).toEqual(['1', '2', '13']);
    expect(again[0]!.code).toBe(tables.find((c) => c.label === '1')!.code);
    expect(await t.db.selectFrom('qr_codes').select('id').where('venue_id', '=', venueId()).where('kind', '=', 'table').execute()).toHaveLength(13);

    await expect(as(diner(), 'manager', (ctx) => qr.createQrCode(ctx, { venueId: venueId(), kind: 'table' }))).rejects.toMatchObject({ code: 'invalid' });
    for (const targetPath of ['https://evil.example/menu', '//evil.example', 'menu', '/menu<script>']) {
      await expect(as(diner(), 'manager', (ctx) => qr.createQrCode(ctx, { venueId: venueId(), kind: 'menu', targetPath }))).rejects.toThrow();
    }
    await expect(as(diner(), 'host', (ctx) => qr.createQrCode(ctx, { venueId: venueId(), kind: 'menu' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(as(group(), 'manager', (ctx) => qr.createQrCode(ctx, { venueId: venueId(), kind: 'menu' }))).rejects.toMatchObject({ code: 'not_found' });

    // Where a code leads can change without reprinting it; switching it off stops it resolving.
    const terrace = await as(diner(), 'manager', (ctx) => qr.createQrCode(ctx, { venueId: venueId(), kind: 'table', label: 'T1', area: 'Terrace' }));
    const moved = await as(diner(), 'manager', (ctx) => qr.updateQrCode(ctx, terrace.id, { label: 'T2', targetPath: '/menu?area=terrace' }));
    expect(moved).toMatchObject({ code: terrace.code, label: 'T2', targetPath: '/menu?area=terrace' });
    expect((await scan(terrace.code)).table).toEqual({ label: 'T2', area: 'Terrace' });
    await as(diner(), 'manager', (ctx) => qr.deactivateQrCode(ctx, terrace.id));
    await expect(scan(terrace.code)).rejects.toMatchObject({ code: 'not_found' });
    const audits = await t.db.selectFrom('audit_log').select('action').where('entity_type', '=', 'qr_code').where('entity_id', '=', terrace.id).execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['qr.code_created', 'qr.code_updated', 'qr.code_updated']);
  });

  it('a scan is counted, starts the visitor session, is recorded as an event and puts the table in context', async () => {
    const five = await codeFor(venueId(), '5');
    const before = await t.db.selectFrom('qr_codes').select('scan_count').where('id', '=', five.id).executeTakeFirstOrThrow();

    const first = await scan(five.code);
    expect(first).toMatchObject({
      code: five.code,
      kind: 'table',
      venueId: venueId(),
      targetPath: '/menu',
      table: { label: '5', area: 'Main room' },
      stage: 'order',
      canOrder: true,
      excludeAlcohol: false,
      showPrices: true,
      campaign: null,
    });
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    // A code reveals a table label and nothing else: no internal ids.
    expect(JSON.stringify(first)).not.toContain(five.id);
    expect(JSON.stringify(first)).not.toContain(diner().orgId);

    const session = await t.db.selectFrom('visitor_sessions').selectAll().where('id', '=', first.sessionId).executeTakeFirstOrThrow();
    expect(session).toMatchObject({ org_id: diner().orgId, venue_id: venueId(), qr_code_id: five.id, landing_path: `/q/${five.code}`, utm_source: 'qr', utm_medium: 'table', device_class: 'mobile' });

    // The same phone scanning again (and typing the code in capitals) is a second scan of the same visit.
    await scan(five.code.toUpperCase(), first.sessionId);
    const row = await t.db.selectFrom('qr_codes').select(['scan_count', 'last_scanned_at']).where('id', '=', five.id).executeTakeFirstOrThrow();
    expect(row.scan_count).toBe(before.scan_count + 2);
    expect(row.last_scanned_at!.toISOString()).toBe(QUIET_EVENING);
    const evs = await t.db.selectFrom('events').select(['name', 'properties', 'venue_id']).where('session_id', '=', first.sessionId).orderBy('occurred_at').orderBy(sql`ctid`).execute();
    expect(evs.map((e) => e.name)).toEqual(['session.started', 'qr.scanned', 'qr.scanned']);
    expect(evs[1]).toMatchObject({ venue_id: venueId(), properties: { qr_code_id: five.id, kind: 'table', table_label: '5', area: 'Main room' } });
  });

  it('a campaign code carries its creator and campaign into the visit and onto the guest it brings in', async () => {
    const flyer = await codeFor(venueId(), null, 'campaign');
    const seen = await scan(flyer.code);
    expect(seen).toMatchObject({ kind: 'campaign', targetPath: '/offer', table: null, canOrder: false, campaign: { creatorId: 'creator_sydney_eats', campaignId: 'camp_spring_launch', offerId: null } });
    const session = await t.db.selectFrom('visitor_sessions').select(['creator_id', 'campaign_id', 'qr_code_id']).where('id', '=', seen.sessionId).executeTakeFirstOrThrow();
    expect(session).toEqual({ creator_id: 'creator_sydney_eats', campaign_id: 'camp_spring_launch', qr_code_id: flyer.id });
    const scanned = await t.db.selectFrom('events').select(['creator_id', 'campaign_id']).where('session_id', '=', seen.sessionId).where('name', '=', 'qr.scanned').executeTakeFirstOrThrow();
    expect(scanned).toEqual({ creator_id: 'creator_sydney_eats', campaign_id: 'camp_spring_launch' });

    // They go on to order pickup: the new customer is stamped with the creator, once and for good.
    const order = await placeOrder(t, diner(), venueId(), { sessionId: seen.sessionId, customer: { name: 'Fay Flyer', email: 'fay.flyer@example.com' } });
    const customer = await t.db.selectFrom('customers').select(['acquisition_source', 'acquisition_creator_id', 'acquisition_campaign_id', 'acquisition_qr_code_id']).where('id', '=', order.customerId!).executeTakeFirstOrThrow();
    expect(customer).toEqual({ acquisition_source: 'criota', acquisition_creator_id: 'creator_sydney_eats', acquisition_campaign_id: 'camp_spring_launch', acquisition_qr_code_id: flyer.id });
    await pay(t, diner(), order);
    const paid = await t.db.selectFrom('events').select('creator_id').where('name', '=', 'order.paid').where(sql<boolean>`properties->>'order_id' = ${order.id}`).executeTakeFirstOrThrow();
    expect(paid.creator_id).toBe('creator_sydney_eats');
  });

  it('a code from another org does not resolve, and with the module off QR does not exist at that venue', async () => {
    const theirs = await codeFor(group().venues.cbd!.id, '3');
    const before = await t.db.selectFrom('qr_codes').select('scan_count').where('id', '=', theirs.id).executeTakeFirstOrThrow();
    // Scanned on the diner's host: the group's code is not there.
    await expect(scan(theirs.code, undefined, diner())).rejects.toMatchObject({ code: 'not_found' });
    await expect(tableOrder(diner(), venueId(), theirs.code)).rejects.toMatchObject({ code: 'not_found' });
    expect((await t.db.selectFrom('qr_codes').select('scan_count').where('id', '=', theirs.id).executeTakeFirstOrThrow()).scan_count).toBe(before.scan_count);
    await expect(scan('nosuchcode')).rejects.toMatchObject({ code: 'not_found' });
    await expect(scan('../../etc/passwd')).rejects.toMatchObject({ code: 'not_found' });
    // On its own host it resolves.
    expect((await scan(theirs.code, undefined, group())).table).toEqual({ label: '3', area: 'Main room' });

    // Switch QR off at the CBD venue: the code is not found, the console surfaces are gone, the rows stay.
    const cbd = group().venues.cbd!.id;
    await t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, qr.qrModule, { venueId: cbd, enabled: false }));
    const gone = { code: 'module_disabled', status: 404 };
    await expect(scan(theirs.code, undefined, group())).rejects.toMatchObject(gone);
    await expect(as(group(), 'owner', (ctx) => qr.listQrCodes(ctx, { venueId: cbd }))).rejects.toMatchObject(gone);
    await expect(as(group(), 'owner', (ctx) => qr.createQrCode(ctx, { venueId: cbd, kind: 'menu' }))).rejects.toMatchObject(gone);
    await expect(as(group(), 'owner', (ctx) => qr.listTableSessions(ctx, { venueId: cbd }))).rejects.toMatchObject(gone);
    await expect(tableOrder(group(), cbd, theirs.code)).rejects.toMatchObject({ code: 'not_found' });
    // Pickup at the same venue is untouched: QR is its own switch.
    expect((await placeOrder(t, group(), cbd)).status).toBe('pending_payment');
    await t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, qr.qrModule, { venueId: cbd, enabled: true }));
    expect((await scan(theirs.code, undefined, group())).canOrder).toBe(true);
    expect(await t.db.selectFrom('qr_codes').select('id').where('venue_id', '=', cbd).where('kind', '=', 'table').execute()).toHaveLength(12);

    // The pickup-only venue has no QR at all.
    const bondi = group().venues.bondi!.id;
    await expect(as(group(), 'owner', (ctx) => qr.listQrCodes(ctx, { venueId: bondi }))).rejects.toMatchObject(gone);
    expect(await t.db.selectFrom('qr_codes').select('id').where('venue_id', '=', bondi).execute()).toHaveLength(0);
  });

  it('a table order carries the table to the order, the ticket and the ledger; rounds share one session until the table goes quiet', async () => {
    const seven = await codeFor(venueId(), '7');
    const m = await menuOf(t, diner(), venueId(), 'in_venue');
    const { sessionId } = await scan(seven.code);

    // Nothing about the table is taken from the phone except the code.
    const first = await tableOrder(diner(), venueId(), seven.code, { sessionId, lines: [{ menuItemId: m.byName('Cheeseburger').id, qty: 1 }], ...({ tableLabel: '99', tableSessionId: randomUUID(), qrCodeId: randomUUID() } as object) });
    expect(first).toMatchObject({ channel: 'dine-in-qr', tableLabel: '7', requestedAsap: true, customerId: null, customerName: null });
    const paid = await pay(t, diner(), first, okCard());
    expect(paid.status).toBe('paid');

    let f = await footprint(t, first.id);
    expect(f.order).toMatchObject({ channel: 'dine-in-qr', table_label: '7', qr_code_id: seven.id, customer_id: null, session_id: sessionId, status: 'placed' });
    expect(f.order.table_session_id).not.toBeNull();
    expect(f.tickets[0]).toMatchObject({ channel: 'dine-in-qr', table_label: '7', guest_name: null, status: 'new' });
    // A guest who ticks nothing still ordered and paid: in the ledger, with no customer, and no message sent.
    expect(f.transactions[0]).toMatchObject({ source: 'online-order', channel: 'dine-in', table_label: '7', customer_id: null, total_cents: 2600 });
    expect(f.messages).toHaveLength(0);

    // Round two, twenty minutes later, from another phone at the same table.
    t.clock.advanceMinutes(20);
    const second = await tableOrder(diner(), venueId(), seven.code, { lines: [{ menuItemId: m.byName('Basque cheesecake').id, qty: 2 }] });
    await pay(t, diner(), second);
    const sessionIdOf = async (orderId: string) => (await footprint(t, orderId)).order.table_session_id;
    expect(await sessionIdOf(second.id)).toBe(await sessionIdOf(first.id));
    // A different table is a different session.
    const eight = await codeFor(venueId(), '8');
    const other = await tableOrder(diner(), venueId(), eight.code);
    expect(await sessionIdOf(other.id)).not.toBe(await sessionIdOf(first.id));

    const open = await as(diner(), 'host', (ctx) => qr.listTableSessions(ctx, { venueId: venueId() }));
    const table7 = open.find((s) => s.tableLabel === '7')!;
    // The unpaid order at table 8 is not part of any total.
    expect(table7).toMatchObject({ id: await sessionIdOf(first.id), orders: 2, totalCents: 2600 + 3200, closedAt: null });
    expect(table7.lastActivityAt.toISOString()).toBe('2026-10-01T08:20:00.000Z');
    expect(open.find((s) => s.tableLabel === '8')).toMatchObject({ orders: 0, totalCents: 0 });
    const rounds = await as(diner(), 'host', (ctx) => ordering.listOrders(ctx, { venueId: venueId(), tableSessionId: table7.id }));
    expect(rounds.map((o) => o.reference).sort()).toEqual([first.reference, second.reference].sort());

    // Two hours with no order (the venue's idle limit): the next order at table 7 is a new party.
    t.clock.advanceMinutes(121);
    const later = await tableOrder(diner(), venueId(), seven.code);
    expect(await sessionIdOf(later.id)).not.toBe(table7.id);
    const old = await t.db.selectFrom('table_sessions').select(['closed_at']).where('id', '=', table7.id).executeTakeFirstOrThrow();
    expect(old.closed_at!.toISOString()).toBe('2026-10-01T10:21:00.000Z');
    const closedEvents = await t.db.selectFrom('events').select('properties').where('name', '=', 'table_session.closed').where(sql<boolean>`properties->>'table_session_id' = ${table7.id}`).execute();
    expect(closedEvents.map((e) => e.properties)).toEqual([{ table_session_id: table7.id, table_label: '7', reason: 'idle', minutes_open: 141 }]);

    // The scheduler closes what is left idle, and staff can close a table when the guests leave.
    const stillOpen = await t.db.selectFrom('table_sessions').select('id').where('venue_id', '=', venueId()).where('closed_at', 'is', null).execute();
    expect(stillOpen.length).toBeGreaterThanOrEqual(2);
    const laterSession = (await sessionIdOf(later.id))!;
    await as(diner(), 'host', (ctx) => qr.closeTableSession(ctx, { sessionId: laterSession, covers: 4 }));
    expect(await t.db.selectFrom('table_sessions').select(['covers']).where('id', '=', laterSession).where('closed_at', 'is not', null).execute()).toEqual([{ covers: 4 }]);
    t.clock.advanceMinutes(60);
    await tickSchedules(t.app, { only: ['qr.close_idle_sessions'] });
    await drainJobs(t.app, { kinds: ['qr.close_idle_sessions'] });
    expect(await t.db.selectFrom('table_sessions').select('id').where('venue_id', '=', venueId()).where('closed_at', 'is', null).execute()).toHaveLength(0);
    t.clock.set(QUIET_EVENING);
  });

  it('stage "view" shows the menu but takes no orders; a venue can require a table and keep alcohol off the phone', async () => {
    const newtown = group().venues.newtown!.id;
    const four = await codeFor(newtown, '4');
    const general = await codeFor(newtown, null, 'menu');
    const m = await menuOf(t, group(), newtown, 'in_venue');
    const fries = [{ menuItemId: m.plain().id, qty: 1 }];
    const price = (input: Parameters<typeof ordering.priceCart>[1]) => t.app.tenant(group().orgId, anon(), (ctx) => ordering.priceCart(ctx, input));

    // The fixture keeps alcohol out of table ordering at Newtown.
    expect((await scan(four.code, undefined, group())).excludeAlcohol).toBe(true);
    const withAle = await price({ venueId: newtown, channel: 'dine-in-qr', qrCode: four.code, lines: [{ menuItemId: m.byName('Pale ale').id, qty: 1 }, ...fries] });
    expect(withAle.issues).toEqual([{ code: 'alcohol_excluded', lineIndex: 0, message: 'Pale ale cannot be ordered from the table. Ask our staff.' }]);
    expect(withAle.table).toEqual({ label: '4' });
    await expect(tableOrder(group(), newtown, four.code, { lines: [{ menuItemId: m.byName('Pale ale').id, qty: 1 }] })).rejects.toMatchObject({ code: 'invalid' });
    // Pickup at the same venue follows ordering's own setting, which allows it.
    expect((await price({ venueId: newtown, lines: [{ menuItemId: m.byName('Pale ale').id, qty: 1 }] })).orderable).toBe(true);
    await qrConfig(group(), newtown, { exclude_alcohol: false });
    expect((await price({ venueId: newtown, channel: 'dine-in-qr', qrCode: four.code, lines: [{ menuItemId: m.byName('Pale ale').id, qty: 1 }] })).orderable).toBe(true);

    // The general menu code has no table: view only while a table is required.
    expect(await scan(general.code, undefined, group())).toMatchObject({ kind: 'menu', table: null, canOrder: false, stage: 'order' });
    await expect(tableOrder(group(), newtown, general.code, { lines: fries })).rejects.toMatchObject({ code: 'invalid', message: 'Scan the code on your table to order.' });
    await qrConfig(group(), newtown, { require_table: false });
    expect((await scan(general.code, undefined, group())).canOrder).toBe(true);
    const counter = await tableOrder(group(), newtown, general.code, { lines: fries });
    expect(counter).toMatchObject({ channel: 'dine-in-qr', tableLabel: null, tableSessionId: null });
    await qrConfig(group(), newtown, { require_table: true });

    // A code is for its own venue: CBD's table code cannot place an order at Newtown.
    const cbdCode = await codeFor(group().venues.cbd!.id, '4');
    await expect(tableOrder(group(), newtown, cbdCode.code, { lines: fries })).rejects.toMatchObject({ code: 'not_found' });

    // Stage "view": the code still resolves to the live menu, and nothing can be ordered from it.
    await qrConfig(group(), newtown, { stage: 'view' });
    expect(await scan(four.code, undefined, group())).toMatchObject({ stage: 'view', canOrder: false, table: { label: '4', area: 'Main room' } });
    const before = await t.db.selectFrom('orders').select('id').where('venue_id', '=', newtown).execute();
    await expect(price({ venueId: newtown, channel: 'dine-in-qr', qrCode: four.code, lines: fries })).rejects.toMatchObject({ code: 'not_found' });
    await expect(tableOrder(group(), newtown, four.code, { lines: fries })).rejects.toMatchObject({ code: 'not_found' });
    expect(await t.db.selectFrom('orders').select('id').where('venue_id', '=', newtown).execute()).toHaveLength(before.length);
    await qrConfig(group(), newtown, { stage: 'order', exclude_alcohol: true });

    // With ordering switched off, a QR venue falls back to the menu: the code resolves, but cannot order.
    await t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: newtown, enabled: false }));
    expect(await scan(four.code, undefined, group())).toMatchObject({ stage: 'order', canOrder: false });
    await expect(tableOrder(group(), newtown, four.code, { lines: fries })).rejects.toMatchObject({ code: 'module_disabled' });
    await t.app.tenant(group().orgId, WORKER, (ctx) => setModule(ctx, ordering.orderingModule, { venueId: newtown, enabled: true }));
  });

  it('an item hidden in the venue cannot be ordered from a table; the guest may choose to be known at the table', async () => {
    const nine = await codeFor(venueId(), '9');
    const online = await menuOf(t, diner(), venueId(), 'online');
    const affogato = online.byName('Affogato');
    await t.db.updateTable('menu_items').set({ is_visible_in_venue: false }).where('id', '=', affogato.id).execute();
    await expect(tableOrder(diner(), venueId(), nine.code, { lines: [{ menuItemId: affogato.id, qty: 1 }] })).rejects.toMatchObject({ code: 'not_found' });
    expect((await placeOrder(t, diner(), venueId(), { lines: [{ menuItemId: affogato.id, qty: 1 }] })).status).toBe('pending_payment');

    // Q3: email me the receipt, join the loyalty program, recognise this card. Each its own box.
    const order = await tableOrder(diner(), venueId(), nine.code, {
      customer: { email: 'tab.nine@example.com' },
      consents: [{ purpose: 'card_recognition' }],
      flags: ['loyalty_join'],
    });
    await pay(t, diner(), order, okCard('table-nine-card'));
    const f = await footprint(t, order.id);
    expect(f.order.customer_id).not.toBeNull();
    const consents = await t.db.selectFrom('consents').select(['purpose', 'source', 'status']).where('customer_id', '=', f.order.customer_id!).execute();
    // The receipt email implies no marketing consent.
    expect(consents).toEqual([{ purpose: 'card_recognition', source: 'qr_checkout', status: 'granted' }]);
    const customer = await t.db.selectFrom('customers').select(['acquisition_source', 'acquisition_qr_code_id']).where('id', '=', f.order.customer_id!).executeTakeFirstOrThrow();
    expect(customer).toEqual({ acquisition_source: 'qr', acquisition_qr_code_id: nine.id });
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((x) => x.to === 'tab.nine@example.com' && x.subject?.includes('confirmed'))).toHaveLength(1);
    expect(t.sim.email.sent.find((x) => x.to === 'tab.nine@example.com')!.body).toContain('We will bring it to table 9.');

    // Next visit they say nothing and just tap the same card: the order is theirs. A card nobody linked stays anonymous.
    const ten = await codeFor(venueId(), '10');
    const recognised = await paidOrder(t, diner(), venueId(), { channel: 'dine-in-qr', qrCode: ten.code, customer: {} }, okCard('table-nine-card'));
    const stranger = await paidOrder(t, diner(), venueId(), { channel: 'dine-in-qr', qrCode: ten.code, customer: {} }, okCard('never-linked-card'));
    expect((await footprint(t, recognised.id)).order.customer_id).toBe(f.order.customer_id);
    expect((await footprint(t, recognised.id)).transactions[0]!.customer_id).toBe(f.order.customer_id);
    expect((await footprint(t, stranger.id)).order.customer_id).toBeNull();
    expect((await footprint(t, stranger.id)).transactions[0]!.customer_id).toBeNull();
  });
});
