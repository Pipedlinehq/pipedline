import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, appendFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, inspectDatabase, migrationProblems, readMigrationStatus, runMigrations } from '../../../../scripts/db-migrate';

/**
 * scripts/db-migrate.ts against EMPTY databases on the test server: not the seeded fixture
 * template every other test clones. What a deployment depends on: every file applied once and
 * recorded, a second run that does nothing, a changed file refused, and a database user who is
 * not a superuser left able to do tenant work.
 */
const run = randomBytes(4).toString('hex');
const port = () => process.env.ROS_TEST_PG_PORT!;
const url = (database: string, user = 'postgres', password = 'postgres') => `postgres://${user}:${password}@127.0.0.1:${port()}/${database}`;
const databases: string[] = [];
const roles: string[] = [];
const dirs: string[] = [];

async function admin<T>(fn: (c: pg.Client) => Promise<T>, database = 'postgres'): Promise<T> {
  const c = new pg.Client({ connectionString: url(database) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function emptyDatabase(owner?: string): Promise<string> {
  const name = `mig_${run}_${databases.length}`;
  await admin((c) => c.query(`create database "${name}"${owner ? ` owner "${owner}"` : ''}`));
  databases.push(name);
  return name;
}

/** A copy of the real migrations that a test may alter. */
async function migrationsCopy(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ros-mig-'));
  dirs.push(dir);
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  return dir;
}

const ledger = (database: string) => admin(async (c) => (await c.query('select name, checksum, applied_at from schema_migrations order by name')).rows, database);

let files: string[];
beforeAll(async () => {
  files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
});

afterAll(async () => {
  await admin(async (c) => {
    for (const d of databases) await c.query(`drop database if exists "${d}" with (force)`);
    for (const r of roles) {
      await c.query(`drop owned by "${r}"`).catch(() => {});
      await c.query(`drop role if exists "${r}"`);
    }
  });
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('scripts/db-migrate.ts', () => {
  it('applies every migration to an empty database, in name order, and records each one', async () => {
    const db = await emptyDatabase();
    expect((await readMigrationStatus(url(db))).pending).toEqual(files);

    const first = await runMigrations(url(db));
    expect(first.applied).toEqual(files);
    expect(first.skipped).toBe(0);

    const rows = await ledger(db);
    expect(rows.map((r) => r.name)).toEqual(files);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.checksum))).toBe(true);
    // The schema is really there, and empty: no fixture came with it.
    const counts = await admin(async (c) => (await c.query('select (select count(*) from orgs)::int as orgs, (select count(*) from users)::int as users, (select count(*) from platform_admins)::int as admins')).rows[0], db);
    expect(counts).toEqual({ orgs: 0, users: 0, admins: 0 });
    const status = await readMigrationStatus(url(db));
    expect(status).toEqual({ applied: files, pending: [], changed: [], unknown: [] });
    expect(migrationProblems(status)).toEqual([]);
  });

  it('does nothing the second time', async () => {
    const db = await emptyDatabase();
    await runMigrations(url(db));
    const before = await ledger(db);

    const second = await runMigrations(url(db));
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(files.length);
    expect(second.grantedTenantRole).toBe(false);
    // Not re-recorded: the same rows with the same timestamps.
    expect(await ledger(db)).toEqual(before);
  });

  it('two runners at once apply each file exactly once', async () => {
    const db = await emptyDatabase();
    const [a, b] = await Promise.all([runMigrations(url(db)), runMigrations(url(db))]);
    expect([...a.applied, ...b.applied].sort()).toEqual(files);
    expect((await ledger(db)).length).toBe(files.length);
  });

  it('refuses a file that changed after it was applied, and changes nothing', async () => {
    const db = await emptyDatabase();
    const dir = await migrationsCopy();
    await runMigrations(url(db), dir);
    const before = await ledger(db);

    const edited = files[2]!;
    await appendFile(path.join(dir, edited), '\n-- edited after the fact\n');
    // A later, new migration must not slip in behind the refusal either.
    await writeFile(path.join(dir, '9999_later.sql'), 'create table later_table (id int);\n');

    await expect(runMigrations(url(db), dir)).rejects.toThrow(`Migration ${edited} changed after it was applied`);
    expect(await ledger(db)).toEqual(before);
    const exists = await admin(async (c) => (await c.query("select to_regclass('public.later_table') as t")).rows[0].t, db);
    expect(exists).toBeNull();

    const status = await readMigrationStatus(url(db), dir);
    expect(status.changed).toEqual([edited]);
    expect(status.pending).toEqual(['9999_later.sql']);
    expect(migrationProblems(status).join('\n')).toMatch(/changed after being applied/);
  });

  it('applies only the new file when one is added, and reports a database newer than the checkout', async () => {
    const db = await emptyDatabase();
    const dir = await migrationsCopy();
    await runMigrations(url(db), dir);
    await writeFile(path.join(dir, '9998_added.sql'), "create table added_table (id int);\ncomment on table added_table is '@platform';\nselect app.apply_tenant_rls();\n");

    const r = await runMigrations(url(db), dir);
    expect(r.applied).toEqual(['9998_added.sql']);
    expect(r.skipped).toBe(files.length);

    // The same database seen from the original checkout, which has no such file.
    const older = await readMigrationStatus(url(db));
    expect(older.unknown).toEqual(['9998_added.sql']);
    expect(migrationProblems(older).join('\n')).toMatch(/code is older than the database/);
  });

  it('a failing migration is rolled back whole and is not recorded', async () => {
    const db = await emptyDatabase();
    const dir = await migrationsCopy();
    await writeFile(path.join(dir, '9997_broken.sql'), 'create table half_made (id int);\nselect this_function_does_not_exist();\n');
    await expect(runMigrations(url(db), dir)).rejects.toThrow(/Migration 9997_broken\.sql failed/);
    const state = await admin(async (c) => (await c.query("select to_regclass('public.half_made') as t, (select count(*)::int from schema_migrations where name = '9997_broken.sql') as n")).rows[0], db);
    expect(state).toEqual({ t: null, n: 0 });
  });

  it('leaves a database user who is not a superuser able to do tenant work, and says so when a user cannot', async () => {
    const owner = `deployer_${run}`;
    const other = `stranger_${run}`;
    roles.push(owner, other);
    await admin(async (c) => {
      await c.query(`create role "${owner}" login createrole password 'pw'`);
      await c.query(`create role "${other}" login password 'pw'`);
      // On a fresh server the user who creates app_tenant holds it with the admin option but may
      // not switch to it (Postgres 16 and later). Here the role already exists, so that state is given.
      await c.query(`grant app_tenant to "${owner}" with admin true, set false, inherit false`);
    });
    const db = await emptyDatabase(owner);

    const r = await runMigrations(url(db, owner, 'pw'));
    expect(r.applied).toEqual(files);
    expect(r.grantedTenantRole).toBe(true);

    // The switch every tenant transaction makes (packages/core/src/app.ts) now works for that user.
    const c = new pg.Client({ connectionString: url(db, owner, 'pw') });
    await c.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('role', 'app_tenant', true), set_config('app.org_id', '00000000-0000-4000-8000-000000000000', true)");
      expect((await c.query('select current_user as u, count(*)::int as n from orgs group by 1')).rows).toEqual([]);
      expect((await c.query('select current_user as u')).rows[0].u).toBe('app_tenant');
      await c.query('rollback');
    } finally {
      await c.end();
    }
    expect((await inspectDatabase(url(db, owner, 'pw'))).problems).toEqual([]);
    expect((await runMigrations(url(db, owner, 'pw'))).grantedTenantRole).toBe(false);

    // A different user on the same database is told plainly why it will not work.
    await admin((c2) => c2.query(`grant connect on database "${db}" to "${other}"`));
    const report = await inspectDatabase(url(db, other, 'pw'));
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/cannot read the schema .* must connect as the user that ran the migrations/);
  });

  it('inspecting a database reports what is missing and never changes it', async () => {
    const db = await emptyDatabase();
    const empty = await inspectDatabase(url(db));
    expect(empty.problems.join('\n')).toMatch(new RegExp(`${files.length} migrations are not applied yet`));
    // Looking did not create the ledger table.
    expect(await admin(async (c) => (await c.query("select to_regclass('public.schema_migrations') as t")).rows[0].t, db)).toBeNull();

    await runMigrations(url(db));
    const ready = await inspectDatabase(url(db));
    expect(ready.problems).toEqual([]);
    expect(ready.notes.join('\n')).toMatch(/No platform admin yet/);

    const unreachable = await inspectDatabase('postgres://postgres:postgres@127.0.0.1:1/nothing');
    expect(unreachable.problems[0]).toMatch(/could not be reached/);
    expect(unreachable.problems.join(' ')).not.toContain('postgres:postgres');
  });
});
