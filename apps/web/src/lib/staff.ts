import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { Ctx, StaffPrincipal } from '@ros/core';
import { auth } from '@ros/modules';
import { app } from './runtime';
import { PLATFORM_COOKIE, STAFF_COOKIE, readCookie } from './cookies';

export interface StaffSession {
  orgId: string;
  principal: StaffPrincipal;
  token: string;
}

/** The signed-in staff member and the one org their session acts for, or a redirect to sign in. */
export const getStaffSession = cache(async (): Promise<StaffSession> => {
  const token = await readCookie(STAFF_COOKIE);
  const who = token ? await auth.authenticate(app(), token) : null;
  if (!who || who.principal.kind !== 'staff') {
    const path = (await headers()).get('x-ros-path');
    redirect(path && path !== '/console' ? `/login?next=${encodeURIComponent(path)}` : '/login');
  }
  if (!who.orgId) redirect('/login/choose');
  return { orgId: who.orgId, principal: who.principal, token: token! };
});

/** Run a service function as the signed-in staff member, inside their org. */
export async function asStaff<T>(fn: (ctx: Ctx, session: StaffSession) => Promise<T>): Promise<T> {
  const session = await getStaffSession();
  const h = await headers();
  return app().tenant(session.orgId, session.principal, (ctx) => fn(ctx, session), { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim() });
}

export const getPlatformSession = cache(async () => {
  const token = await readCookie(PLATFORM_COOKIE);
  const who = token ? await auth.authenticate(app(), token) : null;
  if (!who || who.principal.kind !== 'platform') redirect('/platform/login');
  return { principal: who.principal, token: token! };
});
