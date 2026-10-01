import { z } from 'zod';
import { type App, AppError, invalid } from '@ros/core';
import { resolveCustomer } from '../identity/resolve';
import { linkSessionToCustomer } from '../events/sessions';
import { badCode, issueOtp, parseDestination, verifyOtp } from './otp';
import { type Membership, createSession, membershipsOf } from './sessions';

const PLATFORM_NAME = 'Restaurant OS';

export interface RequestMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Step one of staff sign-in. Always answers the same way, whether or not the address belongs
 * to anyone, so the endpoint cannot be used to discover who has an account.
 */
export async function requestStaffLogin(app: App, rawEmail: string, meta: RequestMeta = {}): Promise<void> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw invalid('Enter your email address.');
  const user = await app.db.selectFrom('users').select('id').where('email', '=', destination.value).executeTakeFirst();
  if (!user) return;
  const memberships = await membershipsOf(app, user.id);
  const isAdmin = await app.db.selectFrom('platform_admins').select('user_id').where('user_id', '=', user.id).executeTakeFirst();
  if (!memberships.length && !isAdmin) return;
  await issueOtp(app, { purpose: 'staff_login', destination, orgId: null, senderName: PLATFORM_NAME, senderSlug: 'signin', ip: meta.ip });
}

export interface StaffLoginResult {
  token: string;
  memberships: Membership[];
  /** Set when the person belongs to exactly one org; otherwise they choose (sessions.selectOrg). */
  activeOrgId: string | null;
}

export async function verifyStaffLogin(app: App, rawEmail: string, code: string, meta: RequestMeta = {}): Promise<StaffLoginResult> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw badCode();
  if (!(await verifyOtp(app, { purpose: 'staff_login', destination, orgId: null, code }))) throw badCode();
  const user = await app.db.selectFrom('users').select('id').where('email', '=', destination.value).executeTakeFirst();
  if (!user) throw badCode();
  const memberships = await membershipsOf(app, user.id);
  if (!memberships.length) throw new AppError('forbidden', 'This address is not a member of any venue.');
  // A first sign-in accepts the invitation.
  await app.db.updateTable('staff').set({ status: 'active' }).where('user_id', '=', user.id).where('status', '=', 'invited').execute();
  const activeOrgId = memberships.length === 1 ? memberships[0]!.orgId : null;
  const { token } = await createSession(app, { kind: 'staff', userId: user.id, orgId: activeOrgId, ...meta });
  return { token, memberships, activeOrgId };
}

export async function requestPlatformLogin(app: App, rawEmail: string, meta: RequestMeta = {}): Promise<void> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw invalid('Enter your email address.');
  const admin = await app.db
    .selectFrom('platform_admins as pa')
    .innerJoin('users as u', 'u.id', 'pa.user_id')
    .select('u.id')
    .where('u.email', '=', destination.value)
    .executeTakeFirst();
  if (!admin) return;
  await issueOtp(app, { purpose: 'platform_login', destination, orgId: null, senderName: `${PLATFORM_NAME} platform`, senderSlug: 'signin', ip: meta.ip });
}

export async function verifyPlatformLogin(app: App, rawEmail: string, code: string, meta: RequestMeta = {}): Promise<{ token: string }> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw badCode();
  if (!(await verifyOtp(app, { purpose: 'platform_login', destination, orgId: null, code }))) throw badCode();
  const admin = await app.db
    .selectFrom('platform_admins as pa')
    .innerJoin('users as u', 'u.id', 'pa.user_id')
    .select('u.id')
    .where('u.email', '=', destination.value)
    .executeTakeFirst();
  if (!admin) throw badCode();
  const { token } = await createSession(app, { kind: 'platform', userId: admin.id, ...meta });
  return { token };
}

export const guestLoginInput = z.object({ destination: z.string().min(3).max(254) });

/** Step one of guest sign-in at one venue's site: a code to their email or phone. No account, no password. */
export async function requestGuestLogin(app: App, orgId: string, rawDestination: string, meta: RequestMeta = {}): Promise<{ channel: 'email' | 'sms' }> {
  const destination = parseDestination(rawDestination);
  if (!destination) throw invalid('Enter an email address or a mobile number.');
  const org = await app.db.selectFrom('orgs').select(['trading_name', 'slug']).where('id', '=', orgId).executeTakeFirstOrThrow();
  await issueOtp(app, { purpose: 'guest_login', destination, orgId, senderName: org.trading_name, senderSlug: org.slug, ip: meta.ip });
  return { channel: destination.channel };
}

export interface GuestLoginResult {
  token: string;
  customerId: string;
  created: boolean;
}

/**
 * Step two. A correct code proves control of the address, so the matching customer is found or
 * created and the address is marked verified. The guest is known at this org only.
 */
export async function verifyGuestLogin(
  app: App,
  orgId: string,
  rawDestination: string,
  code: string,
  opts: RequestMeta & { visitorSessionId?: string | null; venueId?: string | null } = {},
): Promise<GuestLoginResult> {
  const destination = parseDestination(rawDestination);
  if (!destination) throw badCode();
  if (!(await verifyOtp(app, { purpose: 'guest_login', destination, orgId, code }))) throw badCode();

  const resolved = await app.tenant(
    orgId,
    { kind: 'anon', sessionId: opts.visitorSessionId ?? undefined },
    async (ctx) => {
      const session = opts.visitorSessionId
        ? await ctx.db
            .selectFrom('visitor_sessions')
            .select(['creator_id', 'campaign_id', 'code', 'landing_path', 'qr_code_id', 'utm_source'])
            .where('id', '=', opts.visitorSessionId)
            .executeTakeFirst()
        : undefined;
      const r = await resolveCustomer(ctx, {
        hints: [{ kind: destination.channel === 'email' ? 'email' : 'phone', value: destination.value }],
        via: 'guest_login',
        venueId: opts.venueId ?? null,
        verified: true,
        acquisition: session
          ? {
              source: session.creator_id ? 'criota' : session.qr_code_id ? 'qr' : (session.utm_source ?? 'organic'),
              creatorId: session.creator_id,
              campaignId: session.campaign_id,
              code: session.code,
              landingPath: session.landing_path,
              qrCodeId: session.qr_code_id,
            }
          : undefined,
      });
      if (r.customerId) await linkSessionToCustomer(ctx, opts.visitorSessionId, r.customerId);
      return r;
    },
    { ip: opts.ip },
  );
  if (!resolved.customerId) throw badCode();
  const { token } = await createSession(app, { kind: 'guest', orgId, customerId: resolved.customerId, ip: opts.ip, userAgent: opts.userAgent });
  return { token, customerId: resolved.customerId, created: resolved.created };
}

/**
 * Step one of sign-in at the open front door (self-serve start, docs/PIPEDLINE.md section 1).
 * Any address is sent a code, so the answer is still the same for everyone: nothing is learned
 * about who has an account. `issueOtp` limits it per address and per caller.
 */
export async function requestOpenLogin(app: App, rawEmail: string, meta: RequestMeta = {}): Promise<void> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw invalid('Enter your email address.');
  await issueOtp(app, { purpose: 'staff_login', destination, orgId: null, senderName: PLATFORM_NAME, senderSlug: 'signin', ip: meta.ip });
}

export interface OpenLoginResult extends StaffLoginResult {
  userId: string;
  /** True when this address had never signed in or been invited before. */
  newUser: boolean;
}

/**
 * Step two. A correct code proves control of the address; a person nobody has seen before gets
 * a user record and a session that acts for no organisation yet. They belong to nothing until
 * they start a venue of their own (onboarding.selfServeStart) or are invited to one.
 */
export async function verifyOpenLogin(app: App, rawEmail: string, code: string, meta: RequestMeta = {}): Promise<OpenLoginResult> {
  const destination = parseDestination(rawEmail);
  if (!destination || destination.channel !== 'email') throw badCode();
  if (!(await verifyOtp(app, { purpose: 'staff_login', destination, orgId: null, code }))) throw badCode();
  // `users` is a platform table: a person exists before, and apart from, any organisation.
  const existing = await app.db.selectFrom('users').select('id').where('email', '=', destination.value).executeTakeFirst();
  const user =
    existing ??
    (await app.db
      .insertInto('users')
      .values({ email: destination.value })
      .onConflict((oc) => oc.column('email').doUpdateSet((eb) => ({ email: eb.ref('excluded.email') })))
      .returning('id')
      .executeTakeFirstOrThrow());
  const memberships = await membershipsOf(app, user.id);
  await app.db.updateTable('staff').set({ status: 'active' }).where('user_id', '=', user.id).where('status', '=', 'invited').execute();
  const activeOrgId = memberships.length === 1 ? memberships[0]!.orgId : null;
  const { token } = await createSession(app, { kind: 'staff', userId: user.id, orgId: activeOrgId, ...meta });
  return { token, memberships, activeOrgId, userId: user.id, newUser: !existing };
}
