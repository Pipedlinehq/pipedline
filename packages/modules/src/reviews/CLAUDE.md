# reviews — listing reviews in, replies out only with a person's approval

Written from the in-progress state of 2026-10-01; check index.ts for anything newer.

Reads reviews (and daily listing insights) from a venue's connected listing on a schedule, and
drafts replies (the `review_replier` hosted agent, a staff assistant, or a manager) that are posted
only after a person approves. Machine-drafted text is checked by code rules, not just the prompt.

**Toggleable** per venue (`assertModule`). `dependsOn: []`. Owns `reviews` (table from 0005),
`review_sync_state`, `review_reply_drafts`, `review_listing_insights` (0380_reach.sql).

## Public functions by purpose
Inbox (staff at the venue, read_only and above):
- `listReviews(ctx, listReviewsInput)` reviews with their drafts; `body` is guest-written, render as text.
- `reviewsSummary(ctx, venueId, since?)` counts, average, by star, unanswered, awaiting approval.
Listings:
- `connectListing(ctx, connectListingInput)` manager; plug must have a `reviews` adapter; queues the first sync.
- `listListings(ctx, venueId)` read_only; sync state per connection. `requestReviewsSync(ctx, venueId)` manager.
- `listingInsights(ctx, {venueId, from, to})` daily directions / calls / searches / website clicks, summed across listings.
- `syncListing(app, {orgId, connectionId})` worker ingest: cursor-driven, max 20 pages per run, idempotent on (org, source, external id).
Replies:
- `saveReplyDraft(ctx, replyInput)` manager (staff or their assistant); assistant text must pass `checkReplyRules`; creates a pending draft and a `reviews.reply` approval.
- `postReply(ctx, replyInput)` a person only (`principal.kind === 'staff'`), manager; the manager is the approver; enqueues the post.
- `runReviewReplier(app, {orgId, venueId, trigger, limit?})` one agent run (default 10 reviews): shadow records drafts only, supervised queues one approval per reply; rule failures stored as `blocked`.
- `checkReplyRules(text, config?)` refund/compensation, fault/liability, contact details, `forbidden_phrases`, length.
- Guest content: `quoteGuestContent`, `GUEST_CONTENT_LABEL`, `GUEST_TEXT_CAP` (500), `redactContactDetails`, `firstNameOf`.
- Constants: `REVIEW_REPLY_APPROVAL` (`reviews.reply`), `reviewReplier`, `replyDraftSchema`, `REVIEWS_SYNC_EVERY_MINUTES`.

## Hooks
- Registers `approvals.onApprovalDecided('reviews.reply')`: approved → draft `approved` and `postReplyJob` enqueued; otherwise draft `rejected`, review back to `none`.
- Defines hosted agent `review_replier` (ceiling `supervised`); its mode comes from the hub (`agentMode`).
- No identity hooks. `reviews.customer_id` exists in the schema but nothing here sets it.

## Config surface (`reviewsConfig`, venue)
`reply_max_chars` (default 1000) · `draft_for_ratings` star ratings the agent drafts for (default 1-5) ·
`collect_insights` fetch daily insights where the provider has them · `forbidden_phrases[]` extra banned
phrases. Whether the agent runs and how far is the hub's `hosted_agents` / `autonomy_level_per_agent`.
No org settings namespace.

## Jobs, schedules, events, templates, tools
- Jobs: `reviews.sync` (re-enqueues itself on a partial run), `reviews.sync_all`, `reviews.post_reply` (via `once`, key `review-reply:<draftId>`; posts only an approved draft with `approved_by_staff_id`; after 6 attempts marks `failed`), `reviews.draft_replies`.
- Schedules: `reviews.sync` hourly per org with a listing connected; `reviews.draft_replies` hourly per org with the module on.
- Events: `review.received` (rating, never text), `review.reply_drafted`, `review.reply_posted`.
- Templates: none.
- Tools: `reviews_list` (read, `reviews:read`; text only inside labelled `guest_content`), `review_reply_draft` (write, `reviews:write`, manager; propose/commit, saves a draft, never posts). Also exported as `reviewsTools`.

## Simulated vs real
Reviews port `ReviewsAdapter` (`packages/core/src/ports/marketing.ts`: `listReviews`, `reply`, optional `insights`).
Only a simulator: plug `sim-reviews` (declared in `sync.ts`, `simulated: true`, venue-scoped), adapter in
`packages/adapters/src/sim/reviews.ts`. Reply drafting uses the `llm` adapter (`purpose: 'reviews.reply_draft'`).
Seeder `packages/fixtures/src/seeders/36-reach.ts`; tests `packages/modules/test/reach/reviews.test.ts`.

## Known gaps
- No real Google Business Profile adapter: `sync.ts` says its API needs an approved project, so `sim-reviews` stands in. `reviewsPlugKeys()` lists only `sim-reviews`.
- `listingInsights` is described as published for analytics, but no other module calls it yet.
