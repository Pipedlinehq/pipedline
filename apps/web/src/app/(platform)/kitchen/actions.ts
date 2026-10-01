'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { app } from '@/lib/runtime';
import { DEVICE_COOKIE, clearCookie, setSessionCookie } from '@/lib/cookies';
import { DEVICE_COOKIE_DAYS } from '@/lib/ops-device';
import type { FormState } from '@/ui/client';

/**
 * The screen types the 8-character code a manager made in the console. The long-lived token it
 * gets back goes into an httpOnly cookie: page script never sees it.
 */
export async function pairScreen(_prev: FormState, form: FormData): Promise<FormState> {
  const code = String(form.get('code') ?? '').replace(/[\s-]/g, '');
  if (code.length < 4) return { ok: false, error: 'Type the code shown in the console.' };
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim();
  const r = await runAction(() => auth.pairDevice(app(), code, { ip }));
  if (!r.ok) return { ok: false, error: r.error };
  await setSessionCookie(DEVICE_COOKIE, r.data.token, DEVICE_COOKIE_DAYS);
  redirect('/kitchen');
}

/** Forget the pairing on this screen. The device stays listed in the console until a manager revokes it. */
export async function forgetPairing(): Promise<void> {
  await clearCookie(DEVICE_COOKIE);
  redirect('/kitchen');
}
