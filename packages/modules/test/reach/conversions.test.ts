import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { drainJobs, enqueue } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { comms } from '@ros/modules';
import { WORKER, guest, revoke, sale } from './helpers';

/** An independent SHA-256 of the value normalised by hand the way Meta documents it. */
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('reach: purchase conversions to an ad platform', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const DINER_ADS = '100000000000001';
  const GROUP_ADS = '100000000000002';

  beforeAll(async () => {
    const owner = await diner().as('owner');
    await t.app.tenant(diner().orgId, owner, (ctx) => comms.connectAdsAccount(ctx, { plugKey: 'sim-ads', externalAccountId: DINER_ADS, credentials: { accessToken: 'tok-d' } }));
    const gOwner = await group().as('owner');
    await t.app.tenant(group().orgId, gOwner, (ctx) => comms.connectAdsAccount(ctx, { plugKey: 'sim-ads', externalAccountId: GROUP_ADS, credentials: { accessToken: 'tok-g' } }));
  });

  const convRows = (transactionId: string) => t.db.selectFrom('ad_conversions').selectAll().where('transaction_id', '=', transactionId).execute();

  it('only an owner connects an ads account; a manager sees counts', async () => {
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => comms.connectAdsAccount(ctx, { plugKey: 'sim-ads', externalAccountId: '1', credentials: { accessToken: 'x' } }))).rejects.toMatchObject({ code: 'forbidden' });
    const status = await t.app.tenant(diner().orgId, manager, (ctx) => comms.adsConversionStatus(ctx));
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ plugKey: 'sim-ads', status: 'connected' });
  });

  it('a consenting guest\'s sale is sent once, hashed correctly, with no raw email and no card identifier', async () => {
    const id = await guest(t, diner(), { email: '  Mixed.Case@Example.COM ', phone: '(04) 1234-5678', consents: ['ad_platform_sharing', 'card_recognition'] });
    const fingerprint = 'sq0fp-RAW-FINGERPRINT-abc123';
    const par = 'V0010013020298765432109876543';
    const s = await sale(t, diner(), {
      venueId: diner().venueId,
      customerId: id,
      totalCents: 8450,
      hints: [
        { kind: 'email', value: 'mixed.case@example.com' },
        { kind: 'card_fingerprint', value: fingerprint },
        { kind: 'card_par', value: par },
      ],
    });
    await drainJobs(t.app);
    // Replay: the same sale delivered again, and the job run again with a new key.
    await sale(t, diner(), { venueId: diner().venueId, customerId: id, totalCents: 8450, externalRef: s.txn.externalRef });
    const [row] = await convRows(s.transaction.id);
    await t.app.tenant(diner().orgId, WORKER, (ctx) => enqueue(ctx, comms.sendConversionJob, { conversionId: row!.id }, { key: `${row!.id}:replay` }));
    await drainJobs(t.app);

    const batches = t.sim.ads.batches.filter((b) => b.accountRef === DINER_ADS && b.conversions.some((c) => c.eventId === `txn_${s.transaction.id}`));
    expect(batches).toHaveLength(1);
    const c = batches[0]!.conversions[0]!;
    expect(c).toMatchObject({ eventName: 'Purchase', valueCents: 8450, currency: 'AUD', source: 'physical_store', eventId: `txn_${s.transaction.id}` });
    expect(c.hashedEmail).toBe(sha('mixed.case@example.com'));
    expect(c.hashedPhone).toBe(sha('61412345678'));
    const payload = batches[0]!.payload;
    for (const forbidden of ['mixed.case@example.com', 'Mixed.Case', '0412345678', '+61412345678', '61412345678', fingerprint, par, 'sq0fp']) expect(payload).not.toContain(forbidden);
    // Nor the per-org hashes the identity table stores for the card.
    const stored = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('customer_id', '=', id).execute();
    for (const i of stored.filter((x) => x.kind.startsWith('card_'))) expect(payload).not.toContain(i.value);

    expect(await convRows(s.transaction.id)).toHaveLength(1);
    expect((await convRows(s.transaction.id))[0]).toMatchObject({ status: 'sent', source: 'physical_store' });
    const sentEvents = await t.db.selectFrom('events').select('id').where('name', '=', 'ad_conversion.sent').where('properties', '@>', JSON.stringify({ transaction_id: s.transaction.id }) as never).execute();
    expect(sentEvents).toHaveLength(1);
  });

  it('no consent → nothing is sent or even queued', async () => {
    const id = await guest(t, diner(), { email: 'no.ads@example.com', consents: ['marketing_email'] });
    const s = await sale(t, diner(), { venueId: diner().venueId, customerId: id });
    await drainJobs(t.app);
    expect(await convRows(s.transaction.id)).toHaveLength(0);
    expect(JSON.stringify(t.sim.ads.batches)).not.toContain(sha('no.ads@example.com'));
    // An anonymous sale: nothing.
    const anon = await sale(t, diner(), { venueId: diner().venueId });
    await drainJobs(t.app);
    expect(await convRows(anon.transaction.id)).toHaveLength(0);
  });

  it('a refund sends nothing further', async () => {
    const id = await guest(t, diner(), { email: 'refunded@example.com', consents: ['ad_platform_sharing'] });
    const s = await sale(t, diner(), { venueId: diner().venueId, customerId: id, totalCents: 3000 });
    await drainJobs(t.app);
    const before = t.sim.ads.batches.length;
    await sale(t, diner(), { venueId: diner().venueId, customerId: id, totalCents: 3000, externalRef: s.txn.externalRef, status: 'refunded', refundedCents: 3000 });
    await drainJobs(t.app);
    expect(t.sim.ads.batches.length).toBe(before);
    expect(await convRows(s.transaction.id)).toHaveLength(1);
    expect(t.sim.ads.accepted(DINER_ADS).every((c) => (c.valueCents ?? 0) > 0)).toBe(true);
  });

  it('consent withdrawn stops sends, including a sale already queued', async () => {
    const id = await guest(t, diner(), { email: 'changed.mind@example.com', consents: ['ad_platform_sharing'] });
    const queued = await sale(t, diner(), { venueId: diner().venueId, customerId: id });
    await revoke(t, diner(), id, 'ad_platform_sharing');
    await drainJobs(t.app);
    expect((await convRows(queued.transaction.id))[0]).toMatchObject({ status: 'skipped', reason: 'no_consent' });
    const later = await sale(t, diner(), { venueId: diner().venueId, customerId: id });
    await drainJobs(t.app);
    expect(await convRows(later.transaction.id)).toHaveLength(0);
    expect(JSON.stringify(t.sim.ads.batches)).not.toContain(sha('changed.mind@example.com'));
  });

  it('an online sale is marked as website; the event id is the order id when there is one', async () => {
    const id = await guest(t, diner(), { email: 'online@example.com', consents: ['ad_platform_sharing'] });
    const orderId = '6f1d2c3b-0000-4000-8000-00000000abcd';
    const s = await sale(t, diner(), { venueId: diner().venueId, customerId: id, source: 'online-order', channel: 'pickup', orderId });
    await drainJobs(t.app);
    const c = t.sim.ads.accepted(DINER_ADS).find((x) => x.eventId === `order_${orderId}`);
    expect(c).toMatchObject({ source: 'website', orderId });
    expect((await convRows(s.transaction.id))[0]!.status).toBe('sent');
  });

  it("another org's ads connection never receives this org's sales", async () => {
    const d = await guest(t, diner(), { email: 'diner.only@example.com', consents: ['ad_platform_sharing'] });
    const g = await guest(t, group(), { email: 'group.only@example.com', consents: ['ad_platform_sharing'] });
    const ds = await sale(t, diner(), { venueId: diner().venueId, customerId: d });
    const gs = await sale(t, group(), { venueId: group().venues.cbd!.id, customerId: g });
    await drainJobs(t.app);
    const groupSide = JSON.stringify(t.sim.ads.batches.filter((b) => b.accountRef === GROUP_ADS));
    const dinerSide = JSON.stringify(t.sim.ads.batches.filter((b) => b.accountRef === DINER_ADS));
    expect(groupSide).toContain(`txn_${gs.transaction.id}`);
    expect(groupSide).not.toContain(`txn_${ds.transaction.id}`);
    expect(groupSide).not.toContain(sha('diner.only@example.com'));
    expect(dinerSide).not.toContain(`txn_${gs.transaction.id}`);
    expect(dinerSide).not.toContain(sha('group.only@example.com'));
    // RLS: the diner cannot read the group's conversion rows.
    const seen = await t.app.tenant(diner().orgId, WORKER, (ctx) => ctx.db.selectFrom('ad_conversions').select('id').where('transaction_id', '=', gs.transaction.id).execute());
    expect(seen).toHaveLength(0);
  });

  it('a platform outage is retried and the sale is still sent once', async () => {
    const id = await guest(t, diner(), { email: 'retry.ads@example.com', consents: ['ad_platform_sharing'] });
    t.sim.ads.failNext(1);
    const s = await sale(t, diner(), { venueId: diner().venueId, customerId: id });
    await drainJobs(t.app);
    t.clock.advanceMinutes(5);
    await drainJobs(t.app);
    expect(t.sim.ads.accepted(DINER_ADS).filter((c) => c.eventId === `txn_${s.transaction.id}`)).toHaveLength(1);
    expect((await convRows(s.transaction.id))[0]!.status).toBe('sent');
  });
});
