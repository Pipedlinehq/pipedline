import { z } from 'zod';
import { type Ctx, GUEST_FACING_ROLES, audit, conflict, formatMoney, invalid, newCode, notFound, percentOf, requireOwner, requireStaff, staffOf, track } from '@ros/core';
import type { RecordedInfo, RecordedTransaction } from '../ledger/record';
import type { CheckoutAdjuster } from '../ordering/contract';
import { type LoyaltyConfig, loyaltyModule, loyaltyRedeemed, loyaltyRedemptionExpired, loyaltyRedemptionIssued, loyaltyRedemptionReleased } from './module';
import { type AccountRow, accountById, accountForCustomer, activeProgram, assertLoyaltyOn, availablePoints, balanceOf, heldPoints, lockAccount, orgCurrency, venueLoyalty, writePoints } from './points';
import { type RewardRow, REWARD_COLS, rewardBlockedReason, rewardDiscountCents, rewardSummary } from './program';

/**
 * Redeeming a reward.
 *
 * Online, a checkout adjuster prices the reward and the points are spent when the order is paid.
 *
 * At the counter the till is someone else's system, so the redemption is a promise first:
 * staff issue a single-use code with a short expiry, the points are held (not spent), and the
 * sale that then arrives in the ledger turns the promise into a spend. If no sale arrives the
 * code lapses and the points were never touched.
 *
 * Points are written off in exactly one place: confirm(), on a paid sale.
 */

export interface RedemptionView {
  id: string;
  code: string;
  /** 'expired' as soon as the code can no longer be used, even before the sweep has run. */
  status: 'issued' | 'redeemed' | 'expired' | 'voided';
  channel: 'counter' | 'online';
  accountId: string;
  rewardId: string;
  rewardName: string;
  /** e.g. "$10 off". What staff apply at the till. */
  rewardSummary: string;
  minSpendCents: number;
  points: number;
  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  venueId: string | null;
  transactionId: string | null;
  forced: boolean;
}

const VIEW_COLS = [
  'r.id',
  'r.code',
  'r.status',
  'r.channel',
  'r.account_id',
  'r.reward_id',
  'r.points',
  'r.issued_at',
  'r.expires_at',
  'r.redeemed_at',
  'r.issued_venue_id',
  'r.redeemed_venue_id',
  'r.transaction_id',
  'r.forced',
  'w.name as reward_name',
  'w.kind',
  'w.value_cents',
  'w.percent_off',
  'w.min_spend_cents',
] as const;

interface ViewRow {
  id: string;
  code: string;
  status: RedemptionView['status'];
  channel: RedemptionView['channel'];
  account_id: string;
  reward_id: string;
  points: number;
  issued_at: Date;
  expires_at: Date;
  redeemed_at: Date | null;
  issued_venue_id: string | null;
  redeemed_venue_id: string | null;
  transaction_id: string | null;
  forced: boolean;
  reward_name: string;
  kind: RewardRow['kind'];
  value_cents: number | null;
  percent_off: number | null;
  min_spend_cents: number;
}

const toView = (r: ViewRow, now: Date, currency: string): RedemptionView => ({
  id: r.id,
  code: r.code,
  status: r.status === 'issued' && r.expires_at <= now ? 'expired' : r.status,
  channel: r.channel,
  accountId: r.account_id,
  rewardId: r.reward_id,
  rewardName: r.reward_name,
  rewardSummary: rewardSummary(r, currency),
  minSpendCents: r.min_spend_cents,
  points: r.points,
  issuedAt: r.issued_at,
  expiresAt: r.expires_at,
  redeemedAt: r.redeemed_at,
  venueId: r.redeemed_venue_id ?? r.issued_venue_id,
  transactionId: r.transaction_id,
  forced: r.forced,
});

function viewQuery(ctx: Ctx) {
  return ctx.db.selectFrom('redemptions as r').innerJoin('rewards as w', 'w.id', 'r.reward_id').select(VIEW_COLS);
}

export async function redemptionView(ctx: Ctx, redemptionId: string): Promise<RedemptionView> {
  const row = await viewQuery(ctx).where('r.id', '=', redemptionId).executeTakeFirst();
  if (!row) throw notFound('Redemption not found');
  return toView(row, ctx.now(), await orgCurrency(ctx));
}

/** A member's redemptions, newest first. Internal: the read functions check who is asking. */
export async function redemptionsOf(ctx: Ctx, accountId: string, opts: { liveOnly?: boolean; limit?: number } = {}): Promise<RedemptionView[]> {
  const now = ctx.now();
  let q = viewQuery(ctx).where('r.account_id', '=', accountId).orderBy('r.issued_at', 'desc').limit(opts.limit ?? 20);
  if (opts.liveOnly) q = q.where('r.status', '=', 'issued').where('r.expires_at', '>', now);
  const currency = await orgCurrency(ctx);
  return (await q.execute()).map((r) => toView(r, now, currency));
}

async function loadReward(ctx: Ctx, rewardId: string, programId: string): Promise<RewardRow | null> {
  const r = await ctx.db.selectFrom('rewards').select(REWARD_COLS).where('id', '=', rewardId).where('program_id', '=', programId).executeTakeFirst();
  return r ?? null;
}

async function venueTimezone(ctx: Ctx, venueId: string): Promise<string> {
  const v = await ctx.db.selectFrom('venues').select('timezone').where('id', '=', venueId).executeTakeFirst();
  if (!v) throw notFound('Venue not found');
  return v.timezone;
}

/** Why the reward's own limits stop another redemption, or null. Held codes count: they may yet be used. */
async function limitReason(ctx: Ctx, reward: RewardRow, accountId: string): Promise<string | null> {
  if (reward.max_redemptions_total === null && reward.max_redemptions_per_customer === null) return null;
  const rows = await ctx.db
    .selectFrom('redemptions')
    .select(['account_id'])
    .where('reward_id', '=', reward.id)
    .where('status', 'in', ['issued', 'redeemed'])
    .execute();
  if (reward.max_redemptions_total !== null && rows.length >= reward.max_redemptions_total) return 'That reward has all been claimed.';
  if (reward.max_redemptions_per_customer !== null && rows.filter((r) => r.account_id === accountId).length >= reward.max_redemptions_per_customer) {
    return 'That reward has already been used as many times as it allows.';
  }
  return null;
}

// ── At the counter ──────────────────────────────────────────────────────────

export const issueRedemptionInput = z.object({
  venueId: z.string().uuid(),
  /** Staff pass the member they looked up. A guest issuing their own code leaves it out. */
  accountId: z.string().uuid().optional(),
  rewardId: z.string().uuid(),
});

/**
 * Issue a single-use code for a reward, to be applied at the till. Front of house does this for
 * the guest in front of them; a signed-in guest may do it for themself. Nothing is spent: the
 * points are held until the matching sale arrives, and released if it does not.
 */
export async function issueRedemption(ctx: Ctx, raw: z.input<typeof issueRedemptionInput>): Promise<RedemptionView> {
  const input = issueRedemptionInput.parse(raw);
  const guestId = ctx.principal.kind === 'guest' ? ctx.principal.customerId : null;
  if (!guestId) requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  if (!config.redeemHere) throw invalid('Rewards cannot be redeemed at this venue.');
  const program = await activeProgram(ctx);
  if (!program) throw invalid('The loyalty programme is paused.');

  const found = guestId ? await accountForCustomer(ctx, guestId, program.id) : input.accountId ? await accountById(ctx, input.accountId) : null;
  if (!found || found.program_id !== program.id || (guestId && input.accountId && input.accountId !== found.id)) throw notFound('Member not found');
  const account = (await lockAccount(ctx, found.id))!;
  if (account.status !== 'active') throw invalid('That membership is not active.');
  await expireStaleRedemptions(ctx, { accountId: account.id });

  const reward = await loadReward(ctx, input.rewardId, program.id);
  if (!reward) throw notFound('Reward not found');
  const now = ctx.now();
  const blocked = rewardBlockedReason(reward, { venueId: input.venueId, now, timezone: await venueTimezone(ctx, input.venueId) });
  if (blocked) throw invalid(blocked);

  // A double tap, or the guest and the staff member both pressing the button: one code.
  const live = await ctx.db
    .selectFrom('redemptions')
    .select('id')
    .where('account_id', '=', account.id)
    .where('reward_id', '=', reward.id)
    .where('issued_venue_id', '=', input.venueId)
    .where('status', '=', 'issued')
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (live) return redemptionView(ctx, live.id);

  const limited = await limitReason(ctx, reward, account.id);
  if (limited) throw invalid(limited);
  const { available } = await availablePoints(ctx, account.id);
  if (available < reward.cost_points) throw invalid(`Not enough points: ${available} available, ${reward.cost_points} needed.`);

  let id: string | undefined;
  for (let attempt = 0; attempt < 6 && !id; attempt++) {
    const row = await ctx.db
      .insertInto('redemptions')
      .values({
        org_id: ctx.orgId,
        account_id: account.id,
        reward_id: reward.id,
        code: newCode(6, 'R'),
        status: 'issued',
        channel: 'counter',
        points: reward.cost_points,
        issued_at: now,
        expires_at: new Date(now.getTime() + config.redemptionExpiryMinutes * 60_000),
        issued_venue_id: input.venueId,
        issued_staff_id: staffOf(ctx)?.staffId ?? null,
        discount_cents: reward.kind === 'fixed' ? reward.value_cents : null,
      })
      .onConflict((oc) => oc.columns(['org_id', 'code']).doNothing())
      .returning('id')
      .executeTakeFirst();
    id = row?.id;
  }
  if (!id) throw conflict('Could not issue a code just now. Try again.');

  await audit(ctx, { action: 'loyalty.redemption_issued', entityType: 'redemption', entityId: id, venueId: input.venueId, after: { accountId: account.id, rewardId: reward.id, points: reward.cost_points } });
  await track(ctx, loyaltyRedemptionIssued, { account_id: account.id, redemption_id: id, reward_id: reward.id, points: reward.cost_points }, { customerId: account.customer_id, venueId: input.venueId });
  return redemptionView(ctx, id);
}

interface ConfirmArgs {
  transactionId: string | null;
  venueId: string | null;
  discountCents: number | null;
  matchedBy: 'code' | 'amount' | 'forced';
  at: Date;
  force?: { reason: string };
}

/**
 * The one place a counter redemption turns into spent points: a paid sale matched it, or a
 * manager vouched for it. Takes the account lock, re-reads the redemption under it, and writes
 * the burn with a key built from the redemption id, so a replayed sale cannot burn twice.
 */
async function confirm(ctx: Ctx, redemptionId: string, args: ConfirmArgs): Promise<boolean> {
  const head = await ctx.db.selectFrom('redemptions').select(['account_id']).where('id', '=', redemptionId).executeTakeFirst();
  if (!head) return false;
  const account = await lockAccount(ctx, head.account_id);
  if (!account) return false;
  const r = await ctx.db.selectFrom('redemptions').select(['id', 'status', 'points', 'reward_id', 'channel', 'discount_cents']).where('id', '=', redemptionId).forUpdate().executeTakeFirst();
  if (!r) return false;
  const allowed = args.force ? r.status === 'issued' || r.status === 'expired' : r.status === 'issued';
  if (!allowed) return false;

  if (args.force) {
    // A lapsed code no longer holds its points; a manager cannot confirm what the guest has since spent.
    const balance = await balanceOf(ctx, account.id);
    const heldByOthers = await heldPoints(ctx, account.id, r.id);
    if (balance - heldByOthers < r.points) throw conflict('The guest no longer has enough points for that reward.');
  }

  await writePoints(ctx, {
    accountId: account.id,
    kind: 'burn',
    points: -r.points,
    key: `burn:${r.id}`,
    occurredAt: args.at,
    sourceTransactionId: args.transactionId,
    redemptionId: r.id,
    venueId: args.venueId,
    note: args.force ? `Confirmed by a manager: ${args.force.reason}` : null,
  });
  await ctx.db
    .updateTable('redemptions')
    .set({
      status: 'redeemed',
      redeemed_at: args.at,
      redeemed_venue_id: args.venueId,
      redeemed_staff_id: args.force ? (staffOf(ctx)?.staffId ?? null) : null,
      transaction_id: args.transactionId,
      discount_cents: args.discountCents ?? r.discount_cents,
      forced: !!args.force,
      force_reason: args.force?.reason ?? null,
    })
    .where('id', '=', r.id)
    .execute();
  await track(
    ctx,
    loyaltyRedeemed,
    { account_id: account.id, redemption_id: r.id, reward_id: r.reward_id, points: r.points, channel: r.channel, matched_by: args.matchedBy, discount_cents: args.discountCents ?? r.discount_cents },
    { customerId: account.customer_id, venueId: args.venueId, occurredAt: args.at },
  );
  return true;
}

/** The till's clock and ours need not agree to the second. */
const CLOCK_SKEW_MS = 2 * 60_000;
/** Something code-shaped in a discount's name, e.g. "OAK-W-7KQ2M9XA". Upper case only, so "Mid-week special" is not one. */
const OTHER_CODE = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]+)*-[A-Z0-9]{4,}\b/;

/**
 * A sale has arrived in the ledger: does it pay for a code that is waiting? Matched first by
 * the code appearing in the sale's discounts (by code or by name), otherwise by venue, time
 * window and discount amount, and only when exactly one waiting code fits: a guess between two
 * guests' codes would spend the wrong person's points, so an ambiguous sale matches nothing
 * and the codes are left to a manager or to lapse.
 *
 * Returns the member whose code the sale paid for, so an otherwise anonymous sale can earn.
 */
export async function matchSaleToRedemptions(ctx: Ctx, txn: RecordedTransaction, info: RecordedInfo): Promise<AccountRow | null> {
  if (txn.status !== 'completed' && txn.status !== 'partially_refunded') return null;
  // An order placed on this platform redeems through checkout, not here.
  if (txn.orderId) return null;
  if (!info.discounts.length && txn.discountCents <= 0) return null;

  const waiting = await ctx.db
    .selectFrom('redemptions as r')
    .innerJoin('rewards as w', 'w.id', 'r.reward_id')
    .innerJoin('loyalty_accounts as a', 'a.id', 'r.account_id')
    .select(['r.id', 'r.account_id', 'r.code', 'r.issued_venue_id', 'w.kind', 'w.value_cents', 'w.percent_off', 'a.customer_id'])
    .where('r.status', '=', 'issued')
    .where('r.channel', '=', 'counter')
    .where('r.expires_at', '>=', txn.occurredAt)
    .where('r.issued_at', '<=', new Date(txn.occurredAt.getTime() + CLOCK_SKEW_MS))
    .orderBy('r.issued_at', 'asc')
    .execute();
  if (!waiting.length) return null;

  const config = await venueLoyalty(ctx, txn.venueId);
  if (!config || !config.redeemHere) return null;
  if (!info.created) {
    const already = await ctx.db.selectFrom('redemptions').select('id').where('transaction_id', '=', txn.id).limit(1).executeTakeFirst();
    if (already) return null;
  }

  const texts = info.discounts.flatMap((d) => [d.code, d.name]).filter((s): s is string => !!s).map((s) => s.toUpperCase());
  const byCode = waiting.filter((r) => texts.some((t) => t.includes(r.code.toUpperCase())));
  let matched: string | null = null;

  if (byCode.length) {
    for (const r of byCode) {
      const discount = info.discounts.find((d) => `${d.code ?? ''} ${d.name}`.toUpperCase().includes(r.code.toUpperCase()));
      const ok = await confirm(ctx, r.id, { transactionId: txn.id, venueId: txn.venueId, discountCents: discount?.amountCents ?? null, matchedBy: 'code', at: txn.occurredAt });
      if (ok) matched ??= r.account_id;
    }
  } else if (config.matchByAmount) {
    // A discount line that names some other code (an offer's, a voucher's) is not this reward. When the
    // till itemises its discounts, only the unnamed ones are candidates; when it does not, the total is.
    const unnamed = info.discounts.filter((d) => !d.code && !OTHER_CODE.test(d.name));
    const amounts = (info.discounts.length ? unnamed.map((d) => d.amountCents) : [txn.discountCents]).filter((n) => n > 0);
    const fits = (r: (typeof waiting)[number]): number | null => {
      if (r.kind === 'percent') {
        const expected = percentOf(txn.subtotalCents, r.percent_off ?? 0);
        return amounts.find((a) => Math.abs(a - expected) <= 1) ?? null;
      }
      if (r.value_cents === null) return null;
      const expected = Math.min(r.value_cents, txn.subtotalCents);
      return amounts.find((a) => a === expected) ?? null;
    };
    const candidates = waiting.filter((r) => r.issued_venue_id === txn.venueId && (!txn.customerId || r.customer_id === txn.customerId) && fits(r) !== null);
    if (candidates.length === 1) {
      const r = candidates[0]!;
      const ok = await confirm(ctx, r.id, { transactionId: txn.id, venueId: txn.venueId, discountCents: fits(r), matchedBy: 'amount', at: txn.occurredAt });
      if (ok) matched = r.account_id;
    }
  }
  return matched ? accountById(ctx, matched) : null;
}

/** Undo a spent redemption: the points come back and the redemption is closed. Idempotent. */
async function release(ctx: Ctx, redemptionId: string, reason: string): Promise<boolean> {
  const head = await ctx.db.selectFrom('redemptions').select(['account_id']).where('id', '=', redemptionId).executeTakeFirst();
  if (!head) return false;
  const account = await lockAccount(ctx, head.account_id);
  if (!account) return false;
  const r = await ctx.db.selectFrom('redemptions').select(['id', 'status', 'points', 'transaction_id', 'order_id', 'redeemed_venue_id']).where('id', '=', redemptionId).forUpdate().executeTakeFirst();
  if (!r || r.status !== 'redeemed') return false;
  await writePoints(ctx, {
    accountId: account.id,
    kind: 'reverse',
    points: r.points,
    key: `unburn:${r.id}`,
    sourceTransactionId: r.transaction_id,
    orderId: r.order_id,
    redemptionId: r.id,
    venueId: r.redeemed_venue_id,
    note: reason,
  });
  await ctx.db.updateTable('redemptions').set({ status: 'voided', voided_at: ctx.now(), void_reason: reason }).where('id', '=', r.id).execute();
  await track(ctx, loyaltyRedemptionReleased, { account_id: account.id, redemption_id: r.id, points_returned: r.points, reason }, { customerId: account.customer_id, venueId: r.redeemed_venue_id });
  return true;
}

/** A sale that paid for a redemption was refunded in full or voided: give the points back. */
export async function releaseForRefundedSale(ctx: Ctx, txn: RecordedTransaction): Promise<number> {
  if (txn.status !== 'refunded' && txn.status !== 'voided') return 0;
  const rows = await ctx.db.selectFrom('redemptions').select('id').where('transaction_id', '=', txn.id).where('status', '=', 'redeemed').execute();
  let n = 0;
  for (const r of rows) if (await release(ctx, r.id, 'Sale refunded')) n++;
  return n;
}

/** An order's sale has reached the ledger: tie its online redemption to it, for refunds and reporting. */
export async function linkOrderSale(ctx: Ctx, txn: RecordedTransaction): Promise<void> {
  if (!txn.orderId) return;
  await ctx.db.updateTable('redemptions').set({ transaction_id: txn.id }).where('order_id', '=', txn.orderId).where('transaction_id', 'is', null).execute();
}

/**
 * Close codes that have lapsed. A code cannot be used after its expiry, but it is only marked
 * expired once the venue's grace period has also passed, so a sale made in time and reported
 * late still finds it. No points row is written: nothing was ever spent.
 */
export async function expireStaleRedemptions(ctx: Ctx, filter: { accountId?: string } = {}): Promise<number> {
  const now = ctx.now();
  let q = ctx.db
    .selectFrom('redemptions as r')
    .innerJoin('loyalty_accounts as a', 'a.id', 'r.account_id')
    .select(['r.id', 'r.account_id', 'r.reward_id', 'r.points', 'r.issued_venue_id', 'r.expires_at', 'a.customer_id'])
    .where('r.status', '=', 'issued')
    .where('r.expires_at', '<', now);
  if (filter.accountId) q = q.where('r.account_id', '=', filter.accountId);
  const rows = await q.execute();
  const cache = new Map<string, LoyaltyConfig | null>();
  let n = 0;
  for (const r of rows) {
    const config = r.issued_venue_id ? await venueLoyalty(ctx, r.issued_venue_id, cache) : null;
    const grace = (config ?? loyaltyModule.defaultConfig).lateSaleGraceMinutes * 60_000;
    if (r.expires_at.getTime() + grace > now.getTime()) continue;
    const done = await ctx.db.updateTable('redemptions').set({ status: 'expired' }).where('id', '=', r.id).where('status', '=', 'issued').returning('id').executeTakeFirst();
    if (!done) continue;
    n++;
    await track(ctx, loyaltyRedemptionExpired, { account_id: r.account_id, redemption_id: r.id, reward_id: r.reward_id, points: r.points }, { customerId: r.customer_id, venueId: r.issued_venue_id });
  }
  return n;
}

export const forceConfirmInput = z.object({
  venueId: z.string().uuid(),
  redemptionId: z.string().uuid(),
  reason: z.string().trim().min(3, 'Say why this is being confirmed by hand.').max(500),
  /** The sale it belongs to, when the manager can point at one. */
  transactionId: z.string().uuid().optional(),
});

/**
 * A manager confirms a redemption by hand: the guest got the reward but the sale never matched
 * (the till was offline, the discount was keyed differently). Needs a reason and is audited.
 */
export async function forceConfirmRedemption(ctx: Ctx, raw: z.input<typeof forceConfirmInput>): Promise<RedemptionView> {
  const parsed = forceConfirmInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  if (!config.allowStaffForceConfirm) requireOwner(ctx);

  const r = await ctx.db.selectFrom('redemptions').select(['id', 'status', 'forced', 'issued_venue_id', 'channel']).where('id', '=', input.redemptionId).executeTakeFirst();
  if (!r || r.channel !== 'counter' || r.issued_venue_id !== input.venueId) throw notFound('Redemption not found');
  if (r.status === 'redeemed') {
    if (r.forced) return redemptionView(ctx, r.id);
    throw conflict('That redemption has already been confirmed by a sale.');
  }
  if (r.status === 'voided') throw conflict('That redemption was cancelled.');
  if (input.transactionId) {
    const sale = await ctx.db.selectFrom('transactions').select(['id']).where('id', '=', input.transactionId).where('venue_id', '=', input.venueId).executeTakeFirst();
    if (!sale) throw notFound('Sale not found');
  }

  const ok = await confirm(ctx, r.id, { transactionId: input.transactionId ?? null, venueId: input.venueId, discountCents: null, matchedBy: 'forced', at: ctx.now(), force: { reason: input.reason } });
  if (!ok) throw conflict('That redemption can no longer be confirmed.');
  await audit(ctx, {
    action: 'loyalty.redemption_forced',
    entityType: 'redemption',
    entityId: r.id,
    venueId: input.venueId,
    before: { status: r.status },
    after: { status: 'redeemed', reason: input.reason, transactionId: input.transactionId ?? null },
  });
  return redemptionView(ctx, r.id);
}

export const voidRedemptionInput = z.object({ redemptionId: z.string().uuid(), reason: z.string().trim().max(300).optional() });

/** Cancel a code that has not been used: the guest changed their mind. The held points are free again. */
export async function voidRedemption(ctx: Ctx, raw: z.input<typeof voidRedemptionInput>): Promise<RedemptionView> {
  const input = voidRedemptionInput.parse(raw);
  const r = await ctx.db
    .selectFrom('redemptions as r')
    .innerJoin('loyalty_accounts as a', 'a.id', 'r.account_id')
    .select(['r.id', 'r.status', 'r.account_id', 'r.issued_venue_id', 'r.channel', 'a.customer_id'])
    .where('r.id', '=', input.redemptionId)
    .executeTakeFirst();
  if (ctx.principal.kind === 'guest') {
    if (!r || r.customer_id !== ctx.principal.customerId) throw notFound('Redemption not found');
  } else {
    if (!r || !r.issued_venue_id) {
      requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
      throw notFound('Redemption not found');
    }
    requireStaff(ctx, { venueId: r.issued_venue_id, anyOf: GUEST_FACING_ROLES });
  }
  await assertLoyaltyOn(ctx, r.issued_venue_id);
  if (r.status === 'voided') return redemptionView(ctx, r.id);
  if (r.status !== 'issued') throw conflict('That code can no longer be cancelled.');

  await lockAccount(ctx, r.account_id);
  const reason = input.reason || 'Cancelled';
  const done = await ctx.db.updateTable('redemptions').set({ status: 'voided', voided_at: ctx.now(), void_reason: reason }).where('id', '=', r.id).where('status', '=', 'issued').returning('id').executeTakeFirst();
  if (done) {
    await audit(ctx, { action: 'loyalty.redemption_voided', entityType: 'redemption', entityId: r.id, venueId: r.issued_venue_id, after: { reason } });
    await track(ctx, loyaltyRedemptionReleased, { account_id: r.account_id, redemption_id: r.id, points_returned: 0, reason }, { customerId: r.customer_id, venueId: r.issued_venue_id });
  }
  return redemptionView(ctx, r.id);
}

// ── Online, through checkout ────────────────────────────────────────────────

const REWARD_CODE = /^reward-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The code checkout submits for a reward the guest picked. The guest never types it. */
export function rewardCheckoutCode(rewardId: string): string {
  return `REWARD-${rewardId}`;
}

/**
 * Loyalty's side of checkout (ordering/contract.ts). quote() prices a reward against the draft
 * and changes nothing. commit() runs once the order is paid and is where the points are spent;
 * it refuses rather than overdraw if the balance moved between quote and payment. release()
 * gives the points back when a paid order is cancelled or fully refunded.
 */
export const loyaltyAdjuster: CheckoutAdjuster = {
  key: 'loyalty',

  async quote(ctx, draft, code) {
    const m = REWARD_CODE.exec(code.trim());
    if (!m) return null;
    const config = await venueLoyalty(ctx, draft.venueId);
    if (!config) return null;
    const program = await activeProgram(ctx);
    if (!program) return null;
    const reward = await loadReward(ctx, m[1]!.toLowerCase(), program.id);
    if (!reward) return null;

    if (!config.redeemHere) throw invalid('Rewards cannot be redeemed at this venue.');
    if (!draft.customerId) throw invalid('Sign in to use your points.');
    const account = await accountForCustomer(ctx, draft.customerId, program.id);
    if (!account || account.status !== 'active') throw invalid('Join the loyalty programme to use rewards.');
    const blocked = rewardBlockedReason(reward, { venueId: draft.venueId, now: draft.at, timezone: await venueTimezone(ctx, draft.venueId) });
    if (blocked) throw invalid(blocked);
    if (draft.subtotalCents < reward.min_spend_cents) throw invalid(`Spend ${formatMoney(reward.min_spend_cents, await orgCurrency(ctx))} or more to use this reward.`);
    const limited = await limitReason(ctx, reward, account.id);
    if (limited) throw invalid(limited);
    const { available } = await availablePoints(ctx, account.id);
    if (available < reward.cost_points) throw invalid(`Not enough points: ${available} available, ${reward.cost_points} needed.`);

    let freeItemPrice: number | null = null;
    if (reward.kind === 'free_item' && reward.menu_item_id) {
      const line = draft.lines.find((l) => l.menuItemId === reward.menu_item_id);
      if (!line) throw invalid('Add the free item to your order to use this reward.');
      freeItemPrice = line.unitPriceCents;
    }
    const amountCents = rewardDiscountCents(reward, draft.subtotalCents, freeItemPrice);
    if (amountCents <= 0) throw invalid('That reward does not apply to this order.');

    return {
      adjuster: 'loyalty',
      code: rewardCheckoutCode(reward.id),
      label: `${reward.name} (${reward.cost_points} points)`,
      amountCents,
      ref: { rewardId: reward.id, accountId: account.id },
    };
  },

  async commit(ctx, { orderId, venueId, customerId, transactionId, adjustment }) {
    const { rewardId, accountId } = adjustment.ref;
    if (!rewardId || !accountId) throw invalid('That reward could not be applied.');
    const account = await lockAccount(ctx, accountId);
    if (!account || (customerId && account.customer_id !== customerId)) throw notFound('Member not found');

    // Under the account lock: a replayed payment confirmation finds the first one's work and stops.
    const existing = await ctx.db.selectFrom('redemptions').select('id').where('order_id', '=', orderId).where('reward_id', '=', rewardId).executeTakeFirst();
    if (existing) return;

    const reward = await loadReward(ctx, rewardId, account.program_id);
    if (!reward) throw notFound('Reward not found');
    const { available } = await availablePoints(ctx, account.id);
    if (available < reward.cost_points) throw conflict('There are no longer enough points for that reward.');

    const now = ctx.now();
    let id: string | undefined;
    for (let attempt = 0; attempt < 6 && !id; attempt++) {
      const row = await ctx.db
        .insertInto('redemptions')
        .values({
          org_id: ctx.orgId,
          account_id: account.id,
          reward_id: reward.id,
          code: newCode(8, 'O'),
          status: 'redeemed',
          channel: 'online',
          points: reward.cost_points,
          issued_at: now,
          expires_at: now,
          redeemed_at: now,
          issued_venue_id: venueId,
          redeemed_venue_id: venueId,
          transaction_id: transactionId,
          order_id: orderId,
          discount_cents: adjustment.amountCents,
        })
        .onConflict((oc) => oc.columns(['org_id', 'code']).doNothing())
        .returning('id')
        .executeTakeFirst();
      id = row?.id;
    }
    if (!id) throw conflict('That reward could not be applied just now.');

    await writePoints(ctx, {
      accountId: account.id,
      kind: 'burn',
      points: -reward.cost_points,
      key: `burn:${id}`,
      sourceTransactionId: transactionId,
      orderId,
      redemptionId: id,
      venueId,
      note: reward.name,
    });
    await track(
      ctx,
      loyaltyRedeemed,
      { account_id: account.id, redemption_id: id, reward_id: reward.id, points: reward.cost_points, channel: 'online', matched_by: 'order', discount_cents: adjustment.amountCents },
      { customerId: account.customer_id, venueId },
    );
  },

  async release(ctx, { orderId, adjustment }) {
    const { rewardId } = adjustment.ref;
    if (!rewardId) return;
    const rows = await ctx.db.selectFrom('redemptions').select('id').where('order_id', '=', orderId).where('reward_id', '=', rewardId).where('status', '=', 'redeemed').execute();
    for (const r of rows) await release(ctx, r.id, 'Order cancelled or refunded');
  },
};
