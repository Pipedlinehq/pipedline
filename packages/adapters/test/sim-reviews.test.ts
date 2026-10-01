import { describe, expect, it } from 'vitest';
import { createSimReviewsAdapter } from '../src/sim/reviews';

const conn = (ref: string) => ({ externalAccountId: ref, credentials: { accessToken: 'tok' }, config: {} }) as never;

describe('sim-reviews replies', () => {
  it('accepts a reply to a review ingested in another process, once per key, and still refuses an unknown review on a listing it holds', async () => {
    // The seeder's process filled the listing; this process (the running app) holds nothing for it.
    const app = createSimReviewsAdapter();
    expect(await app.reply(conn('listing-a'), { externalId: 'listing-a-r1', body: 'Thank you.', idempotencyKey: 'k1' })).toEqual({ ok: true });
    expect(await app.reply(conn('listing-a'), { externalId: 'listing-a-r1', body: 'Thank you.', idempotencyKey: 'k1' })).toEqual({ ok: true });
    expect(app.replies.map((r) => [r.accountRef, r.externalId, r.body])).toEqual([['listing-a', 'listing-a-r1', 'Thank you.']]);

    const known = app.addReview('listing-b', { rating: 4, body: 'Good.', authorName: 'Sam', reviewedAt: new Date('2026-10-01T00:00:00Z') });
    await expect(app.reply(conn('listing-b'), { externalId: 'not-a-review', body: 'x', idempotencyKey: 'k2' })).rejects.toThrow(/404/);
    await app.reply(conn('listing-b'), { externalId: known.externalId, body: 'Cheers.', idempotencyKey: 'k3' });
    expect(app.replies).toHaveLength(2);
  });
});
