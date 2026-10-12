import { type Ctx, isUniqueViolation, localParts, sql, track } from '@ros/core';
import { isSegmentMember } from '../campaigns/segments';
import type { Adjustment, DraftOrder } from '../ordering/contract';
import { openWindows } from '../tenancy/hours';
import { getOrg } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { type OfferAppliesTo, type OfferRow, type OrderChannel, OFFER_COLS, clockWords, offerDiscountCents, offerStatus, offerSummary, toOfferRow, venueOffers } from './definitions';
import { offerApplied, offerReleased } from './module';

/**
 * Who may use an offer, and when (docs/CONSOLE_IA.md section 9, pattern 6). One answer for a
 * code at checkout, a code at the counter, a till sale carrying a code, and an automatic offer:
 * `offerBlockedReason` says in plain words why not, or null. Automatic offers are priced by
 * `automaticAdjustments`, which ordering calls alongside the code adjusters (see CLAUDE.md), and
 * recorded as uses when the order is paid or the till sale arrives.
 */

export interface UseMoment {
  venueId: string;
  customerId: string | null;
  at: Date;
  /** Online order type; null at the till or counter. */
  channel: OrderChannel | null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Codes redeemed plus automatic uses, for one guest on one offer, or for everyone. */
export async function offerUseCount(ctx: Ctx, offerId: string, customerId?: string | null): Promise<number> {
  const forGuest = customerId ? sql` and customer_id = ${customerId}::uuid` : sql``;
  const r = await sql<{ n: number }>`
    select (select count(*)::int from offer_codes where org_id = ${ctx.orgId} and offer_id = ${offerId}::uuid and status = 'redeemed'${forGuest})
         + (select count(*)::int from offer_uses where org_id = ${ctx.orgId} and offer_id = ${offerId}::uuid and released_at is null${forGuest}) as n`.execute(ctx.db);
  return r.rows[0]?.n ?? 0;
}

/** A guest with no paid sale on record yet (or no record at all) is new. */
async function isNewGuest(ctx: Ctx, customerId: string | null, before: Date): Promise<boolean> {
  if (!customerId) return true;
  const r = await ctx.db
    .selectFrom('transactions')
    .select('id')
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['completed', 'partially_refunded'])
    .where('occurred_at', '<', before)
    .limit(1)
    .executeTakeFirst();
  return !r;
}

async function isLoyaltyMember(ctx: Ctx, customerId: string | null): Promise<boolean> {
  if (!customerId) return false;
  const r = await ctx.db.selectFrom('events').select('id').where('customer_id', '=', customerId).where('name', '=', 'loyalty.enrolled').limit(1).executeTakeFirst();
  return !!r;
}

/**
 * Why this offer cannot be used here and now, in plain words; null when it can. Covers the
 * offer's own rules: on or off, dates, days, daily window, services, who it is for, limits. The
 * code's own state (used, expired, someone else's) and the venue list are the caller's.
 */
export async function offerBlockedReason(ctx: Ctx, offer: OfferRow, use: UseMoment): Promise<string | null> {
  const venue = await getVenue(ctx, use.venueId);
  const tz = venue.timezone;
  const status = offerStatus(offer, use.at);
  if (status === 'off') return 'That offer is switched off.';
  if (status === 'scheduled') {
    const p = localParts(offer.starts_at!, tz);
    return `That offer starts on ${p.day} ${MONTHS[p.month - 1]}.`;
  }
  if (status === 'expired') return 'That offer has ended.';

  const local = localParts(use.at, tz);
  if (offer.days && offer.days.length && !offer.days.includes(local.weekday)) {
    return `That offer is not on ${DAY_NAMES[local.weekday]}s.`;
  }
  if (offer.time_from && offer.time_to) {
    const t = local.time;
    if (t < offer.time_from || t >= offer.time_to) return `That offer runs ${clockWords(offer.time_from)} to ${clockWords(offer.time_to)}.`;
  }
  if (offer.services && offer.services.length) {
    const windows = await openWindows(ctx, use.venueId, local.date);
    const current = windows.filter((w) => w.opensAt <= use.at && use.at < w.closesAt).map((w) => w.serviceType.toLowerCase());
    const wanted = offer.services.map((s) => s.toLowerCase());
    if (!current.some((s) => wanted.includes(s))) return `That offer is for ${wanted.join(' and ')} only.`;
  }
  switch (offer.audience) {
    case 'list':
      if (!use.customerId || !offer.segment_id || !(await isSegmentMember(ctx, offer.segment_id, use.customerId))) return 'That offer is for a particular group of guests.';
      break;
    case 'new_guests':
      if (!(await isNewGuest(ctx, use.customerId, use.at))) return 'That offer is for first-time guests.';
      break;
    case 'loyalty_members':
      if (!(await isLoyaltyMember(ctx, use.customerId))) return 'That offer is for loyalty members.';
      break;
    default:
      break;
  }
  if (offer.total_limit !== null && (await offerUseCount(ctx, offer.id)) >= offer.total_limit) return 'That offer has all been used up.';
  if (offer.per_guest_limit !== null && use.customerId && (await offerUseCount(ctx, offer.id, use.customerId)) >= offer.per_guest_limit) {
    return offer.per_guest_limit === 1 ? 'That offer is one per guest, and this guest has had it.' : `That offer is ${offer.per_guest_limit} per guest, and this guest has had them.`;
  }
  return null;
}

// ── Combining ─────────────────────────────────────────────────────────────────

export type OfferClass = 'item' | 'bill' | 'delivery';

export const offerClass = (appliesTo: OfferAppliesTo): OfferClass => (appliesTo === 'item' || appliesTo === 'category' ? 'item' : appliesTo === 'delivery' ? 'delivery' : 'bill');

const allows = (o: Pick<OfferRow, 'combine_item' | 'combine_bill' | 'combine_delivery'>, cls: OfferClass): boolean => (cls === 'item' ? o.combine_item : cls === 'bill' ? o.combine_bill : o.combine_delivery);

/** Two offers may sit on one bill only when each allows the other's class. */
export function canCombine(a: Pick<OfferRow, 'applies_to' | 'combine_item' | 'combine_bill' | 'combine_delivery'>, b: Pick<OfferRow, 'applies_to' | 'combine_item' | 'combine_bill' | 'combine_delivery'>): boolean {
  return allows(a, offerClass(b.applies_to)) && allows(b, offerClass(a.applies_to));
}

/** What an adjustment already on the bill counts as. A loyalty reward (or anything not ours) counts as a whole-bill offer that combines with nothing. */
function classOfApplied(a: Adjustment, ours: Map<string, OfferRow>): Pick<OfferRow, 'applies_to' | 'combine_item' | 'combine_bill' | 'combine_delivery'> {
  const offer = a.ref.offerId ? ours.get(a.ref.offerId) : undefined;
  return offer ?? { applies_to: 'bill', combine_item: false, combine_bill: false, combine_delivery: false };
}

/** Can this offer join what is already on the bill? */
export async function combinesWithApplied(ctx: Ctx, offer: OfferRow, applied: Adjustment[]): Promise<string | null> {
  if (!applied.length) return null;
  const ids = applied.map((a) => a.ref.offerId).filter((x): x is string => !!x && x !== offer.id);
  const rows = ids.length ? (await ctx.db.selectFrom('offers').select(OFFER_COLS).where('id', 'in', ids).execute()).map(toOfferRow) : [];
  const ours = new Map(rows.map((r) => [r.id, r]));
  for (const a of applied) {
    if (a.ref.offerId === offer.id) return 'That offer is already on this order.';
    if (!canCombine(offer, classOfApplied(a, ours))) return `That offer cannot be used together with ${a.label.split(':')[0]}.`;
  }
  return null;
}

// ── Automatic offers ──────────────────────────────────────────────────────────

/** The part of the draft an offer comes off. */
function baseCents(offer: OfferRow, draft: DraftOrder, deliveryFeeCents: number): { base: number; freeItemPrice: number | null } {
  switch (offer.applies_to) {
    case 'item': {
      const lines = draft.lines.filter((l) => l.menuItemId === offer.menu_item_id);
      return { base: lines.reduce((s, l) => s + l.lineTotalCents, 0), freeItemPrice: lines[0]?.unitPriceCents ?? null };
    }
    case 'category': {
      const want = (offer.category ?? '').trim().toLowerCase();
      const lines = draft.lines.filter((l) => (l.category ?? '').trim().toLowerCase() === want);
      return { base: lines.reduce((s, l) => s + l.lineTotalCents, 0), freeItemPrice: lines[0]?.unitPriceCents ?? null };
    }
    case 'delivery':
      return { base: draft.channel === 'delivery' ? deliveryFeeCents : 0, freeItemPrice: null };
    default:
      return { base: draft.subtotalCents, freeItemPrice: null };
  }
}

/** The automatic offers switched on for this org, newest first. */
export async function activeAutomaticOffers(ctx: Ctx): Promise<OfferRow[]> {
  const rows = await ctx.db.selectFrom('offers').select(OFFER_COLS).where('method', '=', 'automatic').where('is_active', '=', true).orderBy('created_at', 'desc').execute();
  return rows.map(toOfferRow);
}

/**
 * The automatic offers that apply to this draft, priced, as adjustments ordering can add to the
 * bill beside the code adjustments. Changes nothing. `applied` is what is already on the bill
 * (codes the guest typed, a loyalty reward): an automatic offer joins only when both sides allow
 * it, and automatic offers that cannot sit together are taken largest first.
 *
 * Ordering must call this from `buildCart` after the code adjusters and before tax
 * (packages/modules/src/offers/CLAUDE.md); it is not wired there by this module.
 */
export async function automaticAdjustments(ctx: Ctx, draft: DraftOrder, applied: Adjustment[] = [], opts: { deliveryFeeCents?: number } = {}): Promise<Adjustment[]> {
  const config = await venueOffers(ctx, draft.venueId);
  if (!config) return [];
  const offers = (await activeAutomaticOffers(ctx)).filter((o) => (!o.valid_venue_ids || o.valid_venue_ids.includes(draft.venueId)) && o.channels.includes(draft.channel));
  if (!offers.length) return [];
  const currency = (await getOrg(ctx)).currency;
  const use: UseMoment = { venueId: draft.venueId, customerId: draft.customerId, at: draft.at, channel: draft.channel };

  const priced: Array<{ offer: OfferRow; amount: number }> = [];
  for (const offer of offers) {
    if (await offerBlockedReason(ctx, offer, use)) continue;
    if (draft.subtotalCents < offer.min_spend_cents) continue;
    const { base, freeItemPrice } = baseCents(offer, draft, opts.deliveryFeeCents ?? 0);
    if (base <= 0) continue;
    if (offer.discount_kind === 'free_item' && offer.menu_item_id && !draft.lines.some((l) => l.menuItemId === offer.menu_item_id)) continue;
    const amount = offerDiscountCents(offer, base, freeItemPrice);
    if (amount > 0) priced.push({ offer, amount });
  }
  priced.sort((a, b) => b.amount - a.amount);

  const chosen: Adjustment[] = [];
  let remaining = Math.max(0, draft.subtotalCents - applied.reduce((s, a) => s + a.amountCents, 0));
  for (const { offer, amount } of priced) {
    if (await combinesWithApplied(ctx, offer, [...applied, ...chosen])) continue;
    const capped = offer.applies_to === 'delivery' ? amount : Math.min(amount, remaining);
    if (capped <= 0) continue;
    if (offer.applies_to !== 'delivery') remaining -= capped;
    chosen.push({ adjuster: 'offers', code: `auto:${offer.id}`, label: `${offer.name}: ${offerSummary(offer, currency)}`, amountCents: capped, ref: { offerId: offer.id, auto: '1' } });
  }
  return chosen;
}

// ── Uses ──────────────────────────────────────────────────────────────────────

export interface UseRecord {
  offerId: string;
  venueId: string;
  customerId: string | null;
  orderId?: string | null;
  transactionId?: string | null;
  discountCents: number;
  at: Date;
}

/** Record one use of an automatic offer. Idempotent per order and per sale (the database says so). */
export async function recordOfferUse(ctx: Ctx, offer: OfferRow, u: UseRecord): Promise<boolean> {
  try {
    const row = await ctx.db
      .insertInto('offer_uses')
      .values({ org_id: ctx.orgId, offer_id: u.offerId, venue_id: u.venueId, customer_id: u.customerId, order_id: u.orderId ?? null, transaction_id: u.transactionId ?? null, discount_cents: u.discountCents, used_at: u.at, created_at: ctx.now() })
      .returning('id')
      .executeTakeFirstOrThrow();
    await track(ctx, offerApplied, { offer_id: offer.id, offer_kind: offer.kind, use_id: row.id, via: u.orderId ? 'online' : 'till', discount_cents: u.discountCents }, { customerId: u.customerId, venueId: u.venueId, occurredAt: u.at, attribution: { campaignId: offer.campaign_id, creatorId: offer.creator_id } });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}

/** The sale an automatic offer was used on was cancelled or refunded in full: the use no longer counts. Idempotent. */
export async function releaseOfferUses(ctx: Ctx, match: { orderId?: string; transactionId?: string }): Promise<number> {
  let q = ctx.db.updateTable('offer_uses').set({ released_at: ctx.now() }).where('released_at', 'is', null);
  if (match.orderId) q = q.where('order_id', '=', match.orderId);
  else if (match.transactionId) q = q.where('transaction_id', '=', match.transactionId);
  else return 0;
  const rows = await q.returning(['id', 'offer_id', 'customer_id', 'venue_id']).execute();
  for (const r of rows) {
    const offer = (await ctx.db.selectFrom('offers').select(['kind']).where('id', '=', r.offer_id).executeTakeFirst())!;
    await track(ctx, offerReleased, { offer_id: r.offer_id, offer_kind: offer.kind, code_id: `use:${r.id}` }, { customerId: r.customer_id, venueId: r.venue_id });
  }
  return rows.length;
}

/** Tie an online use to the sale that later reaches the ledger, for the sales-attributed figure. */
export async function tieUsesToSale(ctx: Ctx, orderId: string, transactionId: string): Promise<void> {
  await ctx.db.updateTable('offer_uses').set({ transaction_id: transactionId }).where('order_id', '=', orderId).where('transaction_id', 'is', null).execute();
}
