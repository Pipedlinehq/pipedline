import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import type { CanonicalTransaction } from '@ros/core';
import { useTestEnv } from '@ros/testkit';
import { identity, ledger } from '@ros/modules';

const WORKER = { kind: 'worker' as const, job: 'test' };

function sale(ref: string, over: Partial<CanonicalTransaction> = {}): CanonicalTransaction {
  return {
    source: 'sim',
    externalRef: ref,
    occurredAt: new Date('2026-09-29T09:30:00Z'),
    channel: 'dine-in',
    status: 'completed',
    subtotalCents: 5900,
    discountCents: 0,
    taxCents: 536,
    tipCents: 0,
    totalCents: 5900,
    refundedCents: 0,
    currency: 'AUD',
    tenderType: 'card',
    lines: [
      { lineNo: 1, name: 'Wagyu rump 250g', category: 'Mains', qty: 1, unitPriceCents: 4800, modifiers: [{ name: 'Medium rare', priceCents: 0 }], discountCents: 0, taxCents: 436, totalCents: 4800 },
      { lineNo: 2, name: 'Fries, aioli', category: 'Sides', qty: 1, unitPriceCents: 1100, modifiers: [], discountCents: 0, taxCents: 100, totalCents: 1100 },
    ],
    identityHints: [],
    raw: { id: ref, card_details: { card: { brand: 'VISA', last_4: '4242', fingerprint: 'sq0idp-secret-fp', payment_account_reference: 'PAR123' } }, nested: [{ par: 'x' }] },
    ...over,
  };
}

describe('ledger', () => {
  const t = useTestEnv();
  const tenant = <T>(fn: Parameters<typeof t.app.tenant<T>>[2]) => t.app.tenant(t.fixture.diner.orgId, WORKER, fn);
  const venueId = () => t.fixture.diner.venueId;

  it('records a sale once however many times it is delivered', async () => {
    const first = await tenant((ctx) => ledger.recordTransaction(ctx, sale('idem-1'), { venueId: venueId() }));
    const again = await tenant((ctx) => ledger.recordTransaction(ctx, sale('idem-1'), { venueId: venueId() }));
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, changed: false });
    expect(again.transaction.id).toBe(first.transaction.id);
    const rows = await t.db.selectFrom('transactions').select('id').where('external_ref', '=', 'idem-1').execute();
    expect(rows).toHaveLength(1);
    const lines = await t.db.selectFrom('transaction_lines').select('line_no').where('transaction_id', '=', first.transaction.id).execute();
    expect(lines).toHaveLength(2);
    const events = await t.db.selectFrom('events').select('id').where('name', '=', 'transaction.recorded').where(sql`properties->>'transaction_id'`, '=', first.transaction.id).execute();
    expect(events).toHaveLength(1);
  });

  it('strips card identifiers from the stored payload and keeps the rest', async () => {
    const r = await tenant((ctx) => ledger.recordTransaction(ctx, sale('strip-1'), { venueId: venueId() }));
    const row = await t.db.selectFrom('transactions').select('raw').where('id', '=', r.transaction.id).executeTakeFirstOrThrow();
    expect(row.raw).toEqual({ id: 'strip-1', card_details: { card: { brand: 'VISA', last_4: '4242' } }, nested: [{}] });
  });

  it('the database refuses a payload that still carries a card identifier', async () => {
    await expect(
      t.db
        .insertInto('transactions')
        .values({ org_id: t.fixture.diner.orgId, venue_id: venueId(), occurred_at: new Date(), source: 'sim', external_ref: 'bypass', channel: 'dine-in', total_cents: 100, raw: JSON.stringify({ card: { fingerprint: 'abc' } }) })
        .execute(),
    ).rejects.toThrow(/raw_has_no_card_identifier/);
  });

  it('updates the same row when a refund arrives later', async () => {
    const r = await tenant((ctx) => ledger.recordTransaction(ctx, sale('refund-1'), { venueId: venueId() }));
    const refunded = await tenant((ctx) => ledger.recordTransaction(ctx, sale('refund-1', { status: 'refunded', refundedCents: 5900 }), { venueId: venueId() }));
    expect(refunded).toMatchObject({ created: false, changed: true });
    const row = await t.db.selectFrom('transactions').select(['status', 'refunded_cents']).where('id', '=', r.transaction.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'refunded', refunded_cents: 5900 });
    const ev = await t.db.selectFrom('events').select('properties').where('name', '=', 'transaction.refunded').where(sql`properties->>'transaction_id'`, '=', r.transaction.id).execute();
    expect(ev).toHaveLength(1);
  });

  it('ties a sale to a customer from an email on the payment and attributes it to the creator who brought them', async () => {
    const guest = await tenant((ctx) =>
      identity.resolveCustomer(ctx, { hints: [{ kind: 'email', value: 'attributed@example.com' }], via: 'online-order', acquisition: { source: 'criota', creatorId: 'creator_x', campaignId: 'camp_x' } }),
    );
    const r = await tenant((ctx) => ledger.recordTransaction(ctx, sale('attr-1', { identityHints: [{ kind: 'email', value: 'Attributed@example.com' }] }), { venueId: venueId() }));
    expect(r.transaction.customerId).toBe(guest.customerId);
    const attr = await t.db.selectFrom('transaction_attributions').select(['model', 'creator_id', 'campaign_id', 'channel']).where('transaction_id', '=', r.transaction.id).execute();
    expect(attr).toEqual([{ model: 'acquisition', creator_id: 'creator_x', campaign_id: 'camp_x', channel: 'criota' }]);
  });

  it('an anonymous tap stays anonymous', async () => {
    const r = await tenant((ctx) => ledger.recordTransaction(ctx, sale('anon-1', { identityHints: [{ kind: 'card_fingerprint', value: 'never-seen' }, { kind: 'card_par', value: 'never-seen-par' }] }), { venueId: venueId() }));
    expect(r.transaction.customerId).toBeNull();
  });

  it('calls module hooks on create and on change, not on a plain replay', async () => {
    const seen: string[] = [];
    ledger.onTransactionRecorded(async (_ctx, txn, info) => {
      if (txn.externalRef === 'hook-1') seen.push(`${info.created ? 'created' : 'changed'}:${txn.status}`);
    });
    await tenant((ctx) => ledger.recordTransaction(ctx, sale('hook-1'), { venueId: venueId() }));
    await tenant((ctx) => ledger.recordTransaction(ctx, sale('hook-1'), { venueId: venueId() }));
    await tenant((ctx) => ledger.recordTransaction(ctx, sale('hook-1', { status: 'partially_refunded', refundedCents: 1100 }), { venueId: venueId() }));
    expect(seen).toEqual(['created:completed', 'changed:partially_refunded']);
  });

  it('rejects fractional cents', async () => {
    await expect(tenant((ctx) => ledger.recordTransaction(ctx, sale('bad-1', { totalCents: 59.5 }), { venueId: venueId() }))).rejects.toMatchObject({ code: 'invalid' });
  });

  it('the seeded history is internally consistent: every sale\'s lines add up to its subtotal', async () => {
    const bad = await sql<{ n: number }>`
      select count(*)::int as n from transactions t
      where t.org_id = ${t.fixture.diner.orgId} and t.external_ref like 'fx-%'
        and t.subtotal_cents <> (select coalesce(sum(l.total_cents), 0) from transaction_lines l where l.transaction_id = t.id)`.execute(t.db);
    expect(bad.rows[0]!.n).toBe(0);
    const totals = await sql<{ n: number; identified: number }>`
      select count(*)::int as n, count(customer_id)::int as identified from transactions where org_id = ${t.fixture.diner.orgId} and external_ref like 'fx-%'`.execute(t.db);
    expect(totals.rows[0]!.n).toBeGreaterThan(2500);
    expect(totals.rows[0]!.identified).toBeGreaterThan(500);
    expect(totals.rows[0]!.identified).toBeLessThan(totals.rows[0]!.n);
  });

  it('read access follows venue roles: a manager of two venues cannot list the third', async () => {
    const group = t.fixture.group;
    const manager = await group.as('manager');
    const visible = await t.app.tenant(group.orgId, manager, (ctx) => ledger.listTransactions(ctx, { limit: 200 }));
    const venues = new Set(visible.map((v) => v.venueId));
    expect(venues.has(group.venues.bondi!.id)).toBe(false);
    await expect(t.app.tenant(group.orgId, manager, (ctx) => ledger.listTransactions(ctx, { venueId: group.venues.bondi!.id }))).rejects.toMatchObject({ code: 'not_found' });
  });
});
