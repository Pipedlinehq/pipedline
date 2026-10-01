import { type RawBuilder, sql } from 'kysely';
import type { Ctx } from '@ros/core';
import type { AnalyticsSettings } from './settings';

/** rollup_state.rollup values. One row per org-day for DAILY; one marker row each for the others. */
export const ROLLUP_DAILY = 'daily';
export const ROLLUP_CURSOR = 'cursor';
export const CURSOR_NEXT = 'cursor_next';
export const ROLLUP_CUSTOMERS = 'customers';
export const MARKER_DAY = '1970-01-01';

/**
 * A fingerprint of what the day boundaries depend on: each venue and its time zone. Stored on
 * the cursor; when a venue's zone changes every local day moves, and the facts are rebuilt.
 */
export function frameSql(orgId: RawBuilder<unknown>): RawBuilder<unknown> {
  return sql`(select md5(coalesce(string_agg(fv.id::text || '=' || fv.timezone, ',' order by fv.id), '')) from venues fv where fv.org_id = ${orgId})`;
}

/** What a customer snapshot depends on besides the ledger: the day it describes and the segment rules. */
export function customersSignature(asOf: string, settings: AnalyticsSettings): string {
  return `${asOf}#${JSON.stringify(settings.segments)}`;
}

export interface FactsState {
  /** The ledger change the daily facts have been rolled up through. Null before the first roll-up. */
  cursor: Date | null;
  /** True when the venues' time zones are the ones the facts were cut by. */
  frameOk: boolean;
  /** True when no sale has been added or changed since the cursor: the sales facts equal the ledger. */
  salesFresh: boolean;
  /** When the daily facts were last computed. */
  computedAt: Date | null;
  /** What the customer snapshot describes (see customersSignature), and whether the ledger has changed since. */
  customersSignature: string | null;
  customersAsOf: string | null;
  customersFresh: boolean;
}

/**
 * Are the derived facts level with the ledger right now? Cheap: two marker rows and one index
 * probe. Queries in 'auto' mode read facts only when this says they are level, and otherwise
 * read the ledger, so a derived table can never make an answer wrong, only slower.
 *
 * The comparison is done inside Postgres on purpose: the cursor is a microsecond timestamp and
 * would lose precision on a round trip through a JavaScript Date.
 */
export async function factsState(ctx: Ctx): Promise<FactsState> {
  const r = await sql<{ cursor: Date | null; computed_at: Date | null; changed: boolean; frame_ok: boolean; customers: string | null; customers_level: boolean | null }>`
    select c.source_max_ingested_at as cursor,
           c.computed_at,
           exists (
             select 1 from transactions t
             where t.org_id = c.org_id and t.updated_at > c.source_max_ingested_at
           ) as changed,
           (c.signature is not distinct from ${frameSql(sql`c.org_id`)}) as frame_ok,
           k.signature as customers,
           (k.source_max_ingested_at = c.source_max_ingested_at) as customers_level
    from rollup_state c
    left join rollup_state k on k.org_id = c.org_id and k.rollup = ${ROLLUP_CUSTOMERS} and k.day = ${MARKER_DAY}::date
    where c.org_id = ${ctx.orgId} and c.rollup = ${ROLLUP_CURSOR} and c.day = ${MARKER_DAY}::date`.execute(ctx.db);
  const row = r.rows[0];
  if (!row?.cursor) return { cursor: null, frameOk: false, salesFresh: false, computedAt: null, customersSignature: null, customersAsOf: null, customersFresh: false };
  const salesFresh = !row.changed && row.frame_ok;
  return {
    cursor: row.cursor,
    frameOk: row.frame_ok,
    salesFresh,
    computedAt: row.computed_at,
    customersSignature: row.customers,
    customersAsOf: row.customers?.split('#')[0] ?? null,
    customersFresh: salesFresh && row.customers_level === true,
  };
}

/** Latest sale in the venues asked about: when it happened and when it reached the ledger. */
export async function ledgerFreshness(ctx: Ctx, venueIds: string[]): Promise<{ latestSaleAt: Date | null; latestIngestedAt: Date | null }> {
  const r = await sql<{ occurred: Date | null; ingested: Date | null }>`
    select max(t.occurred_at) as occurred, max(t.ingested_at) as ingested
    from transactions t
    where t.org_id = ${ctx.orgId} and t.venue_id = any(${venueIds}::uuid[])`.execute(ctx.db);
  return { latestSaleAt: r.rows[0]?.occurred ?? null, latestIngestedAt: r.rows[0]?.ingested ?? null };
}
