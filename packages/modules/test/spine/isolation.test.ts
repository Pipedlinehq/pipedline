import { describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { useTestEnv } from '@ros/testkit';

/**
 * The control everything else rests on (docs/THREAT_MODEL.md section 5). These run against the
 * full seeded fixture, two orgs with real volumes, for every table in the schema.
 */
describe('tenant isolation', () => {
  const t = useTestEnv();

  interface TableInfo {
    name: string;
    tag: string;
    hasOrg: boolean;
    rls: boolean;
  }

  async function tables(): Promise<TableInfo[]> {
    const r = await sql<{ name: string; tag: string | null; has_org: boolean; rls: boolean }>`
      select c.relname as name,
             obj_description(c.oid, 'pg_class') as tag,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped) as has_org,
             c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'schema_migrations'
      order by 1`.execute(t.db);
    return r.rows.map((x) => ({ name: x.name, tag: x.tag ?? '', hasOrg: x.has_org, rls: x.rls }));
  }

  async function privileges(table: string): Promise<string[]> {
    const r = await sql<{ p: string }>`
      select privilege_type as p from information_schema.role_table_grants
      where grantee = 'app_tenant' and table_schema = 'public' and table_name = ${table}`.execute(t.db);
    return r.rows.map((x) => x.p).sort();
  }

  it('row-level security is on for every table', async () => {
    const off = (await tables()).filter((x) => !x.rls).map((x) => x.name);
    expect(off).toEqual([]);
  });

  it('every table is classified: tenant, shared, reference or platform', async () => {
    const unclassified: string[] = [];
    for (const tb of await tables()) {
      if (tb.name === 'orgs') continue;
      const tagged = /@(platform|reference|append_only|shared_read)/.test(tb.tag);
      // A table with no org_id and no tag would silently be unreachable; make that a decision, not an accident.
      if (!tb.hasOrg && !tagged) unclassified.push(tb.name);
    }
    expect(unclassified).toEqual([]);
  });

  it('the tenant role has no privilege on platform tables', async () => {
    for (const tb of (await tables()).filter((x) => x.tag.includes('@platform'))) {
      expect(await privileges(tb.name), tb.name).toEqual([]);
    }
  });

  it('append-only tables cannot be updated or deleted by the tenant role', async () => {
    const appendOnly = (await tables()).filter((x) => x.tag.includes('@append_only'));
    expect(appendOnly.length).toBeGreaterThan(8);
    for (const tb of appendOnly) expect(await privileges(tb.name), tb.name).toEqual(['INSERT', 'SELECT']);
  });

  it('reference tables are read-only to tenants', async () => {
    for (const tb of (await tables()).filter((x) => x.tag.includes('@reference'))) {
      expect(await privileges(tb.name), tb.name).toEqual(['SELECT']);
    }
  });

  it('one org can read no row of another, in any table', async () => {
    const { diner, group } = t.fixture;
    const leaks: string[] = [];
    let checked = 0;
    await t.app.tenant(diner.orgId, { kind: 'worker', job: 'leak-test' }, async (ctx) => {
      for (const tb of await tables()) {
        if (!tb.hasOrg || tb.tag.includes('@platform')) continue;
        const r = await sql<{ n: number }>`select count(*)::int as n from ${sql.table(tb.name)} where org_id = ${group.orgId}`.execute(ctx.db);
        checked++;
        if (r.rows[0]!.n > 0) leaks.push(tb.name);
      }
      const orgs = await sql<{ id: string }>`select id from orgs`.execute(ctx.db);
      expect(orgs.rows.map((o) => o.id)).toEqual([diner.orgId]);
    });
    expect(checked).toBeGreaterThan(60);
    expect(leaks).toEqual([]);
  });

  it('the fixture really has data on both sides, so the leak test means something', async () => {
    for (const org of [t.fixture.diner, t.fixture.group]) {
      const n = await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll<number>().as('n')).where('org_id', '=', org.orgId).executeTakeFirstOrThrow();
      expect(Number(n.n)).toBeGreaterThan(500);
    }
  });

  it('one org cannot write a row into another', async () => {
    const { diner, group } = t.fixture;
    await expect(
      t.app.tenant(diner.orgId, { kind: 'worker', job: 'leak-test' }, (ctx) =>
        ctx.db.insertInto('customers').values({ org_id: group.orgId, first_name: 'Intruder' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('one org cannot update or delete another org\'s rows', async () => {
    const { diner, group } = t.fixture;
    const before = await t.db.selectFrom('venues').select(['id', 'name']).where('org_id', '=', group.orgId).execute();
    await t.app.tenant(diner.orgId, { kind: 'worker', job: 'leak-test' }, async (ctx) => {
      const updated = await ctx.db.updateTable('venues').set({ name: 'Taken over' }).where('org_id', '=', group.orgId).execute();
      expect(Number(updated[0]?.numUpdatedRows ?? 0)).toBe(0);
      const deleted = await ctx.db.deleteFrom('trading_hours').where('org_id', '=', group.orgId).execute();
      expect(Number(deleted[0]?.numDeletedRows ?? 0)).toBe(0);
    });
    const after = await t.db.selectFrom('venues').select(['id', 'name']).where('org_id', '=', group.orgId).execute();
    expect(after).toEqual(before);
  });

  it('with no org set, the tenant role sees nothing', async () => {
    const n = await t.db.transaction().execute(async (trx) => {
      await sql`set local role app_tenant`.execute(trx);
      const r = await sql<{ n: number }>`select count(*)::int as n from customers`.execute(trx);
      return r.rows[0]!.n;
    });
    expect(n).toBe(0);
  });

  it('the tenant role cannot read secrets, sessions or one-time codes', async () => {
    for (const table of ['secrets', 'sessions', 'otp_codes', 'users', 'webhook_events']) {
      await expect(
        t.app.tenant(t.fixture.diner.orgId, { kind: 'worker', job: 'leak-test' }, (ctx) => sql`select 1 from ${sql.table(table)} limit 1`.execute(ctx.db)),
        table,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('tenant() refuses anything that is not a uuid', async () => {
    await expect(t.app.tenant("x'; drop table orgs; --", { kind: 'anon' }, async () => 1)).rejects.toThrow(/uuid/);
  });

  it('no raw card identifier is stored anywhere', async () => {
    const inRaw = await sql<{ n: number }>`
      select count(*)::int as n from transactions where raw::text ~* '"(fingerprint|payment_account_reference|par)"'`.execute(t.db);
    expect(inRaw.rows[0]!.n).toBe(0);
    const unhashed = await sql<{ n: number }>`
      select count(*)::int as n from customer_identities where kind in ('card_fingerprint','card_par') and value !~ '^[0-9a-f]{64}$'`.execute(t.db);
    expect(unhashed.rows[0]!.n).toBe(0);
    // The fixture writes card references as "fp-…" / "par-…"; none may survive in any text column.
    const anywhere = await sql<{ n: number }>`select count(*)::int as n from customer_identities where value like 'fp-%' or value like 'par-%'`.execute(t.db);
    expect(anywhere.rows[0]!.n).toBe(0);
  });

  it('card links exist only for guests who ticked the card box', async () => {
    const r = await sql<{ n: number }>`
      select count(*)::int as n from customer_identities ci
      where ci.kind in ('card_fingerprint','card_par')
        and not exists (select 1 from consents c where c.customer_id = ci.customer_id and c.purpose = 'card_recognition' and c.status = 'granted')`.execute(t.db);
    expect(r.rows[0]!.n).toBe(0);
    const linked = await sql<{ n: number }>`select count(*)::int as n from customer_identities where kind in ('card_fingerprint','card_par')`.execute(t.db);
    expect(linked.rows[0]!.n).toBeGreaterThan(10);
  });
});
