import { type RawBuilder, sql } from 'kysely';
import { listEventDefs } from '@ros/core';
import { type FetchArgs, type FetchResult, type FamilyRow, bucketSql, inList, rowKey, runGrouped, utcBounds } from '../engine';

/**
 * Visits and events. A session belongs to the venue whose site or QR menu it started on and to
 * that venue's local day; a session on the org-level (group) site has no venue, uses the org's
 * zone, and is only counted when the question covers every venue.
 */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export function sessionCtes(a: { orgId: string; venueIds: string[]; includeOrgLevel: boolean; orgTimezone: string; from?: string; to?: string; days?: string[] }): RawBuilder<unknown>[] {
  const days = a.days ? [...a.days].sort() : null;
  const { lo, hi } = utcBounds(days ? days[0]! : a.from!, days ? days[days.length - 1]! : a.to!);
  const dayExpr = sql`(s.first_seen_at at time zone coalesce(v.timezone, ${a.orgTimezone}))::date`;
  const dayTest = days ? sql`${dayExpr} = any(${days}::date[])` : sql`${dayExpr} between ${a.from!}::date and ${a.to!}::date`;
  return [
    sql`a_sess as (
      select s.id, s.venue_id, ${dayExpr} as day, s.first_seen_at,
             coalesce(s.utm_source, 'direct') as utm_source,
             coalesce(s.utm_medium, '(none)') as utm_medium,
             s.campaign_id, s.creator_id,
             coalesce(s.device_class, '(unknown)') as device_class,
             coalesce(s.landing_path, '/') as landing_path,
             s.customer_id
      from visitor_sessions s
      left join venues v on v.id = s.venue_id
      where s.org_id = ${a.orgId}
        and (s.venue_id = any(${a.venueIds}::uuid[]) or (${a.includeOrgLevel}::boolean and s.venue_id is null))
        and s.first_seen_at >= ${lo} and s.first_seen_at < ${hi}
        and ${dayTest}
    )`,
  ];
}

export function eventCtes(a: { orgId: string; venueIds: string[]; includeOrgLevel: boolean; orgTimezone: string; from?: string; to?: string; days?: string[]; namePrefix?: string }): RawBuilder<unknown>[] {
  const days = a.days ? [...a.days].sort() : null;
  const { lo, hi } = utcBounds(days ? days[0]! : a.from!, days ? days[days.length - 1]! : a.to!);
  const dayExpr = sql`(e.occurred_at at time zone coalesce(v.timezone, ${a.orgTimezone}))::date`;
  const dayTest = days ? sql`${dayExpr} = any(${days}::date[])` : sql`${dayExpr} between ${a.from!}::date and ${a.to!}::date`;
  const nameTest = a.namePrefix ? sql`and e.name like ${`${a.namePrefix}%`}` : sql``;
  return [
    sql`a_event as (
      select e.id, e.venue_id, ${dayExpr} as day, e.name, e.session_id, e.customer_id, e.properties,
             coalesce(e.utm_source, '') as utm_source, coalesce(e.creator_id, '') as creator_id, coalesce(e.campaign_id, '') as campaign_id
      from events e
      left join venues v on v.id = e.venue_id
      where e.org_id = ${a.orgId}
        and (e.venue_id = any(${a.venueIds}::uuid[]) or (${a.includeOrgLevel}::boolean and e.venue_id is null))
        and e.occurred_at >= ${lo} and e.occurred_at < ${hi}
        and ${dayTest}
        ${nameTest}
    )`,
  ];
}

const SESSION_DIMS: Record<string, string> = {
  venue: 'r.venue_id',
  utm_source: 'r.utm_source',
  utm_medium: 'r.utm_medium',
  campaign: `coalesce(r.campaign_id, '(none)')`,
  creator: `coalesce(r.creator_id, '(none)')`,
  device_class: 'r.device_class',
  landing_path: 'r.landing_path',
};
const SESSION_FACT_DIMS = new Set(['venue', 'utm_source', 'campaign', 'creator']);

export async function fetchWeb(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const used = [...new Set([...a.dims, ...Object.keys(a.filters)])];
  // Web facts have no change cursor (the event stream carries no ingest time), so they are
  // read only when asked for by name; 'auto' reads the sessions themselves.
  const facts = a.source === 'facts' && used.every((d) => SESSION_FACT_DIMS.has(d));
  const orgTz = scope.orgTimezone;
  const ctes = facts
    ? [sql`a_sess as (
        select f.day, nullif(f.venue_key, ${ZERO_UUID}::uuid) as venue_id,
               coalesce(nullif(f.channel, ''), 'direct') as utm_source,
               nullif(f.campaign_id, '') as campaign_id, nullif(f.creator_id, '') as creator_id,
               null::text as utm_medium, null::text as device_class, null::text as landing_path, f.sessions
        from fact_campaign_daily f
        where f.org_id = ${ctx.orgId} and f.sessions > 0 and f.day between ${a.from}::date and ${a.to}::date
          and (f.venue_key = any(${scope.venueIds}::uuid[]) or (${scope.all}::boolean and f.venue_key = ${ZERO_UUID}::uuid))
      )`]
    : sessionCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: orgTz, from: a.from, to: a.to });
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_sess',
    bucket: bucketSql('r.day', a.grain),
    dims: a.dims.map((d) => ({ key: d, expr: SESSION_DIMS[d]! })),
    where: Object.entries(a.filters).map(([k, v]) => inList(`(${SESSION_DIMS[k]})::text`, v)),
    aggs: { sessions: facts ? 'sum(sessions)' : 'count(*)' },
  });
  const caveats: string[] = [];
  if (facts) caveats.push('Served from daily facts; visits since the last roll-up are missing.');
  else if (a.source === 'facts') caveats.push('These dimensions cannot be served from the daily facts; the sessions were read instead.');
  return {
    rows: g.rows,
    totals: g.totals,
    path: facts ? 'facts' : 'ledger',
    tables: facts ? ['fact_campaign_daily'] : ['visitor_sessions', 'venues'],
    sourceRows: { [facts ? 'fact_campaign_daily' : 'visitor_sessions']: g.sourceRows },
    caveats,
  };
}

const EVENT_DIMS: Record<string, string> = {
  event_name: 'r.name',
  venue: 'r.venue_id',
  utm_source: `coalesce(nullif(r.utm_source, ''), 'direct')`,
  campaign: `coalesce(nullif(r.campaign_id, ''), '(none)')`,
  creator: `coalesce(nullif(r.creator_id, ''), '(none)')`,
};

export async function fetchEvents(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const facts = a.source === 'facts';
  const orgTz = scope.orgTimezone;
  const ctes = facts
    ? [sql`a_event as (
        select f.day, nullif(f.venue_key, ${ZERO_UUID}::uuid) as venue_id, f.name, f.utm_source, f.creator_id, f.campaign_id, f.events
        from fact_events_daily f
        where f.org_id = ${ctx.orgId} and f.day between ${a.from}::date and ${a.to}::date
          and (f.venue_key = any(${scope.venueIds}::uuid[]) or (${scope.all}::boolean and f.venue_key = ${ZERO_UUID}::uuid))
      )`]
    : eventCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: orgTz, from: a.from, to: a.to });
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_event',
    bucket: bucketSql('r.day', a.grain),
    dims: a.dims.map((d) => ({ key: d, expr: EVENT_DIMS[d]! })),
    where: Object.entries(a.filters).map(([k, v]) => inList(`(${EVENT_DIMS[k]})::text`, v)),
    aggs: { events: facts ? 'sum(events)' : 'count(*)' },
  });
  return {
    rows: g.rows,
    totals: g.totals,
    path: facts ? 'facts' : 'ledger',
    tables: facts ? ['fact_events_daily'] : ['events', 'venues'],
    sourceRows: { [facts ? 'fact_events_daily' : 'events']: g.sourceRows },
    caveats: facts ? ['Served from daily facts; events since the last roll-up are missing.'] : [],
  };
}

export interface FunnelStep {
  step: number;
  event: string;
  description: string;
}

/** The ordered steps of a declared funnel. Modules add steps by declaring events with `funnel`. */
export function funnelSteps(name: string): FunnelStep[] {
  return listEventDefs()
    .filter((d) => d.funnel?.name === name)
    .map((d) => ({ step: d.funnel!.step, event: d.name, description: d.description }))
    .sort((x, y) => x.step - y.step || x.event.localeCompare(y.event));
}

export function funnelNames(): string[] {
  return [...new Set(listEventDefs().flatMap((d) => (d.funnel ? [d.funnel.name] : [])))].sort();
}

const FUNNEL_DIMS: Record<string, string> = { ...SESSION_DIMS, funnel_step: 'r.step' };

/**
 * A closed funnel over sessions that started in the period: a session counts at step N only if
 * it produced the event of step N and of every step before it, so the counts never rise from
 * one step to the next.
 */
export async function fetchFunnel(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const steps = funnelSteps(a.funnel);
  const orgTz = scope.orgTimezone;
  if (!steps.length) {
    return { rows: [], totals: { funnel_sessions: 0, first_step_sessions: 0, prev_step_sessions: null }, path: 'ledger', tables: ['visitor_sessions', 'events'], sourceRows: { visitor_sessions: 0 }, caveats: [`No funnel named "${a.funnel}" is declared.`] };
  }
  // Steps are renumbered 1..n in declared order, so a gap in a module's numbering cannot break the chain.
  const ordered = steps.map((s, i) => ({ ...s, pos: i + 1 }));
  const values = sql.join(ordered.map((s) => sql`(${s.pos}::int, ${s.event}::text)`), sql`, `);
  const ctes = [
    ...sessionCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: orgTz, from: a.from, to: a.to }),
    sql`a_step (pos, name) as (values ${values})`,
    // Per session, one indexed look at its events: which steps it produced, and how far it got
    // without skipping one (the position before the first gap).
    sql`a_depth as (
      select s.*, coalesce(d.depth, 0) as depth
      from a_sess s
      left join lateral (
        select coalesce(min(q.rn) filter (where q.pos <> q.rn) - 1, count(*)) as depth
        from (
          select h.pos, row_number() over (order by h.pos) as rn
          from (
            select distinct st.pos
            from events e
            join a_step st on st.name = e.name
            where e.org_id = ${ctx.orgId} and e.session_id = s.id
          ) h
        ) q
      ) d on true
    )`,
    sql`a_reach as (
      select s.*, st.pos as step
      from a_depth s
      join a_step st on st.pos <= s.depth
    )`,
  ];
  const dims = a.dims.includes('funnel_step') ? a.dims : ['funnel_step', ...a.dims];
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_reach',
    bucket: bucketSql('r.day', a.grain),
    dims: dims.map((d) => ({ key: d, expr: FUNNEL_DIMS[d]! })),
    where: Object.entries(a.filters)
      .filter(([k]) => k !== 'funnel')
      .map(([k, v]) => inList(`(${FUNNEL_DIMS[k]})::text`, v)),
    aggs: { funnel_sessions: 'count(*)' },
  });

  // Every step appears in every slice, so a step nobody reached reads as 0, and each row knows
  // the first and the previous step's count for the conversion rates.
  const others = dims.filter((d) => d !== 'funnel_step');
  const groups = new Map<string, { bucket: string | null; dims: Record<string, string | null>; byStep: Map<string, number> }>();
  for (const r of g.rows) {
    const key = rowKey(r.bucket, r.dims, others);
    const grp = groups.get(key) ?? { bucket: r.bucket, dims: Object.fromEntries(others.map((o) => [o, r.dims[o] ?? null])), byStep: new Map() };
    grp.byStep.set(r.dims.funnel_step!, Number(r.m.funnel_sessions ?? 0));
    groups.set(key, grp);
  }
  const rows: FamilyRow[] = [];
  for (const grp of groups.values()) {
    const first = grp.byStep.get('1') ?? 0;
    let prev: number | null = null;
    for (const s of ordered) {
      const n = grp.byStep.get(String(s.pos)) ?? 0;
      rows.push({
        bucket: grp.bucket,
        dims: { ...grp.dims, funnel_step: String(s.pos), funnel_event: s.event },
        m: { funnel_sessions: n, first_step_sessions: first, prev_step_sessions: prev },
      });
      prev = n;
    }
  }
  const started = await runGrouped(ctx, { ctes, relation: 'a_reach', bucket: null, dims: [], where: [sql`r.step = 1`, ...Object.entries(a.filters).filter(([k]) => k !== 'funnel' && k !== 'funnel_step').map(([k, v]) => inList(`(${FUNNEL_DIMS[k]})::text`, v))], aggs: { n: 'count(*)' } });
  return {
    rows,
    totals: { funnel_sessions: null, first_step_sessions: Number(started.totals.n ?? 0), prev_step_sessions: null },
    path: 'ledger',
    tables: ['visitor_sessions', 'events', 'venues'],
    sourceRows: { visitor_sessions: Number(started.totals.n ?? 0) },
    caveats: [],
  };
}
