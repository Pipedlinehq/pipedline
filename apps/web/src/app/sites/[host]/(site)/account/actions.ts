'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAppError } from '@ros/core';
import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { getSite } from '@/lib/site';
import { GUEST_COOKIE, VISITOR_COOKIE, clearCookie, readCookie, setSessionCookie } from '@/lib/cookies';
import type { FormState } from '@/ui/client';

/** Where to go after signing in: a path on this site only. */
function safeNext(form: FormData): string {
  const next = String(form.get('next') ?? '');
  return /^\/(?!\/)[A-Za-z0-9/_?=&.%-]*$/.test(next) && !next.startsWith('/account/login') ? next : '/account';
}

async function meta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(), userAgent: h.get('user-agent') ?? undefined };
}

export async function requestGuestCode(host: string, _prev: FormState, form: FormData): Promise<FormState> {
  const site = await getSite(host);
  const destination = String(form.get('destination') ?? '');
  try {
    await auth.requestGuestLogin(app(), site.orgId, destination, await meta());
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect(`/account/login?to=${encodeURIComponent(destination.trim())}&sent=1&next=${encodeURIComponent(safeNext(form))}`);
}

export async function verifyGuestCode(host: string, _prev: FormState, form: FormData): Promise<FormState> {
  const site = await getSite(host);
  const destination = String(form.get('destination') ?? '');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  try {
    const r = await auth.verifyGuestLogin(app(), site.orgId, destination, code, { ...(await meta()), visitorSessionId: await readCookie(VISITOR_COOKIE), venueId: site.venueId });
    await setSessionCookie(GUEST_COOKIE, r.token, auth.SESSION_TTL_DAYS.guest);
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect(safeNext(form));
}

export async function guestSignOut(): Promise<void> {
  const token = await readCookie(GUEST_COOKIE);
  if (token) await auth.revokeSession(app(), token);
  await clearCookie(GUEST_COOKIE);
  redirect('/');
}
