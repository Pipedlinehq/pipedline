'use server';

import { approvals, hub } from '@ros/modules';
import { act, nullableText, text } from '@/lib/console-actions';
import type { FormState } from '@/ui/client';

/** The yes (or no) given from Home. The service checks the role at the item's venue and runs its consequence in the same transaction. */
export async function decideFromHome(_prev: FormState, fd: FormData): Promise<FormState> {
  const id = text(fd, 'approvalId');
  const decision = text(fd, 'decision') === 'approved' ? 'approved' : 'rejected';
  const note = nullableText(fd, 'reason');
  return act((ctx) => approvals.decideApproval(ctx, id, { decision, note }), {
    success: decision === 'approved' ? 'Approved. It will go ahead now.' : 'Rejected. Nothing will happen.',
    revalidate: ['/console', '/console/approvals', `/console/approvals/${id}`],
  });
}

/** Put a guidance card away for this person. */
export async function dismissCardAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => hub.dismissCard(ctx, { card: text(fd, 'card') }), { success: 'Put away.', revalidate: ['/console'] });
}

/** Approve a suggestion: the tool's own propose and commit, once, as the person approving. */
export async function approveSuggestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx, c) => hub.approveSuggestion(ctx, { venueId: c.venue.id, key: text(fd, 'key') }), {
    success: (r) => `Done: ${r.question.replace(/\?$/, '.')}`,
    revalidate: ['/console', '/console/orders'],
  });
}

/** Put a suggestion away for the venue, with the reason. */
export async function dismissSuggestionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx, c) => hub.dismissSuggestion(ctx, { venueId: c.venue.id, key: text(fd, 'key'), reason: nullableText(fd, 'reason') }), { success: 'Put away. It will not be suggested again.', revalidate: ['/console'] });
}
