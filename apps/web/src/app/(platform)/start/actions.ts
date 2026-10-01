'use server';

import { notFound, redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { ZodError } from 'zod';
import { isAppError } from '@ros/core';
import { auth, onboarding } from '@ros/modules';
import { app } from '@/lib/runtime';
import { STAFF_COOKIE, readCookie, setSessionCookie } from '@/lib/cookies';
import type { FormState } from '@/ui/client';
import { selfServeOpen } from './open';

/**
 * The open front door (docs/PIPEDLINE.md section 1): anyone proves an email address with a
 * one-time code, and a person who belongs to no organisation starts a venue of their own.
 * The services do the work and hold the limits (auth.requestOpenLogin, onboarding.selfServeStart);
 * these actions only carry the form to them and the session cookie back.
 */
async function meta() {
  const h = await headers();
  return { ip: h.get('x-forwarded-for')?.split(',')[0]?.trim(), userAgent: h.get('user-agent') ?? undefined };
}

export async function requestStartCode(_prev: FormState, form: FormData): Promise<FormState> {
  if (!selfServeOpen()) notFound();
  const email = String(form.get('email') ?? '');
  try {
    await auth.requestOpenLogin(app(), email, await meta());
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect(`/start?email=${encodeURIComponent(email.trim().toLowerCase())}&sent=1`);
}

export async function verifyStartCode(_prev: FormState, form: FormData): Promise<FormState> {
  if (!selfServeOpen()) notFound();
  const email = String(form.get('email') ?? '');
  const code = String(form.get('code') ?? '').replace(/\s/g, '');
  let next = '/start';
  try {
    const r = await auth.verifyOpenLogin(app(), email, code, await meta());
    await setSessionCookie(STAFF_COOKIE, r.token, auth.SESSION_TTL_DAYS.staff);
    // Someone who already belongs somewhere goes to it; only a person with nothing starts a venue.
    if (r.memberships.length) next = r.activeOrgId ? '/console' : '/login/choose';
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    throw e;
  }
  redirect(next);
}

export async function startVenue(_prev: FormState, form: FormData): Promise<FormState> {
  if (!selfServeOpen()) notFound();
  const token = await readCookie(STAFF_COOKIE);
  const who = token ? await auth.authenticate(app(), token) : null;
  if (!token || !who || who.principal.kind !== 'staff') redirect('/start');
  try {
    const started = await onboarding.selfServeStart(
      app(),
      who.principal,
      { venueName: String(form.get('venueName') ?? ''), ...(form.get('timezone') ? { timezone: String(form.get('timezone')) } : {}) },
      { ip: (await meta()).ip },
    );
    // The session now acts for the organisation that was made (or found); membership is checked there.
    await auth.selectOrg(app(), token, started.orgId);
  } catch (e) {
    if (isAppError(e)) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: 'Give the venue a name.' };
    throw e;
  }
  redirect('/console');
}
