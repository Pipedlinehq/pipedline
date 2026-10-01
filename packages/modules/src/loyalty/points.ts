import { type Ctx, AppError, getModule, sql, staffOf, track } from '@ros/core';
import { type LoyaltyConfig, loyaltyModule, loyaltyTierChanged } from './module';

/**
 * The points ledger's internals: the active programme, a member's account, balance, held
 * points, the one function that writes a points row, and tier evaluation. Nothing here checks
 * a role; the service functions that call these do.
 */

export type PointsKind = 'earn' | 'burn' | 'adjust' | 'expire' | 'transfer' | 'reverse' | 'bonus';

export interface ProgramRow {
  id: string;
  name: string;
  is_active: boolean;
  earn_model: string;
  points_per_dollar: number;
  points_rounding: string;
  point_value_cents: number;
  expiry_months: number | null;
  expiry_policy: string;
  enrolment_bonus: number;
  birthday_bonus: number;
  terms_url: string | null;
}

export interface AccountRow {
  id: string;
  program_id: string;
  customer_id: string;
  tier_id: string | null;
  member_code: string;
  status: string;
  enrolled_at: Date;
  enrolled_venue_id: string | null;
}

const PROGRAM_COLS = [
  'id',
  'name',
  'is_active',
  'earn_model',
  'points_per_dollar',
  'points_rounding',
  'point_value_cents',
  'expiry_months',
  'expiry_policy',
  'enrolment_bonus',
  'birthday_bonus',
  'terms_url',
] as const;

export const ACCOUNT_COLS = ['id', 'program_id', 'customer_id', 'tier_id', 'member_code', 'status', 'enrolled_at', 'enrolled_venue_id'] as const;

/** The org's one active programme, or null when none has been set up (or it is paused). */
export async function activeProgram(ctx: Ctx): Promise<ProgramRow | null> {
  const r = await ctx.db.selectFrom('loyalty_programs').select(PROGRAM_COLS).where('is_active', '=', true).executeTakeFirst();
  return r ?? null;
}

/** The org's programme whether or not it is active (there is one row per org in practice). */
export async function latestProgram(ctx: Ctx): Promise<ProgramRow | null> {
  const r = await ctx.db.selectFrom('loyalty_programs').select(PROGRAM_COLS).orderBy('is_active', 'desc').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  return r ?? null;
}

/**
 * Loyalty is org-wide but switched on per venue. With a venue, the module must be on there.
 * Without one (the guest's own account page, programme settings) it must be on somewhere.
 */
export async function assertLoyaltyOn(ctx: Ctx, venueId?: string | null): Promise<LoyaltyConfig> {
  if (venueId) {
    const state = await getModule(ctx, venueId, loyaltyModule);
    if (!state.enabled) throw new AppError('module_disabled', 'That is not available at this venue.');
    return state.config;
  }
  const on = await ctx.db.selectFrom('venue_modules').select('venue_id').where('module_key', '=', loyaltyModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  if (!on) throw new AppError('module_disabled', 'That is not available at this venue.');
  return loyaltyModule.defaultConfig;
}

/** The venue's loyalty config, or null when the module is off there. Cached per call site for loops. */
export async function venueLoyalty(ctx: Ctx, venueId: string, cache?: Map<string, LoyaltyConfig | null>): Promise<LoyaltyConfig | null> {
  if (cache?.has(venueId)) return cache.get(venueId)!;
  const state = await getModule(ctx, venueId, loyaltyModule);
  const config = state.enabled ? state.config : null;
  cache?.set(venueId, config);
  return config;
}

export async function accountById(ctx: Ctx, accountId: string): Promise<AccountRow | null> {
  const r = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('id', '=', accountId).executeTakeFirst();
  return r ?? null;
}

/** A customer's account in the active programme. */
export async function accountForCustomer(ctx: Ctx, customerId: string, programId?: string): Promise<AccountRow | null> {
  const pid = programId ?? (await activeProgram(ctx))?.id;
  if (!pid) return null;
  const r = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('customer_id', '=', customerId).where('program_id', '=', pid).executeTakeFirst();
  return r ?? null;
}

/**
 * Serialises everything that spends from one account. Every path that holds, burns, removes or
 * expires points takes this lock first and only then reads the balance, so two of them at once
 * cannot both see the same points as available.
 */
export async function lockAccount(ctx: Ctx, accountId: string): Promise<AccountRow | null> {
  const r = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('id', '=', accountId).forUpdate().executeTakeFirst();
  return r ?? null;
}

/** The balance is the sum of the ledger. There is no stored balance anywhere. */
export async function balanceOf(ctx: Ctx, accountId: string): Promise<number> {
  const r = await ctx.db
    .selectFrom('loyalty_transactions')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('points'), sql<number>`0`).as('balance'))
    .where('account_id', '=', accountId)
    .executeTakeFirstOrThrow();
  return Number(r.balance);
}

/** Points promised to live counter codes. Held, not spent: they come back if the code lapses. */
export async function heldPoints(ctx: Ctx, accountId: string, exceptRedemptionId?: string): Promise<number> {
  let q = ctx.db
    .selectFrom('redemptions')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('points'), sql<number>`0`).as('held'))
    .where('account_id', '=', accountId)
    .where('status', '=', 'issued');
  if (exceptRedemptionId) q = q.where('id', '!=', exceptRedemptionId);
  const r = await q.executeTakeFirstOrThrow();
  return Number(r.held);
}

export async function availablePoints(ctx: Ctx, accountId: string): Promise<{ balance: number; held: number; available: number }> {
  const balance = await balanceOf(ctx, accountId);
  const held = await heldPoints(ctx, accountId);
  return { balance, held, available: balance - held };
}

export interface PointsEntry {
  accountId: string;
  kind: PointsKind;
  /** Signed. */
  points: number;
  /** Two writes with the same key are one row. Build it from what the row is about. */
  key: string;
  occurredAt?: Date;
  sourceTransactionId?: string | null;
  orderId?: string | null;
  redemptionId?: string | null;
  venueId?: string | null;
  note?: string | null;
}

/** The only place a points row is written. Returns false when the key had already been used. */
export async function writePoints(ctx: Ctx, e: PointsEntry): Promise<boolean> {
  if (!Number.isInteger(e.points) || e.points === 0) return false;
  const row = await ctx.db
    .insertInto('loyalty_transactions')
    .values({
      org_id: ctx.orgId,
      account_id: e.accountId,
      occurred_at: e.occurredAt ?? ctx.now(),
      kind: e.kind,
      points: e.points,
      source_transaction_id: e.sourceTransactionId ?? null,
      order_id: e.orderId ?? null,
      redemption_id: e.redemptionId ?? null,
      venue_id: e.venueId ?? null,
      staff_id: staffOf(ctx)?.staffId ?? null,
      idempotency_key: e.key,
      note: e.note ?? null,
      created_at: ctx.now(),
    })
    .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return !!row;
}

/** Calendar months before an instant, clamped to the end of a shorter month. */
export function monthsBefore(at: Date, months: number): Date {
  const d = new Date(at.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export interface TierRow {
  id: string;
  name: string;
  threshold_points: number;
  threshold_window_months: number;
  multiplier: number;
  perks: unknown;
  sort_order: number;
}

export async function tiersOf(ctx: Ctx, programId: string): Promise<TierRow[]> {
  return ctx.db
    .selectFrom('loyalty_tiers')
    .select(['id', 'name', 'threshold_points', 'threshold_window_months', 'multiplier', 'perks', 'sort_order'])
    .where('program_id', '=', programId)
    .orderBy('threshold_points', 'asc')
    .orderBy('sort_order', 'asc')
    .execute();
}

/**
 * Points that count toward a tier: what sales earned in the window, less what refunds took
 * back. Bonuses, adjustments and spending do not move a tier. A balance carried over by a merge does.
 */
export async function qualifyingPoints(ctx: Ctx, accountId: string, since: Date, until: Date): Promise<number> {
  const r = await ctx.db
    .selectFrom('loyalty_transactions')
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('points'), sql<number>`0`).as('points'))
    .where('account_id', '=', accountId)
    .where('occurred_at', '>', since)
    .where('occurred_at', '<=', until)
    .where((eb) =>
      eb.or([
        eb('kind', '=', 'earn'),
        eb.and([eb('kind', '=', 'reverse'), eb('redemption_id', 'is', null)]),
        eb.and([eb('kind', '=', 'transfer'), eb('points', '>', 0)]),
      ]),
    )
    .executeTakeFirstOrThrow();
  return Number(r.points);
}

/**
 * Work out the member's tier as of `at` (each tier over its own window) and store it if it
 * changed. The stored tier is a cache of this calculation, never the authority.
 */
export async function evaluateTier(ctx: Ctx, account: Pick<AccountRow, 'id' | 'program_id' | 'tier_id' | 'customer_id'>, at?: Date, tiers?: TierRow[]): Promise<TierRow | null> {
  const when = at ?? ctx.now();
  const all = tiers ?? (await tiersOf(ctx, account.program_id));
  const byWindow = new Map<number, number>();
  let chosen: TierRow | null = null;
  for (const t of [...all].sort((a, b) => b.threshold_points - a.threshold_points)) {
    let q = t.threshold_points <= 0 ? 0 : byWindow.get(t.threshold_window_months);
    if (q === undefined) {
      q = await qualifyingPoints(ctx, account.id, monthsBefore(when, t.threshold_window_months), when);
      byWindow.set(t.threshold_window_months, q);
    }
    if (q >= t.threshold_points) {
      chosen = t;
      break;
    }
  }
  const next = chosen?.id ?? null;
  if (next !== account.tier_id) {
    await ctx.db.updateTable('loyalty_accounts').set({ tier_id: next }).where('id', '=', account.id).execute();
    const from = all.find((t) => t.id === account.tier_id)?.name ?? null;
    await track(ctx, loyaltyTierChanged, { account_id: account.id, from, to: chosen?.name ?? null }, { customerId: account.customer_id, occurredAt: when });
    account.tier_id = next;
  }
  return chosen;
}

/** The org's public address, for links in messages. Null until a domain is live. */
export async function primaryHost(ctx: Ctx): Promise<string | null> {
  const r = await ctx.db
    .selectFrom('domains')
    .select('host')
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .orderBy('venue_id', (ob) => ob.asc().nullsFirst())
    .executeTakeFirst();
  return r ? `${ctx.app.config.scheme}://${r.host}` : null;
}

/** The org's currency, for amounts shown in plain words. */
export async function orgCurrency(ctx: Ctx): Promise<string> {
  const r = await ctx.db.selectFrom('orgs').select('currency').where('id', '=', ctx.orgId).executeTakeFirst();
  return r?.currency ?? 'AUD';
}
