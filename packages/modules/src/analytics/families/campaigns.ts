import { type RawBuilder, sql } from 'kysely';
import { type FetchArgs, type FetchResult, type Measures, SALE_STATUSES, bucketSql, inList, runGrouped, utcBounds } from '../engine';
import { ATTRIBUTION_VERSION } from '../../ledger/attribution';
import { eventCtes } from './web';

/**
 * What each acquisition route is aligned with, one row per thing that happened:
 *
 *   a visit       a session that arrived carrying the campaign or creator (visitor_sessions)
 *   a new guest   a customer whose write-once acquisition stamp names it (customers)
 *   an order      a counted sale attributed to it by the 'acquisition' model (transaction_attributions)
 *
 * These are associations, never proof of cause. The rows carry customer ids only so that
 * distinct guests can be counted; no id is ever selected out of the grouped result.
 */
export interface CampaignRowsArgs {
  orgId: string;
  venueIds: string[];
  includeOrgLevel: boolean;
  orgTimezone: string;
  from?: string;
  to?: string;
  days?: string[];
}

export function campaignCtes(a: CampaignRowsArgs): RawBuilder<unknown>[] {
  const days = a.days ? [...a.days].sort() : null;
  const { lo, hi } = utcBounds(days ? days[0]! : a.from!, days ? days[days.length - 1]! : a.to!);
  const dayTest = (expr: RawBuilder<unknown>) => (days ? sql`${expr} = any(${days}::date[])` : sql`${expr} between ${a.from!}::date and ${a.to!}::date`);
  const sessDay = sql`(s.first_seen_at at time zone coalesce(v.timezone, ${a.orgTimezone}))::date`;
  const custDay = sql`(c.acquisition_at at time zone coalesce(v.timezone, ${a.orgTimezone}))::date`;
  const saleDay = sql`(t.occurred_at at time zone v.timezone)::date`;
  return [
    // Every counted sale of a known customer in these venues, ranked per customer in one pass.
    sql`a_crank as (
      select t.id, t.org_id, t.venue_id, t.customer_id, t.occurred_at, t.total_cents, t.refunded_cents,
             row_number() over (partition by t.customer_id order by t.occurred_at, t.id) as rn
      from transactions t
      where t.org_id = ${a.orgId} and t.venue_id = any(${a.venueIds}::uuid[])
        and t.customer_id is not null and t.status in ${sql.raw(SALE_STATUSES)}
    )`,
    sql`a_camp as (
      select ${sessDay} as day, s.venue_id, coalesce(s.utm_source, '') as channel,
             coalesce(s.campaign_id, '') as campaign_id, coalesce(s.creator_id, '') as creator_id,
             1 as sessions, 0 as new_customers, 0 as orders, 0::bigint as revenue_cents, 0 as repeat_orders,
             null::uuid as customer_id, null::uuid as buyer_id, null::uuid as repeat_buyer_id
      from visitor_sessions s
      left join venues v on v.id = s.venue_id
      where s.org_id = ${a.orgId}
        and (s.venue_id = any(${a.venueIds}::uuid[]) or (${a.includeOrgLevel}::boolean and s.venue_id is null))
        and s.first_seen_at >= ${lo} and s.first_seen_at < ${hi} and ${dayTest(sessDay)}
      union all
      select ${custDay}, c.first_seen_venue_id, c.acquisition_source,
             coalesce(c.acquisition_campaign_id, ''), coalesce(c.acquisition_creator_id, ''),
             0, 1, 0, 0::bigint, 0, c.id, null::uuid, null::uuid
      from customers c
      left join venues v on v.id = c.first_seen_venue_id
      where c.org_id = ${a.orgId} and c.status = 'active'
        and (c.first_seen_venue_id = any(${a.venueIds}::uuid[]) or (${a.includeOrgLevel}::boolean and c.first_seen_venue_id is null))
        and c.acquisition_at >= ${lo} and c.acquisition_at < ${hi} and ${dayTest(custDay)}
      union all
      select ${saleDay}, t.venue_id, coalesce(x.channel, ''), coalesce(x.campaign_id, ''), coalesce(x.creator_id, ''),
             0, 0, 1, (t.total_cents - t.refunded_cents)::bigint, (t.rn > 1)::int,
             t.customer_id, t.customer_id, case when t.rn > 1 then t.customer_id end
      from a_crank t
      join venues v on v.id = t.venue_id
      join lateral (
        select ta.channel, ta.campaign_id, ta.creator_id
        from transaction_attributions ta
        where ta.org_id = t.org_id and ta.transaction_id = t.id and ta.model = 'acquisition' and ta.model_version = ${ATTRIBUTION_VERSION}
      ) x on true
      where t.occurred_at >= ${lo} and t.occurred_at < ${hi} and ${dayTest(saleDay)}
    )`,
  ];
}

export const CAMPAIGN_AGGS = {
  sessions: 'sum(sessions)',
  new_customers: 'sum(new_customers)',
  orders: 'sum(orders)',
  revenue: 'sum(revenue_cents)',
  repeat_orders: 'sum(repeat_orders)',
  cohort: 'count(distinct customer_id)',
  buyers: 'count(distinct buyer_id)',
  repeat_buyers: 'count(distinct repeat_buyer_id)',
};

/** Guest-derived measures: hidden whenever fewer than the minimum number of guests stand behind a row. */
export const GUEST_MEASURES = ['new_customers', 'orders', 'revenue', 'repeat_orders', 'buyers', 'repeat_buyers'];

const DIMS: Record<string, string> = {
  campaign: `coalesce(nullif(r.campaign_id, ''), '(none)')`,
  creator: `coalesce(nullif(r.creator_id, ''), '(none)')`,
  channel: `coalesce(nullif(r.channel, ''), 'direct')`,
  venue: 'r.venue_id',
};

export async function fetchCampaigns(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope, settings } = a;
  const ctes = campaignCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: scope.orgTimezone, from: a.from, to: a.to });
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_camp',
    bucket: bucketSql('r.day', a.grain),
    dims: a.dims.map((d) => ({ key: d, expr: DIMS[d]! })),
    where: [sql`(r.campaign_id <> '' or r.creator_id <> '')`, ...Object.entries(a.filters).map(([k, v]) => inList(`(${DIMS[k]})::text`, v))],
    aggs: CAMPAIGN_AGGS,
  });

  // The cohort floor. Visits are anonymous and stay; anything that describes guests does not
  // appear until enough of them stand behind the row.
  let hidden = 0;
  const floor = (m: Measures): boolean => {
    const cohort = Number(m.cohort ?? 0);
    delete m.cohort;
    if (cohort >= settings.minCohort) return false;
    for (const k of GUEST_MEASURES) m[k] = null;
    return true;
  };
  for (const r of g.rows) if (floor(r.m)) hidden++;
  const totalHidden = floor(g.totals);
  const caveats = ['Campaign and creator figures are aligned with the campaign, not proof that it caused them.'];
  if (hidden || totalHidden) {
    caveats.push(
      `${totalHidden && !g.rows.length ? 'The guest figures are' : `Guest figures on ${hidden} ${hidden === 1 ? 'row are' : 'rows are'}`} hidden: not enough guests yet (fewer than ${settings.minCohort}). A hidden figure is unmeasured, not low.`,
    );
  }
  return {
    rows: g.rows,
    totals: g.totals,
    path: 'ledger',
    tables: ['visitor_sessions', 'customers', 'transaction_attributions', 'transactions', 'venues'],
    sourceRows: { campaign_rows: g.sourceRows },
    caveats,
    hiddenRows: hidden,
  };
}

const MESSAGE_DIMS: Record<string, string> = {
  message_channel: 'r.message_channel',
  message_kind: 'r.message_kind',
  template: 'r.template',
  message_campaign: 'r.message_campaign',
  venue: 'r.venue_id',
};

/** Message performance from the event stream: the comms module's own tables are never read. */
export async function fetchMessages(a: FetchArgs): Promise<FetchResult> {
  const { ctx, scope } = a;
  const ctes = [
    ...eventCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: scope.orgTimezone, from: a.from, to: a.to, namePrefix: 'message.' }),
    sql`a_msg as (
      select e.day, e.venue_id, e.name,
             e.properties->>'message_id' as message_id,
             coalesce(e.properties->>'channel', '(unknown)') as message_channel,
             coalesce(e.properties->>'kind', '(unknown)') as message_kind,
             coalesce(e.properties->>'template_key', '(unknown)') as template,
             coalesce(e.properties->>'campaign_id', '(none)') as message_campaign
      from a_event e
    )`,
  ];
  const count = (name: string) => `count(distinct message_id) filter (where name = 'message.${name}')`;
  const g = await runGrouped(ctx, {
    ctes,
    relation: 'a_msg',
    bucket: bucketSql('r.day', a.grain),
    dims: a.dims.map((d) => ({ key: d, expr: MESSAGE_DIMS[d]! })),
    where: Object.entries(a.filters).map(([k, v]) => inList(`(${MESSAGE_DIMS[k]})::text`, v)),
    aggs: {
      sent: count('sent'),
      delivered: count('delivered'),
      opened: count('opened'),
      clicked: count('clicked'),
      bounced: count('bounced'),
      unsubscribed: count('unsubscribed'),
    },
  });
  const caveats: string[] = [];
  if (!g.sourceRows) caveats.push('No message events were recorded in this period, so there is nothing to measure. That is not the same as poor performance.');
  return { rows: g.rows, totals: g.totals, path: 'ledger', tables: ['events', 'venues'], sourceRows: { events: g.sourceRows }, caveats };
}
