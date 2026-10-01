import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { type ConnectionRow, adapterFor, drainJobs, resolveConnection, tickSchedules } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { ledger } from '@ros/modules';
import { POS_JOBS, connectionState, ledgerRow, ledgerTotals, seededPos, tablesContaining } from './helpers';

describe('POS ingest: one venue', () => {
  const t = useTestEnv();
  const pos = () => seededPos(t, t.fixture.diner.orgId, t.fixture.diner.venueId);
  const ingest = async (over: Partial<ledger.IngestArgs> = {}) => {
    const p = await pos();
    return ledger.ingestConnection(t.app, { orgId: p.orgId, connectionId: p.connectionId, ...over });
  };

  it('ingesting twice leaves the same rows and totals, and they equal the provider\'s exactly', async () => {
    const p = await pos();
    const at = { accountRef: p.accountRef, locationRef: p.locationRef };
    t.sim.pos.createSale(at);
    t.sim.pos.createSale({ ...at, tipCents: 700, table: '12', staffRef: 'tm_1' });
    t.sim.pos.createSale({ ...at, discount: { name: 'Staff meal', code: 'STAFF10', amountCents: 590 } });
    t.sim.pos.createSale({ ...at, tender: 'cash', lines: [{ name: 'Flat white', unitPriceCents: 550, qty: 2, category: 'Coffee' }] });
    t.sim.pos.createSale({ ...at, lines: [{ name: 'Scotch fillet', unitPriceCents: 8990, qty: 0.35, category: 'Retail', modifiers: [{ name: 'Vac pack', priceCents: 100 }] }], channel: 'retail' });
    t.sim.pos.createSale({ ...at, customer: { email: 'pos.guest@example.com', firstName: 'Pat', lastName: 'Guest' }, tipCents: 250 });
    t.sim.pos.createSale({ ...at, lines: [{ name: 'Tasting menu', unitPriceCents: 12000, qty: 4 }], tipCents: 4800 });

    // Three sales a page: the run has to follow the provider's cursor to see them all.
    const first = await ingest({ pageSize: 3 });
    expect(first).toMatchObject({ status: 'done', pages: 3, fetched: 7, created: 7, changed: 0, unchanged: 0, skipped: 0 });

    const provider = t.sim.pos.totals({ accountRef: p.accountRef, locationRef: p.locationRef });
    expect(provider.count).toBe(7);
    const afterFirst = await ledgerTotals(t, p.orgId, p.venueId);
    expect(afterFirst).toEqual({ count: provider.count, totalCents: provider.totalCents, refundedCents: provider.refundedCents, tipCents: provider.tipCents });

    // Sale by sale, not only in sum.
    for (const sale of t.sim.pos.sales({ accountRef: p.accountRef })) {
      const [row] = await ledgerRow(t, sale.id);
      expect(row, sale.id).toBeDefined();
      expect(row!.total_cents).toBe(sale.total_money.amount);
      expect(row!.venue_id).toBe(p.venueId);
      const lines = await t.db.selectFrom('transaction_lines').select(['total_cents', 'qty', 'name_snapshot']).where('transaction_id', '=', row!.id).execute();
      expect(lines).toHaveLength(sale.order.line_items.length);
      expect(lines.reduce((s, l) => s + l.total_cents, 0)).toBe(row!.subtotal_cents);
      expect(row!.subtotal_cents - row!.discount_cents + row!.tip_cents).toBe(row!.total_cents);
    }

    const second = await ingest({ pageSize: 3 });
    expect(second).toMatchObject({ status: 'done', fetched: 7, created: 0, changed: 0, unchanged: 7 });
    expect(await ledgerTotals(t, p.orgId, p.venueId)).toEqual(afterFirst);
    const lineCount = await sql<{ n: number }>`
      select count(*)::int as n from transaction_lines l join transactions x on x.id = l.transaction_id
      where x.org_id = ${p.orgId} and x.external_ref like 'simpos_%'`.execute(t.db);
    expect(lineCount.rows[0]!.n).toBe(11);
    const recorded = await sql<{ n: number }>`
      select count(*)::int as n from events e join transactions x on x.id::text = e.properties->>'transaction_id'
      where e.name = 'transaction.recorded' and x.external_ref like 'simpos_%' and x.org_id = ${p.orgId}`.execute(t.db);
    expect(recorded.rows[0]!.n).toBe(7);

    // The cursor moved, and the connection is marked healthy as of this run.
    const cursor = await t.db.selectFrom('ingest_cursors').select(['synced_through', 'cursor', 'last_count']).where('connection_id', '=', p.connectionId).where('stream', '=', 'transactions').executeTakeFirstOrThrow();
    expect(cursor).toEqual({ synced_through: t.clock(), cursor: null, last_count: 7 });
    expect(await connectionState(t, p.connectionId)).toMatchObject({ status: 'connected', last_error: null, last_ok_at: t.clock() });
  });

  it('keeps the sale\'s detail: fractional quantity, modifiers, tender, and the customer on the payment', async () => {
    const p = await pos();
    const sales = t.sim.pos.sales({ accountRef: p.accountRef });
    const weighed = sales.find((s) => s.order.line_items[0]!.name === 'Scotch fillet')!;
    const [row] = await ledgerRow(t, weighed.id);
    const [line] = await t.db.selectFrom('transaction_lines').selectAll().where('transaction_id', '=', row!.id).execute();
    expect(line).toMatchObject({ name_snapshot: 'Scotch fillet', category_snapshot: 'Retail', unit_price_cents: 9090, total_cents: 3182, modifiers: [{ name: 'Vac pack', priceCents: 100 }] });
    expect(Number(line!.qty)).toBe(0.35);

    const cash = sales.find((s) => s.source_type === 'CASH')!;
    expect((await ledgerRow(t, cash.id))[0]).toMatchObject({ tender_type: 'cash', total_cents: 1100 });

    const known = sales.find((s) => s.customer)!;
    const [knownRow] = await ledgerRow(t, known.id);
    expect(knownRow!.customer_id).not.toBeNull();
    const customer = await t.db.selectFrom('customers').select(['primary_email', 'first_name']).where('id', '=', knownRow!.customer_id!).executeTakeFirstOrThrow();
    expect(customer).toEqual({ primary_email: 'pos.guest@example.com', first_name: 'Pat' });
    const anonymous = sales.find((s) => !s.customer)!;
    expect((await ledgerRow(t, anonymous.id))[0]!.customer_id).toBeNull();
  });

  it('stores no card identifier: not in the payload, not anywhere in the database', async () => {
    const p = await pos();
    const sale = t.sim.pos.createSale({
      accountRef: p.accountRef,
      locationRef: p.locationRef,
      card: { fingerprint: 'sq0fp-CANARY-FINGERPRINT', par: 'PAR-CANARY-REFERENCE', brand: 'MASTERCARD', last4: '9029' },
      customer: { email: 'canary@example.com' },
    });
    // The provider really does send them: the simulator's payload carries both.
    expect(JSON.stringify(t.sim.pos.get(sale.id))).toContain('sq0fp-CANARY-FINGERPRINT');
    expect(JSON.stringify(t.sim.pos.get(sale.id))).toContain('payment_account_reference');

    expect(await ingest()).toMatchObject({ created: 1 });
    const [row] = await ledgerRow(t, sale.id);
    const raw = row!.raw as { card_details: { card: Record<string, unknown> }; order: { line_items: unknown[] } };
    // What identifies the guest is gone; what describes the sale is kept.
    expect(raw.card_details.card).toEqual({ card_brand: 'MASTERCARD', last_4: '9029' });
    expect(raw.order.line_items).toHaveLength(2);

    expect(await tablesContaining(t, 'CANARY')).toEqual([]);
    const keyed = await sql<{ n: number }>`
      select count(*)::int as n from transactions where raw::text ~* '"(fingerprint|payment_account_reference|par|card_fingerprint)"'`.execute(t.db);
    expect(keyed.rows[0]!.n).toBe(0);
    // This guest never ticked the card box, so no card identity exists for them even hashed.
    const cards = await t.db.selectFrom('customer_identities').select('kind').where('customer_id', '=', row!.customer_id!).where('kind', 'in', ['card_fingerprint', 'card_par']).execute();
    expect(cards).toEqual([]);
  });

  it('a refund arriving later updates the same row', async () => {
    const p = await pos();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    await ingest();
    const [before] = await ledgerRow(t, sale.id);
    expect(before).toMatchObject({ status: 'completed', refunded_cents: 0, total_cents: 5900 });

    t.clock.advanceMinutes(45);
    t.sim.pos.refund(sale.id, 1100);
    expect(await ingest()).toMatchObject({ status: 'done', changed: 1, created: 0 });
    let rows = await ledgerRow(t, sale.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, status: 'partially_refunded', refunded_cents: 1100, total_cents: 5900 });

    t.clock.advanceMinutes(45);
    t.sim.pos.refund(sale.id);
    await ingest();
    rows = await ledgerRow(t, sale.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before!.id, status: 'refunded', refunded_cents: 5900 });
    const events = await t.db.selectFrom('events').select('properties').where('name', '=', 'transaction.refunded').where(sql`properties->>'transaction_id'`, '=', before!.id).execute();
    expect(events.map((e) => (e.properties as { refunded_cents: number }).refunded_cents).sort((a, b) => a - b)).toEqual([1100, 5900]);
    // The refund is on the provider's books and the ledger's alike.
    const provider = t.sim.pos.totals({ accountRef: p.accountRef });
    expect(await ledgerTotals(t, p.orgId)).toMatchObject({ count: provider.count, totalCents: provider.totalCents, refundedCents: provider.refundedCents });
  });

  it('a provider outage marks the connection unhealthy, loses nothing, and recovers', async () => {
    const p = await pos();
    t.clock.advanceMinutes(5);
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const healthyAt = (await connectionState(t, p.connectionId)).last_ok_at;

    t.sim.pos.failNext(1, 'simulated POS outage: 503');
    await expect(ingest()).rejects.toMatchObject({ code: 'provider_error' });
    expect(await connectionState(t, p.connectionId)).toEqual({ status: 'unhealthy', last_error: 'simulated POS outage: 503', last_ok_at: healthyAt });
    expect(await ledgerRow(t, sale.id)).toEqual([]);
    // The failed run did not move the cursor past the sale it never saw.
    const stuck = await t.db.selectFrom('ingest_cursors').select('synced_through').where('connection_id', '=', p.connectionId).where('stream', '=', 'transactions').executeTakeFirstOrThrow();
    expect(stuck.synced_through!.getTime()).toBeLessThan(t.clock().getTime());

    // Hours later the provider is back. The window reaches back to the last good run, so the sale is still found.
    t.clock.advanceMinutes(180);
    expect(await ingest()).toMatchObject({ status: 'done', created: 1 });
    expect(await ledgerRow(t, sale.id)).toHaveLength(1);
    expect(await connectionState(t, p.connectionId)).toEqual({ status: 'connected', last_error: null, last_ok_at: t.clock() });
  });

  it('a rejected access token is an unhealthy connection, not a crash', async () => {
    const owner = await t.fixture.diner.as('owner');
    const p = await pos();
    // The venue re-connects with a token the provider does not accept.
    await t.app.tenant(p.orgId, owner, (ctx) =>
      ledger.connectPos(ctx, { plugKey: 'sim-pos', venueId: p.venueId, externalAccountId: p.accountRef, locationRef: p.locationRef, credentials: { accessToken: 'revoked', webhookSecret: p.secret } }),
    );
    await expect(ingest()).rejects.toMatchObject({ code: 'provider_error' });
    const state = await connectionState(t, p.connectionId);
    expect(state.status).toBe('unhealthy');
    expect(state.last_error).toContain('401');
    expect(state.last_error).not.toContain('revoked');
    // Re-authorising puts it right.
    const { simPosToken } = await import('@ros/adapters');
    await t.app.tenant(p.orgId, owner, (ctx) =>
      ledger.connectPos(ctx, { plugKey: 'sim-pos', venueId: p.venueId, externalAccountId: p.accountRef, locationRef: p.locationRef, credentials: { accessToken: simPosToken(p.accountRef), webhookSecret: p.secret } }),
    );
    expect(await ingest()).toMatchObject({ status: 'done' });
    expect((await connectionState(t, p.connectionId)).status).toBe('connected');
  });

  it('does not record what is not a POS sale: a cancelled payment, or one this platform took itself', async () => {
    const p = await pos();
    const at = { accountRef: p.accountRef, locationRef: p.locationRef };
    t.clock.advanceMinutes(1);
    const abandoned = t.sim.pos.createSale({ ...at, status: 'pending' });
    t.sim.pos.voidSale(abandoned.id);
    const ours = t.sim.pos.createSale({ ...at, originatedHere: true });
    const held = t.sim.pos.createSale({ ...at, status: 'pending' });
    const walkout = t.sim.pos.createSale({ ...at, status: 'pending' });

    expect(await ingest()).toMatchObject({ created: 2, skipped: 2 });
    expect(await ledgerRow(t, abandoned.id)).toEqual([]);
    expect(await ledgerRow(t, ours.id)).toEqual([]);
    expect((await ledgerRow(t, held.id))[0]).toMatchObject({ status: 'pending' });

    // A pending sale the ledger already holds follows the provider: captured, or cancelled.
    t.clock.advanceMinutes(1);
    t.sim.pos.complete(held.id);
    t.sim.pos.voidSale(walkout.id);
    expect(await ingest()).toMatchObject({ changed: 2 });
    expect((await ledgerRow(t, held.id))[0]).toMatchObject({ status: 'completed' });
    expect((await ledgerRow(t, walkout.id))[0]).toMatchObject({ status: 'voided' });
  });

  it('a connection id from another org finds nothing to ingest', async () => {
    const p = await pos();
    t.clock.advanceMinutes(1);
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const calls = t.sim.pos.calls.listTransactions;
    const r = await ledger.ingestConnection(t.app, { orgId: t.fixture.group.orgId, connectionId: p.connectionId });
    expect(r).toMatchObject({ status: 'idle', fetched: 0 });
    expect(t.sim.pos.calls.listTransactions).toBe(calls);
    expect(await ledgerRow(t, sale.id)).toEqual([]);
  });
});

describe('POS back-fill', () => {
  const t = useTestEnv();
  const pos = () => seededPos(t, t.fixture.diner.orgId, t.fixture.diner.venueId);

  it('fetches history from before the connection, resumes where a run stopped, and survives an expired cursor', async () => {
    const p = await pos();
    const manager = await t.fixture.diner.as('manager');
    const run = (over: Partial<ledger.IngestArgs> = {}) => ledger.ingestConnection(t.app, { orgId: p.orgId, connectionId: p.connectionId, ...over });
    const daysAgo = (n: number) => new Date(t.clock().getTime() - n * 86_400_000);
    const at = { accountRef: p.accountRef, locationRef: p.locationRef };
    const recent = [40, 35, 30, 25, 20].map((d) => t.sim.pos.createSale({ ...at, at: daysAgo(d) }));
    const old = t.sim.pos.createSale({ ...at, at: daysAgo(120) });

    // The rolling sync starts at the connection and does not look that far back.
    expect(await run()).toMatchObject({ status: 'done', fetched: 0 });
    expect(await ledgerRow(t, recent[0]!.id)).toEqual([]);
    // With no back-fill asked for, the back-fill stream has nothing to do.
    expect(await run({ stream: 'backfill' })).toMatchObject({ status: 'idle', fetched: 0 });

    const asked = await t.app.tenant(p.orgId, manager, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: p.connectionId, months: 2 }));
    expect(asked.from.toISOString()).toBe('2026-07-30T02:00:00.000Z');
    const queued = await t.db.selectFrom('jobs').select(['kind', 'payload', 'status']).where('org_id', '=', p.orgId).where('kind', '=', 'ledger.pos_ingest').execute();
    expect(queued).toEqual([{ kind: 'ledger.pos_ingest', payload: { connectionId: p.connectionId, stream: 'backfill' }, status: 'queued' }]);
    const audited = await t.db.selectFrom('audit_log').select(['actor_kind', 'entity_id']).where('action', '=', 'pos.backfill_requested').execute();
    expect(audited).toEqual([{ actor_kind: 'staff', entity_id: p.connectionId }]);

    // Two sales a page, one page a run: the run stops early and says so.
    const backfill = (over: Partial<ledger.IngestArgs> = {}) => run({ stream: 'backfill', pageSize: 2, maxPages: 1, ...over });
    expect(await backfill()).toMatchObject({ status: 'partial', pages: 1, created: 2 });
    // The next run carries on from the stored page rather than starting again.
    expect(await backfill()).toMatchObject({ status: 'partial', pages: 1, created: 2, unchanged: 0 });
    expect((await ledgerTotals(t, p.orgId)).count).toBe(4);

    // The provider's cursor expires between runs. That run fails; the one after starts the window over.
    t.sim.pos.expireCursors();
    await expect(backfill()).rejects.toMatchObject({ code: 'provider_error' });
    expect((await connectionState(t, p.connectionId)).status).toBe('unhealthy');
    expect(await backfill({ maxPages: 10 })).toMatchObject({ status: 'done', pages: 3, created: 1, unchanged: 4 });
    expect((await connectionState(t, p.connectionId)).status).toBe('connected');

    for (const sale of recent) {
      const rows = await ledgerRow(t, sale.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.occurred_at.toISOString()).toBe(sale.created_at);
    }
    expect(await ledgerRow(t, old.id)).toEqual([]);

    // The job queued by the request finds the back-fill finished and changes nothing.
    const before = await ledgerTotals(t, p.orgId);
    expect(await drainJobs(t.app, { kinds: POS_JOBS })).toMatchObject({ ran: 1, succeeded: 1 });
    expect(await ledgerTotals(t, p.orgId)).toEqual(before);

    // Asking for more history reaches the older sale; this time the job does the work.
    await t.app.tenant(p.orgId, manager, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: p.connectionId, months: 6 }));
    const during = await t.app.tenant(p.orgId, manager, (ctx) => ledger.listPosConnections(ctx, { venueId: p.venueId }));
    expect(during[0]!.backfillingFrom!.toISOString()).toBe('2026-03-30T02:00:00.000Z');
    expect(await drainJobs(t.app, { kinds: POS_JOBS })).toMatchObject({ ran: 1, succeeded: 1 });
    expect(await ledgerRow(t, old.id)).toHaveLength(1);

    const view = await t.app.tenant(p.orgId, manager, (ctx) => ledger.listPosConnections(ctx, { venueId: p.venueId }));
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({ id: p.connectionId, status: 'connected', backfillingFrom: null, locationRef: p.locationRef });
    expect(view[0]!.historyFrom!.toISOString()).toBe('2026-03-30T02:00:00.000Z');
    expect(JSON.stringify(view)).not.toContain(p.secret);

    // After all of it, the ledger and the provider agree to the cent.
    const provider = t.sim.pos.totals({ accountRef: p.accountRef });
    expect(await ledgerTotals(t, p.orgId)).toEqual({ count: 6, totalCents: provider.totalCents, refundedCents: 0, tipCents: 0 });
    expect(provider.count).toBe(6);
  });

  it('a long back-fill continues in a fresh job when a run reaches its page limit', async () => {
    const p = await pos();
    const manager = await t.fixture.diner.as('manager');
    t.clock.advanceMinutes(30);
    // 2,050 sales at 50 a page is 41 pages: one more than a single run reads.
    const day = new Date(t.clock().getTime() - 10 * 86_400_000);
    for (let i = 0; i < 2050; i++) t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef, at: day, tender: 'cash', lines: [{ name: 'Counter sale', unitPriceCents: 100 + i }] });
    await t.app.tenant(p.orgId, manager, (ctx) => ledger.requestPosBackfill(ctx, { connectionId: p.connectionId, months: 1 }));

    const drained = await drainJobs(t.app, { kinds: POS_JOBS });
    // The requested job, then the continuation it queued.
    expect(drained).toMatchObject({ ran: 2, succeeded: 2, failed: 0 });
    const provider = t.sim.pos.totals({ accountRef: p.accountRef });
    expect(provider.count).toBe(2056);
    expect(await ledgerTotals(t, p.orgId)).toMatchObject({ count: provider.count, totalCents: provider.totalCents });
  }, 120_000);
});

describe('POS write-back: an order sent to the till comes back as a sale', () => {
  const t = useTestEnv();

  it('a pushed order is discounted once, paid at the till, and ingested with the discount named', async () => {
    const { diner } = t.fixture;
    const p = await seededPos(t, diner.orgId, diner.venueId);
    const row = await t.db.selectFrom('connections').selectAll().where('id', '=', p.connectionId).executeTakeFirstOrThrow();
    const handle = await resolveConnection(t.app, row as unknown as ConnectionRow);
    const adapter = adapterFor(t.app, 'pos', row);
    expect(adapter.capabilities).toMatchObject({ itemisedLines: true, writeBack: 'order', webhooks: true });

    const order = {
      idempotencyKey: 'push:order-1',
      reference: 'A7K2QX',
      locationRef: p.locationRef,
      channel: 'pickup' as const,
      customerName: 'Sam',
      lines: [{ name: 'Wagyu burger', qty: 2, unitPriceCents: 2600, modifiers: [{ name: 'Extra cheese', priceCents: 200 }] }, { name: 'Fries', qty: 1, unitPriceCents: 900, modifiers: [] }],
      totalCents: 6100,
    };
    const pushed = await adapter.pushOrder!(handle, order);
    // The same push again is the same order, not a second one.
    expect(await adapter.pushOrder!(handle, order)).toEqual(pushed);
    expect(t.sim.pos.pushedOrders).toHaveLength(1);
    expect(t.sim.pos.pushedOrders[0]).toMatchObject({ posOrderRef: pushed.posOrderRef, state: 'open', order: { reference: 'A7K2QX', totalCents: 6100 } });

    const discount = { locationRef: p.locationRef, orderRef: pushed.posOrderRef, name: 'Reward: $10 off', amountCents: 1000, idempotencyKey: 'redeem:1' };
    expect(await adapter.applyDiscount!(handle, discount)).toEqual({ ok: true });
    expect(await adapter.applyDiscount!(handle, discount)).toEqual({ ok: true });
    expect(t.sim.pos.pushedOrders[0]!.discounts).toHaveLength(1);
    expect(await adapter.applyDiscount!(handle, { ...discount, orderRef: 'simord_unknown' })).toEqual({ ok: false });

    const seen: Array<{ name: string; amountCents: number }> = [];
    ledger.onTransactionRecorded(async (_ctx, _txn, info) => void seen.push(...info.discounts.map((d) => ({ name: d.name, amountCents: d.amountCents }))));
    const paid = t.sim.pos.settleOrder(pushed.posOrderRef, { tipCents: 300 });
    expect(await adapter.applyDiscount!(handle, { ...discount, idempotencyKey: 'redeem:2' })).toEqual({ ok: false }); // already paid
    expect(await ledger.ingestConnection(t.app, { orgId: p.orgId, connectionId: p.connectionId })).toMatchObject({ status: 'done', created: 1 });

    const [sale] = await ledgerRow(t, paid.id);
    expect(sale).toMatchObject({ venue_id: p.venueId, subtotal_cents: 6100, discount_cents: 1000, tip_cents: 300, total_cents: 5400, status: 'completed' });
    expect(seen).toEqual([{ name: 'Reward: $10 off', amountCents: 1000 }]);
    const lines = await t.db.selectFrom('transaction_lines').select(['name_snapshot', 'unit_price_cents', 'total_cents', 'modifiers']).where('transaction_id', '=', sale!.id).orderBy('line_no').execute();
    expect(lines).toEqual([
      { name_snapshot: 'Wagyu burger', unit_price_cents: 2600, total_cents: 5200, modifiers: [{ name: 'Extra cheese', priceCents: 200 }] },
      { name_snapshot: 'Fries', unit_price_cents: 900, total_cents: 900, modifiers: [] },
    ]);
  });
});

describe('POS reconciliation: the group, three venues on one merchant account', () => {
  const t = useTestEnv();
  const all = async () => {
    const { group } = t.fixture;
    return {
      cbd: await seededPos(t, group.orgId, group.venues.cbd!.id),
      newtown: await seededPos(t, group.orgId, group.venues.newtown!.id),
      bondi: await seededPos(t, group.orgId, group.venues.bondi!.id),
    };
  };
  const reconcile = async () => {
    const ticked = await tickSchedules(t.app, { only: ['ledger.pos_reconcile'] });
    return { ticked, jobs: await drainJobs(t.app, { kinds: POS_JOBS }) };
  };

  it('picks up sales whose webhooks were lost, and puts each in the venue its location maps to', async () => {
    const pos = await all();
    expect(new Set([pos.cbd.accountRef, pos.newtown.accountRef, pos.bondi.accountRef]).size).toBe(1);
    const sales = {
      cbd: t.sim.pos.createSale({ accountRef: pos.cbd.accountRef, locationRef: pos.cbd.locationRef, tipCents: 500 }),
      newtown: t.sim.pos.createSale({ accountRef: pos.newtown.accountRef, locationRef: pos.newtown.locationRef }),
      bondi: t.sim.pos.createSale({ accountRef: pos.bondi.accountRef, locationRef: pos.bondi.locationRef, channel: 'pickup' }),
    };
    // No webhook is delivered for any of them.
    t.clock.advanceMinutes(15);

    const first = await reconcile();
    // One reconcile job per fixture org, then one ingest job per connected venue (one at the diner, three here).
    expect(first.ticked.enqueued).toBe(2);
    expect(first.jobs).toMatchObject({ ran: 6, succeeded: 6, failed: 0 });

    for (const key of ['cbd', 'newtown', 'bondi'] as const) {
      const rows = await ledgerRow(t, sales[key].id);
      expect(rows, key).toHaveLength(1);
      expect(rows[0]).toMatchObject({ org_id: t.fixture.group.orgId, venue_id: pos[key].venueId, total_cents: sales[key].total_money.amount });
      const venueTotals = await ledgerTotals(t, t.fixture.group.orgId, pos[key].venueId);
      expect(venueTotals).toMatchObject({ count: 1, totalCents: t.sim.pos.totals({ accountRef: pos[key].accountRef, locationRef: pos[key].locationRef }).totalCents });
    }
    // Nothing of the group's reached the other org.
    expect(await ledgerTotals(t, t.fixture.diner.orgId)).toMatchObject({ count: 0 });

    // The same tick again, inside the same window, queues nothing new.
    const again = await reconcile();
    expect(again.jobs.ran).toBe(0);
    expect((await ledgerTotals(t, t.fixture.group.orgId)).count).toBe(3);
  });

  it('one POS being down does not hold up the others, and the failed one catches up on retry', async () => {
    const pos = await all();
    t.clock.advanceMinutes(15);
    const sales = [pos.cbd, pos.newtown, pos.bondi].map((p) => t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef }));
    const dinerPos = await seededPos(t, t.fixture.diner.orgId, t.fixture.diner.venueId);
    const dinerSale = t.sim.pos.createSale({ accountRef: dinerPos.accountRef, locationRef: dinerPos.locationRef });

    t.sim.pos.failNext(1);
    const run = await reconcile();
    expect(run.jobs).toMatchObject({ ran: 6, succeeded: 5, failed: 1 });
    const states = await t.db.selectFrom('connections').select(['id', 'status']).where('plug_key', '=', 'sim-pos').execute();
    expect(states.filter((s) => s.status === 'unhealthy')).toHaveLength(1);
    const landed = (await Promise.all([...sales, dinerSale].map((s) => ledgerRow(t, s.id)))).filter((rows) => rows.length === 1);
    expect(landed).toHaveLength(3);

    // The failed job is retried after its back-off and the connection is healthy again.
    t.clock.advanceMinutes(1);
    expect(await drainJobs(t.app, { kinds: POS_JOBS })).toMatchObject({ ran: 1, succeeded: 1 });
    for (const s of [...sales, dinerSale]) expect(await ledgerRow(t, s.id)).toHaveLength(1);
    const after = await t.db.selectFrom('connections').select('status').where('plug_key', '=', 'sim-pos').execute();
    expect(after.every((s) => s.status === 'connected')).toBe(true);
    expect((await ledgerTotals(t, t.fixture.diner.orgId)).count).toBe(1);
  });

  it('a revoked connection is no longer polled', async () => {
    const pos = await all();
    const owner = await t.fixture.group.as('owner');
    const { revokeConnection } = await import('@ros/core');
    const secretRef = (await t.db.selectFrom('connections').select('secret_ref').where('id', '=', pos.bondi.connectionId).executeTakeFirstOrThrow()).secret_ref!;
    await t.app.tenant(t.fixture.group.orgId, owner, (ctx) => revokeConnection(ctx, pos.bondi.connectionId));
    // Revoking also destroys the stored credentials.
    expect(await t.db.selectFrom('secrets').select('id').where('id', '=', secretRef).execute()).toEqual([]);
    t.clock.advanceMinutes(15);
    const sale = t.sim.pos.createSale({ accountRef: pos.bondi.accountRef, locationRef: pos.bondi.locationRef });
    const run = await reconcile();
    // Diner's one connection, and the group's remaining two.
    expect(run.jobs).toMatchObject({ ran: 5, succeeded: 5 });
    expect(await ledgerRow(t, sale.id)).toEqual([]);
  });
});
