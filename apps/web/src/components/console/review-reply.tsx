'use client';

import { useActionState, useRef, useState } from 'react';
import { Button, FormMessage, SubmitButton, type FormState } from '@/ui';

type Action = (prev: FormState, fd: FormData) => Promise<FormState>;

/**
 * A manager's reply to one review. Two ways out: send it to Approvals for a second pair of eyes,
 * or post it now, behind a dialog that shows the exact words that will appear in public.
 */
export function ReviewReplyBox({ reviewId, venueName, listing, maxChars, sendForApproval, postNow }: { reviewId: string; venueName: string; listing: string; maxChars: number; sendForApproval: Action; postNow: Action }) {
  const [body, setBody] = useState('');
  const [open, setOpen] = useState(false);
  const [draftState, draftAction] = useActionState(sendForApproval, null);
  const [postState, postAction] = useActionState(postNow, null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trimmed = body.trim();
  const done = draftState?.ok || postState?.ok;

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid={`reply-open-${reviewId}`}>
        Write a reply
      </Button>
    );
  }
  return (
    <div className="space-y-2" data-testid={`reply-box-${reviewId}`}>
      <form action={draftAction} className="space-y-2">
        <input type="hidden" name="reviewId" value={reviewId} />
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-ink">Your reply, as {venueName}</span>
          <textarea
            name="body"
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            required
            maxLength={maxChars}
            disabled={!!done}
            className="block min-h-24 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink disabled:bg-sunken"
          />
          <span className="mt-1 block text-xs text-ink-3">
            {body.length} of {maxChars} characters. It is public: no refunds or offers, no admissions of fault, no phone numbers or email addresses.
          </span>
        </label>
        {draftState && !draftState.ok ? <FormMessage tone="error">{draftState.error}</FormMessage> : null}
        {postState && !postState.ok ? <FormMessage tone="error">{postState.error}</FormMessage> : null}
        {draftState?.ok ? <FormMessage tone="success">{draftState.message ?? 'Saved.'}</FormMessage> : null}
        {postState?.ok ? <FormMessage tone="success">{postState.message ?? 'Posted.'}</FormMessage> : null}
        {done ? null : (
          <div className="flex flex-wrap gap-2">
            <SubmitButton size="sm" variant="secondary" pendingLabel="Saving…">
              Send for approval
            </SubmitButton>
            <Button type="button" size="sm" disabled={!trimmed} onClick={() => dialog.current?.showModal()}>
              Post reply…
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        )}
      </form>
      <dialog ref={dialog} aria-label="Post this reply in public?" className="m-auto w-[min(34rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-0 text-ink">
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-base font-semibold">Post this reply in public?</h2>
          <button type="button" onClick={() => dialog.current?.close()} aria-label="Close" className="rounded-md px-2 py-1 text-ink-2 hover:bg-sunken">
            ✕
          </button>
        </div>
        <form action={postAction} onSubmit={() => dialog.current?.close()} className="space-y-4 p-5">
          <input type="hidden" name="reviewId" value={reviewId} />
          <input type="hidden" name="body" value={trimmed} />
          <p className="text-sm text-ink-2">
            These exact words will be published on {listing} under {venueName}&apos;s name, where anyone can read them. You are the person approving it. It cannot be unsent from here.
          </p>
          <p className="whitespace-pre-wrap break-words rounded-md bg-sunken px-3 py-2 text-sm text-ink" data-testid="reply-preview">
            {trimmed}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => dialog.current?.close()}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Posting…">Post it publicly</SubmitButton>
          </div>
        </form>
      </dialog>
    </div>
  );
}
