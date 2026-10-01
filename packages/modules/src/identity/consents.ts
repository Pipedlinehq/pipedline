import { type Ctx, AppError, GUEST_FACING_ROLES, audit, forbidden, invalid, isInternal, notFound, requireStaff, staffOf, track, hookList } from '@ros/core';
import { consentChanged } from './module';

export type ConsentPurpose = 'card_recognition' | 'marketing_email' | 'marketing_sms' | 'ad_platform_sharing';
export const CONSENT_PURPOSES: ConsentPurpose[] = ['card_recognition', 'marketing_email', 'marketing_sms', 'ad_platform_sharing'];

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  wordingVersion: string | null;
  source: string | null;
  at: Date | null;
}

type ChangeHandler = (ctx: Ctx, change: { customerId: string; purpose: ConsentPurpose; action: 'granted' | 'revoked'; source: string }) => Promise<void>;
const handlers = hookList<ChangeHandler>('identity.consentHandlers');

/** Other spine modules react to a consent change in the same transaction (comms keeps suppressions in step). */
export function onConsentChanged(handler: ChangeHandler): void {
  handlers.add(handler);
}

export interface Wording {
  purpose: ConsentPurpose;
  version: string;
  body: string;
}

/** The wording to show for a purpose: the org's own latest version if it has one, else the platform default. */
export async function currentWording(ctx: Ctx, purpose: ConsentPurpose): Promise<Wording> {
  const rows = await ctx.db
    .selectFrom('consent_wordings')
    .select(['org_id', 'version', 'body', 'effective_from'])
    .where('purpose', '=', purpose)
    .where('effective_from', '<=', ctx.now())
    .orderBy('effective_from', 'desc')
    .execute();
  const own = rows.find((r) => r.org_id === ctx.orgId);
  const chosen = own ?? rows.find((r) => r.org_id === null);
  if (!chosen) throw notFound('No consent wording is configured.');
  return { purpose, version: chosen.version, body: chosen.body };
}

export async function currentWordings(ctx: Ctx): Promise<Wording[]> {
  return Promise.all(CONSENT_PURPOSES.map((p) => currentWording(ctx, p)));
}

export async function getConsents(ctx: Ctx, customerId: string): Promise<ConsentState[]> {
  assertMayRead(ctx, customerId);
  const rows = await ctx.db
    .selectFrom('consents')
    .select(['purpose', 'status', 'wording_version', 'source', 'consented_at', 'revoked_at'])
    .where('customer_id', '=', customerId)
    .execute();
  return CONSENT_PURPOSES.map((purpose) => {
    const r = rows.find((x) => x.purpose === purpose);
    return {
      purpose,
      granted: r?.status === 'granted',
      wordingVersion: r?.wording_version ?? null,
      source: r?.source ?? null,
      at: r ? (r.status === 'granted' ? r.consented_at : r.revoked_at) : null,
    };
  });
}

/** Internal check used by modules before acting on a consent. No role check. */
export async function hasConsent(ctx: Ctx, customerId: string, purpose: ConsentPurpose): Promise<boolean> {
  const r = await ctx.db
    .selectFrom('consents')
    .select('status')
    .where('customer_id', '=', customerId)
    .where('purpose', '=', purpose)
    .executeTakeFirst();
  return r?.status === 'granted';
}

export interface GrantInput {
  customerId: string;
  purpose: ConsentPurpose;
  /** The surface the guest used: 'checkout', 'qr_checkout', 'loyalty_signup', 'guest_account', 'import' … */
  source: string;
  sourceDetail?: string | null;
  /** The version the guest was shown. Defaults to the current wording; pass it when the form was rendered earlier. */
  wordingVersion?: string;
  /** For imports: when the guest originally consented elsewhere. */
  consentedAt?: Date;
}

/**
 * Record that a guest ticked a consent box. Consent comes from the guest: a guest for their own
 * record, a first-party capture surface acting for the customer it just resolved, or an import
 * that carries provenance. Staff cannot grant on a guest's behalf.
 */
export async function grantConsent(ctx: Ctx, input: GrantInput): Promise<void> {
  const p = ctx.principal;
  if (staffOf(ctx)) throw forbidden('Consent must come from the guest. Ask them to tick the box themselves.');
  if (p.kind === 'guest' && p.customerId !== input.customerId) throw new AppError('not_found', 'Customer not found');
  if (p.kind === 'device') throw forbidden('A kitchen or counter screen cannot record consent.');
  if (input.source === 'import' && !isInternal(ctx)) throw forbidden('Only an import job can record imported consent.');
  if (input.source === 'import' && !input.sourceDetail) throw invalid('Imported consent needs its provenance.');
  if (input.source === 'import' && input.purpose === 'card_recognition') {
    throw invalid('Card recognition cannot be imported; the guest must tick the box here.');
  }

  const customer = await ctx.db.selectFrom('customers').select(['id', 'status']).where('id', '=', input.customerId).executeTakeFirst();
  if (!customer || customer.status !== 'active') throw notFound('Customer not found');

  const wording = input.wordingVersion ?? (await currentWording(ctx, input.purpose)).version;
  const at = input.consentedAt ?? ctx.now();
  const values = {
    status: 'granted' as const,
    wording_version: wording,
    source: input.source,
    source_detail: input.sourceDetail ?? null,
    ip: ctx.ip ?? null,
    consented_at: at,
    revoked_at: null,
  };
  await ctx.db
    .insertInto('consents')
    .values({ org_id: ctx.orgId, customer_id: input.customerId, purpose: input.purpose, ...values })
    .onConflict((oc) => oc.columns(['org_id', 'customer_id', 'purpose']).doUpdateSet(values))
    .execute();
  await ctx.db
    .insertInto('consent_events')
    .values({
      org_id: ctx.orgId,
      customer_id: input.customerId,
      purpose: input.purpose,
      action: 'granted',
      wording_version: wording,
      source: input.source,
      source_detail: input.sourceDetail ?? null,
      ip: ctx.ip ?? null,
      occurred_at: at,
    })
    .execute();
  await track(ctx, consentChanged, { purpose: input.purpose, action: 'granted', source: input.source }, { customerId: input.customerId });
  for (const h of handlers.all()) await h(ctx, { customerId: input.customerId, purpose: input.purpose, action: 'granted', source: input.source });
}

export interface RevokeInput {
  customerId: string;
  purpose: ConsentPurpose;
  /** 'guest_account', 'unsubscribe_link', 'sms_stop', 'staff_on_request', 'provider_complaint' … */
  source: string;
  sourceDetail?: string | null;
}

/** Withdraw a consent. One step, per purpose. Withdrawing card recognition deletes the card links. */
export async function revokeConsent(ctx: Ctx, input: RevokeInput): Promise<void> {
  const p = ctx.principal;
  if (p.kind === 'guest' && p.customerId !== input.customerId) throw new AppError('not_found', 'Customer not found');
  if (p.kind === 'anon' || p.kind === 'device') throw new AppError('unauthenticated', 'Sign in to do that.');
  // Staff may withdraw when the guest asks them to; the source says so. Only staff who deal with
  // guests (and may read the record) can: kitchen and read-only roles cannot change consents.
  if (staffOf(ctx)) requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });

  const existing = await ctx.db
    .selectFrom('consents')
    .select(['status', 'wording_version'])
    .where('customer_id', '=', input.customerId)
    .where('purpose', '=', input.purpose)
    .executeTakeFirst();
  const wording = existing?.wording_version ?? (await currentWording(ctx, input.purpose)).version;
  const at = ctx.now();

  const values = { status: 'revoked' as const, revoked_at: at, source: input.source, source_detail: input.sourceDetail ?? null };
  await ctx.db
    .insertInto('consents')
    .values({ org_id: ctx.orgId, customer_id: input.customerId, purpose: input.purpose, wording_version: wording, ...values })
    .onConflict((oc) => oc.columns(['org_id', 'customer_id', 'purpose']).doUpdateSet(values))
    .execute();
  await ctx.db
    .insertInto('consent_events')
    .values({
      org_id: ctx.orgId,
      customer_id: input.customerId,
      purpose: input.purpose,
      action: 'revoked',
      wording_version: wording,
      source: input.source,
      source_detail: input.sourceDetail ?? null,
      ip: ctx.ip ?? null,
      occurred_at: at,
    })
    .execute();

  if (input.purpose === 'card_recognition') {
    await ctx.db
      .deleteFrom('customer_identities')
      .where('customer_id', '=', input.customerId)
      .where('kind', 'in', ['card_fingerprint', 'card_par'])
      .execute();
  }

  await audit(ctx, { action: 'consent.revoked', entityType: 'customer', entityId: input.customerId, after: { purpose: input.purpose, source: input.source } });
  await track(ctx, consentChanged, { purpose: input.purpose, action: 'revoked', source: input.source }, { customerId: input.customerId });
  for (const h of handlers.all()) await h(ctx, { customerId: input.customerId, purpose: input.purpose, action: 'revoked', source: input.source });
}

function assertMayRead(ctx: Ctx, customerId: string): void {
  const p = ctx.principal;
  if (isInternal(ctx) || staffOf(ctx)) return;
  if (p.kind === 'guest' && p.customerId === customerId) return;
  throw new AppError('not_found', 'Customer not found');
}
