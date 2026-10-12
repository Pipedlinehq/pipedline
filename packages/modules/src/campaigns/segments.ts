import { z } from 'zod';
import type { RawBuilder } from 'kysely';
import { type Ctx, audit, conflict, invalid, isUniqueViolation, json, localDate, notFound, requireStaff, sql } from '@ros/core';
import { type ListNode, compileListQuery, listText, listWords, parseListQuery } from '../identity/lists';
import { getOrg } from '../tenancy/orgs';
import { assertCampaignsOnSomewhere, primaryVenueId } from './settings';

/**
 * Segments, which the console calls guest lists: a rule over what the spine knows about a guest,
 * never SQL from a client. A rule is one of two things:
 *
 *   - `{ query: "last visit more than 60 days ago and said yes to email" }`: the plain query
 *     language (docs/CONSOLE_IA.md section 9, pattern 5), parsed and compiled by the identity
 *     spine (identity/list-grammar.ts, identity/lists.ts). This is what the console builds and
 *     what the default lists use. It reads live facts: sales, consents, the event stream.
 *   - the older declarative tree (`all` / `any` / `not` over fixed leaves), still valid, compiled
 *     here. Its leaves read the customer record, the analytics customer snapshot (fact_customer:
 *     RFM scores, favourite channel and venue), consents and the event stream.
 *
 * Either way the shape is validated with zod and every value a person typed is a bound parameter.
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
/** A guest list written in the plain query language. */
export type SegmentQuery = { query: string };
export type SegmentRule = SegmentQuery | SegmentLeaf | { all: SegmentRule[] } | { any: SegmentRule[] } | { not: SegmentRule };

const queryRule = z.strictObject({ query: z.string().trim().min(1).max(600) });

export const segmentRule: z.ZodType<SegmentRule> = z.lazy(() =>
  z.union([
    queryRule,
    z.strictObject({ all: z.array(segmentRule).min(1).max(20) }),
    z.strictObject({ any: z.array(segmentRule).min(1).max(20) }),
    z.strictObject({ not: segmentRule }),
    leaf,
  ]),
);

const MAX_DEPTH = 5;
const MAX_LEAVES = 40;

export const isQueryRule = (r: SegmentRule): r is SegmentQuery => 'query' in r;

/**
 * Validate a rule: its shape, and that it is not too deep or too large to run. A query rule is
 * parsed by the grammar (which refuses more than ten conditions) and stored in its canonical
 * wording, so the same list always reads the same way.
 */
export function parseSegmentRule(raw: unknown): SegmentRule {
  const parsed = segmentRule.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That segment rule is not valid.', { issues: parsed.error.issues });
  if (isQueryRule(parsed.data)) return { query: listText(parseListQuery(parsed.data.query)) };
  let leaves = 0;
  const walk = (r: SegmentRule, depth: number): void => {
    if (depth > MAX_DEPTH) throw invalid(`A segment rule can nest at most ${MAX_DEPTH} deep.`);
    if (isQueryRule(r)) throw invalid('A plain-words rule stands on its own; it cannot sit inside a condition tree.');
    if ('all' in r) r.all.forEach((x) => walk(x, depth + 1));
    else if ('any' in r) r.any.forEach((x) => walk(x, depth + 1));
    else if ('not' in r) walk(r.not, depth + 1);
    else if (++leaves > MAX_LEAVES) throw invalid(`A segment rule can have at most ${MAX_LEAVES} conditions.`);
  };
  walk(parsed.data, 1);
  return parsed.data;
}

/** The parsed tree of a query rule (already validated), for compiling and for words. */
export const queryTree = (r: SegmentQuery): ListNode => parseListQuery(r.query);

export interface CompileFrame {
  /** The instant the rule is evaluated at (ctx.now()). */
  now: Date;
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
  if (isQueryRule(rule)) return compileListQuery(queryTree(rule), { now: frame.now });
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
  return { now: ctx.now(), today: localDate(ctx.now(), org.timezone), primaryVenueId: await primaryVenueId(ctx) };
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
  /** The rule in the plain query language, when it was written that way; null for an older condition tree. */
  query: string | null;
  /** The rule as a sentence: "Guests whose last visit was more than 60 days ago and who said yes to email". */
  words: string | null;
  isSystem: boolean;
  updatedAt: Date;
}

const SEG_COLS = ['id', 'name', 'description', 'definition', 'is_system', 'updated_at'] as const;
const segView = (r: { id: string; name: string; description: string | null; definition: unknown; is_system: boolean; updated_at: Date }): SegmentView => {
  const definition = r.definition as SegmentRule;
  const query = isQueryRule(definition) ? definition.query : null;
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    definition,
    query,
    words: query ? listWords(parseListQuery(query)) : null,
    isSystem: r.is_system,
    updatedAt: r.updated_at,
  };
};

/**
 * The guest lists every org starts with (docs/CONSOLE.md "Customers"). Written in the plain
 * query language, so an owner can read them and copy one to make their own. They are code: the
 * rows exist per org (`ensureSystemSegments`) and cannot be changed or deleted.
 */
export const SYSTEM_SEGMENTS: Array<{ name: string; description: string; definition: SegmentRule }> = [
  { name: 'Regulars', description: 'Three or more visits, and in within the last 90 days.', definition: { query: 'visits more than 2 and last visit within the last 90 days' } },
  { name: 'New this month', description: 'First visit, or first known to you, in the last 30 days.', definition: { query: 'first visit within the last 30 days' } },
  { name: 'Said yes to email', description: 'Holds marketing-email consent right now.', definition: { query: 'said yes to email is yes' } },
  { name: 'Lapsed 60+ days', description: 'Has been in before, but not for 60 days or more.', definition: { query: 'last visit more than 60 days ago' } },
  { name: 'Big spenders', description: 'More than $500 spent with you, after refunds.', definition: { query: 'spend more than $500' } },
];

/** Create the default lists an org is missing. Idempotent; internal callers and the console's list. */
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
  // A self-serve org has never run a seeder: give it the default lists on first look.
  const have = await ctx.db.selectFrom('segments').select((eb) => eb.fn.countAll<number>().as('n')).where('is_system', '=', true).executeTakeFirstOrThrow();
  if (Number(have.n) < SYSTEM_SEGMENTS.length) await ensureSystemSegments(ctx);
  const rows = await ctx.db.selectFrom('segments').select(SEG_COLS).orderBy('is_system', 'desc').orderBy('name').execute();
  return rows.map(segView);
}

/** Names for a set of segment ids, for another module's plain-words summary (offers). No role check. */
export async function segmentNames(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)].filter((id) => z.string().uuid().safeParse(id).success);
  if (!wanted.length) return new Map();
  const rows = await ctx.db.selectFrom('segments').select(['id', 'name']).where('id', 'in', wanted).execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Is this guest in the list right now? For offer eligibility ("who: a guest list"). No role
 * check: the caller is a service that has done its own. An unknown list is simply "no".
 */
export async function isSegmentMember(ctx: Ctx, segmentId: string, customerId: string): Promise<boolean> {
  if (!z.string().uuid().safeParse(segmentId).success) return false;
  const r = await ctx.db.selectFrom('segments').select(SEG_COLS).where('id', '=', segmentId).executeTakeFirst();
  if (!r) return false;
  const frame = await compileFrame(ctx);
  const hit = await sql<{ hit: boolean }>`
    select exists (
      select 1 from customers c
      left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
      where c.id = ${customerId}::uuid and ${audienceWhere(ctx, { rule: r.definition as SegmentRule, venueId: null }, frame)}
    ) as hit`.execute(ctx.db);
  return !!hit.rows[0]?.hit;
}

export interface SegmentUsage {
  /** Campaigns that target the list, newest first. */
  campaigns: Array<{ id: string; name: string; status: string }>;
}

/** Where a list is used inside campaigns. Offers report their own use (offers.offersUsingList). */
export async function segmentUsage(ctx: Ctx, segmentId: string): Promise<SegmentUsage> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertCampaignsOnSomewhere(ctx);
  await loadSegment(ctx, segmentId);
  const rows = await ctx.db.selectFrom('campaigns').select(['id', 'name', 'status']).where('segment_id', '=', segmentId).orderBy('created_at', 'desc').limit(50).execute();
  return { campaigns: rows.map((r) => ({ id: r.id, name: r.name, status: r.status })) };
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

export const saveSegmentInput = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).nullish(),
    /** A condition tree, or `{ query }`. */
    definition: z.unknown().optional(),
    /** The rule in the plain query language; the same as `definition: { query }`. */
    query: z.string().trim().min(1).max(600).optional(),
  })
  .refine((v) => v.definition !== undefined || v.query !== undefined, { message: 'Write the rule for the list.' });

/** Create or change a guest list. A manager. The default lists cannot be changed, only copied. */
export async function saveSegment(ctx: Ctx, raw: z.input<typeof saveSegmentInput>): Promise<SegmentView> {
  const parsed = saveSegmentInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That segment is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  const definition = parseSegmentRule(input.query !== undefined ? { query: input.query } : input.definition);
  try {
    if (input.id) {
      const before = await loadSegment(ctx, input.id);
      if (before.isSystem) throw invalid('A built-in list cannot be changed. Save a copy under a new name.');
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
    if (isUniqueViolation(e)) throw conflict('A list with that name already exists.');
    throw e;
  }
}

export async function deleteSegment(ctx: Ctx, id: string): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  const s = await loadSegment(ctx, id);
  if (s.isSystem) throw invalid('A built-in list cannot be deleted.');
  const used = await ctx.db.selectFrom('campaigns').select('id').where('segment_id', '=', s.id).limit(1).executeTakeFirst();
  if (used) throw conflict('A campaign uses this list, so it is kept for the record.');
  try {
    await ctx.db.deleteFrom('segments').where('id', '=', s.id).execute();
  } catch (e) {
    // An offer's "who" points at it (offers.segment_id): the database keeps the row.
    if ((e as { code?: string }).code === '23503') throw conflict('An offer uses this list, so it is kept. Change the offer first.');
    throw e;
  }
  await audit(ctx, { action: 'segment.deleted', entityType: 'segment', entityId: s.id, before: { name: s.name, definition: s.definition } });
}

export const previewSegmentInput = z.object({
  /** A stored segment, or a rule not yet saved: a tree, or the plain query language. */
  segmentId: z.string().uuid().optional(),
  definition: z.unknown().optional(),
  query: z.string().trim().min(1).max(600).optional(),
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
  else if (input.query !== undefined) rule = parseSegmentRule({ query: input.query });
  else if (input.definition !== undefined) rule = parseSegmentRule(input.definition);
  else throw invalid('Choose a list or give a rule.');
  return countAudience(ctx, { rule, venueId: input.venueId ?? null });
}
