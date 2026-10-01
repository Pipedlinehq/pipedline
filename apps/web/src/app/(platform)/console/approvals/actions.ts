'use server';

import { approvals } from '@ros/modules';
import { act, nullableText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/** Approve or reject a waiting item. The service checks the role at the item's venue and runs its consequence in the same transaction. */
export async function decide(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'approvalId');
  const decision = text(fd, 'decision') === 'approved' ? 'approved' : 'rejected';
  const note = nullableText(fd, 'reason');
  return act((ctx) => approvals.decideApproval(ctx, id, { decision, note }), {
    success: decision === 'approved' ? 'Approved. It will go ahead now.' : 'Rejected. Nothing will happen.',
    revalidate: ['/console/approvals', `/console/approvals/${id}`],
  });
}
