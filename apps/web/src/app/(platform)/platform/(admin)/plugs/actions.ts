'use server';

import { revalidatePath } from 'next/cache';
import { hub, onboarding } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { app } from '@/lib/runtime';
import { platformActor, platformAdminName } from '@/lib/ops-platform';
import type { FormState } from '@/ui/client';

/**
 * Approve a remote plug's live tool list: read it again now through the named connection and pin
 * it (hub.reviewPlug). Until then, and after any change, the plug's tools are offered to no one.
 */
export async function approvePlugAction(_p: FormState, form: FormData): Promise<FormState> {
  const plugKey = String(form.get('plugKey') ?? '');
  const orgId = String(form.get('orgId') ?? '');
  const connectionId = String(form.get('connectionId') ?? '');
  const r = await runAction(async () => {
    // Platform admins only: the same check every platform function makes.
    await onboarding.requirePlatformAdmin(app(), await platformActor());
    const review = await hub.reviewPlug(app(), { plugKey, reviewedBy: await platformAdminName(), from: { orgId, connectionId } });
    await hub.checkPlugConnections(app(), orgId);
    return review;
  });
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/platform/plugs');
  return { ok: true, message: `Approved ${r.data.tools.length} tools. Assistants can use them again where venues have switched the plug on.` };
}
