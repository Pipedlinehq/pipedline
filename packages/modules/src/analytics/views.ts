import { z } from 'zod';
import { type Ctx, actorOf, audit, conflict, invalid, isUniqueViolation, json, notFound, requireStaff } from '@ros/core';
import { type MetricQuery, type MetricResult, metricQueryInput, queryMetrics } from './query';
import { resolveScope } from './scope';
import { parseInput } from './util';

/**
 * Saved ("pinned") views: a metric query kept under a name so a recurring question is asked
 * the same way every time (framework INTEGRATION_STRATEGY section 5). A view stores the
 * question, never the answer; running it asks the question again, as whoever is running it,
 * so a view can never show someone a venue they cannot see.
 */
export interface SavedView {
  id: string;
  name: string;
  description: string | null;
  query: MetricQuery;
  pinned: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const nameSchema = z.string().trim().min(1).max(80);

export const saveViewInput = z
  .object({
    name: nameSchema,
    description: z.string().trim().max(400).nullish(),
    query: metricQueryInput,
    pinned: z.boolean().optional(),
  })
  .strict();

type Row = { id: string; name: string; description: string | null; query: unknown; is_pinned: boolean; created_by_kind: string; created_at: Date; updated_at: Date };
const view = (r: Row): SavedView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  query: r.query as MetricQuery,
  pinned: r.is_pinned,
  createdBy: r.created_by_kind,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const COLS = ['id', 'name', 'description', 'query', 'is_pinned', 'created_by_kind', 'created_at', 'updated_at'] as const;

/**
 * Save a metric query under a name, replacing a view of the same name. Manager and above: views
 * are shared by the whole org. The query is validated by running its plan, so a saved view is
 * always one that can be run.
 */
export async function saveView(ctx: Ctx, raw: z.input<typeof saveViewInput>): Promise<SavedView> {
  const input = parseInput(saveViewInput, raw, 'That view');
  requireStaff(ctx, { minRole: 'manager' });
  // Running it once proves the metrics, dimensions and venues are real and visible to the saver.
  await queryMetrics(ctx, { ...input.query, limit: 1 });
  const actor = actorOf(ctx.principal);
  // Store what was asked, not the defaults filled in, so a relative period stays relative.
  const stored = (raw as { query: unknown }).query;
  const before = await ctx.db.selectFrom('saved_views').select(COLS).where('org_id', '=', ctx.orgId).where('name', '=', input.name).executeTakeFirst();
  let row: Row;
  if (before) {
    row = await ctx.db
      .updateTable('saved_views')
      .set({ description: input.description ?? null, query: json(stored), ...(input.pinned === undefined ? {} : { is_pinned: input.pinned }) })
      .where('id', '=', before.id)
      .returning(COLS)
      .executeTakeFirstOrThrow();
  } else {
    try {
      row = await ctx.db
        .insertInto('saved_views')
        .values({ org_id: ctx.orgId, name: input.name, description: input.description ?? null, query: json(stored), is_pinned: input.pinned ?? false, created_by_kind: actor.kind, created_by_id: actor.id, created_at: ctx.now() })
        .returning(COLS)
        .executeTakeFirstOrThrow();
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('A view with that name already exists.');
      throw e;
    }
  }
  await audit(ctx, { action: before ? 'analytics.view_updated' : 'analytics.view_saved', entityType: 'saved_view', entityId: row.id, before: before ? { query: before.query, pinned: before.is_pinned } : undefined, after: { name: row.name, query: row.query, pinned: row.is_pinned } });
  return view(row);
}

/** Every saved view, pinned ones first. Read-only staff and above. */
export async function listViews(ctx: Ctx, opts: { pinnedOnly?: boolean } = {}): Promise<SavedView[]> {
  await resolveScope(ctx);
  let q = ctx.db.selectFrom('saved_views').select(COLS).where('org_id', '=', ctx.orgId).orderBy('is_pinned', 'desc').orderBy('name');
  if (opts.pinnedOnly) q = q.where('is_pinned', '=', true);
  return (await q.execute()).map(view);
}

async function find(ctx: Ctx, ref: { id?: string; name?: string }): Promise<Row> {
  if (!ref.id && !ref.name) throw invalid('Say which view: its id or its name.');
  let q = ctx.db.selectFrom('saved_views').select(COLS).where('org_id', '=', ctx.orgId);
  q = ref.id ? q.where('id', '=', ref.id) : q.where('name', '=', ref.name!);
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Saved view not found');
  return row;
}

export const viewRef = z.object({ id: z.string().uuid().optional(), name: nameSchema.optional() }).strict();

/**
 * Ask a saved view's question again. It runs as the caller: the role check and the venue scope
 * are theirs, so a view naming a venue they cannot see is answered as not-found.
 */
export async function runView(ctx: Ctx, raw: z.input<typeof viewRef>): Promise<{ view: SavedView; result: MetricResult }> {
  const ref = parseInput(viewRef, raw, 'That view');
  await resolveScope(ctx);
  const row = await find(ctx, ref);
  return { view: view(row), result: await queryMetrics(ctx, row.query as MetricQuery) };
}

/** Pin or unpin a view. Manager and above. */
export async function pinView(ctx: Ctx, raw: z.input<typeof viewRef> & { pinned: boolean }): Promise<SavedView> {
  const { pinned, ...rest } = parseInput(viewRef.extend({ pinned: z.boolean() }), raw, 'That view');
  requireStaff(ctx, { minRole: 'manager' });
  const row = await find(ctx, rest);
  const updated = await ctx.db.updateTable('saved_views').set({ is_pinned: pinned }).where('id', '=', row.id).returning(COLS).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'analytics.view_pinned', entityType: 'saved_view', entityId: row.id, before: { pinned: row.is_pinned }, after: { pinned } });
  return view(updated);
}

/** Remove a view. Manager and above. */
export async function deleteView(ctx: Ctx, raw: z.input<typeof viewRef>): Promise<void> {
  const ref = parseInput(viewRef, raw, 'That view');
  requireStaff(ctx, { minRole: 'manager' });
  const row = await find(ctx, ref);
  await ctx.db.deleteFrom('saved_views').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'analytics.view_deleted', entityType: 'saved_view', entityId: row.id, before: { name: row.name, query: row.query } });
}
