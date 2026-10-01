/**
 * The migration runner for a real deployment: applies db/migrations/*.sql, in name order, to
 * the database at DATABASE_URL.
 *
 *   pnpm db:migrate              apply what is pending
 *   pnpm db:migrate -- --status  say what is applied and what is pending; change nothing
 *
 * It is the same `migrate` the tests and the development stack use (packages/core/src/db.ts):
 * each file runs in its own transaction and is recorded in `schema_migrations` with a checksum,
 * so a second run does nothing, and a file that changed after it was applied is refused.
 * Around that it adds what a shared database needs: one runner at a time (an advisory lock), and
 * a check that the role the app switches to for tenant work (`app_tenant`, created by the first
 * migration) can really be assumed by this database user.
 *
 * Run it as the database user the app will run as. That user owns the tables, which is what
 * lets platform code read across organisations while tenant code is held to its own rows.
 *
 * Exit code 0 when the database is up to date afterwards, 1 otherwise. No secret is printed.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { type MigrationStatus, migrate, migrationStatus } from '@ros/core';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

/** An arbitrary constant: every runner on one database takes the same lock. */
const LOCK_KEY = 7_405_118_021;

export interface MigrateOutcome {
  applied: string[];
  skipped: number;
  /** True when `app_tenant` had to be granted to the database user (it is done once). */
  grantedTenantRole: boolean;
}

/**
 * Tenant transactions run as role `app_tenant` (packages/core/src/app.ts). A superuser can
 * always switch to it; on Postgres 16 and later an ordinary user who created the role holds it
 * with the admin option only, and has to grant it to itself before it can switch. Tried, not
 * inferred, so the answer holds on every Postgres version.
 */
export async function ensureTenantRole(pool: pg.Pool): Promise<{ granted: boolean }> {
  const canSwitch = async (): Promise<string | null> => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('role', 'app_tenant', true)");
      return null;
    } catch (e) {
      return (e as Error).message;
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }
  };
  if ((await canSwitch()) === null) return { granted: false };
  try {
    await pool.query('grant app_tenant to current_user');
  } catch (e) {
    throw new Error(`This database user cannot act as the role "app_tenant", and could not grant it to itself (${(e as Error).message}). As a database administrator run:  grant app_tenant to <the app's database user>;`, { cause: e });
  }
  const still = await canSwitch();
  if (still) throw new Error(`This database user still cannot act as the role "app_tenant" (${still}). As a database administrator run:  grant app_tenant to <the app's database user>;`);
  return { granted: true };
}

/** Apply pending migrations to `url`. Safe to run twice, and safe to run from two places at once. */
export async function runMigrations(url: string, dir: string = MIGRATIONS_DIR): Promise<MigrateOutcome> {
  // Two connections: one holds the lock for the whole run, the other does the work.
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 10_000 });
  try {
    const lock = await pool.connect();
    try {
      await lock.query('select pg_advisory_lock($1)', [LOCK_KEY]);
      const result = await migrate(pool, dir);
      const role = await ensureTenantRole(pool);
      return { ...result, grantedTenantRole: role.granted };
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
      lock.release();
    }
  } finally {
    await pool.end();
  }
}

export async function readMigrationStatus(url: string, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    return await migrationStatus(pool, dir);
  } finally {
    await pool.end();
  }
}

/** One line per thing that stops the app from running on this database; empty when it is up to date. */
export function migrationProblems(s: MigrationStatus): string[] {
  const out: string[] = [];
  if (s.changed.length) out.push(`${s.changed.length} migration file${s.changed.length === 1 ? '' : 's'} changed after being applied (${s.changed.join(', ')}). Migrations are never edited: restore the file and add a new one.`);
  if (s.pending.length) out.push(`${s.pending.length} migration${s.pending.length === 1 ? ' is' : 's are'} not applied yet (${s.pending[0]}${s.pending.length > 1 ? ` … ${s.pending.at(-1)}` : ''}). Run: pnpm db:migrate`);
  if (s.unknown.length) out.push(`The database has ${s.unknown.length} migration${s.unknown.length === 1 ? '' : 's'} this checkout does not (${s.unknown.join(', ')}): the code is older than the database. Deploy the newer code.`);
  return out;
}

export interface DatabaseReport {
  /** What must be fixed before the app can run on this database. */
  problems: string[];
  /** Facts worth seeing: the server version, how many migrations, how many admins. */
  notes: string[];
}

/**
 * Everything about the database a deployment depends on, read and reported; nothing is changed
 * (the role check runs inside a transaction that is rolled back).
 */
export async function inspectDatabase(url: string, dir: string = MIGRATIONS_DIR): Promise<DatabaseReport> {
  const problems: string[] = [];
  const notes: string[] = [];
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    let who: { db: string; usr: string; version: string; superuser: boolean };
    try {
      who = (await pool.query("select current_database() as db, current_user as usr, current_setting('server_version') as version, (select rolsuper from pg_roles where rolname = current_user) as superuser")).rows[0];
    } catch (e) {
      // pg's own message names the host or the reason, never the password.
      return { problems: [`The database could not be reached: ${(e as Error).message || (e as { code?: string }).code || 'connection refused'}`], notes };
    }
    notes.push(`Database "${who.db}" on Postgres ${who.version}, as user "${who.usr}"${who.superuser ? ' (a superuser)' : ''}.`);

    let status: MigrationStatus;
    try {
      status = await migrationStatus(pool, dir);
    } catch (e) {
      // A user who did not run the migrations cannot read their record, or anything else.
      return { problems: [`This database user cannot read the schema (${(e as Error).message}). The app must connect as the user that ran the migrations: it owns the tables, and any other user sees no rows.`], notes };
    }
    problems.push(...migrationProblems(status));
    if (!status.pending.length && !status.changed.length) notes.push(`All ${status.applied.length} migrations are applied.`);
    if (!status.applied.length) return { problems, notes };

    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('role', 'app_tenant', true)");
    } catch {
      problems.push('This database user cannot act as the role "app_tenant", which every venue request needs. Run pnpm db:migrate as this user (it grants the role), or as an administrator: grant app_tenant to <this user>;');
    } finally {
      await client.query('rollback').catch(() => {});
      client.release();
    }

    if (!who.superuser) {
      const foreign = Number((await pool.query("select count(*) as n from pg_tables where schemaname = 'public' and tableowner <> current_user")).rows[0].n);
      if (foreign) problems.push(`${foreign} table${foreign === 1 ? ' is' : 's are'} owned by a different database user. The app must connect as the user that ran the migrations: platform code reads across organisations as the table owner, and any other user sees no rows.`);
    }

    if (!status.pending.length) {
      const admins = Number((await pool.query('select count(*) as n from platform_admins')).rows[0].n);
      const orgs = Number((await pool.query('select count(*) as n from orgs')).rows[0].n);
      notes.push(`${admins} platform admin${admins === 1 ? '' : 's'}, ${orgs} organisation${orgs === 1 ? '' : 's'}.`);
      if (!admins) notes.push('No platform admin yet. Make the first one: pnpm bootstrap:admin -- --email you@example.com');
    }
    return { problems, notes };
  } finally {
    await pool.end();
  }
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Set it to the database to migrate: postgres://USER:PASSWORD@HOST:5432/DATABASE');
    process.exit(1);
  }
  try {
    if (process.argv.includes('--status')) {
      const s = await readMigrationStatus(url);
      console.log(`${s.applied.length} applied, ${s.pending.length} pending, ${s.changed.length} changed.`);
      for (const f of s.pending) console.log(`  pending  ${f}`);
      for (const f of s.changed) console.log(`  CHANGED  ${f}`);
      for (const f of s.unknown) console.log(`  unknown  ${f} (in the database, not in this checkout)`);
      const problems = migrationProblems(s);
      for (const p of problems) console.log(p);
      process.exit(problems.length ? 1 : 0);
    }
    const r = await runMigrations(url);
    for (const f of r.applied) console.log(`  applied  ${f}`);
    if (r.grantedTenantRole) console.log('  granted the role app_tenant to this database user');
    console.log(r.applied.length ? `Applied ${r.applied.length} migration${r.applied.length === 1 ? '' : 's'}; ${r.skipped} already in place. The database is up to date.` : `Nothing to do: all ${r.skipped} migrations are already applied.`);
    process.exit(0);
  } catch (e) {
    // Names a file and Postgres's own message; never the connection string.
    console.error(`Migration stopped: ${(e as Error).message}`);
    process.exit(1);
  }
}
