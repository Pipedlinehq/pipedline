import { z } from 'zod';
import {
  type App,
  type ConnectionRow,
  type Ctx,
  adapterFor,
  assertModule,
  connect,
  defineJob,
  definePlug,
  defineSchedule,
  enqueue,
  getModule,
  getPlug,
  invalid,
  markConnectionHealth,
  notFound,
  requireStaff,
  resolveConnection,
  track,
} from '@ros/core';
import { reviewReceived, reviewsModule } from './module';

/**
 * Listings a venue connects (a Google Business Profile-style provider) and the scheduled read
 * of their reviews. Ingest is idempotent on (org, source, external id) and cursor-driven: each
 * run asks only for reviews newer than where the last one finished, page by page.
 *
 * A real Google Business Profile adapter is not written: its API needs an approved project (a
 * new project has a quota of 0 until Google accepts an access request), so it cannot be built
 * and checked against the live API from here. `sim-reviews` stands in behind the same port.
 */
export const simReviewsPlug = definePlug({
  key: 'sim-reviews',
  name: 'Simulated review listing',
  description: 'A review listing held in memory. For development, tests and the fixture venues.',
  kind: 'adapter',
  tier: 'first_party',
  adapters: { reviews: 'sim-reviews' },
  auth: 'none',
  scopes: ['reviews:read', 'reviews:reply', 'insights:read'],
  venueScoped: true,
  simulated: true,
});

const WORKER = { kind: 'worker' as const, job: 'reviews.sync' };
const CONN_COLS = ['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'] as const;
export const REVIEWS_SYNC_EVERY_MINUTES = 60;
const MAX_PAGES = 20;

export function reviewsPlugKeys(): string[] {
  return ['sim-reviews'].filter((k) => {
    try {
      return !!getPlug(k).adapters.reviews;
    } catch {
      return false;
    }
  });
}

async function listingRows(ctx: Ctx, venueId?: string): Promise<ConnectionRow[]> {
  let q = ctx.db.selectFrom('connections').select(CONN_COLS).where('plug_key', 'in', reviewsPlugKeys()).where('status', 'in', ['connected', 'unhealthy']);
  if (venueId) q = q.where('venue_id', '=', venueId);
  return q.execute() as Promise<ConnectionRow[]>;
}

// ── Console ─────────────────────────────────────────────────────────────────

export const connectListingInput = z.object({
  plugKey: z.string().min(1),
  venueId: z.string().uuid(),
  /** The provider's location or listing id. */
  externalAccountId: z.string().min(1).max(200),
  credentials: z.record(z.string(), z.string()),
  config: z.record(z.string(), z.unknown()).optional(),
});

export interface ListingView {
  connectionId: string;
  venueId: string;
  plugKey: string;
  name: string;
  status: ConnectionRow['status'];
  syncedThrough: Date | null;
  lastRunAt: Date | null;
  lastCount: number | null;
  lastError: string | null;
}

/** Connect a venue's listing (manager of that venue). The first read is queued straight away. */
export async function connectListing(ctx: Ctx, raw: z.input<typeof connectListingInput>): Promise<ListingView> {
  const input = connectListingInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await assertModule(ctx, input.venueId, reviewsModule);
  const plug = getPlug(input.plugKey);
  if (!plug.adapters.reviews) throw invalid(`${plug.name} is not a review listing.`);
  const row = await connect(ctx, { plugKey: plug.key, venueId: input.venueId, externalAccountId: input.externalAccountId, credentials: input.credentials, config: input.config ?? {} });
  await ctx.db
    .insertInto('review_sync_state')
    .values({ connection_id: row.id, org_id: ctx.orgId, venue_id: input.venueId })
    .onConflict((oc) => oc.column('connection_id').doNothing())
    .execute();
  await enqueue(ctx, reviewsSyncJob, { connectionId: row.id }, { key: `connect:${row.id}:${ctx.now().toISOString()}` });
  return (await listListings(ctx, input.venueId)).find((l) => l.connectionId === row.id)!;
}

/** A venue's connected listings and how their sync is going. */
export async function listListings(ctx: Ctx, venueId: string): Promise<ListingView[]> {
  requireStaff(ctx, { venueId });
  await assertModule(ctx, venueId, reviewsModule);
  const rows = await listingRows(ctx, venueId);
  const out: ListingView[] = [];
  for (const r of rows) {
    const s = await ctx.db.selectFrom('review_sync_state').selectAll().where('connection_id', '=', r.id).executeTakeFirst();
    out.push({
      connectionId: r.id,
      venueId: r.venue_id!,
      plugKey: r.plug_key,
      name: getPlug(r.plug_key).name,
      status: r.status,
      syncedThrough: s?.synced_through ?? null,
      lastRunAt: s?.last_run_at ?? null,
      lastCount: s?.last_count ?? null,
      lastError: s?.last_error ?? r.last_error,
    });
  }
  return out;
}

/** "Check for new reviews now". */
export async function requestReviewsSync(ctx: Ctx, venueId: string): Promise<void> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  await assertModule(ctx, venueId, reviewsModule);
  for (const r of await listingRows(ctx, venueId)) await enqueue(ctx, reviewsSyncJob, { connectionId: r.id }, { key: `manual:${r.id}:${ctx.now().toISOString()}` });
}

export interface InsightDay {
  day: string;
  directions: number;
  calls: number;
  searches: number;
  websiteClicks: number;
}

/** Daily listing insights for a venue, summed across its listings. Published for analytics. */
export async function listingInsights(ctx: Ctx, args: { venueId: string; from: string; to: string }): Promise<InsightDay[]> {
  const input = z.object({ venueId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(args);
  requireStaff(ctx, { venueId: input.venueId });
  await assertModule(ctx, input.venueId, reviewsModule);
  const rows = await ctx.db
    .selectFrom('review_listing_insights')
    .select(['day', (eb) => eb.fn.sum<number>('directions').as('directions'), (eb) => eb.fn.sum<number>('calls').as('calls'), (eb) => eb.fn.sum<number>('searches').as('searches'), (eb) => eb.fn.sum<number>('website_clicks').as('clicks')])
    .where('venue_id', '=', input.venueId)
    .where('day', '>=', input.from)
    .where('day', '<=', input.to)
    .groupBy('day')
    .orderBy('day')
    .execute();
  return rows.map((r) => ({
    day: typeof r.day === 'string' ? r.day : new Date(r.day as unknown as string).toISOString().slice(0, 10),
    directions: Number(r.directions),
    calls: Number(r.calls),
    searches: Number(r.searches),
    websiteClicks: Number(r.clicks),
  }));
}

// ── Ingest ──────────────────────────────────────────────────────────────────

export interface ReviewsSyncResult {
  status: 'done' | 'partial' | 'skipped';
  fetched: number;
  created: number;
  updated: number;
}

/** Read one listing's new reviews (and insights). Safe to run twice: a review is stored once. */
export async function syncListing(app: App, args: { orgId: string; connectionId: string }): Promise<ReviewsSyncResult> {
  const { orgId, connectionId } = args;
  const result: ReviewsSyncResult = { status: 'skipped', fetched: 0, created: 0, updated: 0 };
  const start = await app.tenant(orgId, WORKER, async (ctx) => {
    const row = (await listingRows(ctx)).find((r) => r.id === connectionId);
    if (!row || !row.venue_id) return null;
    const mod = await getModule(ctx, row.venue_id, reviewsModule);
    if (!mod.enabled) return null;
    await ctx.db.insertInto('review_sync_state').values({ connection_id: row.id, org_id: ctx.orgId, venue_id: row.venue_id }).onConflict((oc) => oc.column('connection_id').doNothing()).execute();
    const state = await ctx.db.selectFrom('review_sync_state').selectAll().where('connection_id', '=', row.id).executeTakeFirstOrThrow();
    return { row, state, config: mod.config };
  });
  if (!start) return result;
  const { row, state, config } = start;
  const venueId = row.venue_id!;
  const adapter = adapterFor(app, 'reviews', row);
  const runAt = app.clock();

  try {
    const handle = await resolveConnection(app, row);
    let cursor = state.cursor;
    const since = state.synced_through ?? undefined;
    let newest = state.synced_through;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { items, nextCursor } = await adapter.listReviews(handle, { since, cursor });
      result.fetched += items.length;
      await app.tenant(orgId, WORKER, async (ctx) => {
        for (const r of items) {
          const rating = r.rating === null ? null : Math.max(1, Math.min(5, Math.round(r.rating)));
          const existing = await ctx.db.selectFrom('reviews').select(['id', 'reply_status']).where('source', '=', row.plug_key).where('external_id', '=', r.externalId).executeTakeFirst();
          if (!existing) {
            const ins = await ctx.db
              .insertInto('reviews')
              .values({
                org_id: ctx.orgId,
                venue_id: venueId,
                connection_id: row.id,
                source: row.plug_key,
                external_id: r.externalId,
                rating,
                // Guest-written: stored as text, never rendered as markup.
                body: r.body,
                author_name: r.authorName,
                reviewed_at: r.reviewedAt,
                reply_body: r.replyBody ?? null,
                reply_status: r.replyBody ? 'posted' : 'none',
                replied_at: r.replyBody ? ctx.now() : null,
              })
              .onConflict((oc) => oc.columns(['org_id', 'source', 'external_id']).doNothing())
              .returning('id')
              .executeTakeFirst();
            if (ins) {
              result.created++;
              await track(ctx, reviewReceived, { review_id: ins.id, rating, source: row.plug_key }, { venueId });
            }
          } else {
            await ctx.db
              .updateTable('reviews')
              .set({
                rating,
                body: r.body,
                author_name: r.authorName,
                // A reply made on the listing directly is recorded as posted.
                ...(r.replyBody && existing.reply_status === 'none' ? { reply_body: r.replyBody, reply_status: 'posted' as const, replied_at: ctx.now() } : {}),
              })
              .where('id', '=', existing.id)
              .execute();
            result.updated++;
          }
          if (!newest || r.reviewedAt > newest) newest = r.reviewedAt;
        }
        await ctx.db.updateTable('review_sync_state').set({ cursor: nextCursor }).where('connection_id', '=', row.id).execute();
      });
      cursor = nextCursor;
      if (!cursor) break;
    }
    result.status = cursor ? 'partial' : 'done';

    let insightsThrough = state.insights_through as unknown as string | null;
    if (config.collect_insights && adapter.insights) {
      const yesterday = new Date(runAt.getTime() - 86_400_000);
      const from = insightsThrough ? new Date(new Date(`${String(insightsThrough).slice(0, 10)}T00:00:00Z`).getTime() + 86_400_000) : new Date(runAt.getTime() - 30 * 86_400_000);
      if (from <= yesterday) {
        const days = await adapter.insights(handle, { since: from, until: yesterday });
        await app.tenant(orgId, WORKER, async (ctx) => {
          for (const d of days) {
            const values = { directions: d.directions, calls: d.calls, searches: d.searches, website_clicks: d.websiteClicks };
            await ctx.db
              .insertInto('review_listing_insights')
              .values({ org_id: ctx.orgId, venue_id: venueId, connection_id: row.id, day: d.day, ...values })
              .onConflict((oc) => oc.columns(['connection_id', 'day']).doUpdateSet(values))
              .execute();
          }
        });
        insightsThrough = yesterday.toISOString().slice(0, 10);
      }
    }

    await app.tenant(orgId, WORKER, (ctx) =>
      ctx.db
        .updateTable('review_sync_state')
        .set({
          ...(result.status === 'done' ? { synced_through: newest, cursor: null } : {}),
          insights_through: insightsThrough,
          last_run_at: runAt,
          last_count: result.fetched,
          last_error: null,
        })
        .where('connection_id', '=', row.id)
        .execute(),
    );
    await markConnectionHealth(app, row.id, { ok: true });
    return result;
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    await app.tenant(orgId, WORKER, (ctx) => ctx.db.updateTable('review_sync_state').set({ last_run_at: runAt, last_error: message }).where('connection_id', '=', row.id).execute());
    await markConnectionHealth(app, row.id, { ok: false, error: message });
    throw e;
  }
}

export const reviewsSyncJob = defineJob({
  kind: 'reviews.sync',
  schema: z.object({ connectionId: z.string().uuid() }),
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('reviews.sync is an org job');
    const r = await syncListing(app, { orgId: job.orgId, connectionId: job.payload.connectionId });
    if (r.status === 'partial') {
      await app.tenant(job.orgId, WORKER, (ctx) => enqueue(ctx, reviewsSyncJob, { connectionId: job.payload.connectionId }, { key: `continue:${job.id}` }));
    }
  },
});

export const reviewsSyncAllJob = defineJob({
  kind: 'reviews.sync_all',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('reviews.sync_all is an org job');
    await app.tenant(orgId, WORKER, async (ctx) => {
      for (const r of await listingRows(ctx)) await enqueue(ctx, reviewsSyncJob, { connectionId: r.id }, { key: `sched:${r.id}:${job.payload.bucket}` });
    });
  },
});

export const reviewsSyncSchedule = defineSchedule({
  key: 'reviews.sync',
  everyMinutes: REVIEWS_SYNC_EVERY_MINUTES,
  scope: 'org',
  job: reviewsSyncAllJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  async appliesTo(app, orgId) {
    // app.db: the scheduler runs outside any tenant and asks only whether this org has a listing connected.
    const row = await app.db
      .selectFrom('connections')
      .select('id')
      .where('org_id', '=', orgId)
      .where('plug_key', 'in', reviewsPlugKeys())
      .where('status', 'in', ['connected', 'unhealthy'])
      .limit(1)
      .executeTakeFirst();
    return !!row;
  },
});

/** Used by the reply job: the live connection a review came through. */
export async function reviewConnection(ctx: Ctx, connectionId: string | null, venueId: string): Promise<ConnectionRow> {
  const rows = await listingRows(ctx, venueId);
  const row = (connectionId ? rows.find((r) => r.id === connectionId) : null) ?? rows[0];
  if (!row) throw notFound('That listing is no longer connected.');
  return row;
}
