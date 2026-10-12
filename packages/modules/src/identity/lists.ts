import type { RawBuilder } from 'kysely';
import { type Ctx, invalid, sql } from '@ros/core';
import { type ListClause, type ListNode, ListQueryError, MAX_CLAUSES, countClauses, parseListText } from './list-grammar';

/**
 * Guest lists, the SQL half (docs/CONSOLE_IA.md section 9, pattern 5). A parsed tree becomes one
 * boolean expression over `customers c`: every field is a fixed column or sub-select written in
 * this file, and every value a person typed is a bound parameter. Nothing typed is ever part of
 * the SQL text. Facts come from the identity spine and the tables a spine module may read:
 * sales (`transactions`), consents, suppressions and the event stream (loyalty, no-shows).
 */

export interface ListFrame {
  /** The instant "now" is measured from (ctx.now()). */
  now: Date;
  /** Count visits and spend at this venue only. Null: across the organisation. */
  venueId?: string | null;
}

/** One fact about the guest's counted sales, as a scalar sub-select correlated to `c`. */
function sales(frame: ListFrame, pick: RawBuilder<unknown>): RawBuilder<unknown> {
  const venue = frame.venueId ? sql` and t.venue_id = ${frame.venueId}::uuid` : sql``;
  return sql`(select ${pick} from transactions t where t.org_id = c.org_id and t.customer_id = c.id and t.status <> 'voided'${venue})`;
}

const daysAgo = (frame: ListFrame, days: number) => sql`(${frame.now}::timestamptz - make_interval(days => ${days}::int))`;

const cmp = (op: 'more_than' | 'less_than' | 'is' | 'is_not', expr: RawBuilder<unknown>, value: number): RawBuilder<boolean> => {
  switch (op) {
    case 'more_than':
      return sql<boolean>`(${expr} > ${value})`;
    case 'less_than':
      return sql<boolean>`(${expr} < ${value})`;
    case 'is':
      return sql<boolean>`(${expr} = ${value})`;
    case 'is_not':
      return sql<boolean>`(${expr} <> ${value})`;
  }
};

function compileClause(c: ListClause, frame: ListFrame): RawBuilder<boolean> {
  const lastAt = sales(frame, sql`max(t.occurred_at)`);
  const firstAt = sales(frame, sql`min(t.occurred_at)`);
  const visits = sales(frame, sql`count(*)::int`);
  const spend = sales(frame, sql`coalesce(sum(t.total_cents - t.refunded_cents), 0)::bigint`);
  switch (c.field) {
    case 'last_visit': {
      if (c.op === 'never') return sql<boolean>`(${lastAt} is null)`;
      return c.op === 'within_days' ? sql<boolean>`(${lastAt} >= ${daysAgo(frame, c.days)})` : sql<boolean>`(${lastAt} < ${daysAgo(frame, c.days)})`;
    }
    case 'first_visit': {
      // A guest who has not bought yet was first "seen" when their record was made.
      const first = sql`coalesce(${firstAt}, c.created_at)`;
      if (c.op === 'never') return sql<boolean>`(${firstAt} is null)`;
      return c.op === 'within_days' ? sql<boolean>`(${first} >= ${daysAgo(frame, c.days)})` : sql<boolean>`(${first} < ${daysAgo(frame, c.days)})`;
    }
    case 'visits':
      return cmp(c.op, visits, c.value);
    case 'spend':
      return cmp(c.op, spend, c.value);
    case 'average_spend':
      // No visits, no average: the condition is simply false.
      return sql<boolean>`coalesce(${cmp(c.op, sales(frame, sql`case when count(*) > 0 then (coalesce(sum(t.total_cents - t.refunded_cents), 0) / count(*))::bigint end`), c.value)}, false)`;
    case 'no_shows':
      return cmp(c.op, sql`(select count(*)::int from events e where e.org_id = c.org_id and e.customer_id = c.id and e.name = 'booking.no_show')`, c.value);
    case 'email_yes':
    case 'texts_yes': {
      const purpose = c.field === 'email_yes' ? 'marketing_email' : 'marketing_sms';
      const held = sql`exists (select 1 from consents k where k.org_id = c.org_id and k.customer_id = c.id and k.purpose = ${purpose}::consent_purpose and k.status = 'granted')`;
      const want = c.op === 'is' ? c.value : !c.value;
      return want ? sql<boolean>`${held}` : sql<boolean>`(not ${held})`;
    }
    case 'loyalty_member': {
      const member = sql`exists (select 1 from events e where e.org_id = c.org_id and e.customer_id = c.id and e.name = 'loyalty.enrolled')`;
      const want = c.op === 'is' ? c.value : !c.value;
      return want ? sql<boolean>`${member}` : sql<boolean>`(not ${member})`;
    }
    case 'suburb': {
      const eq = sql`(lower(trim(c.suburb)) = lower(trim(${c.value})))`;
      return c.op === 'is' ? sql<boolean>`coalesce(${eq}, false)` : sql<boolean>`(not coalesce(${eq}, false))`;
    }
    case 'source': {
      const eq = sql`(c.acquisition_source = ${c.value.toLowerCase().replace(/\s+/g, '-')})`;
      return c.op === 'is' ? sql<boolean>`${eq}` : sql<boolean>`(not ${eq})`;
    }
  }
}

/** A tree as one boolean expression over `customers c`. */
export function compileListQuery(node: ListNode, frame: ListFrame): RawBuilder<boolean> {
  if ('and' in node) return sql<boolean>`(${sql.join(node.and.map((n) => compileListQuery(n, frame)), sql` and `)})`;
  if ('or' in node) return sql<boolean>`(${sql.join(node.or.map((n) => compileListQuery(n, frame)), sql` or `)})`;
  return sql<boolean>`coalesce(${compileClause(node, frame)}, false)`;
}

/**
 * Parse a list rule written by a person. Refuses anything that is not the grammar, with a
 * sentence that says what to change; refuses more than ten conditions.
 */
export function parseListQuery(text: unknown): ListNode {
  if (typeof text !== 'string') throw invalid('Write the list rule as words.');
  try {
    const node = parseListText(text);
    if (countClauses(node) > MAX_CLAUSES) throw new ListQueryError(`A list can have at most ${MAX_CLAUSES} conditions. Split it into two lists.`);
    return node;
  } catch (e) {
    if (e instanceof ListQueryError) throw invalid(e.message, { at: e.at });
    throw e;
  }
}

/** The WHERE a list shares with every reader: this org's active guests who match. */
export function listWhere(ctx: Ctx, node: ListNode, frame: ListFrame): RawBuilder<boolean> {
  return sql<boolean>`(c.org_id = ${ctx.orgId} and c.status = 'active' and ${compileListQuery(node, frame)})`;
}

export interface ListCount {
  count: number;
  /** Members who can be sent marketing on the channel now: an address, the consent, no suppression. */
  email: number;
  sms: number;
}

/** SQL: the guest can be sent marketing on the channel. The same test comms makes at send time, as a count. */
export function reachableByListSql(channel: 'email' | 'sms'): RawBuilder<boolean> {
  const address = channel === 'email' ? sql`c.primary_email` : sql`c.primary_phone`;
  const purpose = channel === 'email' ? 'marketing_email' : 'marketing_sms';
  return sql<boolean>`(${address} is not null
    and exists (select 1 from consents k where k.org_id = c.org_id and k.customer_id = c.id and k.purpose = ${purpose}::consent_purpose and k.status = 'granted')
    and not exists (select 1 from suppressions s where s.org_id = c.org_id and s.channel = ${channel}::msg_channel and s.value = ${address}))`;
}

/** How many guests a tree matches. No role check: callers have done it. Never a list of who. */
export async function countListMembers(ctx: Ctx, node: ListNode, frame: ListFrame): Promise<ListCount> {
  const r = await sql<{ n: number; email: number; sms: number }>`
    select count(*)::int as n,
           count(*) filter (where ${reachableByListSql('email')})::int as email,
           count(*) filter (where ${reachableByListSql('sms')})::int as sms
    from customers c
    where ${listWhere(ctx, node, frame)}`.execute(ctx.db);
  const row = r.rows[0]!;
  return { count: row.n, email: row.email, sms: row.sms };
}

/** Is this one guest in the list right now? No role check: used by offer eligibility. */
export async function isListMember(ctx: Ctx, node: ListNode, customerId: string, frame: ListFrame): Promise<boolean> {
  const r = await sql<{ hit: boolean }>`
    select exists (select 1 from customers c where c.id = ${customerId}::uuid and ${listWhere(ctx, node, frame)}) as hit`.execute(ctx.db);
  return !!r.rows[0]?.hit;
}

export { type ListClause, type ListField, type ListNode, LIST_FIELDS, MAX_CLAUSES, OPERATORS, clauseText, countClauses, fieldInfo, listText, listWords, sameList } from './list-grammar';
