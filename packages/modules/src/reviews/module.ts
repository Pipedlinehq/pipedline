import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface for reviews at one venue. Whether the reply-drafting agent runs, and how far it
 * may go, is the hub's `hosted_agents` / `autonomy_level_per_agent` (agent `review_replier`).
 */
export const reviewsConfig = z.object({
  /** Longest reply that is drafted or accepted. */
  reply_max_chars: z.number().int().min(100).max(4000).default(1000),
  /** Star ratings the agent drafts replies for. A venue may leave, say, 5-star reviews unanswered. */
  draft_for_ratings: z.array(z.number().int().min(1).max(5)).max(5).default([1, 2, 3, 4, 5]),
  /** Also fetch daily listing insights (directions, calls, searches, website clicks) where the provider has them. */
  collect_insights: z.boolean().default(true),
  /** Extra words or phrases no drafted reply may contain, on top of the built-in rules. */
  forbidden_phrases: z.array(z.string().trim().min(2).max(80)).max(50).default([]),
});
export type ReviewsConfig = z.infer<typeof reviewsConfig>;

export const reviewsModule = defineModule({
  key: 'reviews',
  name: 'Reviews',
  description: 'Reviews from connected listings, and replies drafted for a person to approve.',
  dependsOn: [],
  tables: ['reviews', 'review_sync_state', 'review_reply_drafts', 'review_listing_insights'],
  configSchema: reviewsConfig,
  configVersion: 1,
  defaultConfig: reviewsConfig.parse({}),
});

export const reviewReceived = defineEvent({
  name: 'review.received',
  module: 'reviews',
  description: 'A new review arrived from a connected listing. Carries the rating, never the text.',
  properties: z.object({ review_id: z.string(), rating: z.number().int().nullable(), source: z.string() }),
});

export const reviewReplyDrafted = defineEvent({
  name: 'review.reply_drafted',
  module: 'reviews',
  description: 'A reply to a review was drafted: by the review agent, a staff assistant, or a person.',
  properties: z.object({
    review_id: z.string(),
    draft_id: z.string(),
    author: z.enum(['agent', 'assistant', 'staff']),
    status: z.enum(['shadow', 'blocked', 'pending', 'approved']),
  }),
});

export const reviewReplyPosted = defineEvent({
  name: 'review.reply_posted',
  module: 'reviews',
  description: 'An approved reply was posted to the listing.',
  properties: z.object({ review_id: z.string(), draft_id: z.string(), author: z.enum(['agent', 'assistant', 'staff']) }),
});
