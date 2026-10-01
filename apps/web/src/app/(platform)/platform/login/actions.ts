'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAppError } from '@ros/core';
import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { PLATFORM_COOKIE, clearCookie, readCookie, setSessionCookie } from '@/lib/cookies';
import { writeSupportCookie } from '@/lib/ops-platform';
import type { FormState } from '@/ui/client';

/** Platform sign-in: a one-time code to a platform admin's address, and its own cookie. Staff sessions play no part. */

async function meta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(), userAgent: h.get('user-agent') ?? undefined };
}

export async function requestPlatformCode(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '');
  try {
    await auth.requestPlatformLogin(app(), email, await meta());
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  // The same answer whether or not the address is a platform admin.
  redirect(`/platform/login?email=${encodeURIComponent(email.trim().toLowerCase())}&sent=1`);
}

export async function verifyPlatformCode(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  try {
    const r = await auth.verifyPlatformLogin(app(), email, code, await meta());
    await setSessionCookie(PLATFORM_COOKIE, r.token, auth.SESSION_TTL_DAYS.platform);
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect('/platform');
}

export async function platformSignOut(): Promise<void> {
  const token = await readCookie(PLATFORM_COOKIE);
  if (token) await auth.revokeSession(app(), token);
  await clearCookie(PLATFORM_COOKIE);
  await writeSupportCookie([]);
  redirect('/platform/login');
}
