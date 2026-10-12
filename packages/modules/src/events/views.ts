import { z } from 'zod';
import { type Ctx, audit, invalid, json, notFound, requireStaff, staffOf } from '@ros/core';

/**
 * Saved views of the console's index pages (docs/CONSOLE_IA.md section 9, wave 1; pattern 1 of
 * docs/COMMERCE_ADMIN_PATTERNS.md section 3). A view is a name and the filter tokens the page's
 * URL carries, kept per venue. The default views ("Needs accepting", "Today", "All") live in the
 * console's code, so there is nothing here to rename or delete for them. Sort order is never
 * saved. Any staff member who can use the page may save a view for the venue; read-only roles
 * can look but not save.
 */
export const CONSOLE_VIEW_PAGES = ['orders', 'bookings', 'customers', 'menu', 'offers', 'activity'] as const;
export type ConsoleViewPage = (typeof CONSOLE_VIEW_PAGES)[number];

const PAGE = z.enum(CONSOLE_VIEW_PAGES);
const NAME = z.string().trim().min(1, 'Give the view a name.').max(60, 'Keep the name under 60 characters.');
/** Filter tokens: short keys and short values, as a URL carries them. */
const FILTERS = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,30}$/), z.string().max(200)).refine((f) => Object.keys(f).length <= 20, 'Too many filters.');

export interface ConsoleViewRow {
  id: string;
  venueId: string;
  page: ConsoleViewPage;
  name: string;
  filters: Record<string, string>;
  position: number;
  createdById: string | null;
  createdAt: Date;
}

const COLS = ['id', 'venue_id', 'page', 'name', 'filters', 'position', 'created_by_id', 'created_at'] as const;
type Row = { id: string; venue_id: string; page: string; name: string; filters: unknown; position: number; created_by_id: string | null; created_at: Date };

const view = (r: Row): ConsoleViewRow => ({
  id: r.id,
  venueId: r.venue_id,
  page: r.page as ConsoleViewPage,
  name: r.name,
  filters: filtersOf(r.filters),
  position: r.position,
  createdById: r.created_by_id,
  createdAt: r.created_at,
});

function filtersOf(stored: unknown): Record<string, string> {
  const parsed = FILTERS.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

export const listConsoleViewsInput = z.object({ venueId: z.string().uuid(), page: PAGE }).strict();

/** The venue's own views of one page, in the order they were put. Any staff role at the venue. */
export async function listConsoleViews(ctx: Ctx, raw: z.input<typeof listConsoleViewsInput>): Promise<ConsoleViewRow[]> {
  const input = listConsoleViewsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  const rows = await ctx.db.selectFrom('console_views').select(COLS).where('venue_id', '=', input.venueId).where('page', '=', input.page).orderBy('position').orderBy('created_at').execute();
  return rows.map(view);
}

export const saveConsoleViewInput = z
  .object({
    venueId: z.string().uuid(),
    page: PAGE,
    name: NAME,
    filters: FILTERS,
    /** Update this view (its filters, and its name if given) instead of making a new one. */
    id: z.string().uuid().optional(),
  })
  .strict();

/** Save the filters as a view, or update one. Kitchen, front of house, hosts and managers; not read-only. */
export async function saveConsoleView(ctx: Ctx, raw: z.input<typeof saveConsoleViewInput>): Promise<ConsoleViewRow> {
  const input = saveConsoleViewInput.parse(raw);
  const staff = requireStaff(ctx, { venueId: input.venueId, minRole: 'kitchen' });
  const clash = await ctx.db
    .selectFrom('console_views')
    .select('id')
    .where('venue_id', '=', input.venueId)
    .where('page', '=', input.page)
    .where((eb) => eb(eb.fn('lower', ['name']), '=', input.name.toLowerCase()))
    .executeTakeFirst();
  if (clash && clash.id !== input.id) throw invalid(`There is already a view called “${input.name}” here. Pick another name, or update that one.`);
  if (input.id) {
    const before = await ctx.db.selectFrom('console_views').select(COLS).where('id', '=', input.id).where('venue_id', '=', input.venueId).where('page', '=', input.page).executeTakeFirst();
    if (!before) throw notFound('That view is not here.');
    const after = await ctx.db
      .updateTable('console_views')
      .set({ name: input.name, filters: json(input.filters) })
      .where('id', '=', before.id)
      .returning(COLS)
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'console.view_updated', entityType: 'console_view', entityId: after.id, venueId: input.venueId, before: view(before), after: view(after) });
    return view(after);
  }
  const count = await ctx.db.selectFrom('console_views').select((eb) => eb.fn.countAll<string>().as('n')).where('venue_id', '=', input.venueId).where('page', '=', input.page).executeTakeFirstOrThrow();
  if (Number(count.n) >= 30) throw invalid('This page already has 30 saved views. Delete one you no longer use first.');
  const row = await ctx.db
    .insertInto('console_views')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      page: input.page,
      name: input.name,
      filters: json(input.filters),
      position: Number(count.n),
      created_by_id: staff?.staffId ?? null,
      created_at: ctx.now(),
    })
    .returning(COLS)
    .executeTakeFirstOrThrow();
  await audit(ctx, { action: 'console.view_saved', entityType: 'console_view', entityId: row.id, venueId: input.venueId, after: view(row) });
  return view(row);
}

export const renameConsoleViewInput = z.object({ id: z.string().uuid(), name: NAME }).strict();

/** Rename one of the venue's own views. A default view is code and cannot be renamed. */
export async function renameConsoleView(ctx: Ctx, raw: z.input<typeof renameConsoleViewInput>): Promise<ConsoleViewRow> {
  const input = renameConsoleViewInput.parse(raw);
  const before = await loadForWrite(ctx, input.id);
  const clash = await ctx.db
    .selectFrom('console_views')
    .select('id')
    .where('venue_id', '=', before.venue_id)
    .where('page', '=', before.page)
    .where((eb) => eb(eb.fn('lower', ['name']), '=', input.name.toLowerCase()))
    .executeTakeFirst();
  if (clash && clash.id !== before.id) throw invalid(`There is already a view called “${input.name}” here.`);
  const after = await ctx.db.updateTable('console_views').set({ name: input.name }).where('id', '=', before.id).returning(COLS).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'console.view_renamed', entityType: 'console_view', entityId: after.id, venueId: after.venue_id, before: { name: before.name }, after: { name: after.name } });
  return view(after);
}

/** Delete one of the venue's own views. A default view is code and cannot be deleted. */
export async function deleteConsoleView(ctx: Ctx, viewId: string): Promise<void> {
  const id = z.string().uuid().parse(viewId);
  const before = await loadForWrite(ctx, id);
  await ctx.db.deleteFrom('console_views').where('id', '=', before.id).execute();
  await audit(ctx, { action: 'console.view_deleted', entityType: 'console_view', entityId: before.id, venueId: before.venue_id, before: view(before) });
}

/** The row, after the role check at its venue. An id from elsewhere is not found. */
async function loadForWrite(ctx: Ctx, id: string): Promise<Row> {
  const row = await ctx.db.selectFrom('console_views').select(COLS).where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('That view is not here.');
  const staff = staffOf(ctx);
  if (staff && !staff.venueRoles[row.venue_id]) throw notFound('That view is not here.');
  requireStaff(ctx, { venueId: row.venue_id, minRole: 'kitchen' });
  return row;
}
