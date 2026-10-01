import type { Ctx } from './app';
import { AppError, forbidden } from './errors';
import { ROLE_RANK, type StaffPrincipal, type StaffRole } from './principal';

/** The staff member behind this context, whether signed in directly or acting through an assistant. */
export function staffOf(ctx: Ctx): StaffPrincipal | null {
  const p = ctx.principal;
  if (p.kind === 'staff') return p;
  if (p.kind === 'agent') return p.staff;
  return null;
}

/** Workers and platform code act for the org as a whole; role checks do not apply to them. */
export function isInternal(ctx: Ctx): boolean {
  return ctx.principal.kind === 'worker' || ctx.principal.kind === 'platform';
}

export interface StaffRequirement {
  /** The venue the action touches. Omit only for org-level actions. */
  venueId?: string;
  minRole?: StaffRole;
  /**
   * Roles are not a single ladder: kitchen and front of house sit side by side. Use this when
   * an action belongs to particular roles. Managers and owners always qualify.
   */
  anyOf?: StaffRole[];
}

/** Roles that deal with guests and may see who they are. Kitchen and read-only roles do not. */
export const GUEST_FACING_ROLES: StaffRole[] = ['front_of_house', 'host'];

/**
 * Asserts the caller is staff (or internal) with at least `minRole` at `venueId`.
 * A venue the caller has no role at is answered as not-found, never as forbidden, so ids
 * cannot be probed. Returns the staff principal, or null for internal callers.
 */
export function requireStaff(ctx: Ctx, req: StaffRequirement = {}): StaffPrincipal | null {
  if (isInternal(ctx)) return null;
  const staff = staffOf(ctx);
  if (!staff) throw new AppError('unauthenticated', 'Sign in to do that.');
  const min = ROLE_RANK[req.minRole ?? 'read_only'];
  const allows = (role: StaffRole) =>
    ROLE_RANK[role] >= min && (!req.anyOf || req.anyOf.includes(role) || ROLE_RANK[role] >= ROLE_RANK.manager);
  if (req.venueId) {
    const role = staff.venueRoles[req.venueId];
    if (!role) throw new AppError('not_found', 'Venue not found');
    if (!allows(role)) throw forbidden('Your role at this venue does not allow that.');
  } else if (!Object.values(staff.venueRoles).some(allows)) {
    throw forbidden('Your role does not allow that.');
  }
  return staff;
}

export function requireOwner(ctx: Ctx): StaffPrincipal | null {
  if (isInternal(ctx)) return null;
  const staff = staffOf(ctx);
  if (!staff) throw new AppError('unauthenticated', 'Sign in to do that.');
  if (!staff.isOwner) throw forbidden('Only an owner can do that.');
  return staff;
}

/** Venues the caller may see. null means every venue in the org (internal callers). */
export function visibleVenueIds(ctx: Ctx): string[] | null {
  if (isInternal(ctx)) return null;
  const staff = staffOf(ctx);
  if (staff) return Object.keys(staff.venueRoles);
  if (ctx.principal.kind === 'device') return [ctx.principal.venueId];
  return [];
}

export function requireGuest(ctx: Ctx): string {
  if (ctx.principal.kind !== 'guest') throw new AppError('unauthenticated', 'Sign in to do that.');
  return ctx.principal.customerId;
}

export function requireDevice(ctx: Ctx, venueId: string, purpose?: 'kitchen' | 'counter'): void {
  if (isInternal(ctx)) return;
  const p = ctx.principal;
  if (p.kind === 'device') {
    if (p.venueId !== venueId) throw new AppError('not_found', 'Venue not found');
    if (purpose && p.purpose !== purpose) throw forbidden('This screen is not paired for that.');
    return;
  }
  // Staff may do anything a paired screen may.
  requireStaff(ctx, { venueId, minRole: 'kitchen' });
}
