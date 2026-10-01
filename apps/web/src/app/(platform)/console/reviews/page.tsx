import Link from 'next/link';
import { getModule } from '@ros/core';
import { reviews } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { DraftStatus, ReplyStatus, ReviewQuote, draftAuthor, sourceName } from '@/components/console/review-bits';
import { ReviewReplyBox } from '@/components/console/review-reply';
import { ReadError } from '@/components/console/states';
import { Card, EmptyState, RankBars, StatTile, dateTime } from '@/ui';
import { postReplyNow, sendReplyForApproval } from './actions';
import { ReviewsFrame } from './shared';

export const metadata = { title: 'Reviews · Pipedline' };

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));

/** The reviews inbox: what guests wrote on the venue's listings, and the replies to them. */
export default async function ReviewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('reviews'))) return <ReviewsFrame c={c} current="/console/reviews">{null}</ReviewsFrame>;

  const show = one(sp, 'show') === 'unanswered' ? 'unanswered' : 'all';
  const starsRaw = Number(one(sp, 'stars'));
  const stars = [1, 2, 3, 4, 5].includes(starsRaw) ? starsRaw : null;
  const tz = c.venue.timezone;

  const [summary, list, config] = await Promise.all([
    read((ctx) => reviews.reviewsSummary(ctx, c.venue.id)),
    read((ctx) => reviews.listReviews(ctx, { venueId: c.venue.id, onlyUnanswered: show === 'unanswered' || undefined, ...(stars ? { minRating: stars, maxRating: stars } : {}), limit: 100 })),
    read((ctx) => getModule(ctx, c.venue.id, reviews.reviewsModule)),
  ]);
  const maxChars = config.ok ? config.data.config.reply_max_chars : 1000;
  const select = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink';

  return (
    <ReviewsFrame c={c} current="/console/reviews" description={`What guests wrote about ${c.venue.name} on its connected listings. A reply is public, and is posted only after a person approves it.`}>
      <div className="space-y-6">
        {summary.ok ? (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="grid grid-cols-2 content-start gap-3" data-testid="review-tiles">
              <StatTile label="Average rating" value={summary.data.averageRating === null ? '–' : `${summary.data.averageRating.toFixed(2)} of 5`} hint="Across every review read in" />
              <StatTile label="Reviews" value={summary.data.count.toLocaleString('en-AU')} hint={summary.data.lastReviewAt ? `Latest ${dateTime(summary.data.lastReviewAt, tz, { time: false })}` : 'None yet'} />
              <StatTile label="Without a reply" value={summary.data.unanswered.toLocaleString('en-AU')} hint="Including replies that failed to post" />
              <StatTile label="Replies waiting for approval" value={summary.data.awaitingApproval.toLocaleString('en-AU')} hint={manager ? 'Decide them in Approvals' : 'A manager decides them'} />
            </div>
            <RankBars
              title="By rating"
              subtitle="Number of reviews at each rating"
              rows={([5, 4, 3, 2, 1] as const).map((n) => ({ label: `${n} of 5`, value: summary.data.byRating[String(n) as '1'] }))}
              note="Counted from the reviews table for this venue."
            />
          </div>
        ) : (
          <ReadError message={summary.error} />
        )}

        <form method="get" role="search" aria-label="Filter reviews" className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Show
            <select name="show" defaultValue={show} className={select}>
              <option value="all">Every review</option>
              <option value="unanswered">Only those without a reply</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Rating
            <select name="stars" defaultValue={stars ? String(stars) : ''} className={select}>
              <option value="">Any rating</option>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {n} of 5
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
            Apply
          </button>
        </form>

        {!list.ok ? (
          <ReadError message={list.error} />
        ) : list.data.length === 0 ? (
          <EmptyState title={show === 'unanswered' || stars ? 'No reviews match' : 'No reviews yet'}>
            {show === 'unanswered' || stars ? 'Try a wider filter.' : 'Reviews are read from the connected listings every hour. Connect one under Listings.'}
          </EmptyState>
        ) : (
          <ul className="space-y-4">
            {list.data.map((r) => {
              const canReply = manager && (r.replyStatus === 'none' || r.replyStatus === 'failed');
              return (
                <li key={r.id}>
                  <Card>
                    <article className="space-y-3" data-testid="review" data-review-id={r.id}>
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <ReviewQuote rating={r.rating} authorName={r.authorName} body={r.body} />
                        <ReplyStatus status={r.replyStatus} />
                      </div>
                      <p className="text-xs text-ink-3">
                        {sourceName(r.source)} · {dateTime(r.reviewedAt, tz)}
                      </p>
                      {r.replyBody ? (
                        <div className="rounded-md bg-sunken px-3 py-2">
                          <p className="text-xs font-medium text-ink-2">
                            {c.venue.name} replied{r.repliedAt ? ` · ${dateTime(r.repliedAt, tz)}` : ''}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{r.replyBody}</p>
                        </div>
                      ) : null}
                      {r.drafts.filter((d) => d.status !== 'posted').length ? (
                        <ul className="space-y-2 border-t border-line pt-3">
                          {r.drafts
                            .filter((d) => d.status !== 'posted')
                            .map((d) => (
                              <li key={d.id} className="text-sm" data-testid="review-draft">
                                <p className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                                  <DraftStatus status={d.status} />
                                  <span>
                                    Drafted by {draftAuthor(d.author)} · {dateTime(d.createdAt, tz)}
                                  </span>
                                  {d.status === 'pending' && d.approvalId && manager ? (
                                    <Link href={`/console/approvals/${d.approvalId}`} className="text-accent hover:underline">
                                      Decide it in Approvals
                                    </Link>
                                  ) : null}
                                </p>
                                <p className="mt-1 whitespace-pre-wrap break-words text-ink-2">{d.body}</p>
                                {d.blockedReasons.length ? <p className="mt-1 text-xs text-bad">Blocked because it {d.blockedReasons.join('; ')}.</p> : null}
                              </li>
                            ))}
                        </ul>
                      ) : null}
                      {canReply ? (
                        <ReviewReplyBox reviewId={r.id} venueName={c.venue.name} listing={sourceName(r.source)} maxChars={maxChars} sendForApproval={sendReplyForApproval} postNow={postReplyNow} />
                      ) : null}
                    </article>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ReviewsFrame>
  );
}
