import { z } from 'zod';
import { type Ctx, type IdentityHint, AppError, GUEST_FACING_ROLES, audit, forbidden, getModule, invalid, isInternal, newCode, notFound, requireGuest, requireStaff, track } from '@ros/core';
import type { OrderSnapshot, OrderStatus } from '../ordering/contract';
import { resolveCustomer } from '../identity/resolve';
import { queueMessage } from '../comms/outbox';
import { LOYALTY_JOIN_FLAG, loyaltyBonusAwarded, loyaltyEnrolled, loyaltyModule } from './module';
import { type AccountRow, type ProgramRow, ACCOUNT_COLS, activeProgram, assertLoyaltyOn, balanceOf, evaluateTier, primaryHost, venueLoyalty, writePoints } from './points';
import { backfillForCustomer } from './earning';
import { WELCOME_TEMPLATE } from './templates';

export type EnrolVia = 'guest' | 'checkout' | 'counter' | 'import';

export interface EnrolResult {
  accountId: string;
  memberCode: string;
  /** False when the guest was already a member: nothing was changed or sent. */
  created: boolean;
  bonusPoints: number;
}

interface EnrolArgs {
  customerId: string;
  venueId: string | null;
  via: EnrolVia;
  /** Send the welcome message. Off for imports and fixtures. */
  notify: boolean;
  /** Give the programme's enrolment bonus. */
  bonus: boolean;
  /** When the guest joined, for an import. Defaults to now. */
  at?: Date;
}

/** Identities a customer already holds that can be passed back to the identity spine to name them. */
async function knownHints(ctx: Ctx, customerId: string): Promise<IdentityHint[]> {
  const rows = await ctx.db
    .selectFrom('customer_identities')
    .select(['kind', 'value'])
    .where('customer_id', '=', customerId)
    .where('kind', 'in', ['email', 'phone', 'pos_customer_id', 'loyalty_qr'])
    .limit(4)
    .execute();
  return rows.map((r) => ({ kind: r.kind as IdentityHint['kind'], value: r.value }));
}

/**
 * The enrolment itself, shared by every way of joining. No role check: callers have done it.
 * Joining twice is one account; the second call changes nothing.
 */
export async function enrolCustomer(ctx: Ctx, program: ProgramRow, args: EnrolArgs): Promise<EnrolResult> {
  const customer = await ctx.db
    .selectFrom('customers')
    .select(['id', 'status', 'first_name', 'primary_email', 'primary_phone'])
    .where('id', '=', args.customerId)
    .executeTakeFirst();
  if (!customer || customer.status !== 'active') throw notFound('Customer not found');

  const find = () => ctx.db.selectFrom('loyalty_accounts').select(ACCOUNT_COLS).where('program_id', '=', program.id).where('customer_id', '=', customer.id).executeTakeFirst();
  const existing = await find();
  if (existing) {
    // Someone who left and comes back gets their old account, points and history.
    if (existing.status === 'closed') await ctx.db.updateTable('loyalty_accounts').set({ status: 'active' }).where('id', '=', existing.id).execute();
    return { accountId: existing.id, memberCode: existing.member_code, created: false, bonusPoints: 0 };
  }

  const at = args.at ?? ctx.now();
  let account: AccountRow | undefined;
  for (let attempt = 0; attempt < 6 && !account; attempt++) {
    const inserted = await ctx.db
      .insertInto('loyalty_accounts')
      .values({ org_id: ctx.orgId, program_id: program.id, customer_id: customer.id, member_code: newCode(10, 'M'), status: 'active', enrolled_at: at, enrolled_venue_id: args.venueId })
      .onConflict((oc) => oc.doNothing())
      .returning(ACCOUNT_COLS)
      .executeTakeFirst();
    if (inserted) account = inserted;
    else {
      // Either another request enrolled this guest a moment ago, or the member code collided.
      const raced = await find();
      if (raced) return { accountId: raced.id, memberCode: raced.member_code, created: false, bonusPoints: 0 };
    }
  }
  if (!account) throw new AppError('unavailable', 'Could not create the membership just now. Try again.');

  // The member code is what the membership QR encodes. Stored as an identity, a scan at the till
  // or on the counter screen resolves straight to this guest.
  const hints = await knownHints(ctx, customer.id);
  if (hints.length) {
    await resolveCustomer(ctx, { hints: [hints[0]!, { kind: 'loyalty_qr', value: account.member_code }], via: 'loyalty', venueId: args.venueId, createIfMissing: false });
  }

  let bonusPoints = 0;
  if (args.bonus && program.enrolment_bonus > 0) {
    const wrote = await writePoints(ctx, { accountId: account.id, kind: 'bonus', points: program.enrolment_bonus, key: `enrol:${account.id}`, occurredAt: at, venueId: args.venueId, note: 'Joining bonus' });
    if (wrote) {
      bonusPoints = program.enrolment_bonus;
      await track(ctx, loyaltyBonusAwarded, { account_id: account.id, points: bonusPoints, reason: 'enrolment' }, { customerId: customer.id, venueId: args.venueId, occurredAt: at });
    }
  }

  await track(ctx, loyaltyEnrolled, { account_id: account.id, via: args.via, bonus_points: bonusPoints }, { customerId: customer.id, venueId: args.venueId, occurredAt: at });

  // A guest who paid and then joined at the counter still earns for that sale.
  const lookback = (args.venueId ? await venueLoyalty(ctx, args.venueId) : null)?.earnLookbackHours ?? loyaltyModule.defaultConfig.earnLookbackHours;
  await backfillForCustomer(ctx, program, account, { since: new Date(at.getTime() - lookback * 3_600_000) });
  await evaluateTier(ctx, account, at);

  if (args.notify) {
    const channel = customer.primary_email ? 'email' : customer.primary_phone ? 'sms' : null;
    if (channel) {
      const host = await primaryHost(ctx);
      await queueMessage(ctx, {
        templateKey: WELCOME_TEMPLATE,
        channel,
        customerId: customer.id,
        venueId: args.venueId,
        idempotencyKey: `loyalty-welcome:${account.id}`,
        variables: {
          first_name: customer.first_name ?? 'there',
          program_name: program.name,
          member_code: account.member_code,
          balance: await balanceOf(ctx, account.id),
          bonus_line: bonusPoints > 0 ? `We have added ${bonusPoints} points to get you started.` : '',
          account_url: host ? `${host}/loyalty` : '',
        },
      });
    }
  }
  return { accountId: account.id, memberCode: account.member_code, created: true, bonusPoints };
}

export const joinInput = z.object({ venueId: z.string().uuid().nullish() });

/** The guest joins from their own account page. */
export async function joinLoyalty(ctx: Ctx, raw: z.input<typeof joinInput> = {}): Promise<EnrolResult> {
  const input = joinInput.parse(raw);
  const customerId = requireGuest(ctx);
  await assertLoyaltyOn(ctx, input.venueId);
  const program = await activeProgram(ctx);
  if (!program) throw invalid('There is no loyalty programme to join yet.');
  return enrolCustomer(ctx, program, { customerId, venueId: input.venueId ?? null, via: 'guest', notify: true, bonus: true });
}

export const counterEnrolInput = z
  .object({
    venueId: z.string().uuid(),
    phone: z.string().trim().min(6).max(30).optional(),
    email: z.string().trim().min(3).max(254).optional(),
    firstName: z.string().trim().min(1).max(100).optional(),
    lastName: z.string().trim().min(1).max(100).optional(),
    birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine((v) => v.phone || v.email, { message: 'Ask the guest for a phone number or an email address.' });

/**
 * Staff enrol a guest at the counter with the phone number or email the guest gives them. Finds
 * the guest's existing record or creates one. Records no marketing consent: that box is the
 * guest's own to tick.
 */
export async function enrolAtCounter(ctx: Ctx, raw: z.input<typeof counterEnrolInput>): Promise<EnrolResult & { customerId: string }> {
  const parsed = counterEnrolInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'Those details are not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, anyOf: GUEST_FACING_ROLES });
  const config = await assertLoyaltyOn(ctx, input.venueId);
  if (!config.counterEnrolment && !isInternal(ctx)) throw forbidden('Joining at the counter is switched off at this venue.');
  const program = await activeProgram(ctx);
  if (!program) throw invalid('There is no loyalty programme to join yet.');

  const hints: IdentityHint[] = [];
  if (input.phone) hints.push({ kind: 'phone', value: input.phone });
  if (input.email) hints.push({ kind: 'email', value: input.email });
  const resolved = await resolveCustomer(ctx, {
    hints,
    via: 'loyalty',
    venueId: input.venueId,
    profile: { firstName: input.firstName ?? null, lastName: input.lastName ?? null, birthday: input.birthday ?? null },
  });
  if (!resolved.customerId) throw invalid('That phone number or email address does not look right.');

  const result = await enrolCustomer(ctx, program, { customerId: resolved.customerId, venueId: input.venueId, via: 'counter', notify: true, bonus: true });
  if (result.created) {
    await audit(ctx, { action: 'loyalty.enrolled_at_counter', entityType: 'loyalty_account', entityId: result.accountId, venueId: input.venueId, after: { customerId: resolved.customerId, newCustomer: resolved.created } });
  }
  return { ...result, customerId: resolved.customerId };
}

export const importMemberInput = z.object({
  customerId: z.string().uuid(),
  venueId: z.string().uuid().nullish(),
  enrolledAt: z.coerce.date().optional(),
  bonus: z.boolean().default(false),
});

/**
 * Bring an existing customer in as a member without messaging them: moving from another
 * loyalty system, or seeding fixtures. Internal callers only.
 */
export async function importMember(ctx: Ctx, raw: z.input<typeof importMemberInput>): Promise<EnrolResult> {
  const input = importMemberInput.parse(raw);
  if (!isInternal(ctx)) throw forbidden('Only an import can do that.');
  const program = await activeProgram(ctx);
  if (!program) throw invalid('There is no loyalty programme to join yet.');
  return enrolCustomer(ctx, program, { customerId: input.customerId, venueId: input.venueId ?? null, via: 'import', notify: false, bonus: input.bonus, at: input.enrolledAt });
}

const PAID: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['placed', 'accepted', 'preparing', 'ready', 'completed']);

/**
 * The guest ticked "join the loyalty programme" at checkout. Registered with ordering's
 * onOrderStatusChanged, so it runs inside the order's own transaction on every status change:
 * it enrols once the order is paid, and does nothing (rather than fail the order) when loyalty
 * is off at the venue, there is no programme, or the guest is already a member.
 */
export async function enrolFromCheckout(ctx: Ctx, order: OrderSnapshot, change: { from: OrderStatus | null; to: OrderStatus }): Promise<void> {
  if (!order.customerId || !order.flags.includes(LOYALTY_JOIN_FLAG) || !PAID.has(change.to)) return;
  const state = await getModule(ctx, order.venueId, loyaltyModule);
  if (!state.enabled) return;
  const program = await activeProgram(ctx);
  if (!program) return;
  const customer = await ctx.db.selectFrom('customers').select('status').where('id', '=', order.customerId).executeTakeFirst();
  if (customer?.status !== 'active') return;
  await enrolCustomer(ctx, program, { customerId: order.customerId, venueId: order.venueId, via: 'checkout', notify: true, bonus: true });
}
