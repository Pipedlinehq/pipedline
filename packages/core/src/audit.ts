import { z } from 'zod';
import type { Ctx } from './app';
import { requireOwner } from './authz';
import { actorOf } from './principal';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  venueId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Append to the audit log in the same transaction as the change it describes. */
export async function audit(ctx: Ctx, entry: AuditEntry): Promise<void> {
  const actor = actorOf(ctx.principal);
  await ctx.db
    .insertInto('audit_log')
    .values({
      org_id: ctx.orgId,
      venue_id: entry.venueId ?? null,
      actor_kind: actor.kind,
      actor_id: actor.id,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      ip: ctx.ip ?? null,
      request_id: ctx.requestId,
      occurred_at: ctx.now(),
    })
    .execute();
}

/**
 * The audit log, read back for the owner (docs/THREAT_MODEL.md section 9: append-only and
 * readable by the venue owner; our own support access is recorded there too). Newest first,
 * paged by time. Owner only: it covers every venue and every person in the organisation.
 */
export const listAuditLogInput = z
  .object({
    limit: z.number().int().min(1).max(200).default(50),
    /** occurred_at of the last row of the previous page. */
    before: z.date().optional(),
    action: z.string().trim().min(1).max(100).optional(),
    entityType: z.string().trim().min(1).max(100).optional(),
    venueId: z.string().uuid().optional(),
  })
  .strict();

export interface AuditEntryView {
  id: string;
  venueId: string | null;
  actorKind: string;
  actorId: string | null;
  /** The staff member's name when the actor was a person in this organisation. */
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  occurredAt: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listAuditLog(ctx: Ctx, raw: z.input<typeof listAuditLogInput> = {}): Promise<AuditEntryView[]> {
  const input = listAuditLogInput.parse(raw);
  requireOwner(ctx);
  let q = ctx.db
    .selectFrom('audit_log as a')
    .select(['a.id', 'a.venue_id', 'a.actor_kind', 'a.actor_id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.before', 'a.after', 'a.occurred_at'])
    .where('a.org_id', '=', ctx.orgId)
    .orderBy('a.occurred_at', 'desc')
    .orderBy('a.id', 'desc')
    .limit(input.limit);
  if (input.before) q = q.where('a.occurred_at', '<', input.before);
  if (input.action) q = q.where('a.action', '=', input.action);
  if (input.entityType) q = q.where('a.entity_type', '=', input.entityType);
  if (input.venueId) q = q.where('a.venue_id', '=', input.venueId);
  const rows = await q.execute();
  // actor_id is text (not every actor is a uuid): look staff names up by the ids that are.
  const staffIds = [...new Set(rows.filter((r) => r.actor_kind === 'staff' && r.actor_id && UUID.test(r.actor_id)).map((r) => r.actor_id!))];
  const people = staffIds.length ? await ctx.db.selectFrom('staff').select(['id', 'first_name', 'last_name']).where('id', 'in', staffIds).execute() : [];
  const nameOf = new Map(people.map((p) => [p.id, `${p.first_name} ${p.last_name ?? ''}`.trim()]));
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    actorKind: r.actor_kind,
    actorId: r.actor_id,
    actorName: r.actor_kind === 'staff' && r.actor_id ? (nameOf.get(r.actor_id) ?? null) : null,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    occurredAt: r.occurred_at,
  }));
}

