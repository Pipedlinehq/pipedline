'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ledger } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { text } from '@/lib/console-actions';
import { CONNECTIONS_PATH, signInPosPlug } from '@/lib/pos-signin';
import { app } from '@/lib/runtime';
import { getStaffSession } from '@/lib/staff';
import type { FormState } from '@/ui/client';

/**
 * The second half of a sign-in for an account with several locations. `pending` is the signed
 * reference the service handed back (it names the sealed tokens; it is not a token), and it is
 * good only for the person and org it was made for: both come from the session here.
 */

/** Connect the location the person chose. A refusal (a location another venue holds) is shown in place so they can choose another. */
export async function choosePosLocation(_prev: FormState, fd: FormData): Promise<FormState> {
  const session = await getStaffSession();
  const r = await runAction(() => ledger.finishPosOAuth(app(), { orgId: session.orgId, principal: session.principal, pending: text(fd, 'pending'), locationRef: text(fd, 'locationRef') }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CONNECTIONS_PATH);
  redirect(`${CONNECTIONS_PATH}?connected=${encodeURIComponent(r.data.plugKey)}`);
}

/** The person walked away from the list: the sealed tokens are forgotten and ended at the provider. */
export async function leavePosSignIn(fd: FormData): Promise<void> {
  const session = await getStaffSession();
  // Already expired or already used: either way nothing is waiting, which is what leaving asks for.
  await runAction(() => ledger.cancelPosOAuth(app(), { orgId: session.orgId, principal: session.principal, pending: text(fd, 'pending') }));
  const plug = signInPosPlug(text(fd, 'plugKey'));
  redirect(plug ? `${CONNECTIONS_PATH}?left=${encodeURIComponent(plug.key)}` : CONNECTIONS_PATH);
}
