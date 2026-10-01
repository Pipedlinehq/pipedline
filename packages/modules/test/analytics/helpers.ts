import type { CanonicalTransaction } from '@ros/core';

export const WORKER = { kind: 'worker' as const, job: 'test' };

/** A plain $59.00 dine-in sale (GST $5.36 included), for tests that need to add to the ledger. */
export function sale(ref: string, occurredAt: string | Date, over: Partial<CanonicalTransaction> = {}): CanonicalTransaction {
  return {
    source: 'sim',
    externalRef: ref,
    occurredAt: new Date(occurredAt),
    channel: 'dine-in',
    status: 'completed',
    subtotalCents: 5900,
    discountCents: 0,
    taxCents: 536,
    tipCents: 0,
    totalCents: 5900,
    refundedCents: 0,
    currency: 'AUD',
    tenderType: 'card',
    lines: [
      { lineNo: 1, name: 'Wagyu rump 250g', category: 'Mains', qty: 1, unitPriceCents: 4800, modifiers: [], discountCents: 0, taxCents: 436, totalCents: 4800 },
      { lineNo: 2, name: 'Fries, aioli', category: 'Sides', qty: 1, unitPriceCents: 1100, modifiers: [], discountCents: 0, taxCents: 100, totalCents: 1100 },
    ],
    identityHints: [],
    ...over,
  };
}
export const SALE_NET = 5900 - 536;
