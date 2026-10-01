'use server';

import { redirect } from 'next/navigation';
import { identity } from '@ros/modules';
import { act, nullableText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

const PURPOSES = ['card_recognition', 'marketing_email', 'marketing_sms', 'ad_platform_sharing'] as const;

/** Change the details staff may keep: name, birthday, allergies, staff notes. Email and phone come from the guest. */
export async function saveCustomer(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'customerId');
  const birthday = nullableText(fd, 'birthday');
  if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return { ok: false, error: 'Use a date for the birthday, or leave it empty.' };
  return act(
    (ctx) =>
      identity.updateCustomer(ctx, id, {
        firstName: nullableText(fd, 'firstName'),
        lastName: nullableText(fd, 'lastName'),
        birthday,
        allergyNotes: nullableText(fd, 'allergyNotes'),
        notes: nullableText(fd, 'notes'),
      }),
    { success: 'Saved.', revalidate: `/console/customers/${id}` },
  );
}

/**
 * Withdraw a consent because the guest asked a staff member to. Staff can withdraw, never grant:
 * a consent only ever comes from the guest (identity.grantConsent refuses staff).
 */
export async function withdrawConsent(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = text(fd, 'customerId');
  const purpose = text(fd, 'purpose') as (typeof PURPOSES)[number];
  if (!PURPOSES.includes(purpose)) return { ok: false, error: 'That is not a consent this platform asks for.' };
  const detail = nullableText(fd, 'reason');
  return act(
    async (ctx) => {
      // Reading the record first applies the same role check as the rest of the page.
      await identity.getCustomer(ctx, customerId);
      await identity.revokeConsent(ctx, { customerId, purpose, source: 'staff_on_request', sourceDetail: detail });
    },
    { success: 'Withdrawn. It takes effect for everything sent from now on.', revalidate: `/console/customers/${customerId}` },
  );
}

/** Erase a guest at their request. Owner only (the service says so); then back to the search. */
export async function erase(_prev: FormState, fd: FormData): Promise<FormState> {
  const customerId = text(fd, 'customerId');
  if (text(fd, 'confirm').toUpperCase() !== 'ERASE') return { ok: false, error: 'Type ERASE to confirm.' };
  const r = await act((ctx) => identity.eraseCustomer(ctx, customerId), { revalidate: '/console/customers' });
  if (!r.ok) return r;
  redirect('/console/customers?erased=1');
}
