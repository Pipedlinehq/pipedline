import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { identity } from '@ros/modules';

const WORKER = { kind: 'worker' as const, job: 'test' };

describe('identity: who may withdraw a consent for a guest', () => {
  const t = useTestEnv();

  it('front-of-house staff withdraw on request; a kitchen role is refused and nothing changes', async () => {
    const org = t.fixture.diner.orgId;
    const guest = await t.app.tenant(org, WORKER, (ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'asks.to.stop@example.com' }], via: 'online-order' }));
    const id = guest.customerId!;
    await t.app.tenant(org, { kind: 'guest', customerId: id }, (ctx) => identity.grantConsent(ctx, { customerId: id, purpose: 'marketing_email', source: 'guest_account' }));
    const status = async () => (await t.db.selectFrom('consents').select('status').where('customer_id', '=', id).where('purpose', '=', 'marketing_email').executeTakeFirstOrThrow()).status;

    const kitchen = await t.fixture.diner.as('kitchen');
    await expect(t.app.tenant(org, kitchen, (ctx) => identity.revokeConsent(ctx, { customerId: id, purpose: 'marketing_email', source: 'staff_on_request' }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await status()).toBe('granted');

    const host = await t.fixture.diner.as('host');
    await t.app.tenant(org, host, (ctx) => identity.revokeConsent(ctx, { customerId: id, purpose: 'marketing_email', source: 'staff_on_request', sourceDetail: 'Asked at the counter' }));
    expect(await status()).toBe('revoked');
    const ev = await t.db.selectFrom('consent_events').select(['action', 'source', 'source_detail']).where('customer_id', '=', id).where('action', '=', 'revoked').executeTakeFirstOrThrow();
    expect(ev).toEqual({ action: 'revoked', source: 'staff_on_request', source_detail: 'Asked at the counter' });
  });
});
