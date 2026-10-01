import { z } from 'zod';
import { type Ctx, GUEST_FACING_ROLES, audit, conflict, forbidden, formatMoney, invalid, notFound, requireStaff, track } from '@ros/core';
import { attributeTransaction } from '../ledger/attribution';
import type { RecordedInfo, RecordedTransaction } from '../ledger/record';
import type { CheckoutAdjuster } from '../ordering/contract';
import { getOrg } from '../tenancy/orgs';
import { type CodeRow, type CodeView, CODE_COLS, codeAttribution, codeView, effectiveStatus, recordTouch } from './codes';
import { type OfferRow, type OrderChannel, assertOffersOn, loadOffer, offerDiscountCents, offerSummary, venueOffers } from './definitions';
import { offerRedeemed, offerRedemptionRefused, offerReleased, offersModule } from './module';

/**
 * Redeeming a code: online through checkout, at the till when the sale that reaches the ledger
 * carries the code, or by staff against a sale. However it happens, a code is used once.
 */

const props = (offer: OfferRow, row: Pick<CodeRow, 'id'>) => ({ offer_id: offer.id, offer_kind: offer.kind, code_id: row.id });

async function lockCode(ctx: Ctx, where: { id: string } | { code: string }): Promise<CodeRow | null> {
  let q = ctx.db.selectFrom('offer_codes').select(CODE_COLS).forUpdate();
  q = 'id' in where ? q.where('id', '=', where.id) : q.where('code', '=', where.code.trim());
  return ((await q.executeTakeFirst()) as CodeRow | undefined) ?? null;
}

interface UseContext {
  venueId: string;
  customerId: string | null;
  now: Date;
  /** Online order type; null at the till. */
  channel: OrderChannel | null;
  /** Null when the size of the sale is not known (staff marking a code with no sale to hand). */
  subtotalCents: number | null;
  currency: string;
}

/** Why this code cannot be used here and now, in plain words; null when it can. */
function blockedReason(row: CodeRow, offer: OfferRow, use: UseContext): string | null {
  const status = effectiveStatus(row, use.now);
  if (status === 'redeemed') return 'That code has already been used.';
  if (status === 'voided') return 'That code is no longer valid.';
  if (status === 'expired') return 'That code has expired.';
  if (row.customer_id && use.customerId && row.customer_id !== use.customerId) return 'That code belongs to a different guest.';
  if (offer.valid_venue_ids && !offer.valid_venue_ids.includes(use.venueId)) return 'That code cannot be used at this venue.';
  if (use.channel && !offer.channels.includes(use.channel)) return 'That code cannot be used on this kind of order.';
  if (use.subtotalCents !== null && use.subtotalCents < offer.min_spend_cents) return `Spend ${formatMoney(offer.min_spend_cents, use.currency)} or more to use this code.`;
  return null;
}

interface Redemption {
  orderId: string | null;
  transactionId: string | null;
  venueId: string;
  customerId: string | null;
  discountCents: number | null;
  via: 'online' | 'till' | 'staff';
  at: Date;
}

/** Mark a locked, usable code as used. A code nobody owned yet becomes the redeeming guest's. */
async function markRedeemed(ctx: Ctx, row: CodeRow, offer: OfferRow, r: Redemption): Promise<void> {
  const customerId = row.customer_id ?? r.customerId;
  await ctx.db
    .updateTable('offer_codes')
    .set({
      status: 'redeemed',
      customer_id: customerId,
      claimed_at: row.claimed_at ?? r.at,
      redeemed_at: r.at,
      redeemed_order_id: r.orderId,
      redeemed_transaction_id: r.transactionId,
      redeemed_venue_id: r.venueId,
      discount_applied_cents: r.discountCents,
    })
    .where('id', '=', row.id)
    .execute();

  // A code used without ever being claimed: using it is the touch. Attribution for the sale
  // was worked out before we knew, so it is worked out again (it only ever adds a row).
  if (!row.claimed_at && customerId) {
    await recordTouch(ctx, offer, { customer_id: customerId, code: row.code }, r.at);
    if (r.transactionId) await attributeTransaction(ctx, { id: r.transactionId, customerId, occurredAt: r.at });
  }
  await track(
    ctx,
    offerRedeemed,
    { ...props(offer, row), via: r.via, discount_cents: r.discountCents },
    { customerId, venueId: r.venueId, occurredAt: r.at, attribution: codeAttribution(offer, row.code) },
  );
}

/** Give a used code back: the sale it was used on was cancelled or refunded in full. Idempotent. */
async function releaseCode(ctx: Ctx, codeId: string, match: { orderId?: string; transactionId?: string }): Promise<boolean> {
  const row = await lockCode(ctx, { id: codeId });
  if (!row || row.status !== 'redeemed') return false;
  if (match.orderId && row.redeemed_order_id !== match.orderId) return false;
  if (match.transactionId && row.redeemed_transaction_id !== match.transactionId) return false;
  const offer = (await loadOffer(ctx, row.offer_id))!;
  const now = ctx.now();
  // If the guest has been issued a fresh code for the offer in the meantime, that one stands.
  const other = row.customer_id
    ? await ctx.db.selectFrom('offer_codes').select('id').where('offer_id', '=', row.offer_id).where('customer_id', '=', row.customer_id).where('status', 'in', ['issued', 'claimed']).executeTakeFirst()
    : undefined;
  await ctx.db
    .updateTable('offer_codes')
    .set({
      status: other || row.expires_at <= now ? 'expired' : 'claimed',
      redeemed_at: null,
      redeemed_order_id: null,
      redeemed_transaction_id: null,
      redeemed_venue_id: null,
      discount_applied_cents: null,
    })
    .where('id', '=', row.id)
    .execute();
  await track(ctx, offerReleased, props(offer, row), { customerId: row.customer_id, attribution: codeAttribution(offer, row.code) });
  return true;
}

// ── Online, through checkout ────────────────────────────────────────────────

/**
 * Offers' side of checkout (ordering/contract.ts). quote() prices a code against the draft and
 * changes nothing. commit() runs once the order is paid and marks the code used; it refuses a
 * code another order has used in the meantime rather than let one code pay twice. release()
 * gives the code back when a paid order is cancelled or fully refunded.
 */
export const offersAdjuster: CheckoutAdjuster = {
  key: 'offers',

  async quote(ctx, draft, code) {
    // Row-level security means another org's code is simply not here: "not one of yours".
    const row = ((await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('code', '=', code.trim()).executeTakeFirst()) as CodeRow | undefined) ?? null;
    if (!row) return null;
    const config = await venueOffers(ctx, draft.venueId);
    if (!config) return null;
    const offer = (await loadOffer(ctx, row.offer_id))!;
    const currency = (await getOrg(ctx)).currency;

    if (!config.acceptHere) throw invalid('Codes cannot be used at this venue.');
    const blocked = blockedReason(row, offer, { venueId: draft.venueId, customerId: draft.customerId, now: ctx.now(), channel: draft.channel, subtotalCents: draft.subtotalCents, currency });
    if (blocked) throw invalid(blocked);

    let freeItemPrice: number | null = null;
    if (offer.discount_kind === 'free_item' && offer.menu_item_id) {
      const line = draft.lines.find((l) => l.menuItemId === offer.menu_item_id);
      if (!line) throw invalid('Add the free item to your order to use this code.');
      freeItemPrice = line.unitPriceCents;
    }
    const amountCents = offerDiscountCents(offer, draft.subtotalCents, freeItemPrice);
    if (amountCents <= 0) throw invalid('That code gives nothing on this order.');
    return { adjuster: 'offers', code: row.code, label: `${offer.name}: ${offerSummary(offer, currency)}`, amountCents, ref: { codeId: row.id, offerId: offer.id } };
  },

  async commit(ctx, { orderId, venueId, customerId, transactionId, adjustment }) {
    const codeId = adjustment.ref.codeId;
    const row = codeId ? await lockCode(ctx, { id: codeId }) : null;
    if (!row) throw notFound('That code was not found.');
    if (row.status === 'redeemed') {
      // The payment confirmation was replayed: this order already used it.
      if (row.redeemed_order_id === orderId) return;
      throw conflict('That code has already been used.');
    }
    if (row.status === 'voided') throw conflict('That code is no longer valid.');
    const now = ctx.now();
    // The order was priced while the code was good; a few minutes at the payment page do not lose it.
    const grace = ((await venueOffers(ctx, venueId)) ?? offersModule.defaultConfig).paymentGraceMinutes * 60_000;
    if (row.expires_at.getTime() + grace <= now.getTime()) throw conflict('That code has expired.');
    if (row.customer_id && customerId && row.customer_id !== customerId) throw conflict('That code belongs to a different guest.');
    const offer = (await loadOffer(ctx, row.offer_id))!;
    await markRedeemed(ctx, row, offer, { orderId, transactionId, venueId, customerId, discountCents: adjustment.amountCents, via: 'online', at: now });
  },

  async release(ctx, { orderId, adjustment }) {
    const codeId = adjustment.ref.codeId;
    if (codeId) await releaseCode(ctx, codeId, { orderId });
  },
};

// ── At the till, from the ledger ────────────────────────────────────────────

const CODE_TOKEN = /[A-Z0-9]{2,}(?:-[A-Z0-9]+)+/gi;

/** Everything in a sale's discounts that could be one of our codes: the code field, the name, and code-shaped words in the name. */
function candidateCodes(discounts: RecordedInfo['discounts']): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of discounts) {
    const texts = [d.code?.trim(), d.name?.trim(), ...(d.name?.match(CODE_TOKEN) ?? [])].filter((s): s is string => !!s && s.length >= 4 && s.length <= 40);
    for (const t of texts) if (!out.has(t.toUpperCase())) out.set(t.toUpperCase(), d.amountCents);
  }
  return out;
}

/**
 * A sale has reached the ledger. If its discounts carry one of our codes, that code is now
 * used. A code that should not have been accepted (expired, already used, another guest's) is
 * not marked: the till gave the discount, and the refusal is recorded so the venue can see it.
 */
export async function redeemFromSale(ctx: Ctx, txn: RecordedTransaction, info: RecordedInfo): Promise<number> {
  if (txn.orderId) {
    // An order placed on this platform redeemed through checkout; tie its code to the sale for reporting.
    await ctx.db.updateTable('offer_codes').set({ redeemed_transaction_id: txn.id }).where('redeemed_order_id', '=', txn.orderId).where('redeemed_transaction_id', 'is', null).execute();
  }
  if (!info.created && (txn.status === 'refunded' || txn.status === 'voided')) {
    const used = await ctx.db.selectFrom('offer_codes').select('id').where('redeemed_transaction_id', '=', txn.id).where('status', '=', 'redeemed').execute();
    for (const u of used) await releaseCode(ctx, u.id, { transactionId: txn.id });
    return 0;
  }
  if (txn.orderId || !info.discounts.length) return 0;
  if (txn.status !== 'completed' && txn.status !== 'partially_refunded') return 0;

  const candidates = candidateCodes(info.discounts);
  if (!candidates.size) return 0;
  const found = (await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('code', 'in', [...candidates.keys()].slice(0, 40)).forUpdate().execute()) as CodeRow[];
  if (!found.length) return 0;
  const config = await venueOffers(ctx, txn.venueId);
  if (!config || !config.acceptHere || !config.matchTillDiscounts) return 0;

  let redeemed = 0;
  for (const row of found) {
    if (row.status === 'redeemed' && row.redeemed_transaction_id === txn.id) continue;
    const offer = (await loadOffer(ctx, row.offer_id))!;
    const status = effectiveStatus(row, txn.occurredAt);
    const refusal =
      status === 'redeemed'
        ? 'used'
        : status === 'voided'
          ? 'voided'
          : status === 'expired'
            ? 'expired'
            : row.customer_id && txn.customerId && row.customer_id !== txn.customerId
              ? 'other_customer'
              : offer.valid_venue_ids && !offer.valid_venue_ids.includes(txn.venueId)
                ? 'venue'
                : null;
    if (refusal) {
      if (info.created) {
        await track(ctx, offerRedemptionRefused, { ...props(offer, row), reason: refusal, transaction_id: txn.id }, { customerId: txn.customerId, venueId: txn.venueId, occurredAt: txn.occurredAt, attribution: codeAttribution(offer, row.code) });
      }
      continue;
    }
    await markRedeemed(ctx, row, offer, {
      orderId: null,
      transactionId: txn.id,
      venueId: txn.venueId,
      customerId: txn.customerId,
      discountCents: candidates.get(row.code.toUpperCase()) ?? null,
      via: 'till',
      at: txn.occurredAt,
    });
    redeemed++;
  }
  return redeemed;
}

// ── At the counter, by staff ────────────────────────────────────────────────

export interface CodeCheck {
  code: CodeView;
  usable: boolean;
  /** Why not, in plain words. */
  reason: string | null;
  /** Guest-written. Render as text. */
  guestName: string | null;
}

export const checkCodeInput = z.object({ venueId: z.string().uuid(), code: z.string().trim().min(4).max(40) });

/** The counter screen: is this code good here, what does it give, whose is it? Changes nothing. */
export async function checkCode(ctx: Ctx, raw: z.input<typeof checkCodeInput>): Promise<CodeCheck> {
  const input = checkCodeInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertOffersOn(ctx, input.venueId);
  const row = ((await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('code', '=', input.code).executeTakeFirst()) as CodeRow | undefined) ?? null;
  if (!row) throw notFound('That code was not found.');
  const offer = (await loadOffer(ctx, row.offer_id))!;
  const now = ctx.now();
  const currency = (await getOrg(ctx)).currency;
  const reason = !config.acceptHere
    ? 'Codes cannot be used at this venue.'
    : blockedReason(row, offer, { venueId: input.venueId, customerId: null, now, channel: null, subtotalCents: null, currency });
  const guest = row.customer_id ? await ctx.db.selectFrom('customers').select(['first_name', 'last_name']).where('id', '=', row.customer_id).executeTakeFirst() : null;
  return {
    code: codeView(row, offer, now, currency),
    usable: reason === null,
    reason,
    guestName: guest ? [guest.first_name, guest.last_name].filter(Boolean).join(' ') || null : null,
  };
}

export const redeemAtCounterInput = z.object({
  venueId: z.string().uuid(),
  code: z.string().trim().min(4).max(40),
  /** The sale the code was used on, when staff can point at it. */
  transactionId: z.string().uuid().optional(),
});

/**
 * Front of house marks a code used, for a till that cannot carry the code on the sale. Single
 * use is enforced here exactly as it is online. Audited.
 */
export async function redeemCodeAtCounter(ctx: Ctx, raw: z.input<typeof redeemAtCounterInput>): Promise<CodeView> {
  const input = redeemAtCounterInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertOffersOn(ctx, input.venueId);
  if (!config.acceptHere) throw invalid('Codes cannot be used at this venue.');
  if (!config.staffRedeem) throw forbidden('Marking codes by hand is switched off at this venue.');

  const row = await lockCode(ctx, { code: input.code });
  if (!row) throw notFound('That code was not found.');
  const offer = (await loadOffer(ctx, row.offer_id))!;
  const now = ctx.now();
  const currency = (await getOrg(ctx)).currency;

  let sale: { id: string; customer_id: string | null; subtotal_cents: number; discount_cents: number; occurred_at: Date } | null = null;
  if (input.transactionId) {
    sale = (await ctx.db.selectFrom('transactions').select(['id', 'customer_id', 'subtotal_cents', 'discount_cents', 'occurred_at']).where('id', '=', input.transactionId).where('venue_id', '=', input.venueId).executeTakeFirst()) ?? null;
    if (!sale) throw notFound('Sale not found');
  }
  const blocked = blockedReason(row, offer, { venueId: input.venueId, customerId: sale?.customer_id ?? null, now, channel: null, subtotalCents: sale?.subtotal_cents ?? null, currency });
  if (blocked) throw conflict(blocked);

  const discountCents = sale ? (sale.discount_cents > 0 ? sale.discount_cents : offerDiscountCents(offer, sale.subtotal_cents)) : offer.discount_kind === 'fixed' ? offer.value_cents : null;
  await markRedeemed(ctx, row, offer, { orderId: null, transactionId: sale?.id ?? null, venueId: input.venueId, customerId: sale?.customer_id ?? null, discountCents, via: 'staff', at: now });
  await audit(ctx, { action: 'offer.code_redeemed_by_staff', entityType: 'offer_code', entityId: row.id, venueId: input.venueId, before: { status: row.status }, after: { status: 'redeemed', transactionId: sale?.id ?? null } });
  const fresh = (await ctx.db.selectFrom('offer_codes').select(CODE_COLS).where('id', '=', row.id).executeTakeFirstOrThrow()) as CodeRow;
  return codeView(fresh, offer, now, currency);
}
