import { describe, expect, it } from 'vitest';
import { useTestEnv } from '@ros/testkit';
import { identity } from '@ros/modules';

const WORKER = { kind: 'worker' as const, job: 'test' };
const ANON = { kind: 'anon' as const };

describe('identity', () => {
  const t = useTestEnv();
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2], principal: Parameters<typeof t.app.tenant>[1] = WORKER) =>
    t.app.tenant(t.fixture.diner.orgId, principal, fn);

  it('creates a customer from an email, then finds the same one by phone once both are known', async () => {
    const a = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: ' New.Guest@Example.COM ' }], via: 'online-order' }));
    expect(a.created).toBe(true);
    const b = await tenant((ctx) =>
      identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'new.guest@example.com' }, { kind: 'phone', value: '0412 345 678' }], via: 'loyalty' }),
    );
    expect(b).toMatchObject({ customerId: a.customerId, created: false });
    const c = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'phone', value: '+61412345678' }], via: 'pos' }));
    expect(c.customerId).toBe(a.customerId);
  });

  it('merges two records when one action proves they are the same person; the older record wins', async () => {
    const first = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'merge.me@example.com' }], via: 'online-order', profile: { firstName: 'Mina' } }));
    t.clock.advanceMinutes(5);
    const second = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'phone', value: '0498 111 222' }], via: 'pos', profile: { lastName: 'Merge' } }));
    expect(second.customerId).not.toBe(first.customerId);

    const joined = await tenant((ctx) =>
      identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'merge.me@example.com' }, { kind: 'phone', value: '0498111222' }], via: 'guest_login' }),
    );
    expect(joined.customerId).toBe(first.customerId);
    expect(joined.mergedFrom).toEqual([second.customerId]);

    const loser = await t.db.selectFrom('customers').select(['status', 'merged_into_id']).where('id', '=', second.customerId!).executeTakeFirstOrThrow();
    expect(loser).toEqual({ status: 'merged', merged_into_id: first.customerId });
    const winner = await t.db.selectFrom('customers').select(['first_name', 'last_name', 'primary_phone']).where('id', '=', first.customerId!).executeTakeFirstOrThrow();
    expect(winner).toEqual({ first_name: 'Mina', last_name: 'Merge', primary_phone: '+61498111222' });
    const merges = await t.db.selectFrom('customer_merges').select('loser_customer_id').where('winner_customer_id', '=', first.customerId!).execute();
    expect(merges).toHaveLength(1);
  });

  it('stamps acquisition once and records later campaigns as touches', async () => {
    const created = await tenant((ctx) =>
      identity.resolveCustomer(ctx, {
        hints: [{ kind: 'email', value: 'stamp@example.com' }],
        via: 'online-order',
        acquisition: { source: 'criota', creatorId: 'creator_a', campaignId: 'camp_1' },
      }),
    );
    await tenant((ctx) =>
      identity.resolveCustomer(ctx, {
        hints: [{ kind: 'email', value: 'stamp@example.com' }],
        via: 'online-order',
        acquisition: { source: 'meta', campaignId: 'camp_2' },
      }),
    );
    const c = await t.db.selectFrom('customers').select(['acquisition_source', 'acquisition_creator_id', 'acquisition_campaign_id']).where('id', '=', created.customerId!).executeTakeFirstOrThrow();
    expect(c).toEqual({ acquisition_source: 'criota', acquisition_creator_id: 'creator_a', acquisition_campaign_id: 'camp_1' });
    const touches = await t.db.selectFrom('customer_touchpoints').select(['channel', 'campaign_id']).where('customer_id', '=', created.customerId!).execute();
    expect(touches).toEqual([{ channel: 'meta', campaign_id: 'camp_2' }]);
  });

  it('the database itself refuses to change an acquisition stamp', async () => {
    const c = await t.db.selectFrom('customers').select('id').where('org_id', '=', t.fixture.diner.orgId).where('status', '=', 'active').limit(1).executeTakeFirstOrThrow();
    await expect(t.db.updateTable('customers').set({ acquisition_source: 'rewritten' }).where('id', '=', c.id).execute()).rejects.toThrow(/write-once/);
  });

  it('a card alone never creates a customer, and is not stored without consent', async () => {
    const r = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'card_fingerprint', value: 'raw-fp-unknown' }], via: 'pos' }));
    expect(r.customerId).toBeNull();

    const guest = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'nocard@example.com' }, { kind: 'card_fingerprint', value: 'raw-fp-1' }], via: 'pos' }));
    const ids = await t.db.selectFrom('customer_identities').select('kind').where('customer_id', '=', guest.customerId!).execute();
    expect(ids.map((i) => i.kind)).toEqual(['email']);
  });

  it('with the card box ticked the card is linked as a per-org hash, recognised later, and deleted on withdrawal', async () => {
    const guest = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'card.ok@example.com' }], via: 'online-order' }));
    await tenant((ctx) => identity.grantConsent(ctx, { customerId: guest.customerId!, purpose: 'card_recognition', source: 'checkout' }), ANON);
    const added = await tenant((ctx) => identity.linkCard(ctx, guest.customerId!, [{ kind: 'card_fingerprint', value: 'raw-fp-42' }, { kind: 'card_par', value: 'raw-par-42' }], 'online-order'));
    expect(added).toBe(2);

    const stored = await t.db.selectFrom('customer_identities').select(['kind', 'value']).where('customer_id', '=', guest.customerId!).where('kind', '!=', 'email').execute();
    expect(stored).toHaveLength(2);
    for (const s of stored) expect(s.value).toMatch(/^[0-9a-f]{64}$/);

    const byCard = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'card_par', value: 'raw-par-42' }], via: 'pos' }));
    expect(byCard.customerId).toBe(guest.customerId);

    // The same card at another org is a different, unrelated value: no cross-venue join is possible.
    const here = await identity.hashCardIdentifier(t.app, t.fixture.diner.orgId, 'card_par', 'raw-par-42');
    const there = await identity.hashCardIdentifier(t.app, t.fixture.group.orgId, 'card_par', 'raw-par-42');
    expect(here).not.toBe(there);
    const elsewhere = await t.app.tenant(t.fixture.group.orgId, WORKER, (ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'card_par', value: 'raw-par-42' }], via: 'pos' }));
    expect(elsewhere.customerId).toBeNull();

    await tenant((ctx) => identity.revokeConsent(ctx, { customerId: guest.customerId!, purpose: 'card_recognition', source: 'guest_account' }), { kind: 'guest', customerId: guest.customerId! });
    const after = await t.db.selectFrom('customer_identities').select('kind').where('customer_id', '=', guest.customerId!).execute();
    expect(after.map((i) => i.kind)).toEqual(['email']);
    const gone = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'card_par', value: 'raw-par-42' }], via: 'pos' }));
    expect(gone.customerId).toBeNull();
  });

  it('staff cannot tick a consent box for a guest, and card recognition cannot be imported', async () => {
    const guest = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'consent.rules@example.com' }], via: 'online-order' }));
    const owner = await t.fixture.diner.as('owner');
    await expect(tenant((ctx) => identity.grantConsent(ctx, { customerId: guest.customerId!, purpose: 'marketing_email', source: 'console' }), owner)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      tenant((ctx) => identity.grantConsent(ctx, { customerId: guest.customerId!, purpose: 'card_recognition', source: 'import', sourceDetail: 'old list' })),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps a proof trail: every grant and withdrawal, with the wording version shown', async () => {
    const guest = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'trail@example.com' }], via: 'online-order' }));
    const g = { kind: 'guest' as const, customerId: guest.customerId! };
    await tenant((ctx) => identity.grantConsent(ctx, { customerId: guest.customerId!, purpose: 'marketing_email', source: 'guest_account' }), g);
    await tenant((ctx) => identity.revokeConsent(ctx, { customerId: guest.customerId!, purpose: 'marketing_email', source: 'guest_account' }), g);
    const trail = await t.db.selectFrom('consent_events').select(['action', 'wording_version']).where('customer_id', '=', guest.customerId!).orderBy('occurred_at').orderBy('action').execute();
    expect(trail).toEqual([{ action: 'granted', wording_version: 'v1' }, { action: 'revoked', wording_version: 'v1' }]);
    const state = await tenant((ctx) => identity.getConsents(ctx, guest.customerId!), g);
    expect(state.find((s) => s.purpose === 'marketing_email')?.granted).toBe(false);
  });

  it('a guest can read only their own record; another id is not found', async () => {
    const mine = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'mine@example.com' }], via: 'online-order' }));
    const theirs = await tenant((ctx) => identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'theirs@example.com' }], via: 'online-order' }));
    const me = { kind: 'guest' as const, customerId: mine.customerId! };
    await expect(tenant((ctx) => identity.getCustomer(ctx, mine.customerId!), me)).resolves.toMatchObject({ email: 'mine@example.com', notes: null });
    await expect(tenant((ctx) => identity.getCustomer(ctx, theirs.customerId!), me)).rejects.toMatchObject({ code: 'not_found' });
    await expect(tenant((ctx) => identity.getCustomer(ctx, mine.customerId!), ANON)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('kitchen staff cannot look guests up; front of house can', async () => {
    const kitchen = await t.fixture.diner.as('kitchen');
    const host = await t.fixture.diner.as('host');
    await expect(tenant((ctx) => identity.searchCustomers(ctx, { q: 'example' }), kitchen)).rejects.toMatchObject({ code: 'forbidden' });
    const found = await tenant((ctx) => identity.searchCustomers(ctx, { q: 'guests.oak-diner' }), host);
    expect(found.length).toBeGreaterThan(0);
  });

  it('erasing a guest removes who they are and keeps what was sold', async () => {
    const seeded = await t.db
      .selectFrom('transactions')
      .select(['customer_id'])
      .where('org_id', '=', t.fixture.diner.orgId)
      .where('customer_id', 'is not', null)
      .limit(1)
      .executeTakeFirstOrThrow();
    const id = seeded.customer_id!;
    const salesBefore = await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', t.fixture.diner.orgId).executeTakeFirstOrThrow();
    const owner = await t.fixture.diner.as('owner');

    const exported = await tenant((ctx) => identity.exportCustomer(ctx, id), owner);
    expect(exported).toHaveProperty('transactions');
    expect(JSON.stringify(exported)).not.toMatch(/[0-9a-f]{64}/);

    await tenant((ctx) => identity.eraseCustomer(ctx, id), owner);
    const c = await t.db.selectFrom('customers').select(['status', 'primary_email', 'first_name']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(c).toEqual({ status: 'deleted', primary_email: null, first_name: null });
    expect(await t.db.selectFrom('customer_identities').select('id').where('customer_id', '=', id).execute()).toEqual([]);
    expect(await t.db.selectFrom('consents').select('id').where('customer_id', '=', id).execute()).toEqual([]);
    const salesAfter = await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', t.fixture.diner.orgId).executeTakeFirstOrThrow();
    expect(Number(salesAfter.n)).toBe(Number(salesBefore.n));
  });
});
