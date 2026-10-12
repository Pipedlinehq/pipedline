import { z } from 'zod';
import { type Ctx, audit, forbidden, json, notFound, requireStaff, staffOf } from '@ros/core';

/**
 * Staff notes on a record (docs/CONSOLE_IA.md section 9, wave 1; pattern 3 of
 * docs/COMMERCE_ADMIN_PATTERNS.md section 3): "Leave a note for the team…" on an order, a
 * booking or a guest, with @mentions of staff at the venue. A note is for the team and never
 * shown to the guest. It is kept against the venue the console was looking at, so one venue's
 * notes are its own even for a guest the whole organisation shares.
 *
 * Who may write: any staff role at the venue except read-only; an assistant acting for such a
 * person writes as that person's assistant (author_kind 'agent') so the timeline can badge it.
 */
export const NOTE_ENTITY_TYPES = ['order', 'booking', 'customer'] as const;
export type NoteEntityType = (typeof NOTE_ENTITY_TYPES)[number];

const ENTITY = z.enum(NOTE_ENTITY_TYPES);
const BODY = z.string().trim().min(1, 'Write something first.').max(2000, 'Keep a note under 2,000 characters.');

export interface StaffNoteView {
  id: string;
  venueId: string;
  entityType: NoteEntityType;
  entityId: string;
  /** Staff-written. Rendered as text, never as markup. */
  body: string;
  /** Staff ids named with @ in the body. */
  mentions: string[];
  /** 'staff' (a person) or 'agent' (a person's assistant, writing for them). */
  authorKind: string;
  authorId: string | null;
  /** The staff member behind the note, for either kind. */
  authorName: string | null;
  createdAt: Date;
}

/** A staff member at a venue who can be @mentioned. */
export interface MentionableStaff {
  id: string;
  name: string;
}

const COLS = ['id', 'venue_id', 'entity_type', 'entity_id', 'body', 'mentions', 'author_kind', 'author_id', 'created_at'] as const;
type Row = { id: string; venue_id: string; entity_type: string; entity_id: string; body: string; mentions: unknown; author_kind: string; author_id: string | null; created_at: Date };

const mentionsOf = (stored: unknown): string[] => (Array.isArray(stored) ? stored.filter((m): m is string => typeof m === 'string') : []);

export const listMentionableStaffInput = z.object({ venueId: z.string().uuid() }).strict();

/** Active staff with a role at the venue, by name, so a note can @mention them. Any staff role at the venue. */
export async function listMentionableStaff(ctx: Ctx, raw: z.input<typeof listMentionableStaffInput>): Promise<MentionableStaff[]> {
  const input = listMentionableStaffInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  return staffAt(ctx, input.venueId);
}

async function staffAt(ctx: Ctx, venueId: string): Promise<MentionableStaff[]> {
  const rows = await ctx.db
    .selectFrom('staff as s')
    .select(['s.id', 's.first_name', 's.last_name', 's.is_owner'])
    .where('s.status', '=', 'active')
    .where((eb) => eb.or([eb('s.is_owner', '=', true), eb.exists(eb.selectFrom('staff_venues as sv').select('sv.staff_id').whereRef('sv.staff_id', '=', 's.id').where('sv.venue_id', '=', venueId))]))
    .orderBy('s.first_name')
    .orderBy('s.last_name')
    .execute();
  return rows.map((r) => ({ id: r.id, name: `${r.first_name} ${r.last_name ?? ''}`.trim() }));
}

/** The staff ids whose names appear after an @ in the body. "@Sam" matches a first name; "@Sam Smith" the whole name. */
export function findMentions(body: string, people: MentionableStaff[]): string[] {
  const lower = body.toLowerCase();
  const out: string[] = [];
  for (const p of people) {
    const full = `@${p.name.toLowerCase()}`;
    const first = `@${p.name.split(' ')[0]!.toLowerCase()}`;
    const at = (needle: string) => {
      let i = lower.indexOf(needle);
      while (i !== -1) {
        const after = lower[i + needle.length];
        if (after === undefined || !/[a-z0-9]/.test(after)) return true;
        i = lower.indexOf(needle, i + 1);
      }
      return false;
    };
    if (at(full) || at(first)) out.push(p.id);
  }
  return out;
}

export const listStaffNotesInput = z.object({ venueId: z.string().uuid(), entityType: ENTITY, entityId: z.string().uuid(), limit: z.number().int().min(1).max(500).default(200) }).strict();

/** The notes on one record at one venue, newest first. Any staff role at the venue. */
export async function listStaffNotes(ctx: Ctx, raw: z.input<typeof listStaffNotesInput>): Promise<StaffNoteView[]> {
  const input = listStaffNotesInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  const rows = await ctx.db
    .selectFrom('staff_notes')
    .select(COLS)
    .where('venue_id', '=', input.venueId)
    .where('entity_type', '=', input.entityType)
    .where('entity_id', '=', input.entityId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(input.limit)
    .execute();
  return withAuthors(ctx, rows);
}

export const addStaffNoteInput = z.object({ venueId: z.string().uuid(), entityType: ENTITY, entityId: z.string().uuid(), body: BODY }).strict();

/** Leave a note for the team on a record. Kitchen, front of house, hosts, managers and owners. */
export async function addStaffNote(ctx: Ctx, raw: z.input<typeof addStaffNoteInput>): Promise<StaffNoteView> {
  const input = addStaffNoteInput.parse(raw);
  const staff = requireStaff(ctx, { venueId: input.venueId, minRole: 'kitchen' });
  if (!staff) throw forbidden('A note is left by a person, or by an assistant acting for one.');
  const people = await staffAt(ctx, input.venueId);
  const mentions = findMentions(input.body, people);
  const row = await ctx.db
    .insertInto('staff_notes')
    .values({
      org_id: ctx.orgId,
      venue_id: input.venueId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      body: input.body,
      mentions: json(mentions),
      author_kind: ctx.principal.kind === 'agent' ? 'agent' : 'staff',
      author_id: staff.staffId,
      created_at: ctx.now(),
    })
    .returning(COLS)
    .executeTakeFirstOrThrow();
  return (await withAuthors(ctx, [row]))[0]!;
}

/** Take a note off the record. Its author, or a manager at the venue. The note is hidden, not erased. */
export async function deleteStaffNote(ctx: Ctx, noteId: string): Promise<void> {
  const id = z.string().uuid().parse(noteId);
  const row = await ctx.db.selectFrom('staff_notes').select(COLS).where('id', '=', id).where('deleted_at', 'is', null).executeTakeFirst();
  if (!row) throw notFound('That note is not here.');
  const staff = staffOf(ctx);
  if (staff && !staff.venueRoles[row.venue_id]) throw notFound('That note is not here.');
  const me = requireStaff(ctx, { venueId: row.venue_id, minRole: 'kitchen' });
  if (me && row.author_id !== me.staffId) requireStaff(ctx, { venueId: row.venue_id, minRole: 'manager' });
  await ctx.db.updateTable('staff_notes').set({ deleted_at: ctx.now() }).where('id', '=', row.id).execute();
  await audit(ctx, { action: 'note.removed', entityType: row.entity_type, entityId: row.entity_id, venueId: row.venue_id, before: { noteId: row.id } });
}

async function withAuthors(ctx: Ctx, rows: Row[]): Promise<StaffNoteView[]> {
  const ids = [...new Set(rows.map((r) => r.author_id).filter((x): x is string => !!x))];
  const people = ids.length ? await ctx.db.selectFrom('staff').select(['id', 'first_name', 'last_name']).where('id', 'in', ids).execute() : [];
  const nameOf = new Map(people.map((p) => [p.id, `${p.first_name} ${p.last_name ?? ''}`.trim()]));
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    entityType: r.entity_type as NoteEntityType,
    entityId: r.entity_id,
    body: r.body,
    mentions: mentionsOf(r.mentions),
    authorKind: r.author_kind,
    authorId: r.author_id,
    authorName: r.author_id ? (nameOf.get(r.author_id) ?? null) : null,
    createdAt: r.created_at,
  }));
}
