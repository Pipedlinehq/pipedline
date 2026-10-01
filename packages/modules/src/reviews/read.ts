import { z } from 'zod';
import { type Ctx, assertModule, requireStaff } from '@ros/core';
import { reviewsModule } from './module';

/**
 * The reviews inbox. Review text is guest-written: the console renders it as text, never as
 * markup, and the assistant tool wraps it as quoted guest content (see tools.ts).
 */
export const listReviewsInput = z.object({
  venueId: z.string().uuid(),
  onlyUnanswered: z.boolean().optional(),
  minRating: z.number().int().min(1).max(5).optional(),
  maxRating: z.number().int().min(1).max(5).optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export interface ReviewDraftView {
  id: string;
  body: string;
  author: 'agent' | 'assistant' | 'staff';
  status: string;
  blockedReasons: string[];
  approvalId: string | null;
  createdAt: Date;
}

export interface ReviewView {
  id: string;
  venueId: string;
  source: string;
  rating: number | null;
  /** Guest-written. Render as text. */
  body: string | null;
  authorName: string | null;
  reviewedAt: Date;
  replyStatus: string;
  replyBody: string | null;
  repliedAt: Date | null;
  drafts: ReviewDraftView[];
}

export async function listReviews(ctx: Ctx, raw: z.input<typeof listReviewsInput>): Promise<ReviewView[]> {
  const input = listReviewsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId });
  await assertModule(ctx, input.venueId, reviewsModule);
  let q = ctx.db
    .selectFrom('reviews')
    .select(['id', 'venue_id', 'source', 'rating', 'body', 'author_name', 'reviewed_at', 'reply_status', 'reply_body', 'replied_at'])
    .where('venue_id', '=', input.venueId)
    .orderBy('reviewed_at', 'desc')
    .limit(input.limit);
  if (input.onlyUnanswered) q = q.where('reply_status', 'in', ['none', 'failed']);
  if (input.minRating) q = q.where('rating', '>=', input.minRating);
  if (input.maxRating) q = q.where('rating', '<=', input.maxRating);
  const rows = await q.execute();
  const drafts = rows.length
    ? await ctx.db
        .selectFrom('review_reply_drafts')
        .select(['id', 'review_id', 'body', 'author', 'status', 'blocked_reasons', 'approval_id', 'created_at'])
        .where('review_id', 'in', rows.map((r) => r.id))
        .orderBy('created_at', 'desc')
        .execute()
    : [];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    source: r.source,
    rating: r.rating,
    body: r.body,
    authorName: r.author_name,
    reviewedAt: r.reviewed_at,
    replyStatus: r.reply_status,
    replyBody: r.reply_body,
    repliedAt: r.replied_at,
    drafts: drafts
      .filter((d) => d.review_id === r.id)
      .map((d) => ({ id: d.id, body: d.body, author: d.author, status: d.status, blockedReasons: d.blocked_reasons, approvalId: d.approval_id, createdAt: d.created_at })),
  }));
}

export interface ReviewsSummary {
  count: number;
  averageRating: number | null;
  byRating: Record<'1' | '2' | '3' | '4' | '5', number>;
  unanswered: number;
  awaitingApproval: number;
  lastReviewAt: Date | null;
}

/** Ratings and counts for one venue, from a deterministic query. */
export async function reviewsSummary(ctx: Ctx, venueId: string, since?: Date): Promise<ReviewsSummary> {
  requireStaff(ctx, { venueId });
  await assertModule(ctx, venueId, reviewsModule);
  let q = ctx.db.selectFrom('reviews').select(['rating', 'reply_status', 'reviewed_at']).where('venue_id', '=', venueId);
  if (since) q = q.where('reviewed_at', '>=', since);
  const rows = await q.execute();
  const byRating = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 } as ReviewsSummary['byRating'];
  let sum = 0;
  let rated = 0;
  let last: Date | null = null;
  for (const r of rows) {
    if (r.rating) {
      byRating[String(r.rating) as keyof typeof byRating]++;
      sum += r.rating;
      rated++;
    }
    if (!last || r.reviewed_at > last) last = r.reviewed_at;
  }
  return {
    count: rows.length,
    averageRating: rated ? Math.round((sum / rated) * 100) / 100 : null,
    byRating,
    unanswered: rows.filter((r) => r.reply_status === 'none' || r.reply_status === 'failed').length,
    awaitingApproval: rows.filter((r) => r.reply_status === 'pending_approval').length,
    lastReviewAt: last,
  };
}
