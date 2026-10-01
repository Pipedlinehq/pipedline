import Link from 'next/link';
import { reviews, type approvals } from '@ros/modules';
import { read } from '@/lib/console-read';
import { Card } from '@/ui';
import { ReviewQuote, draftAuthor, sourceName } from './review-bits';

/**
 * A `reviews.reply` approval in words: the review it answers (guest-written, shown as quoted
 * text) and the exact reply that will be posted in public. Read through the reviews service as
 * the person looking, so it shows nothing they could not already see in the inbox.
 */
export async function ReviewReplyApproval({ approval }: { approval: approvals.Approval }) {
  const payload = (approval.payload ?? {}) as { draftId?: string; reviewId?: string };
  const venueId = approval.venueId;
  if (!venueId || !payload.reviewId) return null;
  const list = await read((ctx) => reviews.listReviews(ctx, { venueId, limit: 200 }));
  if (!list.ok) return null;
  const review = list.data.find((r) => r.id === payload.reviewId);
  const draft = review?.drafts.find((d) => d.id === (payload.draftId ?? approval.subjectId));
  if (!review || !draft) return null;
  return (
    <Card title="The review and the reply" description={`On ${sourceName(review.source)}. The reply is public and is posted under the venue's name.`}>
      <div className="space-y-4" data-testid="approval-review-reply">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-3">The guest wrote</p>
          <ReviewQuote rating={review.rating} authorName={review.authorName} body={review.body} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-ink-3">The exact reply, drafted by {draftAuthor(draft.author)}</p>
          <p className="whitespace-pre-wrap break-words rounded-md bg-sunken px-3 py-2 text-sm text-ink" data-testid="approval-reply-text">
            {draft.body}
          </p>
          <p className="mt-1 text-xs text-ink-3">{draft.body.length} characters. Once posted it cannot be unsent from here.</p>
        </div>
        <Link href="/console/reviews" className="text-sm text-accent hover:underline">
          Open the reviews inbox
        </Link>
      </div>
    </Card>
  );
}
