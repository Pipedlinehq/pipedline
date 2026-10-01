import { randomUUID } from 'node:crypto';
import type { AgentPrincipal, CanonicalTransaction, IdentityHint, StaffPrincipal } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { identity, ledger } from '@ros/modules';

export const WORKER = { kind: 'worker' as const, job: 'test' };
export const ANON = { kind: 'anon' as const };

export type Purpose = 'marketing_email' | 'marketing_sms' | 'ad_platform_sharing' | 'card_recognition';

/** A guest the way checkout makes one: resolved by email (and phone), with the boxes they ticked. */
export async function guest(t: TestEnv, org: FixtureOrg, opts: { email: string; phone?: string; firstName?: string; lastName?: string; consents?: Purpose[] }): Promise<string> {
  const hints: IdentityHint[] = [{ kind: 'email', value: opts.email }, ...(opts.phone ? [{ kind: 'phone' as const, value: opts.phone }] : [])];
  const r = await t.app.tenant(org.orgId, WORKER, (ctx) =>
    identity.resolveCustomer(ctx, { hints, via: 'online-order', profile: { firstName: opts.firstName ?? 'Tess', lastName: opts.lastName ?? 'Tester' } }),
  );
  for (const purpose of opts.consents ?? []) {
    await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId: r.customerId!, purpose, source: 'checkout' }));
  }
  return r.customerId!;
}

export async function revoke(t: TestEnv, org: FixtureOrg, customerId: string, purpose: Purpose): Promise<void> {
  await t.app.tenant(org.orgId, { kind: 'guest', customerId }, (ctx) => identity.revokeConsent(ctx, { customerId, purpose, source: 'guest_account' }));
}

export interface SaleOpts {
  venueId: string;
  customerId?: string | null;
  externalRef?: string;
  totalCents?: number;
  status?: CanonicalTransaction['status'];
  refundedCents?: number;
  channel?: CanonicalTransaction['channel'];
  source?: CanonicalTransaction['source'];
  hints?: IdentityHint[];
  orderId?: string | null;
}

/** A sale entering the ledger, as POS ingest would record it. */
export async function sale(t: TestEnv, org: FixtureOrg, o: SaleOpts) {
  const total = o.totalCents ?? 5900;
  const txn: CanonicalTransaction = {
    source: o.source ?? 'sim',
    externalRef: o.externalRef ?? `reach_${randomUUID()}`,
    occurredAt: t.clock(),
    channel: o.channel ?? 'dine-in',
    status: o.status ?? 'completed',
    subtotalCents: total,
    discountCents: 0,
    taxCents: Math.round(total / 11),
    tipCents: 0,
    totalCents: total,
    refundedCents: o.refundedCents ?? 0,
    currency: 'AUD',
    orderId: o.orderId ?? null,
    lines: [{ lineNo: 1, name: 'Brisket plate', qty: 1, unitPriceCents: total, modifiers: [], discountCents: 0, taxCents: Math.round(total / 11), totalCents: total } as never],
    identityHints: o.hints ?? [],
    raw: { note: 'test' },
  };
  const r = await t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, txn, { venueId: o.venueId, customerId: o.customerId ?? null, via: 'pos' }));
  return { ...r, txn };
}

export function agentOf(staff: StaffPrincipal, scopes: string[], canWrite = true): AgentPrincipal {
  return { kind: 'agent', keyId: randomUUID(), staff, scopes, venueIds: null, canWrite };
}

export async function jobCount(t: TestEnv, orgId: string, kind: string): Promise<number> {
  const r = await t.db.selectFrom('jobs').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', orgId).where('kind', '=', kind).executeTakeFirstOrThrow();
  return Number(r.n);
}
