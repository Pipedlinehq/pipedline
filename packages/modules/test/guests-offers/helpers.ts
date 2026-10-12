import { randomUUID } from 'node:crypto';
import { type CanonicalTransaction, type Principal, json } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { identity, ledger } from '@ros/modules';
import type { DraftOrder } from '@ros/modules/ordering';

export const WORKER: Principal = { kind: 'worker', job: 'test' };
export const ANON: Principal = { kind: 'anon' };
export const guestOf = (customerId: string): Principal => ({ kind: 'guest', customerId });

let n = 0;
export const unique = (prefix: string) => `${prefix}-${++n}-${randomUUID().slice(0, 8)}`;

export interface TestGuest {
  customerId: string;
  email: string;
  phone: string | null;
  firstName: string;
}

/** A guest known to the org. Consent is given by the guest (anon checkout), as it must be. */
export async function newGuest(t: TestEnv, org: FixtureOrg, o: { firstName?: string; phone?: boolean; emailConsent?: boolean; smsConsent?: boolean; venueId?: string; source?: string; suburb?: string } = {}): Promise<TestGuest> {
  const email = `${unique('g')}@lists.example`;
  const phone = o.phone ? `+6148${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` : null;
  const firstName = o.firstName ?? 'Ava';
  const r = await t.app.tenant(org.orgId, WORKER, (ctx) =>
    identity.resolveCustomer(ctx, {
      hints: [{ kind: 'email', value: email }, ...(phone ? [{ kind: 'phone' as const, value: phone }] : [])],
      via: 'online-order',
      venueId: o.venueId ?? org.venueId,
      profile: { firstName, lastName: 'Tester' },
      acquisition: o.source ? { source: o.source } : undefined,
    }),
  );
  const customerId = r.customerId!;
  if (o.emailConsent) await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId, purpose: 'marketing_email', source: 'checkout' }));
  if (o.smsConsent) await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId, purpose: 'marketing_sms', source: 'checkout' }));
  if (o.suburb) {
    const manager = await org.as('manager');
    await t.app.tenant(org.orgId, manager, (ctx) => identity.updateCustomer(ctx, customerId, { suburb: o.suburb! }));
  }
  return { customerId, email, phone, firstName };
}

/** A till sale by a known guest. */
export function sale(t: TestEnv, over: Partial<CanonicalTransaction> & { cents?: number; at?: Date } = {}): CanonicalTransaction {
  const { cents = 5900, at, ...rest } = over;
  const discount = rest.discountCents ?? 0;
  return {
    source: 'sim',
    externalRef: unique('sale'),
    occurredAt: at ?? t.clock(),
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
    lines: [{ lineNo: 1, name: 'Steak frites', category: 'Mains', qty: 1, unitPriceCents: cents, modifiers: [], discountCents: 0, taxCents: Math.round(cents / 11), totalCents: cents }],
    identityHints: [],
    ...rest,
  };
}

export async function record(t: TestEnv, org: FixtureOrg, customerId: string | null, over: Partial<CanonicalTransaction> & { cents?: number; at?: Date } = {}, venueId?: string) {
  return t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, sale(t, over), { venueId: venueId ?? org.venueId, customerId: customerId ?? undefined }));
}

/** A no-show on the record, as the bookings module would leave it (test-only direct write). */
export async function noShow(t: TestEnv, org: FixtureOrg, customerId: string, at?: Date): Promise<void> {
  await t.db
    .insertInto('events')
    .values({ org_id: org.orgId, venue_id: org.venueId, customer_id: customerId, name: 'booking.no_show', occurred_at: at ?? t.clock(), source: 'server', properties: json({ booking_id: randomUUID(), party_size: 2 }) })
    .execute();
}

/** A draft order as ordering hands it to the adjusters: two mains and a drink. */
export function draft(org: FixtureOrg, at: Date, over: Partial<DraftOrder> = {}): DraftOrder {
  const lines = over.lines ?? [
    { menuItemId: randomUUID(), name: 'Wagyu rump', category: 'Mains', qty: 1, unitPriceCents: 4800, lineTotalCents: 4800, isAlcohol: false },
    { menuItemId: randomUUID(), name: 'Barramundi', category: 'Mains', qty: 1, unitPriceCents: 3600, lineTotalCents: 3600, isAlcohol: false },
    { menuItemId: randomUUID(), name: 'Lemonade', category: 'Drinks', qty: 2, unitPriceCents: 600, lineTotalCents: 1200, isAlcohol: false },
  ];
  return { venueId: org.venueId, channel: 'pickup', customerId: null, lines, subtotalCents: lines.reduce((s, l) => s + l.lineTotalCents, 0), at, ...over };
}

export async function auditRows(t: TestEnv, orgId: string, action: string, entityId?: string) {
  let q = t.db.selectFrom('audit_log').select(['actor_kind', 'actor_id', 'action', 'entity_id', 'before', 'after', 'venue_id']).where('org_id', '=', orgId).where('action', '=', action);
  if (entityId) q = q.where('entity_id', '=', entityId);
  return q.execute();
}

/** Wednesday 30 September 2026, 19:00 in Sydney: dinner service at every fixture venue. */
export const DINNER_WED = new Date('2026-09-30T09:00:00.000Z');
/** Sunday 4 October 2026, 12:30 in Sydney: lunch, a Sunday. */
export const LUNCH_SUN = new Date('2026-10-04T02:30:00.000Z');
/** Christmas Day 2026, 12:30 in Sydney. */
export const CHRISTMAS = new Date('2026-12-25T01:30:00.000Z');
