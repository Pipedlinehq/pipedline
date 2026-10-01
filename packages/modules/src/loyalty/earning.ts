import { z } from 'zod';
import { type Ctx, type TxnChannel, type TxnStatus, audit, isInternal, requireStaff, staffOf, track } from '@ros/core';
import { type LoyaltyConfig, loyaltyEarnReversed, loyaltyEarned } from './module';
import { type AccountRow, type ProgramRow, type TierRow, ACCOUNT_COLS, accountById, accountForCustomer, activeProgram, assertLoyaltyOn, evaluateTier, tiersOf, venueLoyalty, writePoints } from './points';

/**
 * Earning comes from the ledger. When a sale is recorded for a member, the points follow by
 * themselves: no step at the till, no box for staff to tick, nothing for the guest to accept.
 * (The design this replaces lost 86% of its members' points to a step at the till.)
 */

export interface SaleForEarning {
  id: string;
  venueId: string;
  customerId: string | null;
  occurredAt: Date;
  channel: TxnChannel;
  status: TxnStatus;
  totalCents: number;
  refundedCents: number;
  subtotalCents: number;
  discountCents: number;
}

export interface EarnOptions {
  /** Use this account rather than looking one up from the sale's customer. */
  account?: AccountRow | null;
  program?: ProgramRow | null;
  /** True when nothing can have been earned for this sale yet (it was only just created). */
  fresh?: boolean;
  /** Earn for sales made before the guest joined. Only a deliberate back-fill sets this. */
  includePreEnrolment?: boolean;
  /** Replaying history: work the tier out as of the sale, not as of now. The caller settles tiers afterwards. */
  historical?: boolean;
  configCache?: Map<string, LoyaltyConfig | null>;
  tiers?: TierRow[];
}

export interface EarnOutcome {
  earned: number;
  reversed: number;
}

const NOTHING: EarnOutcome = { earned: 0, reversed: 0 };

/** Points for a spend, by the programme's rule. Integer arithmetic: no float drift at the boundary. */
export function pointsFor(program: Pick<ProgramRow, 'earn_model' | 'points_per_dollar' | 'points_rounding'>, spendCents: number, multiplier: number): number {
  const rate = Math.round(Number(program.points_per_dollar) * 1000);
  const mult = Math.round(multiplier * 100);
  // Visits and stamps earn a flat amount per sale; points-per-dollar earns on what was spent.
  const numerator = program.earn_model === 'points_per_dollar' ? spendCents * rate * mult : 100 * rate * mult;
  const denominator = 100 * 1000 * 100;
  const exact = numerator / denominator;
  const points = program.points_rounding === 'ceil' ? Math.ceil(exact) : program.points_rounding === 'round' ? Math.round(exact) : Math.floor(exact);
  return Math.max(0, points);
}

/**
 * Bring a member's points into line with one sale: earn once when it is completed, and take
 * back the matching share when it is refunded. Safe to call any number of times for the same
 * sale; the idempotency key is built from the transaction id.
 */
export async function earnForSale(ctx: Ctx, sale: SaleForEarning, opts: EarnOptions = {}): Promise<EarnOutcome> {
  const prior = opts.fresh
    ? []
    : await ctx.db
        .selectFrom('loyalty_transactions')
        .select(['account_id', 'kind', 'points'])
        .where('source_transaction_id', '=', sale.id)
        .where('kind', 'in', ['earn', 'reverse'])
        .where('redemption_id', 'is', null)
        .execute();
  const earnRow = prior.find((p) => p.kind === 'earn');

  let account = opts.account ?? null;
  if (!account && sale.customerId) {
    const program = opts.program ?? (await activeProgram(ctx));
    if (program) account = await accountForCustomer(ctx, sale.customerId, program.id);
  }
  // A refund on a sale whose guest has since been erased or unlinked still takes the points back.
  if (!account && earnRow) account = await accountById(ctx, earnRow.account_id);
  if (!account) return NOTHING;

  let earnedPoints = earnRow?.points ?? 0;
  let earnedNow = 0;
  const live = sale.status === 'completed' || sale.status === 'partially_refunded';

  if (!earnRow && live && account.status === 'active') {
    const program = opts.program ?? (await activeProgram(ctx));
    const config = await venueLoyalty(ctx, sale.venueId, opts.configCache);
    const spend = sale.subtotalCents - sale.discountCents;
    const lookbackMs = (config?.earnLookbackHours ?? 0) * 3_600_000;
    const eligible =
      program !== null &&
      program.id === account.program_id &&
      config !== null &&
      config.earnHere &&
      config.earnChannels.includes(sale.channel) &&
      spend > 0 &&
      (opts.includePreEnrolment || sale.occurredAt.getTime() >= account.enrolled_at.getTime() - lookbackMs);
    if (eligible) {
      const tiers = opts.tiers ?? (await tiersOf(ctx, account.program_id));
      const multiplier = Number(tiers.find((t) => t.id === account!.tier_id)?.multiplier ?? 1);
      const points = pointsFor(program!, spend, multiplier);
      if (points > 0) {
        const wrote = await writePoints(ctx, {
          accountId: account.id,
          kind: 'earn',
          points,
          key: `earn:${sale.id}`,
          occurredAt: sale.occurredAt,
          sourceTransactionId: sale.id,
          venueId: sale.venueId,
          note: multiplier !== 1 ? `x${multiplier}` : null,
        });
        if (wrote) {
          earnedPoints = points;
          earnedNow = points;
          await track(
            ctx,
            loyaltyEarned,
            { account_id: account.id, transaction_id: sale.id, points, multiplier, spend_cents: spend },
            { customerId: account.customer_id, venueId: sale.venueId, occurredAt: sale.occurredAt },
          );
        } else {
          // Lost a race with another delivery of the same sale: it earned, and that stands.
          const row = await ctx.db.selectFrom('loyalty_transactions').select('points').where('idempotency_key', '=', `earn:${sale.id}`).executeTakeFirst();
          earnedPoints = row?.points ?? 0;
        }
      }
    }
  }

  // A reversal goes back to the account that earned, unless that account has since been folded
  // into another by a merge, in which case the surviving account (the sale's customer now) takes it.
  if (earnRow && earnRow.account_id !== account.id) {
    const earner = await accountById(ctx, earnRow.account_id);
    if (earner && earner.status !== 'closed') account = earner;
  }

  let reversedNow = 0;
  if (earnedPoints > 0) {
    const share = sale.status === 'refunded' || sale.status === 'voided' ? 1 : sale.totalCents > 0 ? Math.min(1, Math.max(0, sale.refundedCents / sale.totalCents)) : 0;
    const target = share >= 1 ? earnedPoints : Math.min(earnedPoints, Math.round(earnedPoints * share));
    const already = -prior.filter((p) => p.kind === 'reverse').reduce((s, p) => s + p.points, 0);
    const owed = target - already;
    if (owed > 0) {
      const wrote = await writePoints(ctx, {
        accountId: account.id,
        kind: 'reverse',
        points: -owed,
        key: `reverse:${sale.id}:${target}`,
        sourceTransactionId: sale.id,
        venueId: sale.venueId,
        note: share >= 1 ? 'Sale refunded' : 'Sale partly refunded',
      });
      if (wrote) {
        reversedNow = owed;
        await track(ctx, loyaltyEarnReversed, { account_id: account.id, transaction_id: sale.id, points: owed }, { customerId: account.customer_id, venueId: sale.venueId });
      }
    }
  }

  if (earnedNow || reversedNow) await evaluateTier(ctx, account, opts.historical ? sale.occurredAt : undefined, opts.tiers);
  return { earned: earnedNow, reversed: reversedNow };
}

export interface BackfillResult {
  considered: number;
  sales: number;
  points: number;
}

interface BackfillRange {
  since?: Date;
  until?: Date;
  includePreEnrolment?: boolean;
  limit?: number;
}

async function backfill(ctx: Ctx, program: ProgramRow, filter: { customerId?: string }, range: BackfillRange): Promise<BackfillResult> {
  let q = ctx.db
    .selectFrom('transactions as t')
    .innerJoin('loyalty_accounts as a', (j) => j.onRef('a.customer_id', '=', 't.customer_id').on('a.program_id', '=', program.id).on('a.status', '=', 'active'))
    .leftJoin('loyalty_transactions as e', (j) => j.onRef('e.source_transaction_id', '=', 't.id').on('e.kind', '=', 'earn'))
    .select(['t.id', 't.venue_id', 't.customer_id', 't.occurred_at', 't.channel', 't.status', 't.total_cents', 't.refunded_cents', 't.subtotal_cents', 't.discount_cents', 'a.id as account_id'])
    .where('e.id', 'is', null)
    .where('t.status', 'in', ['completed', 'partially_refunded'])
    .orderBy('t.occurred_at', 'asc')
    .limit(Math.min(range.limit ?? 50_000, 200_000));
  if (filter.customerId) q = q.where('t.customer_id', '=', filter.customerId);
  if (range.since) q = q.where('t.occurred_at', '>=', range.since);
  if (range.until) q = q.where('t.occurred_at', '<', range.until);
  const rows = await q.execute();
  if (!rows.length) return { considered: 0, sales: 0, points: 0 };

  const accountRows = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('id', 'in', [...new Set(rows.map((r) => r.account_id))]).execute();
  const accounts = new Map(accountRows.map((a) => [a.id, a]));
  const tiers = await tiersOf(ctx, program.id);
  const configCache = new Map<string, LoyaltyConfig | null>();
  const result: BackfillResult = { considered: rows.length, sales: 0, points: 0 };
  // Oldest first, so a member's tier (and with it the multiplier) builds the way it would have.
  for (const r of rows) {
    const out = await earnForSale(
      ctx,
      {
        id: r.id,
        venueId: r.venue_id,
        customerId: r.customer_id,
        occurredAt: r.occurred_at,
        channel: r.channel,
        status: r.status,
        totalCents: r.total_cents,
        refundedCents: r.refunded_cents,
        subtotalCents: r.subtotal_cents,
        discountCents: r.discount_cents,
      },
      { account: accounts.get(r.account_id), program, fresh: true, historical: true, includePreEnrolment: range.includePreEnrolment, configCache, tiers },
    );
    if (out.earned) {
      result.sales++;
      result.points += out.earned - out.reversed;
    }
  }
  // Tiers were worked out as of each sale; settle them as of now.
  for (const a of accounts.values()) await evaluateTier(ctx, a, undefined, tiers);
  return result;
}

/** Earn for one member's sales that have not earned yet. Internal: enrolment and merges call it. */
export async function backfillForCustomer(ctx: Ctx, program: ProgramRow, account: AccountRow, range: BackfillRange = {}): Promise<BackfillResult> {
  return backfill(ctx, program, { customerId: account.customer_id }, range);
}

export const backfillInput = z.object({
  customerId: z.string().uuid().optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  /** Also earn for sales made before each guest joined. Off by default. */
  includePreEnrolment: z.boolean().default(false),
  limit: z.number().int().min(1).max(200_000).optional(),
});

/**
 * Re-run earning over sales already in the ledger: every identified sale by a member that has
 * not earned, oldest first. For recovering from an outage, for a programme switched on after
 * the ledger started filling, and for fixtures. Idempotent: a sale that has earned is skipped.
 */
export async function backfillEarning(ctx: Ctx, raw: z.input<typeof backfillInput> = {}): Promise<BackfillResult> {
  const input = backfillInput.parse(raw);
  if (!isInternal(ctx)) requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const program = await activeProgram(ctx);
  if (!program) return { considered: 0, sales: 0, points: 0 };
  const result = await backfill(ctx, program, { customerId: input.customerId }, input);
  // Points are a liability: a person choosing to issue a batch of them is on the record.
  if (staffOf(ctx)) {
    await audit(ctx, {
      action: 'loyalty.backfill_run',
      entityType: 'loyalty_program',
      entityId: program.id,
      after: { customerId: input.customerId ?? null, since: input.since ?? null, until: input.until ?? null, includePreEnrolment: input.includePreEnrolment, ...result },
    });
  }
  return result;
}
