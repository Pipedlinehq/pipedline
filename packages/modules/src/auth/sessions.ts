import {
  type App,
  type GuestPrincipal,
  type PlatformPrincipal,
  type Principal,
  type StaffPrincipal,
  type StaffRole,
  AppError,
  hashToken,
  newToken,
} from '@ros/core';
import { SESSION_TTL_DAYS } from './module';

export interface SessionInfo {
  id: string;
  kind: 'staff' | 'guest' | 'platform';
  userId: string | null;
  orgId: string | null;
  customerId: string | null;
  expiresAt: Date;
}

export async function createSession(
  app: App,
  args: { kind: SessionInfo['kind']; userId?: string | null; orgId?: string | null; customerId?: string | null; ip?: string; userAgent?: string },
): Promise<{ token: string; session: SessionInfo }> {
  const { token, hash } = newToken(`ros_${args.kind[0]}`);
  const now = app.clock();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS[args.kind] * 86_400_000);
  const row = await app.db
    .insertInto('sessions')
    .values({
      token_hash: hash,
      kind: args.kind,
      user_id: args.userId ?? null,
      org_id: args.orgId ?? null,
      customer_id: args.customerId ?? null,
      created_at: now,
      expires_at: expiresAt,
      last_seen_at: now,
      ip: args.ip ?? null,
      user_agent: args.userAgent?.slice(0, 300) ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return {
    token,
    session: { id: row.id, kind: args.kind, userId: args.userId ?? null, orgId: args.orgId ?? null, customerId: args.customerId ?? null, expiresAt },
  };
}

/** The live session a token names, or null. Expired and revoked sessions do not resolve. */
export async function resolveSession(app: App, token: string | null | undefined): Promise<SessionInfo | null> {
  if (!token || !/^ros_[sgp]_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const now = app.clock();
  const r = await app.db
    .selectFrom('sessions')
    .select(['id', 'kind', 'user_id', 'org_id', 'customer_id', 'expires_at', 'last_seen_at'])
    .where('token_hash', '=', hashToken(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (!r) return null;
  if (!r.last_seen_at || now.getTime() - r.last_seen_at.getTime() > 300_000) {
    await app.db.updateTable('sessions').set({ last_seen_at: now }).where('id', '=', r.id).execute();
  }
  return { id: r.id, kind: r.kind, userId: r.user_id, orgId: r.org_id, customerId: r.customer_id, expiresAt: r.expires_at };
}

export async function revokeSession(app: App, token: string): Promise<void> {
  await app.db.updateTable('sessions').set({ revoked_at: app.clock() }).where('token_hash', '=', hashToken(token)).where('revoked_at', 'is', null).execute();
}

export async function revokeUserSessions(app: App, userId: string, orgId?: string): Promise<void> {
  let q = app.db.updateTable('sessions').set({ revoked_at: app.clock() }).where('user_id', '=', userId).where('revoked_at', 'is', null);
  if (orgId) q = q.where('org_id', '=', orgId);
  await q.execute();
}

export interface Membership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  staffId: string;
  isOwner: boolean;
}

/** The orgs a person is staff at. Platform query: this is how a sign-in learns which orgs to offer. */
export async function membershipsOf(app: App, userId: string): Promise<Membership[]> {
  const rows = await app.db
    .selectFrom('staff as s')
    .innerJoin('orgs as o', 'o.id', 's.org_id')
    .select(['s.org_id', 's.id', 's.is_owner', 'o.trading_name', 'o.slug'])
    .where('s.user_id', '=', userId)
    .where('s.status', 'in', ['active', 'invited'])
    .where('o.status', '!=', 'closed')
    .orderBy('o.trading_name')
    .execute();
  return rows.map((r) => ({ orgId: r.org_id, orgName: r.trading_name, orgSlug: r.slug, staffId: r.id, isOwner: r.is_owner }));
}

/**
 * Build the staff principal for one person at one org from the database, never from anything
 * the client sent. An owner holds every venue; everyone else holds the venues they are assigned.
 */
export async function staffPrincipal(app: App, userId: string, orgId: string): Promise<StaffPrincipal | null> {
  const staff = await app.db
    .selectFrom('staff')
    .select(['id', 'is_owner', 'status'])
    .where('user_id', '=', userId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!staff || staff.status === 'disabled') return null;
  const venueRoles: Record<string, StaffRole> = {};
  if (staff.is_owner) {
    const venues = await app.db.selectFrom('venues').select('id').where('org_id', '=', orgId).execute();
    for (const v of venues) venueRoles[v.id] = 'owner';
  } else {
    const roles = await app.db.selectFrom('staff_venues').select(['venue_id', 'role']).where('staff_id', '=', staff.id).execute();
    for (const r of roles) venueRoles[r.venue_id] = r.role;
  }
  return { kind: 'staff', staffId: staff.id, userId, isOwner: staff.is_owner, venueRoles };
}

export interface Authenticated {
  orgId: string | null;
  principal: Principal;
  session: SessionInfo;
}

/** Session → who is acting and for which org. Returns null when the session no longer maps to anyone. */
export async function authenticate(app: App, token: string | null | undefined): Promise<Authenticated | null> {
  const session = await resolveSession(app, token);
  if (!session) return null;
  if (session.kind === 'guest') {
    if (!session.orgId || !session.customerId) return null;
    const principal: GuestPrincipal = { kind: 'guest', customerId: session.customerId };
    return { orgId: session.orgId, principal, session };
  }
  if (session.kind === 'platform') {
    if (!session.userId) return null;
    const admin = await app.db.selectFrom('platform_admins').select('user_id').where('user_id', '=', session.userId).executeTakeFirst();
    if (!admin) return null;
    const principal: PlatformPrincipal = { kind: 'platform', adminUserId: session.userId, reason: 'platform console' };
    return { orgId: null, principal, session };
  }
  if (!session.userId) return null;
  if (!session.orgId) {
    // Signed in, but has not yet chosen which org to act for.
    return { orgId: null, principal: { kind: 'staff', staffId: '', userId: session.userId, isOwner: false, venueRoles: {} }, session };
  }
  const principal = await staffPrincipal(app, session.userId, session.orgId);
  if (!principal) return null;
  return { orgId: session.orgId, principal, session };
}

/** Choose the one org a staff session acts for. Membership is checked against the database. */
export async function selectOrg(app: App, token: string, orgId: string): Promise<Authenticated> {
  const session = await resolveSession(app, token);
  if (!session || session.kind !== 'staff' || !session.userId) throw new AppError('unauthenticated', 'Sign in to do that.');
  const principal = await staffPrincipal(app, session.userId, orgId);
  if (!principal) throw new AppError('not_found', 'Organisation not found');
  await app.db.updateTable('sessions').set({ org_id: orgId }).where('id', '=', session.id).execute();
  return { orgId, principal, session: { ...session, orgId } };
}
