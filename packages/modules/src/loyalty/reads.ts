import { z } from 'zod';
import { type Ctx, AppError, GUEST_FACING_ROLES, invalid, isInternal, notFound, requireGuest, requireStaff, sql, staffOf, visibleVenueIds } from '@ros/core';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import type { PointsKind } from './points';
import { type AccountRow, type ProgramRow, type TierRow, ACCOUNT_COLS, accountById, accountForCustomer, activeProgram, assertLoyaltyOn, availablePoints, latestProgram, monthsBefore, qualifyingPoints, tiersOf } from './points';
import { type ProgramView, type RewardRow, type RewardView, type TierView, REWARD_COLS, getProgram, rewardBlockedReason, rewardView, tierView } from './program';
import { type RedemptionView, redemptionsOf, rewardCheckoutCode } from './redemption';

/** What a guest sees of their own membership, and what staff see when they look a guest up. */

export interface MemberAccount {
  accountId: string;
  memberCode: string;
  status: 'active' | 'suspended' | 'closed';
  enrolledAt: Date;
  /** SUM(points). */
  balance: number;
  /** Promised to live counter codes. */
  held: number;
  /** What can be spent right now. */
  available: number;
  /** What the available points are worth, at the programme's point value. */
  valueCents: number;
  tier: TierView | null;
  nextTier: { name: string; thresholdPoints: number; pointsToGo: number } | null;
}

export interface HistoryEntry {
  id: string;
  occurredAt: Date;
  kind: PointsKind;
  points: number;
  description: string;
  venueId: string | null;
}

export interface RewardOption extends RewardView {
  canAfford: boolean;
  pointsShort: number;
  /** Why it cannot be used at the venue asked about, in plain words. Null when it can, or when no venue was given. */
  blockedReason: string | null;
  /** What checkout submits to use this reward online. */
  checkoutCode: string;
}

function describe(kind: PointsKind, points: number, note: string | null): string {
  switch (kind) {
    case 'earn':
      return 'Points earned';
    case 'burn':
      return 'Reward redeemed';
    case 'bonus':
      return note ?? 'Bonus points';
    case 'expire':
      return 'Points expired';
    case 'reverse':
      return points < 0 ? 'Points returned after a refund' : 'Reward returned';
    case 'transfer':
      return 'Moved between your accounts';
    case 'adjust':
      return points < 0 ? 'Adjustment by the venue' : 'Points added by the venue';
  }
}

async function memberAccount(ctx: Ctx, program: ProgramRow, account: AccountRow, tiers: TierRow[]): Promise<MemberAccount> {
  const { balance, held, available } = await availablePoints(ctx, account.id);
  const current = tiers.find((t) => t.id === account.tier_id) ?? null;
  const above = tiers.filter((t) => t.threshold_points > (current?.threshold_points ?? -1) && t.id !== current?.id).sort((a, b) => a.threshold_points - b.threshold_points)[0];
  let nextTier: MemberAccount['nextTier'] = null;
  if (above) {
    const now = ctx.now();
    const have = await qualifyingPoints(ctx, account.id, monthsBefore(now, above.threshold_window_months), now);
    nextTier = { name: above.name, thresholdPoints: above.threshold_points, pointsToGo: Math.max(0, above.threshold_points - have) };
  }
  return {
    accountId: account.id,
    memberCode: account.member_code,
    status: account.status as MemberAccount['status'],
    enrolledAt: account.enrolled_at,
    balance,
    held,
    available,
    valueCents: Math.max(0, Math.round(available * Number(program.point_value_cents))),
    tier: current ? tierView(current) : null,
    nextTier,
  };
}

async function history(ctx: Ctx, accountId: string, opts: { limit?: number; before?: Date } = {}): Promise<HistoryEntry[]> {
  let q = ctx.db
    .selectFrom('loyalty_transactions')
    .select(['id', 'occurred_at', 'kind', 'points', 'note', 'venue_id'])
    .where('account_id', '=', accountId)
    .orderBy('occurred_at', 'desc')
    .orderBy('created_at', 'desc')
    .limit(Math.min(opts.limit ?? 25, 200));
  if (opts.before) q = q.where('occurred_at', '<', opts.before);
  const rows = await q.execute();
  // A staff member's written reason for an adjustment is the venue's note, not shown to the guest.
  return rows.map((r) => ({ id: r.id, occurredAt: r.occurred_at, kind: r.kind, points: r.points, description: describe(r.kind, r.points, r.kind === 'bonus' ? r.note : null), venueId: r.venue_id }));
}

async function rewardOptions(ctx: Ctx, program: ProgramRow, available: number | null, venueId?: string | null): Promise<RewardOption[]> {
  const rows: RewardRow[] = await ctx.db.selectFrom('rewards').select(REWARD_COLS).where('program_id', '=', program.id).where('is_active', '=', true).orderBy('cost_points').orderBy('name').execute();
  let timezone: string | null = null;
  if (venueId) timezone = (await ctx.db.selectFrom('venues').select('timezone').where('id', '=', venueId).executeTakeFirst())?.timezone ?? null;
  const now = ctx.now();
  return rows
    .filter((r) => !r.valid_to || r.valid_to > now)
    .map((r) => ({
      ...rewardView(r),
      canAfford: available !== null && available >= r.cost_points,
      pointsShort: available === null ? r.cost_points : Math.max(0, r.cost_points - available),
      blockedReason: venueId && timezone ? rewardBlockedReason(r, { venueId, now, timezone }) : null,
      checkoutCode: rewardCheckoutCode(r.id),
    }));
}

export interface MyLoyalty {
  program: ProgramView | null;
  /** Null when the guest has not joined. */
  member: MemberAccount | null;
  rewards: RewardOption[];
  /** Counter codes that can still be used. */
  liveRedemptions: RedemptionView[];
  history: HistoryEntry[];
}

/**
 * The guest's own loyalty page: balance, tier, what they can redeem, recent history. It takes
 * no customer id: a guest can only ever read the account their session belongs to.
 */
export async function getMyLoyalty(ctx: Ctx, opts: { venueId?: string | null } = {}): Promise<MyLoyalty> {
  const customerId = requireGuest(ctx);
  await assertLoyaltyOn(ctx, opts.venueId);
  const programView = await getProgram(ctx);
  const program = await activeProgram(ctx);
  if (!program) return { program: null, member: null, rewards: [], liveRedemptions: [], history: [] };
  const account = await accountForCustomer(ctx, customerId, program.id);
  if (!account || account.status === 'closed') return { program: programView, member: null, rewards: await rewardOptions(ctx, program, null, opts.venueId), liveRedemptions: [], history: [] };
  const member = await memberAccount(ctx, program, account, await tiersOf(ctx, program.id));
  return {
    program: programView,
    member,
    rewards: await rewardOptions(ctx, program, member.available, opts.venueId),
    liveRedemptions: await redemptionsOf(ctx, account.id, { liveOnly: true }),
    history: await history(ctx, account.id),
  };
}

export const historyInput = z.object({ limit: z.number().int().min(1).max(200).default(50), before: z.coerce.date().optional() });

/** More of the guest's own points history, a page at a time. */
export async function getMyLoyaltyHistory(ctx: Ctx, raw: z.input<typeof historyInput> = {}): Promise<HistoryEntry[]> {
  const input = historyInput.parse(raw);
  const customerId = requireGuest(ctx);
  await assertLoyaltyOn(ctx);
  const account = await accountForCustomer(ctx, customerId);
  if (!account) return [];
  return history(ctx, account.id, input);
}

export interface AccountDetail {
  member: MemberAccount;
  history: HistoryEntry[];
  redemptions: RedemptionView[];
}

/**
 * One account by id: for the guest it belongs to, or for front-of-house staff. Anyone else's
 * id, or one from another org, is not found.
 */
export async function getAccount(ctx: Ctx, raw: { accountId: string }): Promise<AccountDetail> {
  const accountId = z.string().uuid().parse(raw.accountId);
  const p = ctx.principal;
  if (p.kind !== 'guest' && !isInternal(ctx)) {
    if (!staffOf(ctx)) throw new AppError('unauthenticated', 'Sign in to do that.');
    requireStaff(ctx, { anyOf: GUEST_FACING_ROLES });
  }
  await assertLoyaltyOn(ctx);
  const account = await accountById(ctx, accountId);
  if (!account || (p.kind === 'guest' && account.customer_id !== p.customerId)) throw notFound('Member not found');
  const program = await latestProgram(ctx);
  if (!program) throw notFound('Member not found');
  return {
    member: await memberAccount(ctx, program, account, await tiersOf(ctx, account.program_id)),
    history: await history(ctx, account.id),
    redemptions: await redemptionsOf(ctx, account.id, { limit: 20 }),
  };
}

// ── Staff lookups ───────────────────────────────────────────────────────────

export interface MemberCard extends MemberAccount {
  customerId: string;
  /** Guest-written. Render as text. */
  name: string;
  phone: string | null;
  email: string | null;
  rewards: RewardOption[];
  liveRedemptions: RedemptionView[];
  recent: HistoryEntry[];
}

async function memberCard(ctx: Ctx, program: ProgramRow, account: AccountRow, venueId: string): Promise<MemberCard> {
  const c = await ctx.db.selectFrom('customers').select(['first_name', 'last_name', 'primary_phone', 'primary_email']).where('id', '=', account.customer_id).executeTakeFirst();
  const member = await memberAccount(ctx, program, account, await tiersOf(ctx, program.id));
  return {
    ...member,
    customerId: account.customer_id,
    name: [c?.first_name, c?.last_name].filter(Boolean).join(' ') || 'Guest',
    phone: c?.primary_phone ?? null,
    email: c?.primary_email ?? null,
    rewards: await rewardOptions(ctx, program, member.available, venueId),
    liveRedemptions: await redemptionsOf(ctx, account.id, { liveOnly: true }),
    recent: await history(ctx, account.id, { limit: 10 }),
  };
}

export const lookupInput = z
  .object({
    venueId: z.string().uuid(),
    /** What the membership QR encodes. */
    memberCode: z.string().trim().min(3).max(40).optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    email: z.string().trim().min(3).max(254).optional(),
  })
  .refine((v) => [v.memberCode, v.phone, v.email].filter(Boolean).length === 1, { message: 'Look up by one of: member code, phone or email.' });

export interface LookupResult {
  /** The member, or null when the guest is not one (offer to enrol them). */
  member: MemberCard | null;
  /** Set when the guest is known to the venue but has not joined. */
  customerId: string | null;
}

/** Find the guest at the counter: by a scan of their membership QR, their phone number, or their email. */
export async function lookupMember(ctx: Ctx, raw: z.input<typeof lookupInput>): Promise<LookupResult> {
  const parsed = lookupInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  const by = input.memberCode ? 'qr' : input.phone ? 'phone' : 'email';
  if (!config.identifyBy.includes(by)) throw invalid('Looking guests up that way is switched off at this venue.');
  const program = await activeProgram(ctx);
  if (!program) return { member: null, customerId: null };

  let customerId: string | null = null;
  if (input.memberCode) {
    const code = input.memberCode.toUpperCase();
    const direct = await ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('member_code', '=', code).where('program_id', '=', program.id).executeTakeFirst();
    if (direct && direct.status !== 'closed') return { member: await memberCard(ctx, program, direct, input.venueId), customerId: direct.customer_id };
    // After a merge the old card still works: its code lives on as an identity of the surviving record.
    customerId = (await ctx.db.selectFrom('customer_identities').select('customer_id').where('kind', '=', 'loyalty_qr').where('value', '=', code).executeTakeFirst())?.customer_id ?? null;
  } else {
    const value = input.phone ? normalisePhone(input.phone) : normaliseEmail(input.email!);
    if (!value) throw invalid(input.phone ? 'That phone number does not look right.' : 'That email address does not look right.');
    customerId =
      (await ctx.db
        .selectFrom('customer_identities')
        .select('customer_id')
        .where('kind', '=', input.phone ? 'phone' : 'email')
        .where('value', '=', value)
        .executeTakeFirst())?.customer_id ?? null;
  }
  if (!customerId) return { member: null, customerId: null };
  const customer = await ctx.db.selectFrom('customers').select(['id', 'status']).where('id', '=', customerId).executeTakeFirst();
  if (!customer || customer.status !== 'active') return { member: null, customerId: null };
  const account = await accountForCustomer(ctx, customerId, program.id);
  if (!account || account.status === 'closed') return { member: null, customerId };
  return { member: await memberCard(ctx, program, account, input.venueId), customerId };
}

export const memberCardInput = z.object({ venueId: z.string().uuid(), accountId: z.string().uuid() });

/** The counter screen's view of one member: balance, the rewards usable here, live codes. */
export async function getMemberCard(ctx: Ctx, raw: z.input<typeof memberCardInput>): Promise<MemberCard> {
  const input = memberCardInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  await assertLoyaltyOn(ctx, input.venueId);
  const account = await accountById(ctx, input.accountId);
  const program = await latestProgram(ctx);
  if (!account || !program || account.program_id !== program.id) throw notFound('Member not found');
  return memberCard(ctx, program, account, input.venueId);
}

export interface MemberSummary {
  accountId: string;
  customerId: string;
  /** Guest-written. Render as text. */
  name: string;
  phone: string | null;
  email: string | null;
  tier: string | null;
  status: string;
  balance: number;
  enrolledAt: Date;
  lastActivityAt: Date | null;
}

async function memberRows(ctx: Ctx, program: ProgramRow, opts: { q?: string; limit: number; offset: number }): Promise<MemberSummary[]> {
  const q = opts.q?.trim();
  const like = q ? `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%` : null;
  const phone = q && /\d{6,}/.test(q.replace(/\D/g, '')) ? normalisePhone(q) : null;
  let query = ctx.db
    .selectFrom('loyalty_accounts as a')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .leftJoin('loyalty_tiers as t', 't.id', 'a.tier_id')
    .select((eb) => [
      'a.id',
      'a.customer_id',
      'a.status',
      'a.enrolled_at',
      'c.first_name',
      'c.last_name',
      'c.primary_phone',
      'c.primary_email',
      't.name as tier_name',
      eb
        .selectFrom('loyalty_transactions as lt')
        .select((e) => e.fn.coalesce(e.fn.sum<number>('lt.points'), sql<number>`0`).as('b'))
        .whereRef('lt.account_id', '=', 'a.id')
        .as('balance'),
      eb
        .selectFrom('loyalty_transactions as lt')
        .select((e) => e.fn.max('lt.occurred_at').as('m'))
        .whereRef('lt.account_id', '=', 'a.id')
        .as('last_activity_at'),
    ])
    .where('a.program_id', '=', program.id)
    .where('a.status', '!=', 'closed')
    .orderBy('a.enrolled_at', 'desc')
    .limit(opts.limit)
    .offset(opts.offset);
  if (like) {
    query = query.where((eb) =>
      eb.or([
        eb(sql<string>`coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')`, 'ilike', like),
        eb('c.primary_email', 'ilike', like),
        eb('a.member_code', 'ilike', like),
        ...(phone ? [eb('c.primary_phone', '=', phone)] : []),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    accountId: r.id,
    customerId: r.customer_id,
    name: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Guest',
    phone: r.primary_phone,
    email: r.primary_email,
    tier: r.tier_name,
    status: r.status,
    balance: Number(r.balance ?? 0),
    enrolledAt: r.enrolled_at,
    lastActivityAt: (r.last_activity_at as Date | null) ?? null,
  }));
}

export const searchMembersInput = z.object({ venueId: z.string().uuid(), q: z.string().trim().min(2).max(120), limit: z.number().int().min(1).max(50).default(20) });

/** Find a member by name at the counter, when they have no phone or card to hand. */
export async function searchMembers(ctx: Ctx, raw: z.input<typeof searchMembersInput>): Promise<MemberSummary[]> {
  const input = searchMembersInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  if (!config.identifyBy.includes('name')) throw invalid('Looking guests up by name is switched off at this venue.');
  const program = await activeProgram(ctx);
  if (!program) return [];
  return memberRows(ctx, program, { q: input.q, limit: input.limit, offset: 0 });
}

export const listMembersInput = z.object({ q: z.string().trim().max(120).optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) });

/** The member list for the console. */
export async function listMembers(ctx: Ctx, raw: z.input<typeof listMembersInput> = {}): Promise<MemberSummary[]> {
  const input = listMembersInput.parse(raw);
  requireStaff(ctx, { minRole: 'manager' });
  await assertLoyaltyOn(ctx);
  const program = await latestProgram(ctx);
  if (!program) return [];
  return memberRows(ctx, program, { q: input.q || undefined, limit: input.limit, offset: input.offset });
}

export interface CounterRedemption extends RedemptionView {
  /** Guest-written. Render as text. */
  memberName: string;
}

/** Codes issued at this venue that are still waiting for their sale, or lapsed in the last day: the counter screen's queue. */
export async function listCounterRedemptions(ctx: Ctx, raw: { venueId: string }): Promise<CounterRedemption[]> {
  const venueId = z.string().uuid().parse(raw.venueId);
  requireStaff(ctx, { venueId, anyOf: GUEST_FACING_ROLES });
  await assertLoyaltyOn(ctx, venueId);
  const now = ctx.now();
  const rows = await ctx.db
    .selectFrom('redemptions as r')
    .innerJoin('loyalty_accounts as a', 'a.id', 'r.account_id')
    .innerJoin('customers as c', 'c.id', 'a.customer_id')
    .select(['r.id', 'r.account_id', 'c.first_name', 'c.last_name'])
    .where('r.issued_venue_id', '=', venueId)
    .where('r.channel', '=', 'counter')
    .where('r.status', 'in', ['issued', 'expired'])
    .where('r.issued_at', '>', new Date(now.getTime() - 86_400_000))
    .orderBy('r.issued_at', 'desc')
    .limit(100)
    .execute();
  const out: CounterRedemption[] = [];
  const byAccount = new Map<string, RedemptionView[]>();
  for (const r of rows) {
    let list = byAccount.get(r.account_id);
    if (!list) {
      list = await redemptionsOf(ctx, r.account_id, { limit: 50 });
      byAccount.set(r.account_id, list);
    }
    const view = list.find((v) => v.id === r.id);
    if (view) out.push({ ...view, memberName: [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Guest' });
  }
  return out;
}

// ── The programme in numbers ────────────────────────────────────────────────

export interface LoyaltySummary {
  program: { name: string; active: boolean } | null;
  periodDays: number;
  members: { total: number; joinedInPeriod: number; neverEarned: number };
  points: { issued: number; redeemed: number; expired: number; outstanding: number; issuedInPeriod: number; redeemedInPeriod: number };
  /** What the outstanding points would cost to honour, at the programme's point value. */
  liabilityCents: number;
  /** Points redeemed as a share of points issued, all time. 0 to 1. */
  redemptionRate: number;
  redemptions: { issued: number; redeemed: number; expired: number; forced: number };
  earnCoverage: {
    /** Completed sales in the period tied to a known customer. */
    identifiedSales: number;
    /** Of those, sales by a member. */
    memberSales: number;
    /** Of those, sales that earned points. */
    earnedSales: number;
    /** earnedSales / identifiedSales. The number the old points leak would have shown as 0.14. */
    share: number;
    /** earnedSales / memberSales. Should sit at or near 1. */
    memberShare: number;
  };
  tiers: Array<{ name: string; members: number }>;
}

export const summaryInput = z.object({ days: z.number().int().min(1).max(730).default(30) });

/** Members, points issued and redeemed, the outstanding liability, and how much of the identified trade is earning. */
export async function getLoyaltySummary(ctx: Ctx, raw: z.input<typeof summaryInput> = {}): Promise<LoyaltySummary> {
  const input = summaryInput.parse(raw);
  requireStaff(ctx, { minRole: 'read_only' });
  await assertLoyaltyOn(ctx);
  const program = await latestProgram(ctx);
  const empty: LoyaltySummary = {
    program: null,
    periodDays: input.days,
    members: { total: 0, joinedInPeriod: 0, neverEarned: 0 },
    points: { issued: 0, redeemed: 0, expired: 0, outstanding: 0, issuedInPeriod: 0, redeemedInPeriod: 0 },
    liabilityCents: 0,
    redemptionRate: 0,
    redemptions: { issued: 0, redeemed: 0, expired: 0, forced: 0 },
    earnCoverage: { identifiedSales: 0, memberSales: 0, earnedSales: 0, share: 0, memberShare: 0 },
    tiers: [],
  };
  if (!program) return empty;
  const since = new Date(ctx.now().getTime() - input.days * 86_400_000);

  const members = (
    await sql<{ total: number; joined: number; never_earned: number }>`
      select count(*)::int as total,
             count(*) filter (where a.enrolled_at >= ${since})::int as joined,
             count(*) filter (where not exists (
               select 1 from loyalty_transactions lt where lt.account_id = a.id and lt.kind = 'earn'))::int as never_earned
      from loyalty_accounts a
      where a.program_id = ${program.id} and a.status <> 'closed'`.execute(ctx.db)
  ).rows[0]!;

  // Issued = what sales and bonuses gave, net of refunds. Redeemed = burns, net of returns.
  // A merge's transfer nets to zero and counts as neither.
  const points = (
    await sql<{ issued: number; redeemed: number; expired: number; outstanding: number; issued_period: number; redeemed_period: number }>`
      select coalesce(sum(lt.points) filter (where lt.kind in ('earn', 'bonus') or (lt.kind = 'adjust' and lt.points > 0) or (lt.kind = 'reverse' and lt.redemption_id is null)), 0)::int as issued,
             coalesce(-sum(lt.points) filter (where lt.kind = 'burn' or (lt.kind = 'reverse' and lt.redemption_id is not null)), 0)::int as redeemed,
             coalesce(-sum(lt.points) filter (where lt.kind = 'expire'), 0)::int as expired,
             coalesce(sum(lt.points), 0)::int as outstanding,
             coalesce(sum(lt.points) filter (where lt.occurred_at >= ${since} and (lt.kind in ('earn', 'bonus') or (lt.kind = 'adjust' and lt.points > 0) or (lt.kind = 'reverse' and lt.redemption_id is null))), 0)::int as issued_period,
             coalesce(-sum(lt.points) filter (where lt.occurred_at >= ${since} and (lt.kind = 'burn' or (lt.kind = 'reverse' and lt.redemption_id is not null))), 0)::int as redeemed_period
      from loyalty_transactions lt
      join loyalty_accounts a on a.id = lt.account_id
      where a.program_id = ${program.id}`.execute(ctx.db)
  ).rows[0]!;

  const redemptions = (
    await sql<{ issued: number; redeemed: number; expired: number; forced: number }>`
      select count(*)::int as issued,
             count(*) filter (where r.status = 'redeemed')::int as redeemed,
             count(*) filter (where r.status = 'expired')::int as expired,
             count(*) filter (where r.forced)::int as forced
      from redemptions r
      where r.issued_at >= ${since}`.execute(ctx.db)
  ).rows[0]!;

  const visible = visibleVenueIds(ctx);
  const venueFilter = visible === null ? sql`true` : visible.length ? sql`t.venue_id in (${sql.join(visible)})` : sql`false`;
  const coverage = (
    await sql<{ identified: number; member: number; earned: number }>`
      select count(*)::int as identified,
             count(*) filter (where a.id is not null)::int as member,
             count(*) filter (where exists (
               select 1 from loyalty_transactions lt where lt.source_transaction_id = t.id and lt.kind = 'earn'))::int as earned
      from transactions t
      left join loyalty_accounts a on a.customer_id = t.customer_id and a.program_id = ${program.id} and a.status <> 'closed'
      where t.customer_id is not null
        and t.status in ('completed', 'partially_refunded')
        and t.occurred_at >= ${since}
        and ${venueFilter}`.execute(ctx.db)
  ).rows[0]!;

  const tiers = (
    await sql<{ name: string; members: number }>`
      select coalesce(t.name, 'No tier') as name, count(*)::int as members
      from loyalty_accounts a
      left join loyalty_tiers t on t.id = a.tier_id
      where a.program_id = ${program.id} and a.status <> 'closed'
      group by t.name, t.threshold_points
      order by t.threshold_points nulls first`.execute(ctx.db)
  ).rows;

  const ratio = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 1000 : 0);
  return {
    program: { name: program.name, active: program.is_active },
    periodDays: input.days,
    members: { total: members.total, joinedInPeriod: members.joined, neverEarned: members.never_earned },
    points: { issued: points.issued, redeemed: points.redeemed, expired: points.expired, outstanding: points.outstanding, issuedInPeriod: points.issued_period, redeemedInPeriod: points.redeemed_period },
    liabilityCents: Math.max(0, Math.round(points.outstanding * Number(program.point_value_cents))),
    redemptionRate: ratio(points.redeemed, points.issued),
    redemptions,
    earnCoverage: { identifiedSales: coverage.identified, memberSales: coverage.member, earnedSales: coverage.earned, share: ratio(coverage.earned, coverage.identified), memberShare: ratio(coverage.earned, coverage.member) },
    tiers,
  };
}
