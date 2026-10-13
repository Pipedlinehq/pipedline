import { type Ctx, getModule } from '@ros/core';
import { automaticAdjustments } from '../offers/eligibility';
import { offersModule } from '../offers/module';
import { codeCombinesWith } from '../offers/redeem';
import { applicableSurcharges, percentWords, surchargeAmountCents, surchargeNotice as offersSurchargeNotice } from '../offers/surcharges';
import type { Adjustment, AppliedSurcharge, DraftOrder } from './contract';

/**
 * The bill: what comes off a total by itself and what goes on it by law, between the lines a
 * guest chose and the tax (docs/CONSOLE_IA.md section 9, pattern 6; docs/modules/offers.md
 * sections 2 and 4). The offers module owns the rules (who, when, how often, what combines) and
 * prices them; this file is where ordering asks, in one place, so `buildCart` (the quote and
 * every checkout) and `planDraftOrder` (phone and function orders) add the same lines:
 *
 *   subtotal − codes − automatic offers → + surcharges → + delivery → tax → + tip = total
 *
 * Everything applies only where the offers plugin is switched on for the venue: a venue that
 * has not turned it on has no automatic offers and no surcharges, whatever rows exist org-wide.
 * The offers module refuses to set up a card-payment surcharge, so none can reach a bill here.
 */

/** Whether the offers plugin is on at this venue. */
export async function offersOnAt(ctx: Ctx, venueId: string): Promise<boolean> {
  return (await getModule(ctx, venueId, offersModule)).enabled;
}

/**
 * Why a code the guest typed cannot sit beside what is already on the bill (an earlier code, a
 * loyalty reward), in plain words; null when it can, or when the code is not an offer's.
 * `quote()` on the adjuster cannot see the other adjustments, so the question is asked here.
 */
export async function codeClash(ctx: Ctx, code: string, applied: Adjustment[]): Promise<string | null> {
  if (!applied.length) return null;
  return codeCombinesWith(ctx, code, applied);
}

/**
 * The automatic offers that apply to this draft, as adjustments, after the codes. Each is capped
 * the way a code's discount is: whole cents, positive, and never more than is left to come off
 * (the food after what is already off, plus the delivery fee for a delivery order, which a
 * "free delivery" offer comes off). Changes nothing; the uses are recorded when the order is paid.
 */
export async function automaticOffers(ctx: Ctx, draft: DraftOrder, applied: Adjustment[], opts: { deliveryFeeCents: number }): Promise<Adjustment[]> {
  const found = await automaticAdjustments(ctx, draft, applied, { deliveryFeeCents: opts.deliveryFeeCents });
  const out: Adjustment[] = [];
  let left = Math.max(0, draft.subtotalCents + opts.deliveryFeeCents - applied.reduce((s, a) => s + a.amountCents, 0));
  for (const a of found) {
    const amount = Math.min(Math.max(0, Math.trunc(a.amountCents)), left);
    if (amount <= 0) continue;
    left -= amount;
    out.push({ adjuster: a.adjuster, code: a.code, label: a.label, amountCents: amount, ref: a.ref });
  }
  return out;
}

/**
 * The surcharges in force at the venue for the day the order is for (the pickup slot, the wanted
 * time, else now), each priced on the bill after discounts. A surcharge is a percentage of the
 * food and drink, not of the delivery fee or the tip.
 */
export async function surchargesFor(ctx: Ctx, venueId: string, at: Date, baseCents: number): Promise<AppliedSurcharge[]> {
  if (!(await offersOnAt(ctx, venueId))) return [];
  const base = Math.max(0, baseCents);
  return (await applicableSurcharges(ctx, venueId, at)).map((s) => ({ id: s.id, name: s.name, percentBp: s.percentBp, reason: s.reason, notice: s.notice, amountCents: surchargeAmountCents(base, s.percentBp) }));
}

/**
 * The notice the menu page and the order page carry for every active surcharge at the venue:
 * "A surcharge of 10% applies on Sundays." Public (it is what a menu says); null when the offers
 * plugin is off at the venue or it has none.
 */
export async function surchargeNotice(ctx: Ctx, venueId: string): Promise<string | null> {
  if (!(await offersOnAt(ctx, venueId))) return null;
  return offersSurchargeNotice(ctx, venueId);
}

/** The line a docket and a receipt print for a surcharge: "Sunday surcharge (10%, Sunday)". */
export const surchargeLabel = (s: Pick<AppliedSurcharge, 'name' | 'percentBp' | 'reason'>): string => `${s.name} (${percentWords(s.percentBp)}, ${s.reason})`;

/** The notices to print once each, under the figures. */
export const surchargeNotices = (surcharges: Array<Pick<AppliedSurcharge, 'notice'>>): string[] => [...new Set(surcharges.map((s) => s.notice))];

// ── The breakdown every surface prints ──────────────────────────────────────

export type TotalsLineKind = 'subtotal' | 'adjustment' | 'surcharge' | 'delivery' | 'tip' | 'tax' | 'total' | 'refunded';

/** One line of a bill, as the quote, the order, the docket and the guest's receipt all print it. */
export interface TotalsLine {
  kind: TotalsLineKind;
  /** What the guest and the kitchen read: "Subtotal", the offer's name and plain-words summary, "Sunday surcharge (10%, Sunday)". */
  label: string;
  /** Always a positive figure; `sign` says whether it comes off. */
  amountCents: number;
  sign: 1 | -1;
  /** The legal line a surcharge carries, printed under the figures. */
  notice?: string;
  /** The code behind an adjustment (a typed code, or auto:<offerId>). */
  code?: string;
}

export interface Billed {
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  subtotalCents: number;
  adjustments: Array<Pick<Adjustment, 'code' | 'label' | 'amountCents'>>;
  surcharges: AppliedSurcharge[];
  deliveryFeeCents: number;
  tipCents: number;
  taxCents: number;
  taxInclusive: boolean;
  totalCents: number;
  refundedCents?: number;
}

/**
 * The lines of a bill in the order they are read: subtotal, each offer as its own line, each
 * surcharge as its own line, delivery, tip, tax, total, and what was refunded. One function, so
 * the quote, the order page, the console docket, the kitchen ticket and the receipt agree.
 */
export function totalsBreakdown(b: Billed): TotalsLine[] {
  const lines: TotalsLine[] = [{ kind: 'subtotal', label: 'Subtotal', amountCents: b.subtotalCents, sign: 1 }];
  for (const a of b.adjustments) lines.push({ kind: 'adjustment', label: a.label, amountCents: a.amountCents, sign: -1, code: a.code });
  for (const s of b.surcharges) lines.push({ kind: 'surcharge', label: surchargeLabel(s), amountCents: s.amountCents, sign: 1, notice: s.notice });
  if (b.channel === 'delivery') lines.push({ kind: 'delivery', label: 'Delivery', amountCents: b.deliveryFeeCents, sign: 1 });
  if (!b.taxInclusive) lines.push({ kind: 'tax', label: 'GST', amountCents: b.taxCents, sign: 1 });
  if (b.tipCents > 0) lines.push({ kind: 'tip', label: 'Tip', amountCents: b.tipCents, sign: 1 });
  lines.push({ kind: 'total', label: 'Total', amountCents: b.totalCents, sign: 1 });
  if (b.taxInclusive) lines.push({ kind: 'tax', label: 'Includes GST of', amountCents: b.taxCents, sign: 1 });
  if (b.refundedCents && b.refundedCents > 0) lines.push({ kind: 'refunded', label: 'Refunded', amountCents: b.refundedCents, sign: -1 });
  return lines;
}
