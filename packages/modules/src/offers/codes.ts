import { z } from 'zod';
import { type Ctx, type IdentityHint, GUEST_FACING_ROLES, audit, conflict, invalid, isInternal, localParts, newCode, notFound, rateLimit, requireGuest, requireStaff, staffOf, track } from '@ros/core';
import { resolveCustomer } from '../identity/resolve';
import { queueMessage } from '../comms/outbox';
import { getOrg } from '../tenancy/orgs';
import { type OfferRow, assertOffersOn, loadOffer, offerSummary } from './definitions';
import { offerClaimed, offerExpired, offerIssued, offerVoided } from './module';
import { OFFER_CODE_TEMPLATE } from './templates';

/**
 * Codes: one per guest per offer, unguessable, single use. A code is never applied by itself:
 * it takes the guest claiming it, entering it at checkout, or showing it at the counter.
 */

export type CodeStatus = 'issued' | 'claimed' | 'redeemed' | 'expired' | 'voided';

export interface CodeRow {
  id: string;
  offer_id: string;
  customer_id: string | null;
  code: string;
  status: CodeStatus;
  source: string | null;
  issued_at: Date;
  claimed_at: Date | null;
  redeemed_at: Date | null;
  expires_at: Date;
  redeemed_order_id: string | null;
  redeemed_transaction_id: string | null;
  redeemed_venue_id: string | null;
  discount_applied_cents: number | null;
}

export const CODE_COLS = [
  'id',
  'offer_id',
  'customer_id',
  'code',
  'status',
  'source',
  'issued_at',
  'claimed_at',
  'redeemed_at',
  'expires_at',
  'redeemed_order_id',
  'redeemed_transaction_id',
  'redeemed_venue_id',
  'discount_applied_cents',
] as const;

export interface CodeView {
  id: string;
  code: string;
  /** 'expired' as soon as the code is past its date, even before the sweep has run. */
  status: CodeStatus;
  offerId: string;
  offerName: string;
  offerKind: OfferRow['kind'];
  /** Plain words, e.g. "$10 off when you spend $40 or more". */
  summary: string;
  minSpendCents: number;
  validVenueIds: string[] | null;
  customerId: string | null;
  source: string | null;
  issuedAt: Date;
  claimedAt: Date | null;
  redeemedAt: Date | null;
  expiresAt: Date;
}

export const effectiveStatus = (row: Pick<CodeRow, 'status' | 'expires_at'>, now: Date): CodeStatus =>
  (row.status === 'issued' || row.status === 'claimed') && row.expires_at <= now ? 'expired' : row.status;

export function codeView(row: CodeRow, offer: OfferRow, now: Date, currency?: string): CodeView {
  return {
    id: row.id,
    code: row.code,
    status: effectiveStatus(row, now),
    offerId: offer.id,
    offerName: offer.name,
    offerKind: offer.kind,
    summary: offerSummary(offer, currency),
    minSpendCents: offer.min_spend_cents,
    validVenueIds: offer.valid_venue_ids,
    customerId: row.customer_id,
    source: row.source,
    issuedAt: row.issued_at,
    claimedAt: row.claimed_at,
    redeemedAt: row.redeemed_at,
    expiresAt: row.expires_at,
  };
}

/** Offers a guest gets once, ever: a second welcome is not a welcome. */
const ONCE_PER_GUEST = new Set<OfferRow['kind']>(['welcome', 'creator']);
/** Offers the public may ask for on a sign-up page. */
const PUBLIC_SIGNUP = new Set<OfferRow['kind']>(['welcome', 'creator']);

const codeEventProps = (offer: OfferRow, row: Pick<CodeRow, 'id'>) => ({ offer_id: offer.id, offer_kind: offer.kind, code_id: row.id });
export const codeAttribution = (offer: OfferRow, code: string) => ({ creatorId: offer.creator_id, campaignId: offer.campaign_id, code });

/** Identities a customer already holds that can be passed back to the identity spine to name them. */
async function knownHints(ctx: Ctx, customerId: string): Promise<IdentityHint[]> {
  const rows = await ctx.db
    .selectFrom('customer_identities')
    .select(['kind', 'value'])
    .where('customer_id', '=', customerId)
    .where('kind', 'in', ['email', 'phone', 'pos_customer_id', 'loyalty_qr'])
    .limit(1)
    .execute();
  return rows.map((r) => ({ kind: r.kind as IdentityHint['kind'], value: r.value }));
}

/**
 * Record that an offer reached an existing guest, as a marketing touch on their record. The
 * acquisition stamp is write-once and is never touched here; a creator or campaign offer shows
 * up in last-touch attribution through this instead. Goes through the identity spine.
 */
export async function recordTouch(ctx: Ctx, offer: OfferRow, code: Pick<CodeRow, 'customer_id' | 'code'>, at: Date): Promise<void> {
  if (!code.customer_id) return;
  const hints = await knownHints(ctx, code.customer_id);
  if (!hints.length) return;
  await resolveCustomer(ctx, {
    hints,
    via: 'offer',
    createIfMissing: false,
    acquisition: { source: offer.creator_id ? 'criota' : 'offer', creatorId: offer.creator_id, campaignId: offer.campaign_id, code: code.code, at },
  });
}

type IssueOutcome = { outcome: 'created' | 'existing'; row: CodeRow } | { outcome: 'already_had' | 'cap_reached' | 'unknown_customer'; row: null };

/** The issuing itself. No role check: callers have done it. */
async function issue(ctx: Ctx, offer: OfferRow, a: { customerId: string | null; source: string; claimed: boolean; code?: string }): Promise<IssueOutcome> {
  const now = ctx.now();
  if (a.customerId) {
    const customer = await ctx.db.selectFrom('customers').select('status').where('id', '=', a.customerId).executeTakeFirst();
    if (customer?.status !== 'active') return { outcome: 'unknown_customer', row: null };
    // Close this guest's lapsed codes for the offer first, so a lapsed one never blocks a fresh one.
    await expireCodes(ctx, { offerId: offer.id, customerId: a.customerId });
    const prior = (await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('offer_id', '=', offer.id).where('customer_id', '=', a.customerId).where('status', '!=', 'voided').execute()) as CodeRow[];
    const live = prior.find((p) => p.status === 'issued' || p.status === 'claimed');
    if (live) return { outcome: 'existing', row: live };
    if (ONCE_PER_GUEST.has(offer.kind) && prior.length) return { outcome: 'already_had', row: null };
  }
  if (offer.max_codes !== null) {
    const n = await ctx.db.selectFrom('offer_codes').select((eb) => eb.fn.countAll<number>().as('n')).where('offer_id', '=', offer.id).where('status', '!=', 'voided').executeTakeFirstOrThrow();
    if (Number(n.n) >= offer.max_codes) return { outcome: 'cap_reached', row: null };
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = attempt === 0 && a.code ? a.code : `${offer.code_prefix}-${newCode(8)}`;
    const row = (await ctx.db
      .insertInto('offer_codes')
      .values({
        org_id: ctx.orgId,
        offer_id: offer.id,
        customer_id: a.customerId,
        code,
        status: a.claimed ? 'claimed' : 'issued',
        source: a.source,
        issued_at: now,
        claimed_at: a.claimed ? now : null,
        expires_at: new Date(now.getTime() + offer.validity_days * 86_400_000),
      })
      // Either the code collided (try another) or another request issued this guest's code a moment ago.
      .onConflict((oc) => oc.doNothing())
      .returning(CODE_COLS)
      .executeTakeFirst()) as CodeRow | undefined;
    if (row) {
      await track(ctx, offerIssued, { ...codeEventProps(offer, row), source: a.source }, { customerId: a.customerId, attribution: codeAttribution(offer, row.code) });
      if (a.claimed) await track(ctx, offerClaimed, { ...codeEventProps(offer, row), via: 'signup' }, { customerId: a.customerId, attribution: codeAttribution(offer, row.code) });
      return { outcome: 'created', row };
    }
    if (a.customerId) {
      const raced = (await ctx.db
        .selectFrom('offer_codes')
        .select(CODE_COLS)
        .where('offer_id', '=', offer.id)
        .where('customer_id', '=', a.customerId)
        .where('status', 'in', ['issued', 'claimed'])
        .executeTakeFirst()) as CodeRow | undefined;
      if (raced) return { outcome: 'existing', row: raced };
    }
  }
  throw conflict('Could not issue a code just now. Try again.');
}

function longDate(at: Date, timezone: string): string {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const p = localParts(at, timezone);
  return `${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** Where a guest claims a code, on the org's own site. Null until a domain is live. */
async function claimUrl(ctx: Ctx, code: string): Promise<string> {
  const r = await ctx.db
    .selectFrom('domains')
    .select('host')
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .orderBy('venue_id', (ob) => ob.asc().nullsFirst())
    .executeTakeFirst();
  return r ? `${ctx.app.config.scheme}://${r.host}/claim/${encodeURIComponent(code)}` : '';
}

/** Queue "here is your code". Marketing: comms sends it only to a guest who has agreed, and records the rest as suppressed. */
async function sendCode(ctx: Ctx, offer: OfferRow, row: CodeRow, channel: 'email' | 'sms'): Promise<{ status: 'queued' | 'suppressed'; reason?: string }> {
  if (!row.customer_id) return { status: 'suppressed', reason: 'no_customer' };
  const org = await getOrg(ctx);
  const c = await ctx.db.selectFrom('customers').select(['first_name']).where('id', '=', row.customer_id).executeTakeFirst();
  const r = await queueMessage(ctx, {
    templateKey: OFFER_CODE_TEMPLATE,
    channel,
    customerId: row.customer_id,
    idempotencyKey: `offer-code:${row.id}:${channel}`,
    variables: {
      first_name: c?.first_name ?? 'there',
      offer_name: offer.name,
      offer_summary: offerSummary(offer, org.currency),
      code: row.code,
      claim_url: await claimUrl(ctx, row.code),
      expires_on: longDate(row.expires_at, org.timezone),
    },
  });
  return { status: r.status, reason: r.reason };
}

export const issueCodeInput = z.object({
  offerId: z.string().uuid(),
  /** Leave out for a code not yet tied to anyone (a printed voucher): it binds to whoever claims or redeems it. */
  customerId: z.string().uuid().nullish(),
  /** What issued it: 'flow:welcome', 'campaign:<id>', 'staff' … Kept on the code for reporting. */
  source: z.string().trim().min(1).max(120),
  /** Send "here is your code" on this channel. Marketing consent is enforced by comms. */
  notify: z.enum(['email', 'sms']).nullish(),
});

export interface IssueResult {
  code: CodeView;
  /** False when the guest already had a live code for this offer: that one is returned. */
  created: boolean;
  message: { status: 'queued' | 'suppressed'; reason?: string } | null;
}

/**
 * Issue a guest their own code for an offer. One live code per guest per offer: asking again
 * returns the one they have. For flows and campaigns (internal callers) and for a manager.
 */
export async function issueCode(ctx: Ctx, raw: z.input<typeof issueCodeInput>): Promise<IssueResult> {
  const input = issueCodeInput.parse(raw);
  if (!isInternal(ctx)) requireStaff(ctx, { minRole: 'manager' });
  await assertOffersOn(ctx);
  const offer = await loadOffer(ctx, input.offerId);
  if (!offer) throw notFound('Offer not found');
  if (!offer.is_active) throw invalid('That offer is switched off.');

  const r = await issue(ctx, offer, { customerId: input.customerId ?? null, source: input.source, claimed: !offer.requires_claim });
  if (!r.row) {
    if (r.outcome === 'unknown_customer') throw notFound('Customer not found');
    if (r.outcome === 'already_had') throw invalid('That guest has already had this offer.');
    throw invalid('Every code for that offer has been issued.');
  }
  const created = r.outcome === 'created';
  if (created && staffOf(ctx)) await audit(ctx, { action: 'offer.code_issued', entityType: 'offer_code', entityId: r.row.id, after: { offerId: offer.id, customerId: r.row.customer_id, source: input.source } });
  const message = input.notify ? await sendCode(ctx, offer, r.row, input.notify) : null;
  const org = await getOrg(ctx);
  return { code: codeView(r.row, offer, ctx.now(), org.currency), created, message };
}

export const issueCodesInput = z.object({
  offerId: z.string().uuid(),
  /** The segment, already worked out by the caller. */
  customerIds: z.array(z.string().uuid()).min(1).max(50_000),
  source: z.string().trim().min(1).max(120),
  notify: z.enum(['email', 'sms']).nullish(),
});

export interface BulkIssueResult {
  issued: number;
  /** Guests who already held a live code for this offer. */
  existing: number;
  /** Guests skipped: they have already had a once-only offer, are not known here, or the offer ran out of codes. */
  skipped: number;
  queued: number;
  suppressed: number;
}

/** Issue one code each to a list of guests. Safe to run twice: a guest with a live code keeps it. */
export async function issueCodes(ctx: Ctx, raw: z.input<typeof issueCodesInput>): Promise<BulkIssueResult> {
  const input = issueCodesInput.parse(raw);
  if (!isInternal(ctx)) requireStaff(ctx, { minRole: 'manager' });
  const config = await assertOffersOn(ctx);
  const offer = await loadOffer(ctx, input.offerId);
  if (!offer) throw notFound('Offer not found');
  if (!offer.is_active) throw invalid('That offer is switched off.');
  const ids = [...new Set(input.customerIds)];
  if (ids.length > config.bulkIssueMax) throw invalid(`That is more than ${config.bulkIssueMax} guests at once. Split the list.`);

  const out: BulkIssueResult = { issued: 0, existing: 0, skipped: 0, queued: 0, suppressed: 0 };
  for (const customerId of ids) {
    const r = await issue(ctx, offer, { customerId, source: input.source, claimed: !offer.requires_claim });
    if (!r.row) {
      out.skipped++;
      continue;
    }
    if (r.outcome === 'created') out.issued++;
    else out.existing++;
    if (input.notify && r.outcome === 'created') {
      const m = await sendCode(ctx, offer, r.row, input.notify);
      if (m.status === 'queued') out.queued++;
      else out.suppressed++;
    }
  }
  if (staffOf(ctx)) await audit(ctx, { action: 'offer.codes_issued', entityType: 'offer', entityId: offer.id, after: { source: input.source, ...out } });
  return out;
}

export const requestCodeInput = z
  .object({
    offerId: z.string().uuid(),
    email: z.string().trim().min(3).max(254).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    venueId: z.string().uuid().nullish(),
    landingPath: z.string().max(300).nullish(),
  })
  .refine((v) => v.email || v.phone, { message: 'Enter an email address or a phone number.' });

/**
 * The public sign-up page for a welcome or creator offer: the visitor gives an email or phone
 * and gets their code. A guest created here is stamped with where they came from (the creator,
 * the campaign and the code), once and for good; a guest we already know gets a marketing
 * touch instead. Asking is claiming, so the code is issued already claimed.
 */
export async function requestOfferCode(ctx: Ctx, raw: z.input<typeof requestCodeInput>): Promise<CodeView> {
  const parsed = requestCodeInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'Those details are not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  await assertOffersOn(ctx, input.venueId);
  if (ctx.ip) await rateLimit(ctx.app, `offer-signup:${ctx.orgId}:${ctx.ip}`, { limit: 10, windowSeconds: 600 });
  const offer = await loadOffer(ctx, input.offerId);
  if (!offer || !offer.is_active || !PUBLIC_SIGNUP.has(offer.kind)) throw notFound('Offer not found');

  const hints: IdentityHint[] = [];
  if (input.email) hints.push({ kind: 'email', value: input.email });
  if (input.phone) hints.push({ kind: 'phone', value: input.phone });
  const profile = { firstName: input.firstName ?? null, lastName: input.lastName ?? null };
  const now = ctx.now();

  const known = await resolveCustomer(ctx, { hints, via: 'offer', venueId: input.venueId, profile, createIfMissing: false });
  let customerId = known.customerId;
  let code: string | undefined;
  if (!customerId) {
    // New to the venue: this offer is how they arrived, and the stamp says so.
    code = `${offer.code_prefix}-${newCode(8)}`;
    const created = await resolveCustomer(ctx, {
      hints,
      via: 'offer',
      venueId: input.venueId,
      profile,
      acquisition: { source: offer.creator_id ? 'criota' : 'offer', creatorId: offer.creator_id, campaignId: offer.campaign_id, code, landingPath: input.landingPath ?? null, at: now },
    });
    customerId = created.customerId;
  }
  if (!customerId) throw invalid('That email address or phone number does not look right.');

  const r = await issue(ctx, offer, { customerId, source: 'signup', claimed: true, code });
  if (!r.row) {
    if (r.outcome === 'already_had') throw invalid('You have already had this offer.');
    if (r.outcome === 'cap_reached') throw invalid('That offer has ended.');
    throw invalid('That email address or phone number does not look right.');
  }
  if (r.outcome === 'existing' && r.row.status === 'issued') await claim(ctx, offer, r.row, 'signup');
  else if (known.customerId && r.outcome === 'created') await recordTouch(ctx, offer, r.row, now);
  const org = await getOrg(ctx);
  const fresh = (await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('id', '=', r.row.id).executeTakeFirstOrThrow()) as CodeRow;
  return codeView(fresh, offer, now, org.currency);
}

async function findByCode(ctx: Ctx, code: string, lock = false): Promise<CodeRow | null> {
  const q = ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('code', '=', code.trim());
  const r = await (lock ? q.forUpdate() : q).executeTakeFirst();
  return (r as CodeRow | undefined) ?? null;
}

/** Mark a code claimed and record the touch. The caller has locked the row and checked it is claimable. */
async function claim(ctx: Ctx, offer: OfferRow, row: CodeRow, via: 'link' | 'signup'): Promise<void> {
  const now = ctx.now();
  await ctx.db.updateTable('offer_codes').set({ status: 'claimed', claimed_at: now, customer_id: row.customer_id }).where('id', '=', row.id).where('status', '=', 'issued').execute();
  await recordTouch(ctx, offer, row, now);
  await track(ctx, offerClaimed, { ...codeEventProps(offer, row), via }, { customerId: row.customer_id, attribution: codeAttribution(offer, row.code) });
}

const codeInput = z.object({ code: z.string().trim().min(4).max(40) });

/** Who may look at a code: whoever holds it. A signed-in guest cannot open a code that belongs to someone else. */
function assertMaySee(ctx: Ctx, row: CodeRow | null): asserts row is CodeRow {
  if (!row) throw notFound('That code was not found.');
  if (ctx.principal.kind === 'guest' && row.customer_id && row.customer_id !== ctx.principal.customerId) throw notFound('That code was not found.');
}

async function limitGuessing(ctx: Ctx): Promise<void> {
  // The code is the key, so guessing is limited per address. Staff and internal callers are not guessing.
  if (ctx.ip && !staffOf(ctx) && !isInternal(ctx)) await rateLimit(ctx.app, `offer-code:${ctx.orgId}:${ctx.ip}`, { limit: 30, windowSeconds: 600 });
}

/**
 * What the claim page shows before the guest presses the button. Reads only, so a mail
 * scanner that follows the link claims nothing.
 */
export async function previewCode(ctx: Ctx, raw: z.input<typeof codeInput>): Promise<CodeView> {
  const input = codeInput.parse(raw);
  await assertOffersOn(ctx);
  await limitGuessing(ctx);
  const row = await findByCode(ctx, input.code);
  assertMaySee(ctx, row);
  const offer = (await loadOffer(ctx, row.offer_id))!;
  return codeView(row, offer, ctx.now(), (await getOrg(ctx)).currency);
}

/**
 * The claim step: the guest pressed the button. Marks the code claimed; applies it to nothing.
 * Claiming twice is one claim. A code with no owner yet becomes the signed-in guest's.
 */
export async function claimCode(ctx: Ctx, raw: z.input<typeof codeInput>): Promise<CodeView> {
  const input = codeInput.parse(raw);
  await assertOffersOn(ctx);
  await limitGuessing(ctx);
  const row = await findByCode(ctx, input.code, true);
  assertMaySee(ctx, row);
  const offer = (await loadOffer(ctx, row.offer_id))!;
  const now = ctx.now();
  const status = effectiveStatus(row, now);
  if (status === 'redeemed') throw invalid('That code has already been used.');
  if (status === 'voided') throw invalid('That code is no longer valid.');
  if (status === 'expired') throw invalid('That code has expired.');
  if (status === 'issued') {
    if (!row.customer_id && ctx.principal.kind === 'guest') {
      // A code nobody owned becomes this guest's, unless they already hold a live one for the offer.
      const held = await ctx.db
        .selectFrom('offer_codes')
        .select('id')
        .where('offer_id', '=', row.offer_id)
        .where('customer_id', '=', ctx.principal.customerId)
        .where('status', 'in', ['issued', 'claimed'])
        .executeTakeFirst();
      if (!held) row.customer_id = ctx.principal.customerId;
    }
    await claim(ctx, offer, row, 'link');
    row.status = 'claimed';
    row.claimed_at = now;
  }
  return codeView(row, offer, now, (await getOrg(ctx)).currency);
}

/** The signed-in guest's own codes that can still be used. */
export async function listMyCodes(ctx: Ctx): Promise<CodeView[]> {
  const customerId = requireGuest(ctx);
  await assertOffersOn(ctx);
  const now = ctx.now();
  const rows = (await ctx.db
    .selectFrom('offer_codes')
    .select(CODE_COLS)
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['issued', 'claimed'])
    .where('expires_at', '>', now)
    .orderBy('expires_at')
    .execute()) as CodeRow[];
  const currency = (await getOrg(ctx)).currency;
  const out: CodeView[] = [];
  for (const r of rows) out.push(codeView(r, (await loadOffer(ctx, r.offer_id))!, now, currency));
  return out;
}

export const listCodesInput = z.object({
  offerId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  status: z.enum(['issued', 'claimed', 'redeemed', 'expired', 'voided']).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});

/** Codes for the console, newest first. Front of house may look up one guest's codes; the full list is a manager's. */
export async function listCodes(ctx: Ctx, raw: z.input<typeof listCodesInput> = {}): Promise<CodeView[]> {
  const input = listCodesInput.parse(raw);
  if (input.customerId) requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
  else requireStaff(ctx, { minRole: 'manager' });
  await assertOffersOn(ctx);
  let q = ctx.db.selectFrom('offer_codes').select(CODE_COLS).orderBy('issued_at', 'desc').limit(input.limit).offset(input.offset);
  if (input.offerId) q = q.where('offer_id', '=', input.offerId);
  if (input.customerId) q = q.where('customer_id', '=', input.customerId);
  if (input.status) q = q.where('status', '=', input.status);
  const rows = (await q.execute()) as CodeRow[];
  const offers = new Map<string, OfferRow>();
  const now = ctx.now();
  const currency = (await getOrg(ctx)).currency;
  const out: CodeView[] = [];
  for (const r of rows) {
    let offer = offers.get(r.offer_id);
    if (!offer) offers.set(r.offer_id, (offer = (await loadOffer(ctx, r.offer_id))!));
    out.push(codeView(r, offer, now, currency));
  }
  return out;
}

export const voidCodeInput = z.object({ codeId: z.string().uuid(), reason: z.string().trim().min(3, 'Give a reason.').max(300) });

/** Cancel a code that has not been used. A manager, with a reason, on the audit log. */
export async function voidCode(ctx: Ctx, raw: z.input<typeof voidCodeInput>): Promise<void> {
  const parsed = voidCodeInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertOffersOn(ctx);
  const row = (await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('id', '=', input.codeId).forUpdate().executeTakeFirst()) as CodeRow | undefined;
  if (!row) throw notFound('That code was not found.');
  if (row.status === 'voided') return;
  if (row.status === 'redeemed') throw conflict('That code has already been used.');
  const offer = (await loadOffer(ctx, row.offer_id))!;
  await ctx.db.updateTable('offer_codes').set({ status: 'voided', voided_at: ctx.now(), void_reason: input.reason }).where('id', '=', row.id).execute();
  await audit(ctx, { action: 'offer.code_voided', entityType: 'offer_code', entityId: row.id, before: { status: row.status }, after: { status: 'voided', reason: input.reason } });
  await track(ctx, offerVoided, codeEventProps(offer, row), { customerId: row.customer_id, attribution: codeAttribution(offer, row.code) });
}

/** Close codes that are past their date. Runs on a schedule, and before issuing so a lapsed code never blocks a fresh one. */
export async function expireCodes(ctx: Ctx, filter: { offerId?: string; customerId?: string } = {}): Promise<number> {
  let q = ctx.db.updateTable('offer_codes').set({ status: 'expired' }).where('status', 'in', ['issued', 'claimed']).where('expires_at', '<=', ctx.now());
  if (filter.offerId) q = q.where('offer_id', '=', filter.offerId);
  if (filter.customerId) q = q.where('customer_id', '=', filter.customerId);
  const rows = await q.returning(['id', 'offer_id', 'customer_id', 'code', 'claimed_at']).execute();
  const offers = new Map<string, OfferRow>();
  for (const r of rows) {
    let offer = offers.get(r.offer_id);
    if (!offer) offers.set(r.offer_id, (offer = (await loadOffer(ctx, r.offer_id))!));
    await track(ctx, offerExpired, { ...codeEventProps(offer, r), claimed: r.claimed_at !== null }, { customerId: r.customer_id, attribution: codeAttribution(offer, r.code) });
  }
  return rows.length;
}
