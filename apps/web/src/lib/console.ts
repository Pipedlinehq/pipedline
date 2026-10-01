import 'server-only';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import type { Ctx, StaffRole } from '@ros/core';
import { ROLE_RANK } from '@ros/core';
import { tenancy } from '@ros/modules';
import { asStaff, getStaffSession, type StaffSession } from './staff';
import { readCookie } from './cookies';

export const VENUE_COOKIE = 'ros_venue';

export interface ConsoleContext {
  session: StaffSession;
  org: tenancy.OrgView;
  venues: tenancy.VenueView[];
  /** The venue the console is currently looking at. */
  venue: tenancy.VenueView;
  role: StaffRole;
  isOwner: boolean;
}

/**
 * Who is signed in, which org, which venues they can see, and which one is selected. The
 * selection is a convenience stored in a cookie; it is checked against the venues the person
 * actually has a role at, so it can never widen access.
 */
export const getConsole = cache(async (): Promise<ConsoleContext> => {
  const session = await getStaffSession();
  const { org, venues } = await asStaff(async (ctx) => ({ org: await tenancy.getOrg(ctx), venues: await tenancy.listVenues(ctx) }));
  if (!venues.length) notFound();
  const wanted = await readCookie(VENUE_COOKIE);
  const venue = venues.find((v) => v.id === wanted) ?? venues[0]!;
  const role = session.principal.venueRoles[venue.id] ?? 'read_only';
  return { session, org, venues, venue, role, isOwner: session.principal.isOwner };
});

export function atLeast(role: StaffRole, min: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Run a service function as the signed-in staff member with the selected venue to hand. */
export async function inConsole<T>(fn: (ctx: Ctx, c: ConsoleContext) => Promise<T>): Promise<T> {
  const c = await getConsole();
  return asStaff((ctx) => fn(ctx, c));
}
