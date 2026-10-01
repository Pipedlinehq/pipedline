import { sql } from 'kysely';
import { type ConnectionRow, resolveConnection } from '@ros/core';
import type { TestEnv } from '@ros/testkit';

export const POS_JOBS = ['ledger.pos_reconcile', 'ledger.pos_ingest'];
export const WEBHOOK_URL = 'https://console.rosplatform.test/webhooks/pos/sim-pos';

export interface SeededPos {
  connectionId: string;
  orgId: string;
  venueId: string;
  accountRef: string;
  locationRef: string;
  /** The secret this connection's webhooks are signed with. */
  secret: string;
}

/** The sim-pos connection the fixture seeder made for a venue. */
export async function seededPos(t: TestEnv, orgId: string, venueId: string): Promise<SeededPos> {
  const row = await t.db
    .selectFrom('connections')
    .select(['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'])
    .where('org_id', '=', orgId)
    .where('venue_id', '=', venueId)
    .where('plug_key', '=', 'sim-pos')
    .executeTakeFirstOrThrow();
  const handle = await resolveConnection(t.app, row as ConnectionRow);
  return {
    connectionId: row.id,
    orgId,
    venueId,
    accountRef: row.external_account_id,
    locationRef: String((row.config as { locationRef: string }).locationRef),
    secret: handle.credentials.webhookSecret!,
  };
}

export interface LedgerTotals {
  count: number;
  totalCents: number;
  refundedCents: number;
  tipCents: number;
}

/** What the ledger holds from the simulated POS (never the seeded history, whose refs start "fx-"). */
export async function ledgerTotals(t: TestEnv, orgId: string, venueId?: string): Promise<LedgerTotals> {
  const r = await sql<{ count: number; total: number; refunded: number; tip: number }>`
    select count(*)::int as count, coalesce(sum(total_cents), 0)::int as total,
           coalesce(sum(refunded_cents), 0)::int as refunded, coalesce(sum(tip_cents), 0)::int as tip
    from transactions
    where org_id = ${orgId} and source = 'sim' and external_ref like 'simpos_%' and status <> 'voided'
      and (${venueId ?? null}::uuid is null or venue_id = ${venueId ?? null}::uuid)`.execute(t.db);
  const x = r.rows[0]!;
  return { count: x.count, totalCents: x.total, refundedCents: x.refunded, tipCents: x.tip };
}

export async function ledgerRow(t: TestEnv, externalRef: string) {
  return t.db
    .selectFrom('transactions')
    .select(['id', 'org_id', 'venue_id', 'status', 'total_cents', 'refunded_cents', 'subtotal_cents', 'discount_cents', 'tip_cents', 'customer_id', 'occurred_at', 'tender_type', 'raw'])
    .where('external_ref', '=', externalRef)
    .execute();
}

export async function connectionState(t: TestEnv, connectionId: string) {
  return t.db.selectFrom('connections').select(['status', 'last_error', 'last_ok_at']).where('id', '=', connectionId).executeTakeFirstOrThrow();
}

/** Every table in the database, searched as text for a value. Returns the tables that contain it. */
export async function tablesContaining(t: TestEnv, needle: string): Promise<string[]> {
  const tables = await sql<{ name: string }>`
    select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by 1`.execute(t.db);
  const hits: string[] = [];
  for (const { name } of tables.rows) {
    const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(name)} x where x::text like ${'%' + needle + '%'}`.execute(t.db);
    if (r.rows[0]!.n > 0) hits.push(name);
  }
  return hits;
}
