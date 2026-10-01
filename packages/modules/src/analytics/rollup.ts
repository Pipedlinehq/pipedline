import { type RawBuilder, sql } from 'kysely';
import { type App, type Ctx, addDays, forbidden, isInternal, localDate } from '@ros/core';
import { campaignCtes } from './families/campaigns';
import { customerCtes } from './families/customers';
import { lineCtes } from './families/items';
import { SALES_COLUMNS, saleCtes } from './families/sales';
import { eventCtes } from './families/web';
import { CURSOR_NEXT, MARKER_DAY, ROLLUP_CURSOR, ROLLUP_CUSTOMERS, ROLLUP_DAILY, customersSignature, factsState, frameSql } from './freshness';
import { getAnalyticsSettings } from './settings';

/**
 * Derived facts. Everything here can be thrown away and rebuilt from the ledger and the event
 * stream: nothing reads a fact as the truth, and queries fall back to the ledger whenever the
 * facts are behind it.
 *
 * A roll-up works on org-days (each venue's own local day). For a set of days it recomputes
 * every fact row from source and *merges* the result: a row whose values are unchanged is not
 * written, a changed row is updated, a row whose source has gone is deleted. So running a
 * roll-up twice changes nothing, and a refund or a late-linked customer simply re-rolls the
 * days it touches. Which days to look at comes from rollup_state: a cursor over when sales last
 * changed, plus the last few days for the event stream, which has no change marker.
 */
const WORKER = { kind: 'worker' as const, job: 'analytics.rollup' };
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
/** Sales changed this close to the cursor are looked at again, in case a slow transaction committed late. */
const CURSOR_OVERLAP = '5 minutes';
/** The nightly reconcile looks a whole day back, for anything a very slow transaction committed late. */
const RECONCILE_OVERLAP = '1 day';
/** Days before today that are always re-examined, for late events, sessions and new customers. */
const TRAILING_DAYS = 2;
const RECONCILE_DAYS = 35;

export interface RollupResult {
  mode: 'incremental' | 'reconcile' | 'backfill';
  daysExamined: number;
  /** Days on which at least one fact row was written or removed. */
  daysChanged: string[];
  customersSnapshot: boolean;
  customersChanged: number;
}

function requireInternal(ctx: Ctx): void {
  if (!isInternal(ctx)) throw forbidden('Only a background job can rebuild analytics.');
}

interface FactSpec {
  table: 'fact_sales_daily' | 'fact_sales_hourly' | 'fact_item_daily' | 'fact_events_daily' | 'fact_campaign_daily';
  keys: string[];
  cols: string[];
  ctes: RawBuilder<unknown>[];
  /** A select producing the key and value columns from the CTEs. */
  rows: string;
}

/** Recompute one fact table for some days and merge. Returns the days on which anything was written. */
async function mergeFact(ctx: Ctx, spec: FactSpec, days: string[]): Promise<string[]> {
  const t = spec.table;
  const keys = spec.keys.join(', ');
  const cols = spec.cols.join(', ');
  const set = spec.cols.map((c) => `${c} = excluded.${c}`).join(', ');
  const stored = spec.cols.map((c) => `${t}.${c}`).join(', ');
  const incoming = spec.cols.map((c) => `excluded.${c}`).join(', ');
  const match = spec.keys.map((k) => `n.${k} = f.${k}`).join(' and ');
  const r = await sql<{ day: string }>`
    with ${sql.join(spec.ctes, sql`, `)},
    a_new as (${sql.raw(spec.rows)}),
    a_up as (
      insert into ${sql.raw(t)} (org_id, ${sql.raw(keys)}, ${sql.raw(cols)}, computed_at)
      select ${ctx.orgId}::uuid, ${sql.raw(keys)}, ${sql.raw(cols)}, ${ctx.now()}::timestamptz from a_new
      on conflict (org_id, ${sql.raw(keys)}) do update set ${sql.raw(set)}, computed_at = excluded.computed_at
      where (${sql.raw(stored)}) is distinct from (${sql.raw(incoming)})
      returning day
    ),
    a_del as (
      delete from ${sql.raw(t)} f
      where f.org_id = ${ctx.orgId} and f.day = any(${days}::date[])
        and not exists (select 1 from a_new n where ${sql.raw(match)})
      returning f.day
    )
    select day from a_up union select day from a_del`.execute(ctx.db);
  return r.rows.map((x) => x.day);
}

/**
 * Recompute every daily fact for these org-days. Internal: jobs, the back-fill and tests.
 * Returns the days on which a fact row actually changed.
 */
export async function rollupDays(ctx: Ctx, days: string[]): Promise<string[]> {
  requireInternal(ctx);
  if (!days.length) return [];
  await lock(ctx);
  const orgId = ctx.orgId;
  const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', orgId).executeTakeFirstOrThrow();
  const venueIds = (await ctx.db.selectFrom('venues').select('id').where('org_id', '=', orgId).execute()).map((v) => v.id);
  const changed = new Set<string>();
  const salesCols = Object.values(SALES_COLUMNS);
  const sums = salesCols
    .map((c) => (c === 'items' ? 'sum(items)::numeric(14, 3) as items' : c.endsWith('_cents') ? `sum(${c})::bigint as ${c}` : `sum(${c})::int as ${c}`))
    .join(', ');

  if (venueIds.length) {
    const sale = saleCtes({ orgId, venueIds, days, withRank: true, withItems: true });
    const specs: FactSpec[] = [
      { table: 'fact_sales_daily', keys: ['venue_id', 'day', 'channel', 'source'], cols: salesCols, ctes: sale, rows: `select venue_id, day, channel, source, ${sums} from a_sale group by venue_id, day, channel, source` },
      { table: 'fact_sales_hourly', keys: ['venue_id', 'day', 'hour'], cols: salesCols, ctes: sale, rows: `select venue_id, day, hour::smallint as hour, ${sums} from a_sale group by venue_id, day, hour` },
      {
        table: 'fact_item_daily',
        keys: ['venue_id', 'day', 'item_key'],
        cols: ['menu_item_id', 'item_name', 'category', 'qty', 'revenue_cents', 'orders'],
        ctes: lineCtes({ orgId, venueIds, days }),
        rows: `select venue_id, day, item_key, (max(menu_item_id::text))::uuid as menu_item_id, max(item_name) as item_name, max(category) as category,
                      sum(qty)::numeric(14, 3) as qty, sum(revenue_cents)::bigint as revenue_cents, count(distinct transaction_id)::int as orders
               from a_line group by venue_id, day, item_key`,
      },
    ];
    for (const s of specs) for (const d of await mergeFact(ctx, s, days)) changed.add(d);
  }

  const scope = { orgId, venueIds, includeOrgLevel: true, orgTimezone: org.timezone, days };
  const more: FactSpec[] = [
    {
      table: 'fact_events_daily',
      keys: ['venue_key', 'day', 'name', 'utm_source', 'creator_id', 'campaign_id'],
      cols: ['events', 'sessions', 'customers'],
      ctes: eventCtes(scope),
      rows: `select coalesce(venue_id, '${ZERO_UUID}'::uuid) as venue_key, day, name, utm_source, creator_id, campaign_id,
                    count(*)::int as events, count(distinct session_id)::int as sessions, count(distinct customer_id)::int as customers
             from a_event group by 1, 2, 3, 4, 5, 6`,
    },
    {
      table: 'fact_campaign_daily',
      keys: ['venue_key', 'day', 'channel', 'campaign_id', 'creator_id'],
      cols: ['sessions', 'new_customers', 'orders', 'revenue_cents', 'repeat_orders'],
      ctes: campaignCtes(scope),
      rows: `select coalesce(venue_id, '${ZERO_UUID}'::uuid) as venue_key, day, channel, campaign_id, creator_id,
                    sum(sessions)::int as sessions, sum(new_customers)::int as new_customers, sum(orders)::int as orders,
                    sum(revenue_cents)::bigint as revenue_cents, sum(repeat_orders)::int as repeat_orders
             from a_camp group by 1, 2, 3, 4, 5`,
    },
  ];
  for (const s of more) for (const d of await mergeFact(ctx, s, days)) changed.add(d);

  // Note each day as rolled up. A day already noted whose facts did not change is left alone.
  const changedDays = [...changed].sort();
  await sql`
    insert into rollup_state (org_id, rollup, day, source_max_ingested_at, computed_at)
    select ${orgId}::uuid, ${ROLLUP_DAILY}, d.day,
           (select max(t.updated_at) from transactions t join venues v on v.id = t.venue_id
            where t.org_id = ${orgId}
              and t.occurred_at >= (d.day::timestamp at time zone 'UTC') - interval '1 day'
              and t.occurred_at < (d.day::timestamp at time zone 'UTC') + interval '2 days'
              and (t.occurred_at at time zone v.timezone)::date = d.day),
           ${ctx.now()}::timestamptz
    from unnest(${days}::date[]) as d(day)
    where d.day = any(${changedDays}::date[])
       or not exists (select 1 from rollup_state r where r.org_id = ${orgId} and r.rollup = ${ROLLUP_DAILY} and r.day = d.day)
    on conflict (org_id, rollup, day) do update
      set source_max_ingested_at = excluded.source_max_ingested_at, computed_at = excluded.computed_at`.execute(ctx.db);
  return changedDays;
}

/**
 * The customer snapshot: one row per identified customer with their order history summarised,
 * RFM scores and a segment, as of today in the org's zone. Merged like the daily facts, so an
 * unchanged customer's row is not rewritten. Returns how many rows were written or removed.
 */
export async function snapshotCustomers(ctx: Ctx): Promise<{ asOf: string; changed: number }> {
  requireInternal(ctx);
  const orgId = ctx.orgId;
  const settings = await getAnalyticsSettings(ctx);
  const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', orgId).executeTakeFirstOrThrow();
  const venueIds = (await ctx.db.selectFrom('venues').select('id').where('org_id', '=', orgId).execute()).map((v) => v.id);
  const asOf = localDate(ctx.now(), org.timezone);
  const cols = ['first_order_at', 'second_order_at', 'last_order_at', 'orders', 'spend_cents', 'avg_order_cents', 'days_to_second_order', 'recency_days', 'r_score', 'f_score', 'm_score', 'segment', 'favourite_channel', 'favourite_venue_id', 'first_order_day', 'last_order_day'];
  const list = cols.join(', ');
  const r = await sql<{ n: number }>`
    with ${sql.join(customerCtes({ orgId, venueIds, asOf, settings }), sql`, `)},
    a_up as (
      insert into fact_customer (org_id, customer_id, ${sql.raw(list)}, computed_at)
      select ${orgId}::uuid, customer_id, ${sql.raw(list)}, ${ctx.now()}::timestamptz from a_scored
      on conflict (org_id, customer_id) do update set ${sql.raw(cols.map((c) => `${c} = excluded.${c}`).join(', '))}, computed_at = excluded.computed_at
      where (${sql.raw(cols.map((c) => `fact_customer.${c}`).join(', '))}) is distinct from (${sql.raw(cols.map((c) => `excluded.${c}`).join(', '))})
      returning 1
    ),
    a_del as (
      delete from fact_customer f
      where f.org_id = ${orgId} and not exists (select 1 from a_scored s where s.customer_id = f.customer_id)
      returning 1
    )
    select ((select count(*) from a_up) + (select count(*) from a_del))::int as n`.execute(ctx.db);
  return { asOf, changed: r.rows[0]!.n };
}

/**
 * One roll-up at a time per org. Two workers merging the same days would each be right, but
 * could deadlock on the rows they share; the lock is held to the end of the transaction.
 */
async function lock(ctx: Ctx): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`analytics.rollup:${ctx.orgId}`}, 0))`.execute(ctx.db);
}

/**
 * Remember where the ledger stood when this run began, and which venue time zones the days
 * were cut by. Promoted to the cursor when the run finishes.
 */
async function markCursorNext(ctx: Ctx): Promise<void> {
  await sql`
    insert into rollup_state (org_id, rollup, day, source_max_ingested_at, computed_at, signature)
    select ${ctx.orgId}::uuid, ${CURSOR_NEXT}, ${MARKER_DAY}::date,
           coalesce((select max(t.updated_at) from transactions t where t.org_id = ${ctx.orgId}), 'epoch'::timestamptz),
           ${ctx.now()}::timestamptz,
           ${frameSql(sql`${ctx.orgId}::uuid`)}
    on conflict (org_id, rollup, day) do update
      set source_max_ingested_at = excluded.source_max_ingested_at, computed_at = excluded.computed_at, signature = excluded.signature
      where (rollup_state.source_max_ingested_at, rollup_state.signature) is distinct from (excluded.source_max_ingested_at, excluded.signature)`.execute(ctx.db);
}

async function allDataDays(ctx: Ctx, from: string | null, to: string | null): Promise<string[]> {
  const r = await sql<{ day: string }>`
    select distinct d.day from (
      select (t.occurred_at at time zone v.timezone)::date as day
      from transactions t join venues v on v.id = t.venue_id where t.org_id = ${ctx.orgId}
      union
      select (e.occurred_at at time zone coalesce(v.timezone, o.timezone))::date
      from events e join orgs o on o.id = e.org_id left join venues v on v.id = e.venue_id where e.org_id = ${ctx.orgId}
      union
      select (s.first_seen_at at time zone coalesce(v.timezone, o.timezone))::date
      from visitor_sessions s join orgs o on o.id = s.org_id left join venues v on v.id = s.venue_id where s.org_id = ${ctx.orgId}
      union
      select (c.acquisition_at at time zone coalesce(v.timezone, o.timezone))::date
      from customers c join orgs o on o.id = c.org_id left join venues v on v.id = c.first_seen_venue_id where c.org_id = ${ctx.orgId}
      union
      select r.day from rollup_state r where r.org_id = ${ctx.orgId} and r.rollup = ${ROLLUP_DAILY}
    ) d
    where (${from}::date is null or d.day >= ${from}::date) and (${to}::date is null or d.day <= ${to}::date)
    order by d.day`.execute(ctx.db);
  return r.rows.map((x) => x.day);
}

/**
 * The days a sale change since the cursor can have affected. A change to one sale can move
 * "new" and "returning" on the customer's other days, so those days are included.
 */
async function changedSaleDays(ctx: Ctx, overlap: string): Promise<string[]> {
  const r = await sql<{ day: string }>`
    with a_cur as (
      select source_max_ingested_at as at from rollup_state
      where org_id = ${ctx.orgId} and rollup = ${ROLLUP_CURSOR} and day = ${MARKER_DAY}::date
    ),
    a_changed as (
      select t.customer_id, (t.occurred_at at time zone v.timezone)::date as day
      from transactions t join venues v on v.id = t.venue_id
      where t.org_id = ${ctx.orgId} and t.updated_at > (select at - ${overlap}::interval from a_cur)
    )
    select day from a_changed
    union
    select (t.occurred_at at time zone v.timezone)::date
    from transactions t join venues v on v.id = t.venue_id
    where t.org_id = ${ctx.orgId} and t.customer_id in (select customer_id from a_changed where customer_id is not null)`.execute(ctx.db);
  return r.rows.map((x) => x.day);
}

async function finish(ctx: Ctx, daysChanged: string[]): Promise<{ snapshot: boolean; changed: number }> {
  const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const settings = await getAnalyticsSettings(ctx);
  const wanted = customersSignature(localDate(ctx.now(), org.timezone), settings);
  const s = await sql<{ moved: boolean; customers: string | null; level: boolean | null }>`
    select ((c.source_max_ingested_at, c.signature) is distinct from (n.source_max_ingested_at, n.signature)) as moved,
           k.signature as customers,
           (k.source_max_ingested_at = n.source_max_ingested_at) as level
    from rollup_state n
    left join rollup_state c on c.org_id = n.org_id and c.rollup = ${ROLLUP_CURSOR} and c.day = n.day
    left join rollup_state k on k.org_id = n.org_id and k.rollup = ${ROLLUP_CUSTOMERS} and k.day = n.day
    where n.org_id = ${ctx.orgId} and n.rollup = ${CURSOR_NEXT} and n.day = ${MARKER_DAY}::date`.execute(ctx.db);
  const st = s.rows[0]!;
  let snapshot = false;
  let changed = 0;
  // Recency moves every day and the segment rules are a setting, so the snapshot is retaken
  // when the day or the rules change, even if no sale did.
  if (daysChanged.length || st.moved || st.customers !== wanted || st.level !== true) {
    const snap = await snapshotCustomers(ctx);
    snapshot = true;
    changed = snap.changed;
    await sql`
      insert into rollup_state (org_id, rollup, day, source_max_ingested_at, computed_at, signature)
      select n.org_id, ${ROLLUP_CUSTOMERS}, n.day, n.source_max_ingested_at, ${ctx.now()}::timestamptz, ${customersSignature(snap.asOf, settings)}
      from rollup_state n
      where n.org_id = ${ctx.orgId} and n.rollup = ${CURSOR_NEXT} and n.day = ${MARKER_DAY}::date
      on conflict (org_id, rollup, day) do update
        set source_max_ingested_at = excluded.source_max_ingested_at, computed_at = excluded.computed_at, signature = excluded.signature`.execute(ctx.db);
  }
  await sql`
    insert into rollup_state (org_id, rollup, day, source_max_ingested_at, computed_at, signature)
    select n.org_id, ${ROLLUP_CURSOR}, n.day, n.source_max_ingested_at, ${ctx.now()}::timestamptz, n.signature
    from rollup_state n
    where n.org_id = ${ctx.orgId} and n.rollup = ${CURSOR_NEXT} and n.day = ${MARKER_DAY}::date
    on conflict (org_id, rollup, day) do update
      set source_max_ingested_at = excluded.source_max_ingested_at, computed_at = excluded.computed_at, signature = excluded.signature
      where (rollup_state.source_max_ingested_at, rollup_state.signature) is distinct from (excluded.source_max_ingested_at, excluded.signature)`.execute(ctx.db);
  return { snapshot, changed };
}

/**
 * Bring an org's facts level with its ledger. Safe to run at any time and any number of times.
 *
 *   incremental  the days touched by sales that changed since the last run (and the other days
 *                of the customers involved), plus the last few days for late events
 *   reconcile    that, looking a full day back past the cursor, plus every day with data in
 *                the last five weeks
 *
 * An org that has never been rolled up, or whose venues' time zones have changed since it was
 * (which moves every day boundary), is rebuilt in full instead.
 */
export async function rollup(app: App, orgId: string, opts: { mode?: 'incremental' | 'reconcile' } = {}): Promise<RollupResult> {
  const mode = opts.mode ?? 'incremental';
  const state = await app.tenant(orgId, WORKER, (ctx) => factsState(ctx));
  if (!state.cursor || !state.frameOk) return backfill(app, orgId);
  return app.tenant(orgId, WORKER, async (ctx) => {
    await lock(ctx);
    await markCursorNext(ctx);
    const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', orgId).executeTakeFirstOrThrow();
    const today = localDate(ctx.now(), org.timezone);
    const set = new Set(await changedSaleDays(ctx, mode === 'reconcile' ? RECONCILE_OVERLAP : CURSOR_OVERLAP));
    for (let i = -TRAILING_DAYS; i <= 1; i++) set.add(addDays(today, i));
    if (mode === 'reconcile') for (const d of await allDataDays(ctx, addDays(today, -RECONCILE_DAYS), null)) set.add(d);
    const days = [...set].sort();
    const daysChanged = await rollupDays(ctx, days);
    const fin = await finish(ctx, daysChanged);
    return { mode, daysExamined: days.length, daysChanged, customersSnapshot: fin.snapshot, customersChanged: fin.changed };
  });
}

/**
 * Rebuild the facts from source for a date range, or for all of history. The entry point for a
 * new venue's imported history, after a definition change, and for the fixtures. Works through
 * the days in chunks, each in its own transaction, so a long history never holds one open.
 */
export async function backfill(app: App, orgId: string, opts: { from?: string; to?: string; chunkDays?: number } = {}): Promise<RollupResult> {
  const chunk = Math.max(1, opts.chunkDays ?? 120);
  const days = await app.tenant(orgId, WORKER, async (ctx) => {
    await lock(ctx);
    await markCursorNext(ctx);
    return allDataDays(ctx, opts.from ?? null, opts.to ?? null);
  });
  const daysChanged: string[] = [];
  for (let i = 0; i < days.length; i += chunk) {
    const part = days.slice(i, i + chunk);
    daysChanged.push(
      ...(await app.tenant(orgId, WORKER, async (ctx) => {
        await lock(ctx);
        return rollupDays(ctx, part);
      })),
    );
  }
  // A partial back-fill must not claim the whole ledger is rolled up: only a full one moves the cursor.
  const full = !opts.from && !opts.to;
  const fin = await app.tenant(orgId, WORKER, async (ctx) => {
    await lock(ctx);
    if (full) return finish(ctx, daysChanged);
    const snap = await snapshotCustomers(ctx);
    return { snapshot: true, changed: snap.changed };
  });
  return { mode: 'backfill', daysExamined: days.length, daysChanged, customersSnapshot: fin.snapshot, customersChanged: fin.changed };
}
