import { z } from 'zod';
import { type Ctx, addMinutes, assertModule, audit, defineJob, defineSchedule, forbidden, getModule, isInternal, noPayload, notFound, requireStaff, track } from '@ros/core';
import { tableSessionTotals } from '../ordering/orders';
import { qrModule, tableSessionClosed, tableSessionOpened } from './module';

const WORKER = { kind: 'worker' as const, job: 'qr' };

/**
 * Table sessions. A table orders more than once; each round is its own paid order, and the
 * session links them so the venue sees the table's total (docs/modules/qr.md section 5). A
 * session opens on a table's first order and closes after a configurable idle period.
 */

const minutesOpen = (s: { opened_at: Date }, until: Date) => Math.max(0, Math.round((until.getTime() - s.opened_at.getTime()) / 60_000));

/**
 * The open session for a table, opened if there is none. Called by ordering, in the transaction
 * that creates a table order. A session left idle past the venue's limit is closed first: the
 * people at the table now are not the people who ordered three hours ago.
 */
export async function openTableSession(ctx: Ctx, args: { venueId: string; qrCodeId: string; tableLabel: string }): Promise<string> {
  const { config } = await getModule(ctx, args.venueId, qrModule);
  const now = ctx.now();
  const open = await ctx.db
    .selectFrom('table_sessions')
    .select(['id', 'opened_at', 'last_activity_at', 'table_label'])
    .where('venue_id', '=', args.venueId)
    .where('table_label', '=', args.tableLabel)
    .where('closed_at', 'is', null)
    .orderBy('opened_at', 'desc')
    .forUpdate()
    .execute();

  let current: string | null = null;
  for (const s of open) {
    if (!current && s.last_activity_at > addMinutes(now, -config.session_idle_minutes)) {
      current = s.id;
      await ctx.db.updateTable('table_sessions').set({ last_activity_at: now }).where('id', '=', s.id).execute();
    } else {
      await ctx.db.updateTable('table_sessions').set({ closed_at: now }).where('id', '=', s.id).execute();
      await track(ctx, tableSessionClosed, { table_session_id: s.id, table_label: s.table_label, reason: 'idle', minutes_open: minutesOpen(s, now) }, { venueId: args.venueId });
    }
  }
  if (current) return current;

  const created = await ctx.db
    .insertInto('table_sessions')
    .values({ org_id: ctx.orgId, venue_id: args.venueId, qr_code_id: args.qrCodeId, table_label: args.tableLabel, opened_at: now, last_activity_at: now })
    .returning('id')
    .executeTakeFirstOrThrow();
  await track(ctx, tableSessionOpened, { table_session_id: created.id, table_label: args.tableLabel }, { venueId: args.venueId });
  return created.id;
}

export interface TableSessionView {
  id: string;
  venueId: string;
  tableLabel: string;
  covers: number | null;
  openedAt: Date;
  lastActivityAt: Date;
  closedAt: Date | null;
  /** Paid rounds and what they came to. */
  orders: number;
  totalCents: number;
}

export const listTableSessionsInput = z.object({
  venueId: z.string().uuid(),
  /** True (the default) = tables ordering now. False = closed sessions, newest first. */
  open: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(100),
});

/** The tables ordering right now, each with its rounds and total. Staff at the venue. */
export async function listTableSessions(ctx: Ctx, raw: z.input<typeof listTableSessionsInput>): Promise<TableSessionView[]> {
  const input = listTableSessionsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  await assertModule(ctx, input.venueId, qrModule);
  let q = ctx.db
    .selectFrom('table_sessions')
    .select(['id', 'venue_id', 'table_label', 'covers', 'opened_at', 'last_activity_at', 'closed_at'])
    .where('venue_id', '=', input.venueId)
    .orderBy('opened_at', 'desc')
    .limit(input.limit);
  q = input.open ? q.where('closed_at', 'is', null) : q.where('closed_at', 'is not', null);
  const rows = await q.execute();
  const totals = await tableSessionTotals(ctx, rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    tableLabel: r.table_label,
    covers: r.covers,
    openedAt: r.opened_at,
    lastActivityAt: r.last_activity_at,
    closedAt: r.closed_at,
    orders: totals.get(r.id)?.orders ?? 0,
    totalCents: totals.get(r.id)?.totalCents ?? 0,
  }));
}

export const closeTableSessionInput = z.object({ sessionId: z.string().uuid(), covers: z.number().int().min(1).max(200).optional() });

/** Staff close a table when the guests leave, so the next party starts a fresh session. */
export async function closeTableSession(ctx: Ctx, raw: z.input<typeof closeTableSessionInput>): Promise<void> {
  const input = closeTableSessionInput.parse(raw);
  const s = await ctx.db.selectFrom('table_sessions').select(['id', 'venue_id', 'table_label', 'opened_at', 'closed_at']).where('id', '=', input.sessionId).forUpdate().executeTakeFirst();
  if (!s) throw notFound('Table session not found');
  requireStaff(ctx, { venueId: s.venue_id, minRole: 'kitchen' });
  await assertModule(ctx, s.venue_id, qrModule);
  if (s.closed_at) return;
  const now = ctx.now();
  await ctx.db
    .updateTable('table_sessions')
    .set({ closed_at: now, ...(input.covers ? { covers: input.covers } : {}) })
    .where('id', '=', s.id)
    .execute();
  await track(ctx, tableSessionClosed, { table_session_id: s.id, table_label: s.table_label, reason: 'staff', minutes_open: minutesOpen(s, now) }, { venueId: s.venue_id });
  await audit(ctx, { action: 'qr.table_session_closed', entityType: 'table_session', entityId: s.id, venueId: s.venue_id, after: { covers: input.covers ?? null } });
}

/** Close every session in the org that has sat idle past its venue's limit. The scheduler's job: internal callers only. */
export async function closeIdleTableSessions(ctx: Ctx): Promise<number> {
  if (!isInternal(ctx)) throw forbidden('Idle tables are closed by the platform.');
  const now = ctx.now();
  const open = await ctx.db.selectFrom('table_sessions').select(['id', 'venue_id', 'table_label', 'opened_at', 'last_activity_at']).where('closed_at', 'is', null).execute();
  const idleFor = new Map<string, number>();
  let closed = 0;
  for (const s of open) {
    if (!idleFor.has(s.venue_id)) idleFor.set(s.venue_id, (await getModule(ctx, s.venue_id, qrModule)).config.session_idle_minutes);
    if (s.last_activity_at > addMinutes(now, -idleFor.get(s.venue_id)!)) continue;
    await ctx.db.updateTable('table_sessions').set({ closed_at: now }).where('id', '=', s.id).where('closed_at', 'is', null).execute();
    await track(ctx, tableSessionClosed, { table_session_id: s.id, table_label: s.table_label, reason: 'idle', minutes_open: minutesOpen(s, now) }, { venueId: s.venue_id });
    closed++;
  }
  return closed;
}

export const closeIdleSessionsJob = defineJob({
  kind: 'qr.close_idle_sessions',
  schema: noPayload,
  async handler(app, job) {
    if (!job.orgId) throw new Error('qr.close_idle_sessions needs an org');
    await app.tenant(job.orgId, WORKER, (ctx) => closeIdleTableSessions(ctx));
  },
});

export const closeIdleSessionsSchedule = defineSchedule({
  key: 'qr.close_idle_sessions',
  everyMinutes: 10,
  scope: 'org',
  job: closeIdleSessionsJob,
  payload: () => ({}),
  // Platform scheduler: asked outside any tenant, only "does this org use QR at all".
  appliesTo: async (app, orgId) =>
    !!(await app.db.selectFrom('venue_modules').select('venue_id').where('org_id', '=', orgId).where('module_key', '=', qrModule.key).where('enabled', '=', true).executeTakeFirst()),
});
