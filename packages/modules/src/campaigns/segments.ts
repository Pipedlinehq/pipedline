import { z } from 'zod';
import type { RawBuilder } from 'kysely';
import { type Ctx, audit, conflict, invalid, isUniqueViolation, json, localDate, notFound, requireStaff, sql } from '@ros/core';
import { getOrg } from '../tenancy/orgs';
import { assertCampaignsOnSomewhere, primaryVenueId } from './settings';

/**
 * Segments: a declarative rule tree over what the spine knows about a guest, never SQL from a
 * client. The tree is validated with zod (strict objects, a fixed set of fields, bounded depth
 * and size) and compiled here to parameterised SQL: field names come from this file's own
 * table, and every value a person typed is a bound parameter.
 *
 * Fields read the customer record, the analytics customer snapshot (fact_customer: order
 * count, spend, first and last order, RFM scores and segment, favourite channel and venue), the
 * guest's consents, and the event stream (loyalty membership).
 */

export const RFM_SEGMENTS = ['new', 'one_timer', 'repeater', 'frequent', 'loyal', 'at_risk', 'lapsed'] as const;
const CHANNELS = ['dine-in', 'pickup', 'delivery', 'catering', 'retail'] as const;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30.');
const int = (max: number) => z.number().int().min(0).max(max);

const range = <K extends string>(fields: readonly [K, ...K[]], max: number) =>
  z
    .strictObject({ field: z.enum(fields), min: int(max).optional(), max: int(max).optional() })
    .refine((r) => r.min !== undefined || r.max !== undefined, { message: 'Give a minimum, a maximum or both.' });

const leaf = z.union([
  z.strictObject({ field: z.literal('rfm_segment'), in: z.array(z.enum(RFM_SEGMENTS)).min(1).max(RFM_SEGMENTS.length) }),
  z.strictObject({ field: z.enum(['r_score', 'f_score', 'm_score']), in: z.array(z.number().int().min(1).max(5)).min(1).max(5) }),
  range(['recency_days', 'days_since_first_order'] as const, 36_500),
  range(['orders'] as const, 100_000),
  range(['spend_cents'] as const, 1_000_000_000),
  z
    .strictObject({ field: z.enum(['first_order_date', 'last_order_date']), after: DATE.optional(), before: DATE.optional() })
    .refine((r) => r.after || r.before, { message: 'Give a date to compare with.' }),
  z.strictObject({ field: z.literal('acquisition_source'), in: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/, 'Use a source such as organic, criota, meta or walk-in.')).min(1).max(20) }),
  z.strictObject({ field: z.enum(['acquisition_creator', 'acquisition_campaign']), in: z.array(z.string().trim().min(1).max(100)).min(1).max(50) }),
  z.strictObject({ field: z.literal('favourite_channel'), in: z.array(z.enum(CHANNELS)).min(1).max(CHANNELS.length) }),
  z.strictObject({ field: z.enum(['favourite_venue', 'home_venue']), in: z.array(z.string().uuid()).min(1).max(50) }),
  z.strictObject({ field: z.literal('consent'), purpose: z.enum(['marketing_email', 'marketing_sms']), granted: z.boolean() }),
  z.strictObject({ field: z.literal('loyalty_member'), is: z.boolean() }),
  z.strictObject({ field: z.literal('birthday_month'), in: z.array(z.number().int().min(1).max(12)).min(1).max(12) }),
]);
export type SegmentLeaf = z.infer<typeof leaf>;
export type SegmentRule = SegmentLeaf | { all: SegmentRule[] } | { any: SegmentRule[] } | { not: SegmentRule };

export const segmentRule: z.ZodType<SegmentRule> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(segmentRule).min(1).max(20) }),
    z.strictObject({ any: z.array(segmentRule).min(1).max(20) }),
    z.strictObject({ not: segmentRule }),
    leaf,
  ]),
);

const MAX_DEPTH = 5;
const MAX_LEAVES = 40;

/** Validate a rule tree: its shape, and that it is not too deep or too large to run. */
export function parseSegmentRule(raw: unknown): SegmentRule {
  const parsed = segmentRule.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That segment rule is not valid.', { issues: parsed.error.issues });
  let leaves = 0;
  const walk = (r: SegmentRule, depth: number): void => {
    if (depth > MAX_DEPTH) throw invalid(`A segment rule can nest at most ${MAX_DEPTH} deep.`);
    if ('all' in r) r.all.forEach((x) => walk(x, depth + 1));
    else if ('any' in r) r.any.forEach((x) => walk(x, depth + 1));
    else if ('not' in r) walk(r.not, depth + 1);
    else if (++leaves > MAX_LEAVES) throw invalid(`A segment rule can have at most ${MAX_LEAVES} conditions.`);
  };
  walk(parsed.data, 1);
  return parsed.data;
}

export interface CompileFrame {
  /** Venue-local "today" (the org's zone), for day counts. */
  today: string;
  /** The org's first venue: the home of a guest whose history names none. */
  primaryVenueId: string;
}

/** A guest's home venue: where they buy most, else where they were first seen, else the org's first venue. */
export const homeVenueSql = (frame: CompileFrame): RawBuilder<string> => sql<string>`coalesce(f.favourite_venue_id, c.first_seen_venue_id, ${frame.primaryVenueId}::uuid)`;

const between = (expr: RawBuilder<unknown>, min: number | undefined, max: number | undefined): RawBuilder<boolean> => {
  const parts: RawBuilder<unknown>[] = [];
  if (min !== undefined) parts.push(sql`${expr} >= ${min}`);
  if (max !== undefined) parts.push(sql`${expr} <= ${max}`);
  return sql<boolean>`(${sql.join(parts, sql` and `)})`;
};

function compileLeaf(r: SegmentLeaf, frame: CompileFrame): RawBuilder<boolean> {
  switch (r.field) {
    case 'rfm_segment':
      return sql<boolean>`(f.segment = any(${r.in}::text[]))`;
    case 'r_score':
      return sql<boolean>`(f.r_score = any(${r.in}::int[]))`;
    case 'f_score':
      return sql<boolean>`(f.f_score = any(${r.in}::int[]))`;
    case 'm_score':
      return sql<boolean>`(f.m_score = any(${r.in}::int[]))`;
    case 'recency_days':
      return between(sql`(${frame.today}::date - f.last_order_day)`, r.min, r.max);
    case 'days_since_first_order':
      return between(sql`(${frame.today}::date - f.first_order_day)`, r.min, r.max);
    case 'orders':
      return between(sql`coalesce(f.orders, 0)`, r.min, r.max);
    case 'spend_cents':
      return between(sql`coalesce(f.spend_cents, 0)`, r.min, r.max);
    case 'first_order_date':
    case 'last_order_date': {
      const col = r.field === 'first_order_date' ? sql`f.first_order_day` : sql`f.last_order_day`;
      const parts: RawBuilder<unknown>[] = [];
      if (r.after) parts.push(sql`${col} > ${r.after}::date`);
      if (r.before) parts.push(sql`${col} < ${r.before}::date`);
      return sql<boolean>`(${sql.join(parts, sql` and `)})`;
    }
    case 'acquisition_source':
      return sql<boolean>`(c.acquisition_source = any(${r.in}::text[]))`;
    case 'acquisition_creator':
      return sql<boolean>`(c.acquisition_creator_id = any(${r.in}::text[]))`;
    case 'acquisition_campaign':
      return sql<boolean>`(c.acquisition_campaign_id = any(${r.in}::text[]))`;
    case 'favourite_channel':
      return sql<boolean>`(f.favourite_channel::text = any(${r.in}::text[]))`;
    case 'favourite_venue':
      return sql<boolean>`(f.favourite_venue_id = any(${r.in}::uuid[]))`;
    case 'home_venue':
      return sql<boolean>`(${homeVenueSql(frame)} = any(${r.in}::uuid[]))`;
    case 'consent': {
      const held = sql`exists (select 1 from consents k where k.org_id = c.org_id and k.customer_id = c.id and k.purpose = ${r.purpose}::consent_purpose and k.status = 'granted')`;
      return r.granted ? sql<boolean>`${held}` : sql<boolean>`(not ${held})`;
    }
    case 'loyalty_member': {
      const member = sql`exists (select 1 from events e where e.org_id = c.org_id and e.customer_id = c.id and e.name = 'loyalty.enrolled')`;
      return r.is ? sql<boolean>`${member}` : sql<boolean>`(not ${member})`;
    }
    case 'birthday_month':
      return sql<boolean>`(extract(month from c.birthday)::int = any(${r.in}::int[]))`;
  }
}

/**
 * Compile a validated rule tree to a boolean SQL expression over `customers c left join
 * fact_customer f`. A condition on a field the guest has no value for (no orders yet, no
 * birthday) is false, so its negation is true: "not seen in the last 30 days" includes a guest
 * who has never ordered.
 */
export function compileSegmentRule(rule: SegmentRule, frame: CompileFrame): RawBuilder<boolean> {
  if ('all' in rule) return sql<boolean>`(${sql.join(rule.all.map((r) => compileSegmentRule(r, frame)), sql` and `)})`;
  if ('any' in rule) return sql<boolean>`(${sql.join(rule.any.map((r) => compileSegmentRule(r, frame)), sql` or `)})`;
  if ('not' in rule) return sql<boolean>`(not coalesce(${compileSegmentRule(rule.not, frame)}, false))`;
  return sql<boolean>`coalesce(${compileLeaf(rule, frame)}, false)`;
}

/** SQL: this guest can be sent marketing on the channel: an address, the consent, and no suppression. */
export function reachableSql(channel: 'email' | 'sms'): RawBuilder<boolean> {
  const address = channel === 'email' ? sql`c.primary_email` : sql`c.primary_phone`;
  const purpose = channel === 'email' ? 'marketing_email' : 'marketing_sms';
  return sql<boolean>`(${address} is not null
    and exists (select 1 from consents k where k.org_id = c.org_id and k.customer_id = c.id and k.purpose = ${purpose}::consent_purpose and k.status = 'granted')
    and not exists (select 1 from suppressions s where s.org_id = c.org_id and s.channel = ${channel}::msg_channel and s.value = ${address}))`;
}

export async function compileFrame(ctx: Ctx): Promise<CompileFrame> {
  const org = await getOrg(ctx);
  return { today: localDate(ctx.now(), org.timezone), primaryVenueId: await primaryVenueId(ctx) };
}

export interface AudienceSpec {
  rule: SegmentRule;
  /** Only guests whose home venue is this one. */
  venueId?: string | null;
}

/** The FROM and WHERE every audience query shares. */
export function audienceWhere(ctx: Ctx, spec: AudienceSpec, frame: CompileFrame): RawBuilder<boolean> {
  const parts: RawBuilder<unknown>[] = [sql`c.org_id = ${ctx.orgId}`, sql`c.status = 'active'`, compileSegmentRule(spec.rule, frame)];
  if (spec.venueId) parts.push(sql`${homeVenueSql(frame)} = ${spec.venueId}::uuid`);
  return sql<boolean>`${sql.join(parts, sql` and `)}`;
}

export interface SegmentPreview {
  /** Guests matching the rule. */
  count: number;
  email: { reachable: number; share: number };
  sms: { reachable: number; share: number };
}

/** Counts for an audience: never a list of guests. */
export async function countAudience(ctx: Ctx, spec: AudienceSpec): Promise<SegmentPreview> {
  const frame = await compileFrame(ctx);
  const r = await sql<{ n: number; email: number; sms: number }>`
    select count(*)::int as n,
           count(*) filter (where ${reachableSql('email')})::int as email,
           count(*) filter (where ${reachableSql('sms')})::int as sms
    from customers c
    left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
    where ${audienceWhere(ctx, spec, frame)}`.execute(ctx.db);
  const row = r.rows[0]!;
  const share = (x: number) => (row.n > 0 ? Math.round((x / row.n) * 1000) / 1000 : 0);
  return { count: row.n, email: { reachable: row.email, share: share(row.email) }, sms: { reachable: row.sms, share: share(row.sms) } };
}

// ── Stored segments ───────────────────────────────────────────────────────

export interface SegmentView {
  id: string;
  name: string;
  description: string | null;
  definition: SegmentRule;
  isSystem: boolean;
  updatedAt: Date;
}

const SEG_COLS = ['id', 'name', 'description', 'definition', 'is_system', 'updated_at'] as const;
const segView = (r: { id: string; name: string; description: string | null; definition: unknown; is_system: boolean; updated_at: Date }): SegmentView => ({
  id: r.id,
  name: r.name,
  description: r.description,
  definition: r.definition as SegmentRule,
  isSystem: r.is_system,
  updatedAt: r.updated_at,
});

/**
 * The segments every org starts with. Thresholds follow the analytics settings' segments where
 * the snapshot already names the group; "lapsed 60+" and "regulars" are rules of their own.
 */
export const SYSTEM_SEGMENTS: Array<{ name: string; description: string; definition: SegmentRule }> = [
  { name: 'New', description: 'One order so far, recently.', definition: { field: 'rfm_segment', in: ['new'] } },
  { name: 'One-timers', description: 'One order, a while ago, and never back.', definition: { field: 'rfm_segment', in: ['one_timer'] } },
  { name: 'Lapsed 60+', description: 'Not seen for 60 days or more.', definition: { field: 'recency_days', min: 60 } },
  { name: 'At risk', description: 'Came back before, but has gone quiet.', definition: { field: 'rfm_segment', in: ['at_risk'] } },
  { name: 'Regulars', description: 'Three or more orders, seen in the last 60 days.', definition: { all: [{ field: 'orders', min: 3 }, { field: 'recency_days', max: 60 }] } },
  { name: 'VIP', description: 'Five or more orders, or the top fifth by spend with at least two.', definition: { any: [{ field: 'orders', min: 5 }, { all: [{ field: 'm_score', in: [5] }, { field: 'orders', min: 2 }] }] } },
];

/** Create the system segments an org is missing. Idempotent; internal callers and the console's first load. */
export async function ensureSystemSegments(ctx: Ctx): Promise<void> {
  for (const s of SYSTEM_SEGMENTS) {
    await ctx.db
      .insertInto('segments')
      .values({ org_id: ctx.orgId, name: s.name, description: s.description, definition: json(s.definition), is_system: true, created_at: ctx.now(), updated_at: ctx.now() })
      .onConflict((oc) => oc.columns(['org_id', 'name']).doNothing())
      .execute();
  }
}

export async function listSegments(ctx: Ctx): Promise<SegmentView[]> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertCampaignsOnSomewhere(ctx);
  const rows = await ctx.db.selectFrom('segments').select(SEG_COLS).orderBy('is_system', 'desc').orderBy('name').execute();
  return rows.map(segView);
}

/** Internal: a segment by id, or not-found. */
export async function loadSegment(ctx: Ctx, id: string): Promise<SegmentView> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Segment not found');
  const r = await ctx.db.selectFrom('segments').select(SEG_COLS).where('id', '=', parsed.data).executeTakeFirst();
  if (!r) throw notFound('Segment not found');
  return segView(r);
}

export async function getSegment(ctx: Ctx, id: string): Promise<SegmentView> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertCampaignsOnSomewhere(ctx);
  return loadSegment(ctx, id);
}

export const saveSegmentInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullish(),
  definition: z.unknown(),
});

/** Create or change a segment. A manager. The system segments cannot be changed, only copied. */
export async function saveSegment(ctx: Ctx, raw: z.input<typeof saveSegmentInput>): Promise<SegmentView> {
  const parsed = saveSegmentInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That segment is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  const definition = parseSegmentRule(input.definition);
  try {
    if (input.id) {
      const before = await loadSegment(ctx, input.id);
      if (before.isSystem) throw invalid('A built-in segment cannot be changed. Save a copy under a new name.');
      const r = await ctx.db
        .updateTable('segments')
        .set({ name: input.name, description: input.description ?? null, definition: json(definition), updated_at: ctx.now() })
        .where('id', '=', input.id)
        .returning(SEG_COLS)
        .executeTakeFirstOrThrow();
      await audit(ctx, { action: 'segment.updated', entityType: 'segment', entityId: r.id, before: { name: before.name, definition: before.definition }, after: { name: r.name, definition } });
      return segView(r);
    }
    const r = await ctx.db
      .insertInto('segments')
      .values({ org_id: ctx.orgId, name: input.name, description: input.description ?? null, definition: json(definition), is_system: false, created_at: ctx.now(), updated_at: ctx.now() })
      .returning(SEG_COLS)
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'segment.created', entityType: 'segment', entityId: r.id, after: { name: r.name, definition } });
    return segView(r);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A segment with that name already exists.');
    throw e;
  }
}

export async function deleteSegment(ctx: Ctx, id: string): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  const s = await loadSegment(ctx, id);
  if (s.isSystem) throw invalid('A built-in segment cannot be deleted.');
  const used = await ctx.db.selectFrom('campaigns').select('id').where('segment_id', '=', s.id).limit(1).executeTakeFirst();
  if (used) throw conflict('A campaign uses this segment, so it is kept for the record.');
  await ctx.db.deleteFrom('segments').where('id', '=', s.id).execute();
  await audit(ctx, { action: 'segment.deleted', entityType: 'segment', entityId: s.id, before: { name: s.name, definition: s.definition } });
}

export const previewSegmentInput = z.object({
  /** A stored segment, or a rule tree not yet saved. */
  segmentId: z.string().uuid().optional(),
  definition: z.unknown().optional(),
  /** Only guests whose home venue is this one. */
  venueId: z.string().uuid().optional(),
});

/**
 * How many guests a segment holds, and what share can be reached by email and by SMS
 * (consented and not suppressed). Counts only: this never returns who they are.
 */
export async function previewSegment(ctx: Ctx, raw: z.input<typeof previewSegmentInput>): Promise<SegmentPreview> {
  const parsed = previewSegmentInput.safeParse(raw);
  if (!parsed.success) throw invalid('That preview is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const on = await assertCampaignsOnSomewhere(ctx);
  if (input.venueId && !on.includes(input.venueId)) throw notFound('Venue not found');
  let rule: SegmentRule;
  if (input.segmentId) rule = (await loadSegment(ctx, input.segmentId)).definition;
  else if (input.definition !== undefined) rule = parseSegmentRule(input.definition);
  else throw invalid('Choose a segment or give a rule.');
  return countAudience(ctx, { rule, venueId: input.venueId ?? null });
}
