import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { type Ctx, audit, invalid, notFound, requireOwner, requireStaff, track } from '@ros/core';
import { loyaltyAdjusted } from './module';
import { assertLoyaltyOn, availablePoints, balanceOf, lockAccount, writePoints } from './points';

export const adjustPointsInput = z.object({
  venueId: z.string().uuid(),
  accountId: z.string().uuid(),
  /** Signed: positive adds points, negative removes them. */
  points: z
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((n) => n !== 0, 'Say how many points to add or remove.'),
  reason: z.string().trim().min(3, 'Give a reason for the adjustment.').max(500),
  /** A value the form makes once, so a double submit is one adjustment. */
  requestKey: z.string().min(8).max(100).optional(),
});

export interface AdjustResult {
  balance: number;
  /** False when this request had already been applied. */
  applied: boolean;
}

/**
 * Add or remove points by hand. A manager at the venue, with a reason, on the audit log; an
 * adjustment larger than the venue's threshold needs an owner. Points are a liability the
 * venue owes, so front of house cannot do this (docs/THREAT_MODEL.md section 9).
 */
export async function adjustPoints(ctx: Ctx, raw: z.input<typeof adjustPointsInput>): Promise<AdjustResult> {
  const parsed = adjustPointsInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That adjustment is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  if (Math.abs(input.points) > config.ownerAdjustmentAbovePoints) requireOwner(ctx);

  const account = await lockAccount(ctx, input.accountId);
  if (!account) throw notFound('Member not found');
  if (account.status === 'closed') throw invalid('That membership is closed.');
  const before = await availablePoints(ctx, account.id);
  // Points promised to a live counter code cannot be taken from under it.
  if (input.points < 0 && before.available + input.points < 0) throw invalid(`Only ${Math.max(0, before.available)} points can be removed.`);

  const applied = await writePoints(ctx, {
    accountId: account.id,
    kind: 'adjust',
    points: input.points,
    key: `adjust:${input.requestKey ?? randomUUID()}`,
    venueId: input.venueId,
    note: input.reason,
  });
  const balance = await balanceOf(ctx, account.id);
  if (!applied) return { balance, applied: false };

  await audit(ctx, {
    action: 'loyalty.points_adjusted',
    entityType: 'loyalty_account',
    entityId: account.id,
    venueId: input.venueId,
    before: { balance: before.balance },
    after: { balance, points: input.points, reason: input.reason },
  });
  await track(ctx, loyaltyAdjusted, { account_id: account.id, points: input.points }, { customerId: account.customer_id, venueId: input.venueId });
  return { balance, applied: true };
}

export const memberStatusInput = z.object({
  accountId: z.string().uuid(),
  status: z.enum(['active', 'suspended']),
  reason: z.string().trim().min(3, 'Give a reason.').max(500),
});

/** Suspend a membership (it stops earning and redeeming, and keeps its points) or lift a suspension. */
export async function setMemberStatus(ctx: Ctx, raw: z.input<typeof memberStatusInput>): Promise<void> {
  const parsed = memberStatusInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const account = await lockAccount(ctx, input.accountId);
  if (!account) throw notFound('Member not found');
  if (account.status === 'closed') throw invalid('That membership is closed.');
  if (account.status === input.status) return;
  await ctx.db.updateTable('loyalty_accounts').set({ status: input.status }).where('id', '=', account.id).execute();
  await audit(ctx, { action: 'loyalty.member_status', entityType: 'loyalty_account', entityId: account.id, before: { status: account.status }, after: { status: input.status, reason: input.reason } });
}
