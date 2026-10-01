import type { ConnectionHandle, ExternalReview, ReviewsAdapter } from '@ros/core';

export const SIM_REVIEWS_KEY = 'sim-reviews';

export interface SimReviewReply {
  accountRef: string;
  externalId: string;
  body: string;
  idempotencyKey: string;
  at: Date;
}

export interface SimInsightDay {
  day: string;
  directions: number;
  calls: number;
  searches: number;
  websiteClicks: number;
}

export interface SimReviewsAdapter extends ReviewsAdapter {
  /** Put a review on a listing, as a guest writing one would. */
  addReview(accountRef: string, review: Omit<ExternalReview, 'externalId'> & { externalId?: string }): ExternalReview;
  setInsights(accountRef: string, days: SimInsightDay[]): void;
  /** Replies actually posted to the listing, in order. */
  readonly replies: SimReviewReply[];
  /** Every listReviews call, so a test can see the cursor it was given. */
  readonly listCalls: Array<{ accountRef: string; since: Date | null; cursor: string | null }>;
  pageSize: number;
  failNext(n: number): void;
  reset(): void;
}

/**
 * A review listing held in memory. Pages through reviews newer than `since`, oldest first,
 * `pageSize` at a time; a reply with an idempotency key it has seen is answered without posting
 * again, the way a careful real integration behaves.
 */
export function createSimReviewsAdapter(opts: { clock?: () => Date } = {}): SimReviewsAdapter {
  const listings = new Map<string, ExternalReview[]>();
  const insights = new Map<string, SimInsightDay[]>();
  const replies: SimReviewReply[] = [];
  const listCalls: SimReviewsAdapter['listCalls'] = [];
  const replyKeys = new Set<string>();
  let failures = 0;
  let seq = 0;
  const now = () => (opts.clock ? opts.clock() : new Date());
  const listing = (ref: string) => {
    let l = listings.get(ref);
    if (!l) listings.set(ref, (l = []));
    return l;
  };
  const account = (conn: ConnectionHandle) => {
    if (!conn.credentials.accessToken) throw new Error('sim-reviews: 401 no access token');
    return conn.externalAccountId;
  };

  const adapter: SimReviewsAdapter = {
    key: SIM_REVIEWS_KEY,
    replies,
    listCalls,
    pageSize: 2,

    addReview(accountRef, review) {
      const r: ExternalReview = { ...review, externalId: review.externalId ?? `simrev_${++seq}_${Math.random().toString(36).slice(2, 8)}` };
      listing(accountRef).push(r);
      return r;
    },

    setInsights(accountRef, days) {
      insights.set(accountRef, days);
    },

    async listReviews(conn, args) {
      if (failures > 0) {
        failures--;
        throw new Error('sim-reviews: simulated outage');
      }
      const ref = account(conn);
      listCalls.push({ accountRef: ref, since: args.since ?? null, cursor: args.cursor ?? null });
      const all = listing(ref)
        .filter((r) => !args.since || r.reviewedAt > args.since)
        .sort((a, b) => a.reviewedAt.getTime() - b.reviewedAt.getTime() || a.externalId.localeCompare(b.externalId));
      const offset = args.cursor ? Number(args.cursor) : 0;
      const items = all.slice(offset, offset + adapter.pageSize).map((r) => ({ ...r }));
      const next = offset + adapter.pageSize < all.length ? String(offset + adapter.pageSize) : null;
      return { items, nextCursor: next };
    },

    async reply(conn, args) {
      const ref = account(conn);
      if (failures > 0) {
        failures--;
        throw new Error('sim-reviews: simulated outage');
      }
      if (replyKeys.has(args.idempotencyKey)) return { ok: true };
      const held = listing(ref);
      const review = held.find((r) => r.externalId === args.externalId);
      // A listing this process holds knows its reviews. A listing it holds nothing for was filled
      // in another process (the fixture seeder, or before a restart); a real provider would
      // still know the review, so the reply is accepted and recorded.
      if (!review && held.length) throw new Error('sim-reviews: 404 review not found');
      replyKeys.add(args.idempotencyKey);
      if (review) review.replyBody = args.body;
      replies.push({ accountRef: ref, externalId: args.externalId, body: args.body, idempotencyKey: args.idempotencyKey, at: now() });
      return { ok: true };
    },

    async insights(conn, args) {
      const ref = account(conn);
      const from = args.since.toISOString().slice(0, 10);
      const to = args.until.toISOString().slice(0, 10);
      return (insights.get(ref) ?? []).filter((d) => d.day >= from && d.day <= to);
    },

    failNext(n) {
      failures = n;
    },

    reset() {
      listings.clear();
      insights.clear();
      replies.length = 0;
      listCalls.length = 0;
      replyKeys.clear();
      failures = 0;
    },
  };
  return adapter;
}
