import { z } from 'zod';
import { type Ctx, AppError, assertModule, formatMoney, isAppError, notFound, percentOf, taxIncluded, taxOn } from '@ros/core';
import { getOrderableItems } from '../menu/public';
import { getOrg } from '../tenancy/orgs';
import { type Adjustment, type DraftOrder, type TableContext, checkoutAdjusters, getDeliveryPricing, getTableOrdering } from './contract';
import { type OrderingConfig, orderingModule } from './module';
import { type Timing, resolveTiming } from './slots';

/**
 * The server prices everything. The browser sends item ids, modifier ids, quantities and codes;
 * every name, price, discount, tax and total below comes from the menu and the venue's config
 * (docs/THREAT_MODEL.md section 6, "Ordering abuse"). Unknown keys in the input, such as a
 * price the client made up, are dropped by the schema and never read.
 */

export const cartLineInput = z.object({
  menuItemId: z.string().uuid(),
  qty: z.number().int().min(1).max(99),
  modifierIds: z.array(z.string().uuid()).max(30).default([]),
  /** Guest-written. Shown to the kitchen as text. */
  note: z.string().trim().max(200).nullish(),
});

export const cartInput = z.object({
  venueId: z.string().uuid(),
  channel: z.enum(['pickup', 'delivery', 'dine-in-qr']).default('pickup'),
  lines: z.array(cartLineInput).min(1).max(60),
  codes: z.array(z.string().trim().min(1).max(60)).max(5).default([]),
  /** The guest's own choice, within the venue's limits. Not a price. */
  tipCents: z.number().int().min(0).max(1_000_000).default(0),
  /** The start of a slot from getPickupSlots, or null for as soon as possible. */
  slotStart: z.string().datetime().nullish(),
  /** The code the guest scanned, for a table order. */
  qrCode: z.string().trim().min(4).max(40).nullish(),
  /** A delivery quote saved by the delivery module, for a delivery order. */
  deliveryId: z.string().uuid().nullish(),
});
export type CartInput = z.infer<typeof cartInput>;

export interface PricedModifier {
  id: string;
  group: string;
  name: string;
  priceDeltaCents: number;
}

export interface PricedLine {
  menuItemId: string;
  name: string;
  category: string | null;
  qty: number;
  /** Item price plus chosen modifiers, per unit. */
  unitPriceCents: number;
  lineTotalCents: number;
  modifiers: PricedModifier[];
  note: string | null;
  allergens: string[];
  isAlcohol: boolean;
  prepMinutes: number;
}

export type CartIssueCode =
  | 'unavailable'
  | 'not_served'
  | 'modifier_required'
  | 'modifier_limit'
  | 'max_per_order'
  | 'alcohol_excluded'
  | 'min_order'
  | 'tip'
  | 'timing'
  | 'delivery';

export interface CartIssue {
  code: CartIssueCode;
  /** Plain words, safe to show the guest. */
  message: string;
  /** Which line of the cart it concerns, when it concerns one. */
  lineIndex?: number;
}

export interface PricedCart {
  venueId: string;
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  currency: string;
  taxInclusive: boolean;
  lines: PricedLine[];
  itemCount: number;
  /** The longest prep time in the cart. */
  prepMinutes: number;
  subtotalCents: number;
  adjustments: Adjustment[];
  /** Codes that gave nothing, with the reason in plain words. */
  rejectedCodes: Array<{ code: string; reason: string }>;
  discountCents: number;
  /** Tax contained in the total (inclusive pricing) or added to it (exclusive). */
  taxCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  timing: Timing | null;
  table: { label: string | null } | null;
  tipping: { enabled: boolean; presets: number[] };
  /** Everything that stops this cart being ordered as it stands. Empty = orderable. */
  issues: CartIssue[];
  orderable: boolean;
}

export interface BuiltCart extends PricedCart {
  config: OrderingConfig;
  tableContext: TableContext | null;
  deliveryId: string | null;
}

function unavailable(): AppError {
  return new AppError('module_disabled', 'That is not available at this venue.');
}

/** Price a cart. Shared by priceCart (the cart page) and createOrder (which refuses any issue). */
export async function buildCart(ctx: Ctx, input: CartInput, opts: { customerId: string | null; excludeOrderId?: string | null }): Promise<BuiltCart> {
  const cfg = await assertModule(ctx, input.venueId, orderingModule);
  const org = await getOrg(ctx);
  const now = ctx.now();
  const issues: CartIssue[] = [];

  // The channel decides the surface, the alcohol rule and the tipping rule.
  let tableContext: TableContext | null = null;
  let excludeAlcohol = cfg.exclude_alcohol;
  let tipping = { enabled: cfg.tipping_enabled, presets: cfg.tip_presets };
  if (input.channel === 'pickup') {
    if (!cfg.pickup_enabled) throw unavailable();
  } else if (input.channel === 'dine-in-qr') {
    const tables = getTableOrdering();
    if (!tables || !input.qrCode) throw notFound('That table code was not found.');
    tableContext = await tables.resolveForOrder(ctx, { venueId: input.venueId, code: input.qrCode });
    excludeAlcohol = tableContext.excludeAlcohol;
    tipping = { enabled: tableContext.tippingEnabled, presets: tableContext.tipPresets };
  } else if (!getDeliveryPricing() || !input.deliveryId) {
    throw unavailable();
  }

  const slotStart = input.channel === 'dine-in-qr' || !input.slotStart ? null : new Date(input.slotStart);
  const menuAt = slotStart ?? now;
  const items = await getOrderableItems(ctx, input.venueId, input.lines.map((l) => l.menuItemId), {
    surface: input.channel === 'dine-in-qr' ? 'in_venue' : 'online',
    at: menuAt,
  });

  const lines: PricedLine[] = [];
  const qtyByItem = new Map<string, number>();
  input.lines.forEach((l, lineIndex) => {
    const item = items.get(l.menuItemId);
    // Another org's id, another venue's, a removed or hidden item: all the same answer.
    if (!item) throw notFound('Menu item not found');

    const chosen: PricedModifier[] = [];
    const wanted = new Set(l.modifierIds);
    for (const g of item.modifierGroups) {
      const picked = g.modifiers.filter((m) => wanted.has(m.id));
      for (const m of picked) {
        wanted.delete(m.id);
        chosen.push({ id: m.id, group: g.name, name: m.name, priceDeltaCents: m.priceDeltaCents });
        if (!m.isAvailable) issues.push({ code: 'unavailable', lineIndex, message: `${m.name} is not available with ${item.name} right now.` });
      }
      if (picked.length < g.minSelections) {
        issues.push({
          code: 'modifier_required',
          lineIndex,
          message: g.minSelections === 1 ? `Choose an option for "${g.name}" on ${item.name}.` : `Choose at least ${g.minSelections} for "${g.name}" on ${item.name}.`,
        });
      }
      if (picked.length > g.maxSelections) {
        issues.push({ code: 'modifier_limit', lineIndex, message: `Choose at most ${g.maxSelections} for "${g.name}" on ${item.name}.` });
      }
    }
    // A modifier that is not one of this item's own.
    if (wanted.size) throw notFound('Modifier not found');

    if (!item.isServed) issues.push({ code: 'not_served', lineIndex, message: `${item.name} is not being served at that time.` });
    else if (!item.isAvailable) issues.push({ code: 'unavailable', lineIndex, message: `${item.name} is sold out.` });
    if (excludeAlcohol && item.isAlcohol) {
      issues.push({
        code: 'alcohol_excluded',
        lineIndex,
        message: input.channel === 'dine-in-qr' ? `${item.name} cannot be ordered from the table. Ask our staff.` : `${item.name} is not available to order online.`,
      });
    }
    const total = (qtyByItem.get(item.id) ?? 0) + l.qty;
    qtyByItem.set(item.id, total);
    if (item.maxPerOrder !== null && total > item.maxPerOrder && total - l.qty <= item.maxPerOrder) {
      issues.push({ code: 'max_per_order', lineIndex, message: `At most ${item.maxPerOrder} of ${item.name} per order.` });
    }

    const unit = Math.max(0, item.priceCents + chosen.reduce((s, m) => s + m.priceDeltaCents, 0));
    lines.push({
      menuItemId: item.id,
      name: item.name,
      category: item.category,
      qty: l.qty,
      unitPriceCents: unit,
      lineTotalCents: unit * l.qty,
      modifiers: chosen,
      note: l.note?.length ? l.note : null,
      allergens: item.allergens,
      isAlcohol: item.isAlcohol,
      prepMinutes: item.prepMinutes,
    });
  });

  const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const itemCount = lines.reduce((s, l) => s + l.qty, 0);
  const prepMinutes = lines.reduce((m, l) => Math.max(m, l.prepMinutes), 0);

  if (input.channel === 'pickup' && subtotal < cfg.min_order_cents) {
    issues.push({ code: 'min_order', message: `The smallest order here is ${formatMoney(cfg.min_order_cents, org.currency)}.` });
  }

  // Codes: each registered adjuster is asked in turn; the first to recognise a code prices it.
  const adjustments: Adjustment[] = [];
  const rejectedCodes: PricedCart['rejectedCodes'] = [];
  const seen = new Set<string>();
  let remaining = subtotal;
  const draft: DraftOrder = {
    venueId: input.venueId,
    channel: input.channel,
    customerId: opts.customerId,
    lines: lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, category: l.category, qty: l.qty, unitPriceCents: l.unitPriceCents, lineTotalCents: l.lineTotalCents, isAlcohol: l.isAlcohol })),
    subtotalCents: subtotal,
    at: now,
  };
  for (const code of input.codes) {
    const key = code.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!cfg.promo_codes_enabled) {
      rejectedCodes.push({ code, reason: 'Codes cannot be used on orders here.' });
      continue;
    }
    let found: Adjustment | null = null;
    let reason = 'That code is not valid.';
    for (const adjuster of checkoutAdjusters()) {
      try {
        const a = await adjuster.quote(ctx, draft, code);
        if (a) {
          found = a;
          break;
        }
      } catch (e) {
        if (!isAppError(e) || e.code !== 'invalid') throw e;
        reason = e.message;
        found = null;
        break;
      }
    }
    if (!found) {
      rejectedCodes.push({ code, reason });
      continue;
    }
    // Whatever an adjuster says, a discount is whole cents, positive, and never more than is left.
    const amount = Math.min(Math.max(0, Math.trunc(found.amountCents)), remaining);
    if (amount <= 0) {
      rejectedCodes.push({ code, reason: 'That code gives nothing on this order.' });
      continue;
    }
    remaining -= amount;
    adjustments.push({ adjuster: found.adjuster, code: found.code, label: found.label, amountCents: amount, ref: found.ref });
  }
  const discount = subtotal - remaining;

  let deliveryFee = 0;
  if (input.channel === 'delivery') {
    const quote = await getDeliveryPricing()!.getQuote(ctx, {
      deliveryId: input.deliveryId!,
      venueId: input.venueId,
      subtotalCents: subtotal - discount,
      containsAlcohol: lines.some((l) => l.isAlcohol),
    });
    // A stale quote is never charged: the guest checks the address again and gets a fresh one.
    if (!quote || quote.expiresAt <= now) issues.push({ code: 'delivery', message: 'That delivery quote has expired. Check the address again.' });
    else if (quote.issue) issues.push({ code: 'delivery', message: quote.issue });
    else deliveryFee = quote.customerFeeCents;
  }

  let tip = input.tipCents;
  if (tip > 0 && !tipping.enabled) {
    issues.push({ code: 'tip', message: 'Tips cannot be added to orders here.' });
    tip = 0;
  } else if (tip > percentOf(subtotal, cfg.max_tip_percent)) {
    issues.push({ code: 'tip', message: `A tip can be at most ${cfg.max_tip_percent}% of the order.` });
    tip = 0;
  }

  const taxable = subtotal - discount + deliveryFee;
  const tax = org.taxInclusive ? taxIncluded(taxable, org.taxRateBp) : taxOn(taxable, org.taxRateBp);
  const total = taxable + (org.taxInclusive ? 0 : tax) + tip;

  let timing: Timing | null = null;
  const t = await resolveTiming(ctx, cfg, input.venueId, {
    slotStart,
    itemCount,
    prepMinutes,
    tableOrder: input.channel === 'dine-in-qr',
    excludeOrderId: opts.excludeOrderId,
  });
  if (t.ok) timing = t.timing;
  else issues.push({ code: 'timing', message: t.message });

  return {
    venueId: input.venueId,
    channel: input.channel,
    currency: org.currency,
    taxInclusive: org.taxInclusive,
    lines,
    itemCount,
    prepMinutes,
    subtotalCents: subtotal,
    adjustments,
    rejectedCodes,
    discountCents: discount,
    taxCents: tax,
    tipCents: tip,
    deliveryFeeCents: deliveryFee,
    totalCents: total,
    timing,
    table: tableContext ? { label: tableContext.tableLabel } : null,
    tipping,
    issues,
    orderable: issues.length === 0,
    config: cfg,
    tableContext,
    deliveryId: input.channel === 'delivery' ? (input.deliveryId ?? null) : null,
  };
}

/**
 * Price a cart for the cart and checkout pages. Public: no role check. Problems a guest can
 * fix (a sold-out item, a missing choice, a full slot, a code that does not apply) come back
 * as `issues` and `rejectedCodes`; an id that is not this venue's is not found.
 */
export async function priceCart(ctx: Ctx, raw: z.input<typeof cartInput>): Promise<PricedCart> {
  const input = cartInput.parse(raw);
  const customerId = ctx.principal.kind === 'guest' ? ctx.principal.customerId : null;
  const { config: _config, tableContext: _table, deliveryId: _delivery, ...cart } = await buildCart(ctx, input, { customerId });
  return cart;
}
