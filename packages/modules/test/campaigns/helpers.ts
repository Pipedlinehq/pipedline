import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { AgentPrincipal, CanonicalTransaction, Principal, StaffPrincipal } from '@ros/core';
import type { FixtureOrg } from '@ros/fixtures';
import type { TestEnv } from '@ros/testkit';
import { campaigns, identity, ledger } from '@ros/modules';

export const WORKER: Principal = { kind: 'worker', job: 'test' };
export const ANON: Principal = { kind: 'anon' };
export const guestOf = (customerId: string): Principal => ({ kind: 'guest', customerId });

let n = 0;
export const unique = (prefix: string) => `${prefix}-${++n}-${randomUUID().slice(0, 8)}`;

export interface TestGuest {
  customerId: string;
  email: string | null;
  phone: string | null;
  firstName: string;
}

/**
 * A guest known to the org, first seen at a venue. Consent is given by the guest (anon checkout),
 * as it must be. Granting marketing consent enrols them in the welcome flow when it is on.
 */
export async function newGuest(
  t: TestEnv,
  org: FixtureOrg,
  o: { firstName?: string; email?: boolean; phone?: boolean; emailConsent?: boolean; smsConsent?: boolean; venueId?: string; tag?: string } = {},
): Promise<TestGuest> {
  const email = o.email === false ? null : `${unique('g')}@campaigns.example`;
  const phone = o.phone ? `+6147${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` : null;
  const firstName = o.firstName ?? 'Ava';
  const r = await t.app.tenant(org.orgId, WORKER, (ctx) =>
    identity.resolveCustomer(ctx, {
      hints: [...(email ? [{ kind: 'email' as const, value: email }] : []), ...(phone ? [{ kind: 'phone' as const, value: phone }] : [])],
      via: 'online-order',
      venueId: o.venueId ?? org.venueId,
      profile: { firstName, lastName: 'Tester' },
      acquisition: o.tag ? { source: 'meta', campaignId: o.tag } : undefined,
    }),
  );
  const customerId = r.customerId!;
  if (o.emailConsent) await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId, purpose: 'marketing_email', source: 'checkout' }));
  if (o.smsConsent) await t.app.tenant(org.orgId, ANON, (ctx) => identity.grantConsent(ctx, { customerId, purpose: 'marketing_sms', source: 'checkout' }));
  return { customerId, email, phone, firstName };
}

/** Clear a flow's slate for a test: every active enrolment cancelled, every waiting batch rejected. Test-only direct writes. */
export async function resetFlow(t: TestEnv, org: FixtureOrg, key: string): Promise<string> {
  const flow = await t.db.selectFrom('flows').select('id').where('org_id', '=', org.orgId).where('key', '=', key).executeTakeFirstOrThrow();
  await t.db.updateTable('flow_enrollments').set({ status: 'cancelled' }).where('flow_id', '=', flow.id).where('status', '=', 'active').execute();
  await t.db
    .updateTable('approvals')
    .set({ status: 'rejected' })
    .where('org_id', '=', org.orgId)
    .where('kind', '=', campaigns.FLOW_BATCH_APPROVAL)
    .where('status', '=', 'pending')
    .execute();
  return flow.id;
}

/** Put a guest straight into a flow, due now: a test-only shortcut for a guest the flow found earlier. */
export async function enrolDirect(t: TestEnv, org: FixtureOrg, flowId: string, customerId: string, venueId?: string): Promise<string> {
  const r = await t.db
    .insertInto('flow_enrollments')
    .values({ org_id: org.orgId, flow_id: flowId, customer_id: customerId, venue_id: venueId ?? org.venueId, step: 0, cycle: 1, status: 'active', next_at: new Date(t.clock().getTime() - 60_000), enrolled_at: new Date(t.clock().getTime() - 60_000) })
    .onConflict((oc) => oc.columns(['flow_id', 'customer_id']).doUpdateSet({ status: 'active', step: 0, next_at: new Date(t.clock().getTime() - 60_000) }))
    .returning('id')
    .executeTakeFirstOrThrow();
  return r.id;
}

export async function setMode(t: TestEnv, org: FixtureOrg, flowKey: campaigns.FlowKey, mode: 'off' | 'shadow' | 'supervised' | 'autonomous') {
  const owner = await org.as('owner');
  return t.app.tenant(org.orgId, owner, (ctx) => campaigns.setFlowMode(ctx, { flowKey, mode }));
}

export async function enrolment(t: TestEnv, flowId: string, customerId: string) {
  return t.db.selectFrom('flow_enrollments').select(['id', 'status', 'step', 'cycle', 'next_at', 'context', 'venue_id']).where('flow_id', '=', flowId).where('customer_id', '=', customerId).executeTakeFirst();
}

export async function messagesFor(t: TestEnv, customerId: string, where: { flowId?: string; campaignId?: string } = {}) {
  let q = t.db.selectFrom('messages').select(['id', 'status', 'error', 'template_key', 'channel', 'flow_id', 'campaign_id', 'venue_id', 'idempotency_key', 'rendered_body', 'subject']).where('customer_id', '=', customerId);
  if (where.flowId) q = q.where('flow_id', '=', where.flowId);
  if (where.campaignId) q = q.where('campaign_id', '=', where.campaignId);
  return q.execute();
}

export const sentTo = (t: TestEnv, address: string | null) => (address ? t.sim.email.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase()) : []);
export const smsTo = (t: TestEnv, phone: string | null) => (phone ? t.sim.sms.sent.filter((m) => m.to === phone) : []);

export async function pendingBatches(t: TestEnv, org: FixtureOrg, flowId?: string) {
  let q = t.db.selectFrom('approvals').select(['id', 'venue_id', 'subject_id', 'payload', 'summary', 'status', 'expires_at']).where('org_id', '=', org.orgId).where('kind', '=', campaigns.FLOW_BATCH_APPROVAL).where('status', '=', 'pending');
  if (flowId) q = q.where('subject_id', 'like', `${flowId}:%`);
  return q.execute();
}

export async function agentRuns(t: TestEnv, org: FixtureOrg, agentKey: string) {
  return t.db.selectFrom('agent_runs').select(['id', 'mode', 'status', 'summary', 'output', 'template_version', 'venue_id', 'trigger']).where('org_id', '=', org.orgId).where('agent_key', '=', agentKey).orderBy('started_at', 'desc').execute();
}

export function agentFor(staff: StaffPrincipal, opts: { canWrite?: boolean } = {}): AgentPrincipal {
  return { kind: 'agent', keyId: randomUUID(), staff, scopes: ['campaigns:write', 'campaigns:read'], venueIds: null, canWrite: opts.canWrite ?? true };
}

/** A till sale by a known guest. */
export function sale(t: TestEnv, over: Partial<CanonicalTransaction> & { cents?: number } = {}): CanonicalTransaction {
  const { cents = 5900, ...rest } = over;
  return {
    source: 'sim',
    externalRef: unique('sale'),
    occurredAt: t.clock(),
    channel: 'dine-in',
    status: 'completed',
    subtotalCents: cents,
    discountCents: 0,
    taxCents: Math.round(cents / 11),
    tipCents: 0,
    totalCents: cents,
    refundedCents: 0,
    currency: 'AUD',
    tenderType: 'card',
    lines: [{ lineNo: 1, name: 'Steak frites', category: 'Mains', qty: 1, unitPriceCents: cents, modifiers: [], discountCents: 0, taxCents: Math.round(cents / 11), totalCents: cents }],
    identityHints: [],
    ...rest,
  };
}

export async function record(t: TestEnv, org: FixtureOrg, customerId: string, over: Partial<CanonicalTransaction> = {}, venueId?: string) {
  return t.app.tenant(org.orgId, WORKER, (ctx) => ledger.recordTransaction(ctx, sale(t, over), { venueId: venueId ?? org.venueId, customerId }));
}

export async function eventsNamed(t: TestEnv, orgId: string, name: string, where: Record<string, string> = {}) {
  let q = t.db.selectFrom('events').select(['properties', 'customer_id', 'venue_id']).where('org_id', '=', orgId).where('name', '=', name);
  for (const [k, v] of Object.entries(where)) q = q.where(sql<string>`properties->>${k}`, '=', v);
  return q.execute();
}
