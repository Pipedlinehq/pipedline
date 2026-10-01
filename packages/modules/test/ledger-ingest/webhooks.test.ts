import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { signedWebhook } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { ledger } from '@ros/modules';
import { WEBHOOK_URL, connectionState, ledgerRow, ledgerTotals, seededPos } from './helpers';

describe('POS webhooks', () => {
  const t = useTestEnv();
  const diner = () => seededPos(t, t.fixture.diner.orgId, t.fixture.diner.venueId);
  const deliver = (w: { rawBody: string; headers: Record<string, string | undefined> }) =>
    ledger.handlePosWebhook(t.app, { plugKey: 'sim-pos', rawBody: w.rawBody, headers: w.headers, url: WEBHOOK_URL });
  const webhookRows = (eventId: string) => t.db.selectFrom('webhook_events').select(['status', 'org_id', 'connection_id', 'event_type']).where('event_id', 'like', `%:${eventId}`).execute();
  const recordedEvents = async (transactionId: string) =>
    (await t.db.selectFrom('events').select('id').where('name', '=', 'transaction.recorded').where(sql`properties->>'transaction_id'`, '=', transactionId).execute()).length;

  it('a signed webhook puts the sale in the ledger of the venue its connection maps to', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef, tipCents: 300 });
    const w = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });

    expect(await deliver(w)).toEqual({ status: 'processed', created: 1, changed: 0, unchanged: 0, skipped: 0 });
    const rows = await ledgerRow(t, sale.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: p.orgId, venue_id: p.venueId, total_cents: 6200, tip_cents: 300, status: 'completed' });
    expect(await webhookRows(w.eventId)).toEqual([{ status: 'processed', org_id: p.orgId, connection_id: p.connectionId, event_type: 'payment.updated' }]);
  });

  it('the same webhook delivered again has no second effect', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const w = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });
    await deliver(w);
    const [row] = await ledgerRow(t, sale.id);
    const fetches = t.sim.pos.calls.getTransaction;

    const replay = t.sim.pos.duplicate(w.eventId);
    expect(replay.rawBody).toBe(w.rawBody);
    expect(await deliver(replay)).toEqual({ status: 'duplicate', created: 0, changed: 0, unchanged: 0, skipped: 0 });
    expect(await deliver(replay)).toMatchObject({ status: 'duplicate' });

    // Not even re-fetched: the replay is recognised before any work is done.
    expect(t.sim.pos.calls.getTransaction).toBe(fetches);
    expect(await ledgerRow(t, sale.id)).toHaveLength(1);
    expect(await recordedEvents(row!.id)).toBe(1);
    expect(await webhookRows(w.eventId)).toHaveLength(1);
  });

  it('a forged webhook is unauthenticated and nothing is stored', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const before = await ledgerTotals(t, p.orgId);
    const fetches = t.sim.pos.calls.getTransaction;
    const events = await t.db.selectFrom('webhook_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();

    const wrongSecret = t.sim.pos.webhook('not-the-secret', { accountRef: p.accountRef, paymentIds: [sale.id] });
    await expect(deliver(wrongSecret)).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });

    // A genuine signature does not cover a body that was changed after signing.
    const genuine = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });
    await expect(deliver({ rawBody: genuine.rawBody.replace(sale.id, `${sale.id}x`), headers: genuine.headers })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(deliver({ rawBody: genuine.rawBody, headers: { 'content-type': 'application/json' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    // An account nobody has connected, a body that is not an event at all: the same answer, so nothing can be probed.
    await expect(deliver(t.sim.pos.webhook(p.secret, { accountRef: 'simpos-acct-nobody', paymentIds: [sale.id] }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(deliver(signedWebhook(p.secret, { hello: 'world' }))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(deliver({ rawBody: 'not json', headers: genuine.headers })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(ledger.handlePosWebhook(t.app, { plugKey: 'no-such-plug', rawBody: genuine.rawBody, headers: genuine.headers, url: WEBHOOK_URL })).rejects.toMatchObject({ code: 'not_found' });

    expect(t.sim.pos.calls.getTransaction).toBe(fetches);
    expect(await ledgerRow(t, sale.id)).toEqual([]);
    expect(await ledgerTotals(t, p.orgId)).toEqual(before);
    const after = await t.db.selectFrom('webhook_events').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(events.n));

    // The genuine one still works afterwards: the forgeries did not use up its event id.
    expect(await deliver(genuine)).toMatchObject({ status: 'processed', created: 1 });
  });

  it('a change-only webhook, naming a payment id and nothing else, is re-fetched in full', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({
      accountRef: p.accountRef,
      locationRef: p.locationRef,
      lines: [{ name: 'Lamb shoulder', unitPriceCents: 6400, category: 'Mains' }, { name: 'Greens', unitPriceCents: 1200, qty: 2, category: 'Sides' }],
      discount: { name: 'Locals night', amountCents: 880 },
      tipCents: 1000,
    });
    const w = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id], changeOnly: true, type: 'payment.changed' });
    expect(JSON.parse(w.rawBody)).toEqual({ event_id: w.eventId, type: 'payment.changed', account_id: p.accountRef, created_at: expect.any(String), data: { type: 'payment', id: sale.id } });

    const fetches = t.sim.pos.calls.getTransaction;
    expect(await deliver(w)).toMatchObject({ status: 'processed', created: 1 });
    expect(t.sim.pos.calls.getTransaction).toBe(fetches + 1);
    const [row] = await ledgerRow(t, sale.id);
    expect(row).toMatchObject({ venue_id: p.venueId, subtotal_cents: 8800, discount_cents: 880, tip_cents: 1000, total_cents: 8920 });
    const lines = await t.db.selectFrom('transaction_lines').select(['name_snapshot', 'total_cents']).where('transaction_id', '=', row!.id).orderBy('line_no').execute();
    expect(lines).toEqual([{ name_snapshot: 'Lamb shoulder', total_cents: 6400 }, { name_snapshot: 'Greens', total_cents: 2400 }]);
  });

  it('what the webhook says is not believed: the provider\'s record is what gets written', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    // Correctly signed, but every figure in it is wrong, and it names another venue's location.
    const lying = signedWebhook(p.secret, {
      event_id: randomUUID(),
      type: 'payment.updated',
      account_id: p.accountRef,
      location_id: 'simpos-loc-oak-group-cbd',
      data: { type: 'payment', ids: [sale.id], object: { payments: [{ id: sale.id, status: 'COMPLETED', total_money: { amount: 1, currency: 'AUD' }, refunded_money: { amount: 1, currency: 'AUD' } }] } },
    });
    expect(await deliver(lying)).toMatchObject({ status: 'processed', created: 1 });
    expect((await ledgerRow(t, sale.id))[0]).toMatchObject({ venue_id: p.venueId, total_cents: 5900, refunded_cents: 0, status: 'completed' });

    // A webhook built before a refund, delivered after it: the ledger gets the refund, because it asks the provider.
    const stale = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });
    t.sim.pos.refund(sale.id, 2000);
    expect(JSON.parse(stale.rawBody).data.object.payments[0].refunded_money.amount).toBe(0);
    expect(await deliver(stale)).toMatchObject({ status: 'processed', changed: 1 });
    expect(await ledgerRow(t, sale.id)).toHaveLength(1);
    expect((await ledgerRow(t, sale.id))[0]).toMatchObject({ status: 'partially_refunded', refunded_cents: 2000 });
  });

  it('when the re-fetch fails the claim is released, so the provider\'s retry is processed', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const w = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });

    t.sim.pos.failNext(1);
    await expect(deliver(w)).rejects.toMatchObject({ code: 'provider_error', status: 502 });
    expect(await webhookRows(w.eventId)).toEqual([]);
    expect(await ledgerRow(t, sale.id)).toEqual([]);
    expect((await connectionState(t, p.connectionId)).status).toBe('unhealthy');

    // The provider retries the identical delivery.
    expect(await deliver(t.sim.pos.duplicate(w.eventId))).toMatchObject({ status: 'processed', created: 1 });
    expect(await ledgerRow(t, sale.id)).toHaveLength(1);
    expect(await webhookRows(w.eventId)).toMatchObject([{ status: 'processed' }]);
    expect(await connectionState(t, p.connectionId)).toMatchObject({ status: 'connected', last_error: null });
  });

  it('a webhook and the poll arriving for the same sale still make one row', async () => {
    const p = await diner();
    const sale = t.sim.pos.createSale({ accountRef: p.accountRef, locationRef: p.locationRef });
    const w = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [sale.id] });
    const [viaWebhook, viaPoll] = await Promise.all([deliver(w), ledger.ingestConnection(t.app, { orgId: p.orgId, connectionId: p.connectionId })]);
    expect(viaWebhook.status).toBe('processed');
    expect(viaPoll.status).toBe('done');
    const rows = await ledgerRow(t, sale.id);
    expect(rows).toHaveLength(1);
    expect(await recordedEvents(rows[0]!.id)).toBe(1);
  });

  it('events that name no sale, or a sale the provider does not have, are acknowledged and ignored', async () => {
    const p = await diner();
    const before = await ledgerTotals(t, p.orgId);
    const nothing = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: [], type: 'catalog.updated' });
    expect(await deliver(nothing)).toEqual({ status: 'ignored', created: 0, changed: 0, unchanged: 0, skipped: 0 });
    const ghost = t.sim.pos.webhook(p.secret, { accountRef: p.accountRef, paymentIds: ['simpos_does_not_exist'] });
    expect(await deliver(ghost)).toEqual({ status: 'ignored', created: 0, changed: 0, unchanged: 0, skipped: 1 });
    expect(await webhookRows(ghost.eventId)).toMatchObject([{ status: 'ignored' }]);
    expect(await ledgerTotals(t, p.orgId)).toEqual(before);
  });
});

describe('POS webhooks: one org can never write into another', () => {
  const t = useTestEnv();
  const deliver = (w: { rawBody: string; headers: Record<string, string | undefined> }) =>
    ledger.handlePosWebhook(t.app, { plugKey: 'sim-pos', rawBody: w.rawBody, headers: w.headers, url: WEBHOOK_URL });
  const both = async () => ({
    a: await seededPos(t, t.fixture.diner.orgId, t.fixture.diner.venueId),
    b: await seededPos(t, t.fixture.group.orgId, t.fixture.group.venues.cbd!.id),
    bNewtown: await seededPos(t, t.fixture.group.orgId, t.fixture.group.venues.newtown!.id),
  });
  const rowsInOrg = async (orgId: string) =>
    Number((await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).where('external_ref', 'like', 'simpos_%').executeTakeFirstOrThrow()).n);

  it('a webhook for org A\'s account never touches org B', async () => {
    const { a, b } = await both();
    expect(a.accountRef).not.toBe(b.accountRef);
    expect(a.secret).not.toBe(b.secret);
    const sale = t.sim.pos.createSale({ accountRef: a.accountRef, locationRef: a.locationRef });

    expect(await deliver(t.sim.pos.webhook(a.secret, { accountRef: a.accountRef, paymentIds: [sale.id] }))).toMatchObject({ status: 'processed', created: 1 });
    const rows = await ledgerRow(t, sale.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: a.orgId, venue_id: a.venueId });
    expect(await rowsInOrg(b.orgId)).toBe(0);
    // Org B, looking through its own tenant, cannot see the sale at all.
    const seen = await t.app.tenant(b.orgId, { kind: 'worker', job: 'test' }, (ctx) => ctx.db.selectFrom('transactions').select('id').where('external_ref', '=', sale.id).execute());
    expect(seen).toEqual([]);
  });

  it('org B cannot sign for org A\'s account, nor pull org A\'s sale through its own', async () => {
    const { a, b } = await both();
    const sale = t.sim.pos.createSale({ accountRef: a.accountRef, locationRef: a.locationRef, tipCents: 123 });
    const aBefore = await rowsInOrg(a.orgId);

    // B's secret on an event for A's account: not A's signature.
    await expect(deliver(t.sim.pos.webhook(b.secret, { accountRef: a.accountRef, paymentIds: [sale.id] }))).rejects.toMatchObject({ code: 'unauthenticated' });

    // B's own account, properly signed, naming A's payment. The signature is genuine, so the
    // event is accepted; the re-fetch is made with B's credentials, and the provider has no
    // such payment for B. Nothing is written for either org.
    const sneaky = t.sim.pos.webhook(b.secret, { accountRef: b.accountRef, paymentIds: [sale.id] });
    expect(await deliver(sneaky)).toEqual({ status: 'ignored', created: 0, changed: 0, unchanged: 0, skipped: 1 });
    expect(await ledgerRow(t, sale.id)).toEqual([]);
    expect(await rowsInOrg(b.orgId)).toBe(0);
    expect(await rowsInOrg(a.orgId)).toBe(aBefore);

    // Nor does it work with A's payment described in full inside B's event.
    const stuffed = signedWebhook(b.secret, {
      event_id: randomUUID(),
      type: 'payment.updated',
      account_id: b.accountRef,
      location_id: b.locationRef,
      data: { type: 'payment', ids: [sale.id], object: { payments: [t.sim.pos.get(sale.id)] } },
    });
    expect(await deliver(stuffed)).toMatchObject({ status: 'ignored', created: 0 });
    expect(await rowsInOrg(b.orgId)).toBe(0);
  });

  it('org B reusing an event id org A has already used does not shadow either event', async () => {
    const { a, b } = await both();
    const eventId = randomUUID();
    const saleA = t.sim.pos.createSale({ accountRef: a.accountRef, locationRef: a.locationRef });
    const saleB = t.sim.pos.createSale({ accountRef: b.accountRef, locationRef: b.locationRef });
    expect(await deliver(t.sim.pos.webhook(b.secret, { accountRef: b.accountRef, paymentIds: [saleB.id], eventId }))).toMatchObject({ status: 'processed', created: 1 });
    expect(await deliver(t.sim.pos.webhook(a.secret, { accountRef: a.accountRef, paymentIds: [saleA.id], eventId }))).toMatchObject({ status: 'processed', created: 1 });
    expect((await ledgerRow(t, saleA.id))[0]).toMatchObject({ org_id: a.orgId });
    expect((await ledgerRow(t, saleB.id))[0]).toMatchObject({ org_id: b.orgId, venue_id: b.venueId });
  });

  it('within one org, a sale lands in the venue of its own location whichever location the event names', async () => {
    const { b, bNewtown } = await both();
    expect(b.accountRef).toBe(bNewtown.accountRef);
    const sale = t.sim.pos.createSale({ accountRef: bNewtown.accountRef, locationRef: bNewtown.locationRef });
    const w = signedWebhook(b.secret, { event_id: randomUUID(), type: 'payment.updated', account_id: b.accountRef, location_id: b.locationRef, data: { type: 'payment', ids: [sale.id] } });
    expect(await deliver(w)).toMatchObject({ status: 'processed', created: 1 });
    expect((await ledgerRow(t, sale.id))[0]).toMatchObject({ org_id: b.orgId, venue_id: bNewtown.venueId });
  });

  it('a revoked connection no longer accepts webhooks', async () => {
    const { a } = await both();
    const owner = await t.fixture.diner.as('owner');
    const { revokeConnection } = await import('@ros/core');
    await t.app.tenant(a.orgId, owner, (ctx) => revokeConnection(ctx, a.connectionId));
    const sale = t.sim.pos.createSale({ accountRef: a.accountRef, locationRef: a.locationRef });
    await expect(deliver(t.sim.pos.webhook(a.secret, { accountRef: a.accountRef, paymentIds: [sale.id] }))).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await ledgerRow(t, sale.id)).toEqual([]);
  });
});
