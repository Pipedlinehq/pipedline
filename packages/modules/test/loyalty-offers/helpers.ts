import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { type CanonicalTransaction, type Principal, setModule } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { identity, ledger, loyalty, offers } from '@ros/modules';
import type { DraftOrder } from '@ros/modules/ordering';

export const WORKER: Principal = { kind: 'worker', job: 'test' };
export const ANON: Principal = { kind: 'anon' };
export const guestOf = (customerId: string): Principal => ({ kind: 'guest', customerId });

/**
 * Put an org's programme into a known state, whatever the fixtures seeded: modules on at every
 * venue with default config, one point per dollar rounded down, no bonuses, no expiry, no tiers.
 */
export async function resetProgram(t: TestEnv, org: FixtureOrg, over: Partial<Parameters<typeof loyalty.saveProgram>[1]> = {}): Promise<void> {
  await t.app.tenant(org.orgId, WORKER, async (ctx) => {
    for (const v of Object.values(org.venues)) {
      await setModule(ctx, loyalty.loyaltyModule, { venueId: v.id, enabled: true, config: loyalty.loyaltyModule.defaultConfig });
      await setModule(ctx, offers.offersModule, { venueId: v.id, enabled: true, config: offers.offersModule.defaultConfig });
    }
    const p = await loyalty.saveProgram(ctx, { name: 'Test Rewards', pointsPerDollar: 1, pointsRounding: 'floor', pointValueCents: 1, expiryPolicy: 'none', enrolmentBonus: 0, birthdayBonus: 0, ...over });
    for (const tier of p.tiers) await loyalty.deleteTier(ctx, tier.id);
  });
}

let n = 0;
export const unique = (prefix: string) => `${prefix}-${++n}-${randomUUID().slice(0, 8)}`;

export interface TestGuest {
  customerId: string;
  email: string;
  phone: string | null;
}

export async function newGuest(t: TestEnv, org: FixtureOrg, opts: { phone?: boolean; firstName?: string; marketingEmail?: boolean } = {}): Promise<TestGuest> {
  const email = `${unique('guest')}@loyalty.example`;
  const phone = opts.phone ? `+6149${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` : null;
  const r = await t.app.tenant(org.orgId, WORKER, (ctx) =>
    identity.resolveCustomer(ctx, {
      hints: [{ kind: 'email', value: email }, ...(phone ? [{ kind: 'phone' as const, value: phone }] : [])],
      via: 'online-order',
      profile: { firstName: opts.firstName ?? 'Tess', lastName: 'Tester' },
    }),
  );
  if (opts.marketingEmail) await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId: r.customerId!, purpose: 'marketing_email', source: 'checkout' }));
  return { customerId: r.customerId!, email, phone };
}

/** A guest who is already a member. Enrolled silently, as an import would. */
export async function newMember(t: TestEnv, org: FixtureOrg, opts: Parameters<typeof newGuest>[2] & { venueId?: string; enrolledAt?: Date } = {}): Promise<TestGuest & { accountId: string; memberCode: string }> {
  const g = await newGuest(t, org, opts);
  const e = await t.app.tenant(org.orgId, WORKER, (ctx) => loyalty.importMember(ctx, { customerId: g.customerId, venueId: opts.venueId ?? org.venueId, enrolledAt: opts.enrolledAt }));
  return { ...g, accountId: e.accountId, memberCode: e.memberCode };
}

/** A till sale. The subtotal is what the guest bought; a discount comes off it. */
export function sale(t: TestEnv, over: Partial<CanonicalTransaction> & { cents?: number } = {}): CanonicalTransaction {
  const { cents = 5900, ...rest } = over;
  const discount = rest.discountCents ?? 0;
  return {
    source: 'sim',
    externalRef: unique('sale'),
    occurredAt: t.clock(),
    channel: 'dine-in',
    status: 'completed',
    subtotalCents: cents,
    discountCents: discount,
    taxCents: Math.round((cents - discount) / 11),
    tipCents: 0,
    totalCents: cents - discount,
    refundedCents: 0,
    currency: 'AUD',
    tenderType: 'card',
    lines: [{ lineNo: 1, name: 'Wagyu rump 250g', category: 'Mains', qty: 1, unitPriceCents: cents, modifiers: [], discountCents: 0, taxCents: Math.round(cents / 11), totalCents: cents }],
    identityHints: [],
    ...rest,
  };
}

export async function record(t: TestEnv, org: FixtureOrg, txn: CanonicalTransaction, opts: { venueId?: string; customerId?: string | null } = {}) {
  return t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId: opts.venueId ?? org.venueId, customerId: opts.customerId }));
}

/** Give a member points the way they really arrive: a sale in the ledger. One point per dollar. */
export async function earn(t: TestEnv, org: FixtureOrg, member: TestGuest, points: number, venueId?: string) {
  return record(t, org, sale(t, { cents: points * 100, identityHints: [{ kind: 'email', value: member.email }] }), { venueId });
}

export async function balanceOf(t: TestEnv, accountId: string): Promise<number> {
  const r = await sql<{ b: number }>`select coalesce(sum(points), 0)::int as b from loyalty_transactions where account_id = ${accountId}`.execute(t.db);
  return r.rows[0]!.b;
}

export async function pointsRows(t: TestEnv, accountId: string) {
  return t.db.selectFrom('loyalty_transactions').select(['kind', 'points', 'source_transaction_id', 'redemption_id', 'idempotency_key', 'venue_id', 'staff_id', 'note']).where('account_id', '=', accountId).orderBy('created_at').orderBy('points', 'desc').execute();
}

/** An order row for the adjusters to commit against. The ordering module would have made it; here the test does. */
export async function makeOrder(t: TestEnv, org: FixtureOrg, opts: { venueId?: string; customerId?: string | null } = {}): Promise<string> {
  const row = await t.db
    .insertInto('orders')
    .values({ org_id: org.orgId, venue_id: opts.venueId ?? org.venueId, customer_id: opts.customerId ?? null, reference: unique('T').slice(0, 20), channel: 'pickup', status: 'placed', idempotency_key: unique('order') })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

export function draft(t: TestEnv, org: FixtureOrg, over: Partial<DraftOrder> = {}): DraftOrder {
  const subtotalCents = over.subtotalCents ?? 6000;
  return {
    venueId: org.venueId,
    channel: 'pickup',
    customerId: null,
    lines: [{ menuItemId: randomUUID(), name: 'Cheeseburger, pickles, fries', category: 'Mains', qty: 1, unitPriceCents: subtotalCents, lineTotalCents: subtotalCents, isAlcohol: false }],
    subtotalCents,
    at: t.clock(),
    ...over,
  };
}

export async function eventsNamed(t: TestEnv, orgId: string, name: string, where: Record<string, string> = {}) {
  let q = t.db.selectFrom('events').select(['properties', 'customer_id', 'venue_id', 'creator_id', 'campaign_id', 'code']).where('org_id', '=', orgId).where('name', '=', name);
  for (const [k, v] of Object.entries(where)) q = q.where(sql<string>`properties->>${k}`, '=', v);
  return q.execute();
}

export async function auditRows(t: TestEnv, orgId: string, action: string, entityId?: string) {
  let q = t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id', 'action', 'entity_id', 'before', 'after', 'venue_id']).where('org_id', '=', orgId).where('action', '=', action);
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.execute();
}
