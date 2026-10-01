'use server';

import { revalidatePath } from 'next/cache';
import { onboarding } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { app } from '@/lib/runtime';
import { forgetSupport, platformActor, rememberSupport } from '@/lib/ops-platform';
import type { FormState } from '@/ui/client';

/** Open support access to an org, with the reason the owner will read in their audit log. */
export async function openSupportAction(_p: FormState, form: FormData): Promise<FormState> {
  const orgId = String(form.get('orgId') ?? '');
  const orgName = String(form.get('orgName') ?? '');
  const reason = String(form.get('reason') ?? '');
  const r = await runAction(async () => onboarding.openSupportAccess(app(), await platformActor(), { orgId, reason }));
  if (!r.ok) return { ok: false, error: r.error };
  await rememberSupport({ accessId: r.data.id, orgId, orgName, reason: reason.trim() });
  revalidatePath('/platform', 'layout');
  return { ok: true, message: 'Support access is open. It is on the owner’s record with your reason.' };
}

export async function closeSupportAction(form: FormData): Promise<void> {
  const accessId = String(form.get('accessId') ?? '');
  const r = await runAction(async () => onboarding.closeSupportAccess(app(), await platformActor(), { accessId }));
  // Closed here or already closed elsewhere: either way this browser stops showing it.
  if (r.ok || r.code === 'not_found') await forgetSupport(accessId);
  revalidatePath('/platform', 'layout');
}
