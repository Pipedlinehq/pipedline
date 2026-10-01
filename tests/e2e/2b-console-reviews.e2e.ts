import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviews } from '@ros/modules';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { E2E_CLOCK_START } from './global-setup';
import { BASE, closeBrowser, closeDb, db, eventually, newVisitor, orgBySlug, signInStaff } from './helpers';

/**
 * Reviews in the console. Two reviews are put on a fresh simulated listing and read in through
 * the real ingest, from this process (a guest writes a review on the provider's site, not in the
 * console). Everything staff do goes through the console: a reply sent for approval and approved
 * in Approvals, a reply posted directly behind its confirmation, and what a host is offered.
 */
const RUN = Date.now();
const PLAIN = `The lamb was superb and the room was warm ${RUN}`;
const MARKUP = `<script>window.__pwned = 1</script><b>Bold</b> claim about lunch ${RUN}`;
let ids: { plain: string; markup: string };

beforeAll(async () => {
  const diner = await orgBySlug('oak-diner');
  const now = new Date(new Date(E2E_CLOCK_START).getTime() + 60_000);
  const t = createTestApp(process.env.E2E_DATABASE_URL!, { clock: fakeClock(now), config: configFromEnv() });
  try {
    const ref = `e2e-listing-${RUN}`;
    t.sim.reviews.addReview(ref, { rating: 5, body: PLAIN, authorName: 'Dana E2E', reviewedAt: new Date(now.getTime() - 3 * 3_600_000) });
    t.sim.reviews.addReview(ref, { rating: 2, body: MARKUP, authorName: '<i>Mallory</i>', reviewedAt: new Date(now.getTime() - 2 * 3_600_000) });
    const worker = { kind: 'worker' as const, job: 'e2e.reviews' };
    const listing = await t.app.tenant(diner.orgId, worker, (ctx) =>
      reviews.connectListing(ctx, { plugKey: 'sim-reviews', venueId: diner.venueId, externalAccountId: ref, credentials: { accessToken: 'e2e-token' } }),
    );
    // The running app's worker may pick the queued sync up too; ingest is idempotent, and only this
    // process's simulator holds the listing, so read it in here.
    await reviews.syncListing(t.app, { orgId: diner.orgId, connectionId: listing.connectionId });
    const rows = await db().selectFrom('reviews').select(['id', 'body']).where('connection_id', '=', listing.connectionId).execute();
    ids = { plain: rows.find((r) => r.body === PLAIN)!.id, markup: rows.find((r) => r.body === MARKUP)!.id };
  } finally {
    await t.close();
  }
});

afterAll(async () => {
  await closeBrowser();
  await closeDb();
});

describe('console: reviews', () => {
  it('a manager sends a reply for approval, nothing is posted until it is approved in Approvals, then it is posted', async () => {
    const reply = `Thank you Dana, we will tell the kitchen. ${RUN}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/reviews`);
    const card = v.page.locator(`[data-review-id="${ids.plain}"]`);
    expect(await card.innerText()).toContain('5 of 5 · Excellent');
    await card.getByRole('button', { name: 'Write a reply' }).click();
    await card.locator('textarea[name=body]').fill(reply);
    await card.getByRole('button', { name: 'Send for approval' }).click();
    await card.getByText('Reply waiting').waitFor();

    const draft = await db().selectFrom('review_reply_drafts').select(['id', 'status', 'author', 'body', 'approval_id']).where('review_id', '=', ids.plain).executeTakeFirstOrThrow();
    expect(draft).toMatchObject({ status: 'pending', author: 'staff', body: reply });
    const approval = await db().selectFrom('approvals').select(['id', 'kind', 'status']).where('id', '=', draft.approval_id!).executeTakeFirstOrThrow();
    expect(approval).toMatchObject({ kind: 'reviews.reply', status: 'pending' });
    // Not posted: the review has no reply and nothing was sent to the listing.
    expect(await db().selectFrom('reviews').select(['reply_status', 'reply_body', 'replied_at']).where('id', '=', ids.plain).executeTakeFirstOrThrow()).toEqual({ reply_status: 'pending_approval', reply_body: null, replied_at: null });
    expect(await db().selectFrom('side_effects').select('key').where('key', '=', `review-reply:${draft.id}`).execute()).toEqual([]);

    // The approval shows the guest's words and the exact reply, not raw data.
    await v.page.goto(`${BASE()}/console/approvals/${approval.id}`);
    const shown = v.page.getByTestId('approval-review-reply');
    expect(await shown.innerText()).toContain(PLAIN);
    expect(await v.page.getByTestId('approval-reply-text').innerText()).toBe(reply);
    await v.page.getByTestId(`approve-${approval.id}`).click();
    await v.page.getByRole('dialog', { name: 'Approve this?' }).getByRole('button', { name: 'Approve' }).click();
    await v.page.getByText('Approved', { exact: true }).first().waitFor();

    const posted = await eventually(async () => {
      const r = await db().selectFrom('reviews').select(['reply_status', 'reply_body', 'replied_at']).where('id', '=', ids.plain).executeTakeFirstOrThrow();
      return r.reply_status === 'posted' ? r : null;
    }, 'the approved reply to be posted');
    expect(posted.reply_body).toBe(reply);
    expect(posted.replied_at).not.toBeNull();
    const after = await db().selectFrom('review_reply_drafts').select(['status', 'approved_by_staff_id']).where('id', '=', draft.id).executeTakeFirstOrThrow();
    expect(after.status).toBe('posted');
    expect(after.approved_by_staff_id).not.toBeNull();
    const audits = await db().selectFrom('audit_log').select('action').where('entity_type', '=', 'review').where('entity_id', '=', ids.plain).execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['review.reply_drafted', 'review.reply_posted']);
    expect((await db().selectFrom('side_effects').select('key').where('key', '=', `review-reply:${draft.id}`).execute()).length).toBe(1);

    await v.page.goto(`${BASE()}/console/reviews`);
    const done = v.page.locator(`[data-review-id="${ids.plain}"]`);
    expect(await done.innerText()).toContain(reply);
    expect(await done.getByRole('button', { name: 'Write a reply' }).count()).toBe(0);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('a review containing markup is shown as text; a manager posts a reply directly after confirming the exact words', async () => {
    const reply = `We are sorry lunch fell short. Please ask for the manager next time. ${RUN}`;
    const v = await newVisitor();
    await signInStaff(v.page, 'manager@oak-diner.test');
    await v.page.goto(`${BASE()}/console/reviews?stars=2`);
    const card = v.page.locator(`[data-review-id="${ids.markup}"]`);
    const text = await card.innerText();
    expect(text).toContain('<script>window.__pwned = 1</script><b>Bold</b>');
    expect(text).toContain('<i>Mallory</i>');
    expect(await card.locator('b, i, script').count()).toBe(0);
    expect(await v.page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

    await card.getByRole('button', { name: 'Write a reply' }).click();
    await card.locator('textarea[name=body]').fill(reply);
    await card.getByRole('button', { name: 'Post reply…' }).click();
    const dialog = v.page.getByRole('dialog', { name: 'Post this reply in public?' });
    expect(await dialog.getByTestId('reply-preview').innerText()).toBe(reply);
    expect(await dialog.innerText()).toMatch(/cannot be unsent/);
    await dialog.getByRole('button', { name: 'Post it publicly' }).click();

    const posted = await eventually(async () => {
      const r = await db().selectFrom('reviews').select(['reply_status', 'reply_body']).where('id', '=', ids.markup).executeTakeFirstOrThrow();
      return r.reply_status === 'posted' ? r : null;
    }, 'the reply to be posted');
    expect(posted.reply_body).toBe(reply);
    const audits = await db().selectFrom('audit_log').select(['action', 'actor_kind']).where('entity_type', '=', 'review').where('entity_id', '=', ids.markup).execute();
    expect(audits.map((a) => a.action).sort()).toEqual(['review.reply_approved', 'review.reply_posted']);
    expect(audits.find((a) => a.action === 'review.reply_approved')!.actor_kind).toBe('staff');
    // No approval was queued: the manager was the approver.
    expect((await db().selectFrom('review_reply_drafts').select('approval_id').where('review_id', '=', ids.markup).execute()).map((d) => d.approval_id)).toEqual([null]);
    expect(v.problems).toEqual([]);
    await v.context.close();
  });

  it('front-of-house staff read the reviews but are offered no way to reply or change settings', async () => {
    const v = await newVisitor();
    await signInStaff(v.page, 'host@oak-diner.test');
    await v.page.goto(`${BASE()}/console/reviews`);
    await v.page.locator('[data-testid=review]').first().waitFor();
    expect(await v.page.locator('[data-testid=review-tiles]').innerText()).toContain('Average rating');
    expect(await v.page.getByRole('button', { name: 'Write a reply' }).count()).toBe(0);
    expect(await v.page.getByRole('link', { name: 'Reply settings' }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/reviews/listings`);
    expect(await v.page.locator('[data-testid=listing]').count()).toBeGreaterThan(0);
    expect(await v.page.getByRole('button', { name: /Connect listing|Check for new reviews/ }).count()).toBe(0);
    await v.page.goto(`${BASE()}/console/reviews/settings`);
    expect(await v.page.locator('main').innerText()).toContain('Your role does not include this');
    expect(v.problems).toEqual([]);
    await v.context.close();
  });
});
