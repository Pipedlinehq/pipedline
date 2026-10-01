'use server';

import { revalidatePath } from 'next/cache';
import { getModule, setModule } from '@ros/core';
import { reviews } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { runAction } from '@/lib/actions';
import { inConsole } from '@/lib/console';
import { act, text } from '@/lib/console-actions';
import { formSpec, readForm } from '@/lib/console-schema-form';

/** Reviews changes. The services make every role check; the venue comes from the console. */

const PATHS = ['/console/reviews', '/console/approvals'];

/** Save a reply as a draft and queue it for a manager's approval. Nothing is posted. */
export async function sendReplyForApproval(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => reviews.saveReplyDraft(ctx, { reviewId: text(fd, 'reviewId'), body: text(fd, 'body') }), {
    success: 'Saved and waiting in Approvals. Nothing is posted until a manager approves it.',
    revalidate: PATHS,
  });
}

/** A manager posts their own reply: they are the person approving it. */
export async function postReplyNow(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => reviews.postReply(ctx, { reviewId: text(fd, 'reviewId'), body: text(fd, 'body') }), {
    success: 'Approved by you. It is being posted to the listing now.',
    revalidate: PATHS,
  });
}

export async function connectListingAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act(
    (ctx, c) =>
      reviews.connectListing(ctx, {
        plugKey: text(fd, 'plugKey'),
        venueId: c.venue.id,
        externalAccountId: text(fd, 'externalAccountId'),
        credentials: { accessToken: text(fd, 'accessToken') },
      }),
    { success: (l) => `${l.name} is connected. Its reviews are being read in now.`, revalidate: '/console/reviews/listings' },
  );
}

export async function checkForReviews(_prev: FormState, _fd: FormData): Promise<FormState> {
  return act((ctx, c) => reviews.requestReviewsSync(ctx, c.venue.id), { success: 'Checking the listings now. New reviews appear in the inbox in a moment.', revalidate: PATHS });
}

export async function saveReviewSettings(_prev: FormState, fd: FormData): Promise<FormState> {
  const def = reviews.reviewsModule;
  const r = await runAction(() =>
    inConsole(async (ctx, c) => {
      const current = await getModule(ctx, c.venue.id, def);
      const { config, errors } = readForm(formSpec(def.configSchema, current.config), fd);
      if (errors.length) return { errors };
      await setModule(ctx, def, { venueId: c.venue.id, config });
      return { errors: [] as string[] };
    }),
  );
  if (!r.ok) {
    const issues = Array.isArray(r.issues) ? (r.issues as Array<{ path?: unknown[]; message?: string }>) : [];
    const detail = issues.map((i) => `${(i.path ?? []).join(' › ') || 'value'}: ${i.message}`).join(' ');
    return { ok: false, error: detail ? `${r.error} ${detail}` : r.error };
  }
  if (r.data.errors.length) return { ok: false, error: r.data.errors.join(' ') };
  revalidatePath('/console/reviews/settings');
  return { ok: true, message: 'Reply settings saved.' };
}
