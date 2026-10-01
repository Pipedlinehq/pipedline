import { z } from 'zod';
import { type Ctx, audit, formatMoney, invalid, json, localParts, notFound, percentOf, requireStaff } from '@ros/core';
import { type ProgramRow, type TierRow, activeProgram, assertLoyaltyOn, latestProgram, tiersOf } from './points';

/** Programme setup, tiers and rewards. Org-wide; a manager or owner changes them, and every change is audited. */

export interface ProgramView {
  id: string;
  name: string;
  isActive: boolean;
  earnModel: 'points_per_dollar' | 'visits' | 'stamps';
  /** Points per dollar spent, or points per visit for the visits and stamps models. */
  pointsPerDollar: number;
  pointsRounding: 'floor' | 'round' | 'ceil';
  /** What one point is worth when redeemed, in cents. Drives the liability figure. */
  pointValueCents: number;
  expiryPolicy: 'none' | 'rolling' | 'fixed';
  expiryMonths: number | null;
  enrolmentBonus: number;
  birthdayBonus: number;
  termsUrl: string | null;
  tiers: TierView[];
}

export interface TierView {
  id: string;
  name: string;
  thresholdPoints: number;
  windowMonths: number;
  multiplier: number;
  perks: string[];
  sortOrder: number;
}

export const tierView = (t: TierRow): TierView => ({
  id: t.id,
  name: t.name,
  thresholdPoints: t.threshold_points,
  windowMonths: t.threshold_window_months,
  multiplier: Number(t.multiplier),
  perks: Array.isArray(t.perks) ? (t.perks as unknown[]).map(String) : [],
  sortOrder: t.sort_order,
});

function programView(p: ProgramRow, tiers: TierRow[]): ProgramView {
  return {
    id: p.id,
    name: p.name,
    isActive: p.is_active,
    earnModel: p.earn_model as ProgramView['earnModel'],
    pointsPerDollar: Number(p.points_per_dollar),
    pointsRounding: p.points_rounding as ProgramView['pointsRounding'],
    pointValueCents: Number(p.point_value_cents),
    expiryPolicy: p.expiry_policy as ProgramView['expiryPolicy'],
    expiryMonths: p.expiry_months,
    enrolmentBonus: p.enrolment_bonus,
    birthdayBonus: p.birthday_bonus,
    termsUrl: p.terms_url,
    tiers: tiers.map(tierView),
  };
}

/**
 * The programme as the public sees it: what it is called, how points are earned, the tiers.
 * No role check (it is what the venue's own site shows). Null when none is active.
 */
export async function getProgram(ctx: Ctx): Promise<ProgramView | null> {
  await assertLoyaltyOn(ctx);
  const p = await activeProgram(ctx);
  if (!p) return null;
  return programView(p, await tiersOf(ctx, p.id));
}

/** The programme for the console, including one that is paused. */
export async function getProgramSettings(ctx: Ctx): Promise<ProgramView | null> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const p = await latestProgram(ctx);
  if (!p) return null;
  return programView(p, await tiersOf(ctx, p.id));
}

export const programInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    isActive: z.boolean().default(true),
    earnModel: z.enum(['points_per_dollar', 'visits', 'stamps']).default('points_per_dollar'),
    pointsPerDollar: z.number().min(0).max(1000).default(1),
    pointsRounding: z.enum(['floor', 'round', 'ceil']).default('floor'),
    pointValueCents: z.number().min(0).max(10_000).default(2),
    expiryPolicy: z.enum(['none', 'rolling', 'fixed']).default('none'),
    expiryMonths: z.number().int().min(1).max(120).nullable().default(null),
    enrolmentBonus: z.number().int().min(0).max(1_000_000).default(0),
    birthdayBonus: z.number().int().min(0).max(1_000_000).default(0),
    termsUrl: z.string().url().max(500).nullable().default(null),
  })
  .refine((v) => v.expiryPolicy === 'none' || v.expiryMonths !== null, { message: 'Say after how many months points expire.', path: ['expiryMonths'] });

/**
 * Create the org's programme, or change it. There is one programme per org: saving again
 * updates it in place, so members and their points carry over. Pausing it (isActive false)
 * stops earning and redeeming and keeps every balance.
 */
export async function saveProgram(ctx: Ctx, raw: z.input<typeof programInput>): Promise<ProgramView> {
  const parsed = programInput.safeParse(raw);
  if (!parsed.success) throw invalid('Those programme settings are not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);

  const before = await latestProgram(ctx);
  const values = {
    name: input.name,
    is_active: input.isActive,
    earn_model: input.earnModel,
    points_per_dollar: input.pointsPerDollar,
    points_rounding: input.pointsRounding,
    point_value_cents: input.pointValueCents,
    expiry_policy: input.expiryPolicy,
    expiry_months: input.expiryPolicy === 'none' ? null : input.expiryMonths,
    enrolment_bonus: input.enrolmentBonus,
    birthday_bonus: input.birthdayBonus,
    terms_url: input.termsUrl,
  };
  let id: string;
  if (before) {
    await ctx.db.updateTable('loyalty_programs').set(values).where('id', '=', before.id).execute();
    id = before.id;
  } else {
    const row = await ctx.db
      .insertInto('loyalty_programs')
      .values({ org_id: ctx.orgId, ...values, created_at: ctx.now() })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
  }
  const after = (await latestProgram(ctx))!;
  await audit(ctx, { action: before ? 'loyalty.program_updated' : 'loyalty.program_created', entityType: 'loyalty_program', entityId: id, before: before ?? undefined, after });
  return programView(after, await tiersOf(ctx, id));
}

export const tierInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(60),
  /** Points earned within the window to hold this tier. 0 = the tier everyone starts on. */
  thresholdPoints: z.number().int().min(0).max(100_000_000),
  windowMonths: z.number().int().min(1).max(120).default(12),
  /** Earn rate multiplier while on this tier, e.g. 1.5. */
  multiplier: z.number().min(0).max(99).default(1),
  perks: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

export async function saveTier(ctx: Ctx, raw: z.input<typeof tierInput>): Promise<TierView> {
  const parsed = tierInput.safeParse(raw);
  if (!parsed.success) throw invalid('That tier is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const program = await latestProgram(ctx);
  if (!program) throw invalid('Set up the loyalty programme first.');

  const values = {
    name: input.name,
    threshold_points: input.thresholdPoints,
    threshold_window_months: input.windowMonths,
    multiplier: input.multiplier,
    perks: json(input.perks),
    sort_order: input.sortOrder,
  };
  let id = input.id;
  let before: unknown;
  if (id) {
    before = await ctx.db.selectFrom('loyalty_tiers').selectAll().where('id', '=', id).where('program_id', '=', program.id).executeTakeFirst();
    if (!before) throw notFound('Tier not found');
    await ctx.db.updateTable('loyalty_tiers').set(values).where('id', '=', id).execute();
  } else {
    const row = await ctx.db.insertInto('loyalty_tiers').values({ org_id: ctx.orgId, program_id: program.id, ...values }).returning('id').executeTakeFirstOrThrow();
    id = row.id;
  }
  const after = (await tiersOf(ctx, program.id)).find((t) => t.id === id)!;
  await audit(ctx, { action: before ? 'loyalty.tier_updated' : 'loyalty.tier_created', entityType: 'loyalty_tier', entityId: id, before, after });
  return tierView(after);
}

/** Remove a tier. Members on it are re-tiered the next time their tier is worked out (their next sale, or overnight). */
export async function deleteTier(ctx: Ctx, tierId: string): Promise<void> {
  const id = z.string().uuid().parse(tierId);
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const before = await ctx.db.selectFrom('loyalty_tiers').selectAll().where('id', '=', id).executeTakeFirst();
  if (!before) throw notFound('Tier not found');
  await ctx.db.updateTable('loyalty_accounts').set({ tier_id: null }).where('tier_id', '=', id).execute();
  await ctx.db.deleteFrom('loyalty_tiers').where('id', '=', id).execute();
  await audit(ctx, { action: 'loyalty.tier_deleted', entityType: 'loyalty_tier', entityId: id, before });
}

// ── Rewards ─────────────────────────────────────────────────────────────────

export interface RewardView {
  id: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  costPoints: number;
  kind: 'fixed' | 'percent' | 'free_item';
  valueCents: number | null;
  percentOff: number | null;
  menuItemId: string | null;
  minSpendCents: number;
  validVenueIds: string[] | null;
  /** 0 = Sunday. Null = every day. */
  validDays: number[] | null;
  validFrom: Date | null;
  validTo: Date | null;
  maxRedemptionsTotal: number | null;
  maxRedemptionsPerCustomer: number | null;
  isActive: boolean;
}

export interface RewardRow {
  id: string;
  program_id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  cost_points: number;
  kind: 'fixed' | 'percent' | 'free_item';
  value_cents: number | null;
  percent_off: number | null;
  menu_item_id: string | null;
  min_spend_cents: number;
  valid_venue_ids: string[] | null;
  valid_days: number[] | null;
  valid_from: Date | null;
  valid_to: Date | null;
  max_redemptions_total: number | null;
  max_redemptions_per_customer: number | null;
  is_active: boolean;
}

export const REWARD_COLS = [
  'id',
  'program_id',
  'name',
  'description',
  'image_url',
  'cost_points',
  'kind',
  'value_cents',
  'percent_off',
  'menu_item_id',
  'min_spend_cents',
  'valid_venue_ids',
  'valid_days',
  'valid_from',
  'valid_to',
  'max_redemptions_total',
  'max_redemptions_per_customer',
  'is_active',
] as const;

export const rewardView = (r: RewardRow): RewardView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  imageUrl: r.image_url,
  costPoints: r.cost_points,
  kind: r.kind,
  valueCents: r.value_cents,
  percentOff: r.percent_off,
  menuItemId: r.menu_item_id,
  minSpendCents: r.min_spend_cents,
  validVenueIds: r.valid_venue_ids,
  validDays: r.valid_days,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  maxRedemptionsTotal: r.max_redemptions_total,
  maxRedemptionsPerCustomer: r.max_redemptions_per_customer,
  isActive: r.is_active,
});

export const rewardInput = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().default(null),
    imageUrl: z.string().url().max(1000).nullable().default(null),
    costPoints: z.number().int().min(1).max(100_000_000),
    kind: z.enum(['fixed', 'percent', 'free_item']),
    /** Dollars off for a fixed reward. For a free item: what it is worth at the till, used to match the sale. */
    valueCents: z.number().int().min(1).max(10_000_000).nullable().default(null),
    percentOff: z.number().int().min(1).max(100).nullable().default(null),
    menuItemId: z.string().uuid().nullable().default(null),
    minSpendCents: z.number().int().min(0).max(10_000_000).default(0),
    validVenueIds: z.array(z.string().uuid()).min(1).nullable().default(null),
    validDays: z.array(z.number().int().min(0).max(6)).min(1).nullable().default(null),
    validFrom: z.coerce.date().nullable().default(null),
    validTo: z.coerce.date().nullable().default(null),
    maxRedemptionsTotal: z.number().int().min(1).nullable().default(null),
    maxRedemptionsPerCustomer: z.number().int().min(1).nullable().default(null),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, c) => {
    if (v.kind === 'fixed' && !v.valueCents) c.addIssue({ code: 'custom', message: 'Say how much this reward takes off.', path: ['valueCents'] });
    if (v.kind === 'percent' && !v.percentOff) c.addIssue({ code: 'custom', message: 'Say what percentage this reward takes off.', path: ['percentOff'] });
    if (v.kind === 'free_item' && !v.menuItemId && !v.valueCents) c.addIssue({ code: 'custom', message: 'Choose the free item, or say what it is worth.', path: ['menuItemId'] });
    if (v.validFrom && v.validTo && v.validTo <= v.validFrom) c.addIssue({ code: 'custom', message: 'The end date must be after the start date.', path: ['validTo'] });
  });

export async function saveReward(ctx: Ctx, raw: z.input<typeof rewardInput>): Promise<RewardView> {
  const parsed = rewardInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That reward is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const program = await latestProgram(ctx);
  if (!program) throw invalid('Set up the loyalty programme first.');

  if (input.validVenueIds) {
    // Row-level security hides other orgs' venues, so an id from elsewhere simply is not found.
    const found = await ctx.db.selectFrom('venues').select('id').where('id', 'in', input.validVenueIds).execute();
    if (found.length !== new Set(input.validVenueIds).size) throw notFound('Venue not found');
  }

  const values = {
    name: input.name,
    description: input.description,
    image_url: input.imageUrl,
    cost_points: input.costPoints,
    kind: input.kind,
    value_cents: input.valueCents,
    percent_off: input.kind === 'percent' ? input.percentOff : null,
    menu_item_id: input.kind === 'free_item' ? input.menuItemId : null,
    min_spend_cents: input.minSpendCents,
    valid_venue_ids: input.validVenueIds,
    valid_days: input.validDays,
    valid_from: input.validFrom,
    valid_to: input.validTo,
    max_redemptions_total: input.maxRedemptionsTotal,
    max_redemptions_per_customer: input.maxRedemptionsPerCustomer,
    is_active: input.isActive,
  };
  let id = input.id;
  let before: unknown;
  if (id) {
    before = await ctx.db.selectFrom('rewards').select(REWARD_COLS).where('id', '=', id).where('program_id', '=', program.id).executeTakeFirst();
    if (!before) throw notFound('Reward not found');
    await ctx.db.updateTable('rewards').set(values).where('id', '=', id).execute();
  } else {
    const row = await ctx.db
      .insertInto('rewards')
      .values({ org_id: ctx.orgId, program_id: program.id, ...values, created_at: ctx.now() })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
  }
  const after = await ctx.db.selectFrom('rewards').select(REWARD_COLS).where('id', '=', id).executeTakeFirstOrThrow();
  await audit(ctx, { action: before ? 'loyalty.reward_updated' : 'loyalty.reward_created', entityType: 'reward', entityId: id, before, after });
  return rewardView(after);
}

/** Every reward, for the console. */
export async function listRewards(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<RewardView[]> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertLoyaltyOn(ctx);
  const program = await latestProgram(ctx);
  if (!program) return [];
  let q = ctx.db.selectFrom('rewards').select(REWARD_COLS).where('program_id', '=', program.id).orderBy('cost_points').orderBy('name');
  if (!opts.includeInactive) q = q.where('is_active', '=', true);
  return (await q.execute()).map(rewardView);
}

/** Why a reward cannot be used at this venue right now, in plain words; null when it can. */
export function rewardBlockedReason(r: RewardRow, at: { venueId: string; now: Date; timezone: string }): string | null {
  if (!r.is_active) return 'That reward is no longer offered.';
  if (r.valid_from && at.now < r.valid_from) return 'That reward is not available yet.';
  if (r.valid_to && at.now >= r.valid_to) return 'That reward has ended.';
  if (r.valid_venue_ids && !r.valid_venue_ids.includes(at.venueId)) return 'That reward cannot be used at this venue.';
  if (r.valid_days && !r.valid_days.includes(localParts(at.now, at.timezone).weekday)) return 'That reward cannot be used today.';
  return null;
}

/** What a reward takes off a sale of this size. For a free item the caller supplies the item's price. */
export function rewardDiscountCents(r: Pick<RewardRow, 'kind' | 'value_cents' | 'percent_off'>, subtotalCents: number, freeItemPriceCents?: number | null): number {
  let off = 0;
  if (r.kind === 'fixed') off = r.value_cents ?? 0;
  else if (r.kind === 'percent') off = percentOf(subtotalCents, r.percent_off ?? 0);
  else off = freeItemPriceCents ?? r.value_cents ?? 0;
  return Math.max(0, Math.min(off, subtotalCents));
}

/** What staff apply at the till, in plain words: "$10 off", "15% off", "Free item". */
export function rewardSummary(r: Pick<RewardRow, 'kind' | 'value_cents' | 'percent_off'>, currency = 'AUD'): string {
  if (r.kind === 'fixed') return `${formatMoney(r.value_cents ?? 0, currency).replace(/\.00$/, '')} off`;
  if (r.kind === 'percent') return `${r.percent_off ?? 0}% off`;
  return 'Free item';
}
