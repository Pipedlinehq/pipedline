'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AppError, type Ctx } from '@ros/core';
import { auth, identity, loyalty } from '@ros/modules';
import type { SiteFormState } from '@/components/site/action-form';
import { runAction } from '@/lib/actions';
import { GUEST_COOKIE, clearCookie, readCookie } from '@/lib/cookies';
import { app } from '@/lib/runtime';
import { getVisitor, onSite } from '@/lib/site';

/**
 * The signed-in guest's own actions on their account page. Each runs as the guest of the org the
 * host resolves to; the customer id is the session's, never one the form sends.
 */
async function asGuest<T>(host: string, fn: (ctx: Ctx, customerId: string) => Promise<T>): Promise<T> {
  return onSite(host, async (ctx, site) => {
    const { customerId } = await getVisitor(site.orgId);
    if (!customerId) throw new AppError('unauthenticated', 'Your session has ended. Sign in again.');
    return fn(ctx, customerId);
  });
}

const toState = (r: Awaited<ReturnType<typeof runAction>>, message?: string): SiteFormState => (r.ok ? { ok: true, message } : { ok: false, error: r.error });
const text = (form: FormData, key: string) => {
  const v = String(form.get(key) ?? '').trim();
  return v.length ? v : null;
};

export async function updateProfile(host: string, _prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  const r = await runAction(() =>
    asGuest(host, (ctx, id) =>
      identity.updateCustomer(ctx, id, { firstName: text(form, 'firstName'), lastName: text(form, 'lastName'), birthday: text(form, 'birthday'), allergyNotes: text(form, 'allergyNotes') }),
    ),
  );
  revalidatePath('/account');
  return toState(r, 'Saved.');
}

/** One consent, one step: on with the words shown, or off. */
export async function setConsent(host: string, _prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  const purpose = String(form.get('purpose') ?? '') as identity.ConsentPurpose;
  const turnOn = form.get('action') === 'grant';
  const shownVersion = String(form.get('version') ?? '');
  const r = await runAction(() =>
    asGuest(host, async (ctx, id) => {
      if (!identity.CONSENT_PURPOSES.includes(purpose)) throw new AppError('invalid', 'That choice is not one we offer.');
      if (turnOn) {
        const current = await identity.currentWording(ctx, purpose);
        // The record must name the words the guest actually read on this page.
        if (current.version !== shownVersion) throw new AppError('invalid', 'The wording has changed since this page loaded. Reload it and read it again.');
        await identity.grantConsent(ctx, { customerId: id, purpose, source: 'guest_account', wordingVersion: current.version });
      } else {
        await identity.revokeConsent(ctx, { customerId: id, purpose, source: 'guest_account' });
      }
    }),
  );
  revalidatePath('/account');
  return toState(r, turnOn ? 'Turned on.' : 'Withdrawn. This takes effect straight away.');
}

export async function joinProgram(host: string, venueId: string | null, _prev: SiteFormState, _form: FormData): Promise<SiteFormState> {
  const r = await runAction(() => asGuest(host, (ctx) => loyalty.joinLoyalty(ctx, { venueId })));
  revalidatePath('/account');
  return toState(r, 'Welcome to the programme.');
}

export async function getCounterCode(host: string, _prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  const r = await runAction(() => asGuest(host, (ctx) => loyalty.issueRedemption(ctx, { venueId: String(form.get('venueId') ?? ''), rewardId: String(form.get('rewardId') ?? '') })));
  revalidatePath('/account');
  return r.ok ? { ok: true, message: `Show this code at the counter: ${r.data.code}` } : { ok: false, error: r.error };
}

export async function cancelCounterCode(host: string, _prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  const r = await runAction(() => asGuest(host, (ctx) => loyalty.voidRedemption(ctx, { redemptionId: String(form.get('redemptionId') ?? ''), reason: 'Cancelled by the guest' })));
  revalidatePath('/account');
  return toState(r, 'Cancelled. Your points are free again.');
}

/** Erase the guest at their request, then end the session. */
export async function deleteAccount(host: string, _prev: SiteFormState, form: FormData): Promise<SiteFormState> {
  if (String(form.get('confirm') ?? '').trim().toUpperCase() !== 'DELETE') return { ok: false, error: 'Type DELETE in the box to confirm.' };
  const r = await runAction(() => asGuest(host, (ctx, id) => identity.eraseCustomer(ctx, id)));
  if (!r.ok) return { ok: false, error: r.error };
  const token = await readCookie(GUEST_COOKIE);
  if (token) await auth.revokeSession(app(), token);
  await clearCookie(GUEST_COOKIE);
  redirect('/account/deleted');
}
