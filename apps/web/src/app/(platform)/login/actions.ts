'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { isAppError } from '@ros/core';
import { auth } from '@ros/modules';
import { app } from '@/lib/runtime';
import { STAFF_COOKIE, clearCookie, readCookie, setSessionCookie } from '@/lib/cookies';
import type { FormState } from '@/ui/client';

/** Only a path on this site's console is an acceptable place to return to. */
function safeNext(raw: FormDataEntryValue | null): string | null {
  const v = typeof raw === 'string' ? raw : '';
  return /^\/console(\/|\?|$)/.test(v) && !v.includes('//') && !v.includes('\\') ? v : null;
}

async function meta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(), userAgent: h.get('user-agent') ?? undefined };
}

export async function requestCode(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '');
  try {
    await auth.requestStaffLogin(app(), email, await meta());
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  // The same answer whether or not the address has an account.
  const back = safeNext(form.get('next'));
  redirect(`/login?email=${encodeURIComponent(email.trim().toLowerCase())}&sent=1${back ? `&next=${encodeURIComponent(back)}` : ''}`);
}

export async function verifyCode(_prev: FormState, form: FormData): Promise<FormState> {
  const email = String(form.get('email') ?? '');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  let next = safeNext(form.get('next')) ?? '/console';
  try {
    const r = await auth.verifyStaffLogin(app(), email, code, await meta());
    await setSessionCookie(STAFF_COOKIE, r.token, auth.SESSION_TTL_DAYS.staff);
    if (!r.activeOrgId) next = '/login/choose';
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect(next);
}

export async function chooseOrg(form: FormData): Promise<void> {
  const token = await readCookie(STAFF_COOKIE);
  if (!token) redirect('/login');
  await auth.selectOrg(app(), token, String(form.get('orgId') ?? ''));
  redirect('/console');
}

export async function signOut(): Promise<void> {
  const token = await readCookie(STAFF_COOKIE);
  if (token) await auth.revokeSession(app(), token);
  await clearCookie(STAFF_COOKIE);
  redirect('/login');
}
