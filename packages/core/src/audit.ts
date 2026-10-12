import { z } from 'zod';
import type { Ctx } from './app';
import { requireOwner, requireStaff } from './authz';
import { ROLE_RANK, actorOf } from './principal';

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
  let q = baseQuery(ctx).limit(input.limit);
  if (input.before) q = q.where('a.occurred_at', '<', input.before);
  if (input.action) q = q.where('a.action', '=', input.action);
  if (input.entityType) q = q.where('a.entity_type', '=', input.entityType);
  if (input.venueId) q = q.where('a.venue_id', '=', input.venueId);
  return withNames(ctx, await q.execute());
}

/**
 * One record's own history, for the timeline on its page (docs/CONSOLE_IA.md section 9, wave 1):
 * every audit entry about that entity, newest first. Any staff role at the venue the record
 * belongs to may read it; the page has already shown them the record through its own service,
 * which made the real check. Entries are the org's own, so another org's id yields nothing.
 */
export const listEntityAuditInput = z
  .object({
    entityType: z.string().trim().min(1).max(100),
    entityId: z.string().trim().min(1).max(200),
    /** The venue the record belongs to. Entries tagged with another venue are left out. */
    venueId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

export async function listEntityAudit(ctx: Ctx, raw: z.input<typeof listEntityAuditInput>): Promise<AuditEntryView[]> {
  const input = listEntityAuditInput.parse(raw);
  requireStaff(ctx, input.venueId ? { venueId: input.venueId, minRole: 'read_only' } : { minRole: 'read_only' });
  let q = baseQuery(ctx).where('a.entity_type', '=', input.entityType).where('a.entity_id', '=', input.entityId).limit(input.limit);
  if (input.venueId) q = q.where((eb) => eb.or([eb('a.venue_id', '=', input.venueId!), eb('a.venue_id', 'is', null)]));
  return withNames(ctx, await q.execute());
}

/**
 * The activity log (docs/COMMERCE_ADMIN_PATTERNS.md section 1.11; CONSOLE_IA section 9, wave 1):
 * who did what and when, across the organisation, for a manager or owner. An owner sees every
 * entry. A manager sees entries tagged with a venue they manage, plus the organisation-wide ones
 * (an entry with no venue on it: a setting, a team change, an offer), never another venue's.
 */
export const listActivityInput = z
  .object({
    /** Only entries at this venue (and organisation-wide ones). */
    venueId: z.string().uuid().optional(),
    /** actor_kind values to keep: staff, agent, service_key, worker, platform, device, guest, anon. */
    actorKinds: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    from: z.date().optional(),
    to: z.date().optional(),
    limit: z.number().int().min(1).max(500).default(100),
    /** occurred_at of the last row of the previous page. */
    before: z.date().optional(),
  })
  .strict();

export async function listActivity(ctx: Ctx, raw: z.input<typeof listActivityInput> = {}): Promise<AuditEntryView[]> {
  const input = listActivityInput.parse(raw);
  const staff = requireStaff(ctx, input.venueId ? { venueId: input.venueId, minRole: 'manager' } : { minRole: 'manager' });
  let q = baseQuery(ctx).limit(input.limit);
  if (staff && !staff.isOwner) {
    const managed = Object.entries(staff.venueRoles)
      .filter(([, role]) => ROLE_RANK[role] >= ROLE_RANK.manager)
      .map(([id]) => id);
    q = q.where((eb) => eb.or([...(managed.length ? [eb('a.venue_id', 'in', managed)] : []), eb('a.venue_id', 'is', null)]));
  }
  if (input.venueId) q = q.where((eb) => eb.or([eb('a.venue_id', '=', input.venueId!), eb('a.venue_id', 'is', null)]));
  if (input.actorKinds?.length) q = q.where('a.actor_kind', 'in', input.actorKinds);
  if (input.from) q = q.where('a.occurred_at', '>=', input.from);
  if (input.to) q = q.where('a.occurred_at', '<', input.to);
  if (input.before) q = q.where('a.occurred_at', '<', input.before);
  return withNames(ctx, await q.execute());
}

function baseQuery(ctx: Ctx) {
  return ctx.db
    .selectFrom('audit_log as a')
    .select(['a.id', 'a.venue_id', 'a.actor_kind', 'a.actor_id', 'a.action', 'a.entity_type', 'a.entity_id', 'a.before', 'a.after', 'a.occurred_at'])
    .where('a.org_id', '=', ctx.orgId)
    .orderBy('a.occurred_at', 'desc')
    .orderBy('a.id', 'desc');
}

type AuditRow = { id: string; venue_id: string | null; actor_kind: string; actor_id: string | null; action: string; entity_type: string; entity_id: string | null; before: unknown; after: unknown; occurred_at: Date };

/** The rows as views, with the staff member's name where the actor was a person in this organisation. */
async function withNames(ctx: Ctx, rows: AuditRow[]): Promise<AuditEntryView[]> {
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

