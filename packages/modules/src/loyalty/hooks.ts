import type { Ctx } from '@ros/core';
import { onCustomerErase, registerCustomerDataProvider } from '../identity/customers';
import { onCustomerMerge } from '../identity/merge';
import { onTransactionRecorded } from '../ledger/record';
import { onOrderStatusChanged, registerCheckoutAdjuster } from '../ordering/contract';
import { backfillForCustomer, earnForSale } from './earning';
import { enrolFromCheckout } from './enrol';
import { loyaltyModule } from './module';
import { ACCOUNT_COLS, activeProgram, balanceOf, evaluateTier, lockAccount, writePoints } from './points';
import { linkOrderSale, loyaltyAdjuster, matchSaleToRedemptions, releaseForRefundedSale } from './redemption';

/**
 * Where loyalty plugs into the rest of the platform. Everything here runs inside someone
 * else's transaction (a sale being recorded, an order changing status, a merge, an erasure),
 * so each handler is idempotent and returns quietly when loyalty has nothing to do.
 */

// Earning, counter-redemption matching and refunds all follow the ledger.
onTransactionRecorded(async (ctx, txn, info) => {
  await linkOrderSale(ctx, txn);
  if (!info.created) await releaseForRefundedSale(ctx, txn);
  const redeemer = await matchSaleToRedemptions(ctx, txn, info);
  // A brand-new sale with no customer has nothing to earn and nothing earned to reverse,
  // unless it just paid for a member's counter code, in which case we know whose it is.
  if (info.created && !txn.customerId && !redeemer) return;
  await earnForSale(
    ctx,
    {
      id: txn.id,
      venueId: txn.venueId,
      customerId: txn.customerId,
      occurredAt: txn.occurredAt,
      channel: txn.channel,
      status: txn.status,
      totalCents: txn.totalCents,
      refundedCents: txn.refundedCents,
      subtotalCents: txn.subtotalCents,
      discountCents: txn.discountCents,
    },
    { account: txn.customerId ? undefined : redeemer, fresh: info.created },
  );
});

registerCheckoutAdjuster(loyaltyAdjuster);

// The guest ticked "join the loyalty programme" at checkout: enrol them once the order is paid.
onOrderStatusChanged(enrolFromCheckout);

// Two records turned out to be one person. By now the identity spine has moved the loser's
// identities and sales to the winner.
onCustomerMerge(async (ctx, { winnerId, loserId }) => {
  const losing = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('customer_id', '=', loserId).execute();
  for (const from of losing) {
    const into = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('customer_id', '=', winnerId).where('program_id', '=', from.program_id).executeTakeFirst();
    if (!into) {
      // Only the loser was a member: the account, with its whole ledger, becomes the winner's.
      await ctx.db.updateTable('loyalty_accounts').set({ customer_id: winnerId }).where('id', '=', from.id).execute();
      continue;
    }
    // Both were members: the winner's account survives. The ledger is append-only, so the
    // loser's balance crosses as a transfer pair rather than by rewriting history.
    const [first, second] = [from.id, into.id].sort();
    await lockAccount(ctx, first!);
    await lockAccount(ctx, second!);
    const balance = await balanceOf(ctx, from.id);
    if (balance !== 0) {
      await writePoints(ctx, { accountId: from.id, kind: 'transfer', points: -balance, key: `merge:${from.id}:out`, note: 'Merged into another membership' });
      await writePoints(ctx, { accountId: into.id, kind: 'transfer', points: balance, key: `merge:${from.id}:in`, note: 'Merged from another membership' });
    }
    await ctx.db.updateTable('redemptions').set({ account_id: into.id }).where('account_id', '=', from.id).execute();
    await ctx.db.updateTable('loyalty_accounts').set({ status: 'closed', tier_id: null }).where('id', '=', from.id).execute();
    if (from.status === 'active' && into.status === 'closed') await ctx.db.updateTable('loyalty_accounts').set({ status: 'active' }).where('id', '=', into.id).execute();
    if (from.enrolled_at < into.enrolled_at) await ctx.db.updateTable('loyalty_accounts').set({ enrolled_at: from.enrolled_at }).where('id', '=', into.id).execute();
  }

  // Sales the other record brought with it earn now, if they have not already.
  const program = await activeProgram(ctx);
  if (!program) return;
  const account = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('customer_id', '=', winnerId).where('program_id', '=', program.id).executeTakeFirst();
  if (!account || account.status !== 'active') return;
  const lookbackMs = loyaltyModule.defaultConfig.earnLookbackHours * 3_600_000;
  await backfillForCustomer(ctx, program, account, { since: new Date(account.enrolled_at.getTime() - lookbackMs) });
  await evaluateTier(ctx, account);
});

// A guest asked to be forgotten. The points ledger is append-only and carries no personal
// detail, so it stays as arithmetic; the membership itself is closed, emptied and unlinked
// from anything that could find the guest again.
onCustomerErase(async (ctx, customerId) => {
  const accounts = await ctx.db.selectFrom('loyalty_accounts').select(['id']).where('customer_id', '=', customerId).execute();
  for (const a of accounts) {
    await lockAccount(ctx, a.id);
    await ctx.db
      .updateTable('redemptions')
      .set({ status: 'voided', voided_at: ctx.now(), void_reason: 'Member erased' })
      .where('account_id', '=', a.id)
      .where('status', '=', 'issued')
      .execute();
    const balance = await balanceOf(ctx, a.id);
    if (balance !== 0) await writePoints(ctx, { accountId: a.id, kind: 'adjust', points: -balance, key: `erase:${a.id}`, note: 'Membership closed' });
    await ctx.db
      .updateTable('loyalty_accounts')
      .set({ status: 'closed', tier_id: null, member_code: `erased-${a.id}` })
      .where('id', '=', a.id)
      .execute();
  }
});

// What the guest's data export says about their membership.
registerCustomerDataProvider('loyalty', async (ctx: Ctx, customerId: string) => {
  const accounts = await ctx.db
    .selectFrom('loyalty_accounts as a')
    .innerJoin('loyalty_programs as p', 'p.id', 'a.program_id')
    .leftJoin('loyalty_tiers as t', 't.id', 'a.tier_id')
    .select(['a.id', 'a.member_code', 'a.status', 'a.enrolled_at', 'p.name as program', 't.name as tier'])
    .where('a.customer_id', '=', customerId)
    .execute();
  const out = [];
  for (const a of accounts) {
    out.push({
      program: a.program,
      memberCode: a.member_code,
      status: a.status,
      enrolledAt: a.enrolled_at,
      tier: a.tier,
      balance: await balanceOf(ctx, a.id),
      points: await ctx.db.selectFrom('loyalty_transactions').select(['occurred_at', 'kind', 'points', 'venue_id']).where('account_id', '=', a.id).orderBy('occurred_at').execute(),
      redemptions: await ctx.db
        .selectFrom('redemptions as r')
        .innerJoin('rewards as w', 'w.id', 'r.reward_id')
        .select(['w.name as reward', 'r.status', 'r.points', 'r.issued_at', 'r.redeemed_at'])
        .where('r.account_id', '=', a.id)
        .orderBy('r.issued_at')
        .execute(),
    });
  }
  return out;
});
