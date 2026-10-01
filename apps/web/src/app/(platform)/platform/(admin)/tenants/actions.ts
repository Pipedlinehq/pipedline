'use server';

import { revalidatePath } from 'next/cache';
import { onboarding } from '@ros/modules';
import { runAction } from '@/lib/actions';
import { app } from '@/lib/runtime';
import { platformActor } from '@/lib/ops-platform';
import type { FormState } from '@/ui/client';

/**
 * Close an org: custom domains detached, connections revoked, sending identities suspended,
 * the org and its venues closed. Nothing is deleted. The admin types the org's site address to
 * confirm, and gives the reason, which goes on the org's audit log.
 */
export async function closeOrgAction(_p: FormState, form: FormData): Promise<FormState> {
  const orgId = String(form.get('orgId') ?? '');
  const slug = String(form.get('slug') ?? '');
  const typed = String(form.get('confirm') ?? '').trim().toLowerCase();
  if (typed !== slug) return { ok: false, error: `Type ${slug} to confirm.` };
  const reason = String(form.get('reason') ?? '');
  const r = await runAction(async () => onboarding.closeOrg(app(), await platformActor(), { orgId, reason }));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath('/platform', 'layout');
  return { ok: true, message: `Closed. ${r.data.domainsRemoved.length} custom domain(s) detached, ${r.data.connectionsRevoked} connection(s) revoked.` };
}
