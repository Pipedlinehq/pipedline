import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { drainJobs } from '@ros/core';
import { SIM_WEBHOOK_SECRET } from '@ros/adapters';
import { useTestEnv } from '@ros/testkit';
import { comms, identity } from '@ros/modules';

const WORKER = { kind: 'worker' as const, job: 'test' };
const ANON = { kind: 'anon' as const };

comms.defineTemplate({
  key: 'test.receipt',
  channel: 'email',
  kind: 'transactional',
  description: 'test',
  subject: 'Your receipt {{reference}}',
  body: 'Thanks {{name}}. Total {{total}}.',
  variables: z.object({ reference: z.string(), name: z.string(), total: z.string() }),
});
comms.defineTemplate({
  key: 'test.offer',
  channel: 'email',
  kind: 'marketing',
  description: 'test',
  subject: 'An offer from {{org_name}}',
  body: 'Hi {{name}}, come back this week.',
  variables: z.object({ name: z.string() }),
});
comms.defineTemplate({
  key: 'test.offer',
  channel: 'sms',
  kind: 'marketing',
  description: 'test',
  body: '{{org_name}}: come back this week.',
  variables: z.object({}),
});

describe('comms outbox', () => {
  const t = useTestEnv();
  const orgId = () => t.fixture.diner.orgId;
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) => t.app.tenant(orgId(), principal, fn);

  async function guest(email: string, opts: { phone?: string; email_ok?: boolean; sms_ok?: boolean } = {}) {
    const r = await tenant((ctx) =>
      identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: email }, ...(opts.phone ? [{ kind: 'phone' as const, value: opts.phone }] : [])], via: 'online-order', profile: { firstName: 'Tess' } }),
    );
    if (opts.email_ok) await tenant((ctx) => identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'marketing_email', source: 'checkout' }), ANON);
    if (opts.sms_ok) await tenant((ctx) => identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'marketing_sms', source: 'checkout' }), ANON);
    return r.customerId!;
  }

  async function verifiedMarketingIdentity() {
    const owner = await t.fixture.diner.as('owner');
    const existing = await t.db.selectFrom('sending_identities').select('id').where('org_id', '=', orgId()).where('channel', '=', 'email').executeTakeFirst();
    if (existing) return;
    const id = await tenant((ctx) => comms.addSendingIdentity(ctx, { channel: 'email', domain: 'mail.oak-diner.example', fromName: 'Oak Diner' }, { key: 'sim-email' }), owner);
    const sms = await tenant((ctx) => comms.addSendingIdentity(ctx, { channel: 'sms', smsSenderId: 'OAKDINER' }, { key: 'sim-sms' }), owner);
    await tenant((ctx) => comms.setSendingIdentityStatus(ctx, id.id, 'verified'));
    await tenant((ctx) => comms.setSendingIdentityStatus(ctx, sms.id, 'verified'));
  }

  it('nothing is sent from the request: a message is queued, then a worker sends it once', async () => {
    const q = await tenant((ctx) =>
      comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'Buyer@Example.com', idempotencyKey: 'receipt:1', variables: { reference: 'A1', name: 'Bea', total: '$59.00' } }),
    );
    expect(q.status).toBe('queued');
    expect(t.sim.email.sent).toHaveLength(0);

    const again = await tenant((ctx) =>
      comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'buyer@example.com', idempotencyKey: 'receipt:1', variables: { reference: 'A1', name: 'Bea', total: '$59.00' } }),
    );
    expect(again.messageId).toBe(q.messageId);

    await drainJobs(t.app);
    await drainJobs(t.app);
    const sent = t.sim.email.sent.filter((m) => m.to === 'buyer@example.com');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ subject: 'Your receipt A1', kind: 'transactional' });
    expect(sent[0]!.from.email).toBe('oak-diner@mail.rosplatform.test');
    expect(sent[0]!.body).toContain('Thanks Bea. Total $59.00.');

    const row = await t.db.selectFrom('messages').select(['status', 'rendered_body', 'provider_message_id']).where('id', '=', q.messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('sent');
    expect(row.rendered_body).toContain('Thanks Bea');
    expect(row.provider_message_id).toBe(sent[0]!.providerMessageId);
  });

  it('template variables are never treated as markup', async () => {
    await tenant((ctx) =>
      comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'xss@example.com', idempotencyKey: 'receipt:xss', variables: { reference: 'A2', name: '<script>alert(1)</script>', total: '$1' } }),
    );
    await drainJobs(t.app);
    const m = t.sim.email.lastTo('xss@example.com')!;
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
  });

  it('a marketing message needs the guest\'s consent; without it the message is recorded as suppressed, not sent', async () => {
    await verifiedMarketingIdentity();
    const no = await guest('no.consent@example.com');
    const r = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: no, idempotencyKey: 'offer:no', variables: { name: 'Tess' } }));
    expect(r).toMatchObject({ status: 'suppressed', reason: 'no_consent' });

    const yes = await guest('yes.consent@example.com', { email_ok: true });
    const ok = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: yes, idempotencyKey: 'offer:yes', variables: { name: 'Tess' } }));
    expect(ok.status).toBe('queued');
    await drainJobs(t.app);
    expect(t.sim.email.lastTo('no.consent@example.com')).toBeUndefined();
    const m = t.sim.email.lastTo('yes.consent@example.com')!;
    expect(m.from.email).toBe('hello@mail.oak-diner.example');
    expect(m.unsubscribeUrl).toMatch(/^http:\/\/oak-diner\.tables\.test\/u\//);
    expect(m.body).toContain('Unsubscribe:');
    expect(m.body).toContain('Sent by Oak Diner');
  });

  it('consent is checked again at send time', async () => {
    await verifiedMarketingIdentity();
    const id = await guest('changed.mind@example.com', { email_ok: true });
    const q = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: id, idempotencyKey: 'offer:changed', variables: { name: 'Tess' } }));
    await tenant((ctx) => identity.revokeConsent(ctx, { customerId: id, purpose: 'marketing_email', source: 'guest_account' }), { kind: 'guest', customerId: id });
    await drainJobs(t.app);
    expect(t.sim.email.lastTo('changed.mind@example.com')).toBeUndefined();
    const row = await t.db.selectFrom('messages').select(['status', 'error']).where('id', '=', q.messageId).executeTakeFirstOrThrow();
    expect(row.status).toBe('suppressed');
  });

  it('the unsubscribe link withdraws consent and suppresses the address in one step', async () => {
    await verifiedMarketingIdentity();
    const id = await guest('leaver@example.com', { email_ok: true });
    await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: id, idempotencyKey: 'offer:leaver', variables: { name: 'Tess' } }));
    await drainJobs(t.app);
    const token = t.sim.email.lastTo('leaver@example.com')!.unsubscribeUrl!.split('/u/')[1]!;

    expect(await comms.unsubscribeByToken(t.app, orgId(), `${token.split('.')[0]}.deadbeefdeadbeefdeadbeefdeadbeef`)).toEqual({ ok: false });
    // A token is only good at the org that issued it.
    expect(await comms.unsubscribeByToken(t.app, t.fixture.group.orgId, token)).toEqual({ ok: false });
    expect(await comms.unsubscribeByToken(t.app, orgId(), token)).toEqual({ ok: true });

    expect(await tenant((ctx) => identity.hasConsent(ctx, id, 'marketing_email'))).toBe(false);
    expect(await tenant((ctx) => comms.isSuppressed(ctx, 'email', 'leaver@example.com'))).toBe('unsubscribed');
    const next = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: id, idempotencyKey: 'offer:leaver:2', variables: { name: 'Tess' } }));
    expect(next.status).toBe('suppressed');
    // A receipt still reaches someone who only opted out of marketing.
    const receipt = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', customerId: id, idempotencyKey: 'receipt:leaver', variables: { reference: 'A9', name: 'Tess', total: '$10' } }));
    expect(receipt.status).toBe('queued');
  });

  it('a hard bounce from the provider suppresses the address for everything; a forged webhook is refused', async () => {
    await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'dead@example.com', idempotencyKey: 'receipt:dead', variables: { reference: 'B1', name: 'Dee', total: '$5' } }));
    await drainJobs(t.app);
    const sent = t.sim.email.lastTo('dead@example.com')!;
    const hook = t.sim.email.webhook(SIM_WEBHOOK_SECRET, [{ providerMessageId: sent.providerMessageId, event: 'bounced', hardBounce: true, eventId: 'evt-bounce-1' }]);

    await expect(comms.handleMessageWebhook(t.app, { adapterKey: 'sim-email', rawBody: hook.rawBody, headers: { 'x-sim-signature': 'forged' }, url: 'http://x/webhooks/sim-email' })).rejects.toMatchObject({ code: 'unauthenticated' });
    const first = await comms.handleMessageWebhook(t.app, { adapterKey: 'sim-email', ...hook, url: 'http://x/webhooks/sim-email' });
    expect(first).toEqual({ applied: 1, duplicates: 0, unmatched: 0 });
    const replay = await comms.handleMessageWebhook(t.app, { adapterKey: 'sim-email', ...hook, url: 'http://x/webhooks/sim-email' });
    expect(replay).toEqual({ applied: 0, duplicates: 1, unmatched: 0 });

    expect(await tenant((ctx) => comms.isSuppressed(ctx, 'email', 'dead@example.com'))).toBe('bounced_hard');
    const blocked = await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'dead@example.com', idempotencyKey: 'receipt:dead:2', variables: { reference: 'B2', name: 'Dee', total: '$5' } }));
    expect(blocked.status).toBe('suppressed');
    const events = await t.db.selectFrom('message_events as e').innerJoin('messages as m', 'm.id', 'e.message_id').select('e.event').where('m.to_address', '=', 'dead@example.com').orderBy('e.occurred_at').execute();
    expect(events.map((e) => e.event)).toEqual(['sent', 'bounced']);
  });

  it('a provider outage is retried with the same key and the guest gets one message', async () => {
    t.sim.email.failNext(2);
    await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.receipt', channel: 'email', to: 'retry@example.com', idempotencyKey: 'receipt:retry', variables: { reference: 'C1', name: 'Rae', total: '$7' } }));
    let r = await drainJobs(t.app);
    expect(r.failed).toBeGreaterThan(0);
    expect(t.sim.email.lastTo('retry@example.com')).toBeUndefined();
    t.clock.advanceMinutes(60);
    r = await drainJobs(t.app);
    t.clock.advanceMinutes(60);
    await drainJobs(t.app);
    expect(t.sim.email.sent.filter((m) => m.to === 'retry@example.com')).toHaveLength(1);
  });

  it('marketing SMS waits for the end of quiet hours', async () => {
    await verifiedMarketingIdentity();
    const id = await guest('night.owl@example.com', { phone: '0400 555 001', sms_ok: true });
    t.clock.set('2026-10-02T11:30:00Z'); // 21:30 in Sydney
    await tenant((ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'sms', customerId: id, idempotencyKey: 'sms:night', variables: {} }));
    await drainJobs(t.app);
    expect(t.sim.sms.lastTo('+61400555001')).toBeUndefined();
    t.clock.set('2026-10-02T23:05:00Z'); // 09:05 next morning
    await drainJobs(t.app);
    const m = t.sim.sms.lastTo('+61400555001')!;
    expect(m.body).toContain('Reply STOP to opt out.');
    expect(m.from.smsSenderId).toBe('OAKDINER');
  });

  it('a venue cannot mark its own sending domain verified', async () => {
    const owner = await t.fixture.group.as('owner');
    const id = await t.app.tenant(t.fixture.group.orgId, owner, (ctx) => comms.addSendingIdentity(ctx, { channel: 'email', domain: 'mail.oak-group.example', fromName: 'Oak Group' }, { key: 'sim-email' }));
    await expect(t.app.tenant(t.fixture.group.orgId, owner, (ctx) => comms.setSendingIdentityStatus(ctx, id.id, 'verified'))).rejects.toMatchObject({ code: 'forbidden' });
    // Without a verified identity, marketing fails closed rather than going out on the platform's domain.
    const g = await t.app.tenant(t.fixture.group.orgId, WORKER, (ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'group.guest@example.com' }], via: 'online-order' }));
    await t.app.tenant(t.fixture.group.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId: g.customerId!, purpose: 'marketing_email', source: 'checkout' }));
    const q = await t.app.tenant(t.fixture.group.orgId, WORKER, (ctx) => comms.queueMessage(ctx, { templateKey: 'test.offer', channel: 'email', customerId: g.customerId!, idempotencyKey: 'offer:group', variables: { name: 'G' } }));
    await drainJobs(t.app);
    expect(t.sim.email.lastTo('group.guest@example.com')).toBeUndefined();
    const row = await t.db.selectFrom('messages').select(['status', 'error']).where('id', '=', q.messageId).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'failed', error: 'no_verified_sending_identity' });
  });
});
