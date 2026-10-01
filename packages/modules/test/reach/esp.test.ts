import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { drainJobs } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { comms } from '@ros/modules';
import { WORKER, guest, revoke, sale } from './helpers';

comms.defineTemplate({
  key: 'reach.offer',
  channel: 'email',
  kind: 'marketing',
  description: 'test',
  subject: 'Come back to {{org_name}}',
  body: 'Hi {{name}}.',
  variables: z.object({ name: z.string() }),
});
comms.defineTemplate({
  key: 'reach.receipt',
  channel: 'email',
  kind: 'transactional',
  description: 'test',
  subject: 'Your receipt',
  body: 'Thanks {{name}}.',
  variables: z.object({ name: z.string() }),
});

describe('reach: the connected email platform', () => {
  const t = useTestEnv();
  const diner = () => t.fixture.diner;
  const group = () => t.fixture.group;
  const DINER_ACCT = 'esp-diner';
  const GROUP_ACCT = 'esp-group';
  let connectionId: string;
  let groupConnectionId: string;
  let consenting: string;
  let smsOnly: string;
  let noConsent: string;
  let lapsed: string;

  const acct = () => t.sim.esp.account(DINER_ACCT);
  const sync = () => comms.syncEmailPlatform(t.app, { orgId: diner().orgId, connectionId });

  beforeAll(async () => {
    consenting = await guest(t, diner(), { email: 'Keen.Guest@Example.com', phone: '0400 111 222', consents: ['marketing_email'] });
    smsOnly = await guest(t, diner(), { email: 'sms.only@example.com', phone: '0400 333 444', consents: ['marketing_sms'] });
    noConsent = await guest(t, diner(), { email: 'no.box@example.com', phone: '0400 555 666' });
    lapsed = await guest(t, diner(), { email: 'lapsed@example.com', consents: ['marketing_email'] });
    await revoke(t, diner(), lapsed, 'marketing_email');
    await sale(t, diner(), { venueId: diner().venueId, customerId: noConsent });

    const owner = await diner().as('owner');
    const s = await t.app.tenant(diner().orgId, owner, (ctx) => comms.connectEmailPlatform(ctx, { plugKey: 'sim-esp', externalAccountId: DINER_ACCT, credentials: { apiKey: 'sim-key' } }));
    connectionId = s.connectionId;
    const gOwner = await group().as('owner');
    const g = await t.app.tenant(group().orgId, gOwner, (ctx) => comms.connectEmailPlatform(ctx, { plugKey: 'sim-esp', externalAccountId: GROUP_ACCT, credentials: { apiKey: 'sim-key-g' } }));
    groupConnectionId = g.connectionId;
    await drainJobs(t.app);
  });

  it('only a manager or owner sees sync health; only an owner connects', async () => {
    const manager = await diner().as('manager');
    await expect(t.app.tenant(diner().orgId, manager, (ctx) => comms.connectEmailPlatform(ctx, { plugKey: 'sim-esp', externalAccountId: 'x', credentials: { apiKey: 'k' } }))).rejects.toMatchObject({ code: 'forbidden' });
    const status = await t.app.tenant(diner().orgId, manager, (ctx) => comms.emailPlatformStatus(ctx));
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ connectionId, status: 'connected', tier: 'connected', lastError: null });
    expect(status[0]!.lastRunAt).not.toBeNull();
    expect(status[0]!.profilesSubscribed).toBeGreaterThan(0);
    const host = await diner().as('host');
    await expect(t.app.tenant(diner().orgId, host, (ctx) => comms.emailPlatformStatus(ctx))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pushes only guests with a marketing consent, and only the address they agreed to', async () => {
    const pushedIds = new Set(acct().upserts.map((p) => p.externalId));
    expect(pushedIds.has(consenting)).toBe(true);
    expect(pushedIds.has(smsOnly)).toBe(true);
    expect(pushedIds.has(noConsent)).toBe(false);
    expect(pushedIds.has(lapsed)).toBe(false);

    // Every profile the platform got belongs to a guest who holds a marketing consent here.
    const granted = await t.db
      .selectFrom('consents')
      .select('customer_id')
      .where('org_id', '=', diner().orgId)
      .where('purpose', 'in', ['marketing_email', 'marketing_sms'])
      .where('status', '=', 'granted')
      .execute();
    const ok = new Set(granted.map((g) => g.customer_id));
    for (const p of acct().upserts) expect(ok.has(p.externalId), p.externalId).toBe(true);

    const keen = acct().profiles.get(consenting)!;
    expect(keen).toMatchObject({ email: 'keen.guest@example.com', phone: null, consents: { marketingEmail: true, marketingSms: false } });
    expect(keen.properties).toMatchObject({ order_count: expect.any(Number) });
    const sms = acct().profiles.get(smsOnly)!;
    expect(sms).toMatchObject({ email: null, phone: '+61400333444', consents: { marketingEmail: false, marketingSms: true } });

    // The guest who never ticked a box: nothing at all, not a profile, an event or a suppression.
    const everything = JSON.stringify([acct().upserts, acct().events, acct().pushed]);
    expect(everything).not.toContain('no.box@example.com');
    expect(everything).not.toContain(noConsent);
    // The guest who opted out went only as a suppression, to keep them unsubscribed there too.
    expect(acct().pushed).toContainEqual(expect.objectContaining({ channel: 'email', value: 'lapsed@example.com', reason: 'unsubscribed' }));
  });

  it('a replayed sync pushes nothing new', async () => {
    const before = { upserts: acct().upserts.length, events: acct().events.length, pushed: acct().pushed.length };
    const r = await sync();
    await sync();
    await drainJobs(t.app);
    expect(r).toMatchObject({ status: 'done', profilesPushed: 0, eventsPushed: 0, suppressionsPushed: 0 });
    expect({ upserts: acct().upserts.length, events: acct().events.length, pushed: acct().pushed.length }).toEqual(before);
  });

  it('orders and points go as events with idempotency keys, only for consenting guests', async () => {
    t.clock.advanceMinutes(5);
    const a = await sale(t, diner(), { venueId: diner().venueId, customerId: consenting, channel: 'pickup' });
    const b = await sale(t, diner(), { venueId: diner().venueId, customerId: noConsent });
    t.clock.advanceMinutes(1);
    await sync();
    await sync();
    const mine = acct().events.filter((e) => e.properties.transaction_id === a.transaction.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: 'Placed Order', profileExternalId: consenting, idempotencyKey: `ros:txn:${a.transaction.id}` });
    expect(acct().events.some((e) => e.properties.transaction_id === b.transaction.id)).toBe(false);
    // The profile's order count moved, so the profile was pushed again, once.
    expect(acct().profiles.get(consenting)!.properties!.order_count).toBeGreaterThanOrEqual(1);
  });

  it('an unsubscribe on the platform withdraws consent and suppresses here', async () => {
    t.clock.advanceMinutes(1);
    t.sim.esp.platformUnsubscribe(DINER_ACCT, { channel: 'email', value: 'KEEN.guest@example.com', reason: 'unsubscribed' });
    t.clock.advanceMinutes(1);
    const r = await sync();
    expect(r.suppressionsPulled).toBe(1);
    const consent = await t.db.selectFrom('consents').select(['status', 'source']).where('customer_id', '=', consenting).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow();
    expect(consent).toEqual({ status: 'revoked', source: 'esp_unsubscribe' });
    const sup = await t.db.selectFrom('suppressions').select('reason').where('org_id', '=', diner().orgId).where('value', '=', 'keen.guest@example.com').executeTakeFirstOrThrow();
    expect(sup.reason).toBe('unsubscribed');
    // Not echoed back to the platform it came from.
    expect(acct().pushed.filter((p) => p.value === 'keen.guest@example.com')).toHaveLength(0);
    // Pulled again: applied once.
    const again = await sync();
    expect(again.suppressionsPulled).toBe(0);
    const events = await t.db.selectFrom('consent_events').select('id').where('customer_id', '=', consenting).where('action', '=', 'revoked').execute();
    expect(events).toHaveLength(1);
  });

  it('a conflict resolves to "not consented": the platform says unsubscribed, here says consented', async () => {
    const both = await guest(t, diner(), { email: 'conflict@example.com', consents: ['marketing_email'] });
    t.clock.advanceMinutes(1);
    await sync();
    expect(acct().profiles.get(both)?.consents.marketingEmail).toBe(true);
    t.sim.esp.platformUnsubscribe(DINER_ACCT, { channel: 'email', value: 'conflict@example.com', reason: 'complained' });
    t.clock.advanceMinutes(1);
    await sync();
    const c = await t.db.selectFrom('consents').select('status').where('customer_id', '=', both).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow();
    expect(c.status).toBe('revoked');
    const sup = await t.db.selectFrom('suppressions').select('reason').where('org_id', '=', diner().orgId).where('value', '=', 'conflict@example.com').executeTakeFirstOrThrow();
    expect(sup.reason).toBe('complained');
  });

  it('an opt-out here reaches the platform promptly', async () => {
    const leaver = await guest(t, diner(), { email: 'leaver@example.com', consents: ['marketing_email'] });
    t.clock.advanceMinutes(1);
    await sync();
    expect(acct().profiles.get(leaver)?.consents.marketingEmail).toBe(true);
    t.clock.advanceMinutes(1);
    await revoke(t, diner(), leaver, 'marketing_email');
    // The consent change queued a sync; the worker runs it.
    await drainJobs(t.app);
    expect(acct().pushed).toContainEqual(expect.objectContaining({ channel: 'email', value: 'leaver@example.com', reason: 'unsubscribed' }));
    expect(acct().profiles.get(leaver)?.consents.marketingEmail).toBe(false);
    const n = acct().pushed.filter((p) => p.value === 'leaver@example.com').length;
    await sync();
    await drainJobs(t.app);
    expect(acct().pushed.filter((p) => p.value === 'leaver@example.com').length).toBe(n);
  });

  it('on the connected tier, marketing email is not sent natively but receipts are', async () => {
    const fan = await guest(t, diner(), { email: 'fan@example.com', consents: ['marketing_email'] });
    const offer = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.queueMessage(ctx, { templateKey: 'reach.offer', channel: 'email', customerId: fan, idempotencyKey: 'reach:offer:fan', variables: { name: 'Fan' } }));
    expect(offer).toMatchObject({ status: 'suppressed', reason: 'connected_platform' });
    const receipt = await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.queueMessage(ctx, { templateKey: 'reach.receipt', channel: 'email', customerId: fan, idempotencyKey: 'reach:receipt:fan', variables: { name: 'Fan' } }));
    expect(receipt.status).toBe('queued');
    await drainJobs(t.app);
    const sent = t.sim.email.sent.filter((m) => m.to === 'fan@example.com');
    expect(sent.map((m) => m.kind)).toEqual(['transactional']);
    const row = await t.db.selectFrom('messages').select(['status', 'error']).where('id', '=', offer.messageId).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'suppressed', error: 'connected_platform' });

    // The group org, whose platform is connected with tier "native", still sends natively? It chose connected too:
    // disconnecting puts marketing back on the native tier.
    const gOwner = await group().as('owner');
    await t.app.tenant(group().orgId, gOwner, (ctx) => comms.disconnectEmailPlatform(ctx, groupConnectionId));
    expect(await t.app.tenant(group().orgId, WORKER, (ctx) => comms.emailMarketingTier(ctx))).toBe('native');
    expect(await t.app.tenant(diner().orgId, WORKER, (ctx) => comms.emailMarketingTier(ctx))).toBe('connected');
  });

  it("another org's connection never receives this org's data", async () => {
    const dinerIds = new Set((await t.db.selectFrom('customers').select('id').where('org_id', '=', diner().orgId).execute()).map((c) => c.id));
    const groupIds = new Set((await t.db.selectFrom('customers').select('id').where('org_id', '=', group().orgId).execute()).map((c) => c.id));
    const g = t.sim.esp.account(GROUP_ACCT);
    expect(g.upserts.length).toBeGreaterThan(0);
    for (const p of g.upserts) {
      expect(groupIds.has(p.externalId)).toBe(true);
      expect(dinerIds.has(p.externalId)).toBe(false);
    }
    for (const p of acct().upserts) expect(dinerIds.has(p.externalId)).toBe(true);
    const gText = JSON.stringify([g.upserts, g.events, g.pushed]);
    for (const email of ['keen.guest@example.com', 'lapsed@example.com', 'leaver@example.com', 'fan@example.com']) expect(gText).not.toContain(email);
    // A connection id from another org is not found.
    const owner = await diner().as('owner');
    await expect(t.app.tenant(diner().orgId, owner, (ctx) => comms.requestEmailPlatformSync(ctx, groupConnectionId))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a platform outage marks the connection unhealthy and the next run recovers', async () => {
    t.sim.esp.failNext(1);
    await expect(sync()).rejects.toThrow();
    const bad = await t.db.selectFrom('connections').select(['status', 'last_error']).where('id', '=', connectionId).executeTakeFirstOrThrow();
    expect(bad.status).toBe('unhealthy');
    await sync();
    const good = await t.db.selectFrom('connections').select(['status', 'last_error']).where('id', '=', connectionId).executeTakeFirstOrThrow();
    expect(good).toEqual({ status: 'connected', last_error: null });
  });
});
