import { z } from 'zod';
import { type Ctx, actorOf, audit, conflict, defineEvent, defineModule, invalid, json, notFound, requireStaff, track, visibleVenueIds, keyedRegistry, register } from '@ros/core';

/**
 * One queue for everything a person must say yes to before it happens: a campaign send, a
 * batch of win-back messages, a review reply, an action a hosted agent proposes. Whoever
 * requests an approval registers what to do when it is decided.
 */
export const approvalsModule = defineModule({
  key: 'approvals',
  name: 'Approvals',
  description: 'The queue of things waiting for a person to approve or reject.',
  spine: true,
  dependsOn: [],
  tables: ['approvals'],
  configSchema: z.object({}),
  configVersion: 1,
  defaultConfig: {},
});

export const approvalRequested = defineEvent({
  name: 'approval.requested',
  module: 'approvals',
  description: 'Something is waiting for a person to approve it.',
  properties: z.object({ approval_id: z.string(), kind: z.string() }),
});

export const approvalDecided = defineEvent({
  name: 'approval.decided',
  module: 'approvals',
  description: 'A person approved or rejected a waiting item.',
  properties: z.object({ approval_id: z.string(), kind: z.string(), decision: z.enum(['approved', 'rejected', 'expired']) }),
});

export interface Approval {
  id: string;
  venueId: string | null;
  kind: string;
  subjectType: string;
  subjectId: string;
  summary: string;
  payload: unknown;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedByKind: string;
  decidedByStaffId: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

type DecisionHandler = (ctx: Ctx, approval: Approval, decision: 'approved' | 'rejected' | 'expired') => Promise<void>;
const handlers = keyedRegistry<DecisionHandler>('approvals.handlers');

/** Register what happens when an approval of this kind is decided. Runs in the deciding transaction. */
export function onApprovalDecided(kind: string, handler: DecisionHandler): void {
  register(handlers, kind, handler, 'Approval handler');
}

const COLS = [
  'id',
  'venue_id',
  'kind',
  'subject_type',
  'subject_id',
  'summary',
  'payload',
  'status',
  'requested_by_kind',
  'decided_by_staff_id',
  'decided_at',
  'decision_note',
  'expires_at',
  'created_at',
] as const;

const view = (r: {
  id: string;
  venue_id: string | null;
  kind: string;
  subject_type: string;
  subject_id: string;
  summary: string;
  payload: unknown;
  status: Approval['status'];
  requested_by_kind: string;
  decided_by_staff_id: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  expires_at: Date | null;
  created_at: Date;
}): Approval => ({
  id: r.id,
  venueId: r.venue_id,
  kind: r.kind,
  subjectType: r.subject_type,
  subjectId: r.subject_id,
  summary: r.summary,
  payload: r.payload,
  status: r.status,
  requestedByKind: r.requested_by_kind,
  decidedByStaffId: r.decided_by_staff_id,
  decidedAt: r.decided_at,
  decisionNote: r.decision_note,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export interface RequestApprovalInput {
  kind: string;
  subjectType: string;
  subjectId: string;
  /** Plain words: exactly what will happen if this is approved. */
  summary: string;
  payload?: unknown;
  venueId?: string | null;
  expiresAt?: Date | null;
}

/** Queue something for a person's yes. One pending approval per subject: asking twice returns the first. */
export async function requestApproval(ctx: Ctx, input: RequestApprovalInput): Promise<Approval> {
  if (!handlers.has(input.kind)) throw new Error(`No approval handler is registered for ${input.kind}`);
  if (ctx.principal.kind === 'anon' || ctx.principal.kind === 'guest' || ctx.principal.kind === 'device') {
    throw invalid('Only staff, their assistants and scheduled work can ask for an approval.');
  }
  const pending = await ctx.db
    .selectFrom('approvals')
    .select(COLS)
    .where('kind', '=', input.kind)
    .where('subject_type', '=', input.subjectType)
    .where('subject_id', '=', input.subjectId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (pending) return view(pending);
  const actor = actorOf(ctx.principal);
  const row = await ctx.db
    .insertInto('approvals')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId ?? null,
      kind: input.kind,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      summary: input.summary,
      payload: json(input.payload ?? {}),
      requested_by_kind: actor.kind,
      requested_by_id: actor.id,
      expires_at: input.expiresAt ?? null,
      created_at: ctx.now(),
    })
    .returning(COLS)
    .executeTakeFirstOrThrow();
  await track(ctx, approvalRequested, { approval_id: row.id, kind: input.kind }, { venueId: input.venueId ?? null });
  return view(row);
}

export async function listApprovals(ctx: Ctx, filter: { status?: Approval['status']; kind?: string; venueId?: string } = {}): Promise<Approval[]> {
  requireStaff(ctx, { venueId: filter.venueId, minRole: 'manager' });
  const visible = visibleVenueIds(ctx);
  let q = ctx.db.selectFrom('approvals').select(COLS).orderBy('created_at', 'desc').limit(200);
  if (filter.status) q = q.where('status', '=', filter.status);
  if (filter.kind) q = q.where('kind', '=', filter.kind);
  if (filter.venueId) q = q.where('venue_id', '=', filter.venueId);
  else if (visible) q = q.where((eb) => eb.or([eb('venue_id', 'is', null), ...(visible.length ? [eb('venue_id', 'in', visible)] : [])]));
  return (await q.execute()).map(view);
}

export async function getApproval(ctx: Ctx, id: string): Promise<Approval> {
  const row = await ctx.db.selectFrom('approvals').select(COLS).where('id', '=', id).executeTakeFirst();
  if (!row) throw notFound('Approval not found');
  requireStaff(ctx, { venueId: row.venue_id ?? undefined, minRole: 'manager' });
  return view(row);
}

/**
 * A manager approves or rejects. The decision and its consequence happen in one transaction:
 * if the registered handler fails, the approval stays pending.
 */
export async function decideApproval(ctx: Ctx, id: string, input: { decision: 'approved' | 'rejected'; note?: string | null }): Promise<Approval> {
  const row = await ctx.db.selectFrom('approvals').select(COLS).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!row) throw notFound('Approval not found');
  const staff = requireStaff(ctx, { venueId: row.venue_id ?? undefined, minRole: 'manager' });
  // The person deciding must be a person: an assistant can queue an approval, never grant one.
  if (ctx.principal.kind === 'agent') throw invalid('An approval is decided by a person in the console.');
  if (row.status !== 'pending') throw conflict(`That was already ${row.status}.`);
  if (row.expires_at && row.expires_at <= ctx.now()) throw conflict('That request has expired.');

  const updated = await ctx.db
    .updateTable('approvals')
    .set({ status: input.decision, decided_by_staff_id: staff?.staffId ?? null, decided_at: ctx.now(), decision_note: input.note ?? null })
    .where('id', '=', id)
    .returning(COLS)
    .executeTakeFirstOrThrow();
  const approval = view(updated);
  const handler = handlers.get(row.kind);
  if (handler) await handler(ctx, approval, input.decision);
  await audit(ctx, { action: `approval.${input.decision}`, entityType: 'approval', entityId: id, venueId: row.venue_id, after: { kind: row.kind, subject: `${row.subject_type}:${row.subject_id}` } });
  await track(ctx, approvalDecided, { approval_id: id, kind: row.kind, decision: input.decision }, { venueId: row.venue_id });
  return approval;
}

/** Expire pending approvals past their deadline. Internal; called by a scheduled job per org. */
export async function expireApprovals(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .selectFrom('approvals')
    .select(COLS)
    .where('status', '=', 'pending')
    .where('expires_at', '<=', ctx.now())
    .forUpdate()
    .execute();
  for (const row of due) {
    await ctx.db.updateTable('approvals').set({ status: 'expired', decided_at: ctx.now() }).where('id', '=', row.id).execute();
    const handler = handlers.get(row.kind);
    if (handler) await handler(ctx, { ...view(row), status: 'expired' }, 'expired');
    await track(ctx, approvalDecided, { approval_id: row.id, kind: row.kind, decision: 'expired' }, { venueId: row.venue_id });
  }
  return due.length;
}
