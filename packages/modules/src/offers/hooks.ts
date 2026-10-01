import type { Ctx } from '@ros/core';
import { onCustomerErase, registerCustomerDataProvider } from '../identity/customers';
import { onCustomerMerge } from '../identity/merge';
import { onTransactionRecorded } from '../ledger/record';
import { registerCheckoutAdjuster } from '../ordering/contract';
import { offersAdjuster, redeemFromSale } from './redeem';

/**
 * Where offers plug into the rest of the platform. Each handler runs inside someone else's
 * transaction, is idempotent, and returns quietly when there is nothing for it to do.
 */

// In-venue redemption and refunds follow the ledger.
onTransactionRecorded(async (ctx, txn, info) => {
  if (!txn.orderId && !info.discounts.length && info.created) return;
  await redeemFromSale(ctx, txn, info);
});

registerCheckoutAdjuster(offersAdjuster);

// Two records turned out to be one person: the winner holds the codes. Where both held a live
// code for the same offer, the winner's stands and the other is cancelled (one live code per guest).
onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  const theirs = await ctx.db.selectFrom('offer_codes').select(['id', 'offer_id', 'status']).where('customer_id', '=', loserId).execute();
  if (!theirs.length) return;
  const mine = await ctx.db.selectFrom('offer_codes').select(['offer_id']).where('customer_id', '=', winnerId).where('status', 'in', ['issued', 'claimed']).execute();
  const held = new Set(mine.map((m) => m.offer_id));
  for (const c of theirs) {
    const live = c.status === 'issued' || c.status === 'claimed';
    if (live && held.has(c.offer_id)) {
      await ctx.db.updateTable('offer_codes').set({ status: 'voided', voided_at: ctx.now(), void_reason: 'Duplicate after two guest records were merged', customer_id: winnerId }).where('id', '=', c.id).execute();
    } else {
      await ctx.db.updateTable('offer_codes').set({ customer_id: winnerId }).where('id', '=', c.id).execute();
      if (live) held.add(c.offer_id);
    }
  }
});

// A guest asked to be forgotten: their unused codes are cancelled, and every code they ever
// held is unlinked from them. The counts the venue reports on are not the guest's data.
onCustomerErase(async (ctx, customerId) => {
  await ctx.db
    .updateTable('offer_codes')
    .set({ status: 'voided', voided_at: ctx.now(), void_reason: 'Guest erased' })
    .where('customer_id', '=', customerId)
    .where('status', 'in', ['issued', 'claimed'])
    .execute();
  await ctx.db.updateTable('offer_codes').set({ customer_id: null }).where('customer_id', '=', customerId).execute();
});

// What the guest's data export says about the offers they were sent.
registerCustomerDataProvider('offers', async (ctx: Ctx, customerId: string) =>
  ctx.db
    .selectFrom('offer_codes as c')
    .innerJoin('offers as o', 'o.id', 'c.offer_id')
    .select(['o.name as offer', 'c.code', 'c.status', 'c.source', 'c.issued_at', 'c.claimed_at', 'c.redeemed_at', 'c.expires_at'])
    .where('c.customer_id', '=', customerId)
    .orderBy('c.issued_at')
    .execute(),
);
