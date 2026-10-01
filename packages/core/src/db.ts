import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { DB } from './db.gen';

export type { DB } from './db.gen';
export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
/** Anything a query can be run against: the pool-backed handle or an open transaction. */
export type Queryable = Kysely<DB> | Transaction<DB>;

// Parse the types whose default node-postgres handling loses information or convenience.
// int8 → number (every quantity here is far below 2^53), numeric → number, date → 'YYYY-MM-DD'.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export function createPool(connectionString: string, opts: { max?: number } = {}): pg.Pool {
  return new pg.Pool({ connectionString, max: opts.max ?? 10 });
}

export function createDb(pool: pg.Pool): Database {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export interface MigrationResult {
  applied: string[];
  skipped: number;
}

/**
 * Applies db/migrations/*.sql in name order, each in its own transaction. A file that has
 * already been applied is skipped; one whose contents changed since it was applied is an error,
 * because migrations are additive (docs/DEPLOYMENT.md section 6).
 */
export async function migrate(pool: pg.Pool, dir: string): Promise<MigrationResult> {
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists public.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Map<string, string>(
      (await client.query('select name, checksum from public.schema_migrations')).rows.map((r) => [r.name, r.checksum]),
    );
    const applied: string[] = [];
    let skipped = 0;
    for (const file of files) {
      const body = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum) {
          throw new Error(`Migration ${file} changed after it was applied. Add a new migration instead.`);
        }
        skipped++;
        continue;
      }
      try {
        await client.query('begin');
        await client.query(body);
        await client.query('insert into public.schema_migrations (name, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        applied.push(file);
      } catch (e) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
    return { applied, skipped };
  } finally {
    client.release();
  }
}

export interface MigrationStatus {
  /** Files on disk that the database has, unchanged. */
  applied: string[];
  /** Files on disk the database has not had yet, in the order they would run. */
  pending: string[];
  /** Files whose contents differ from what was applied: `migrate` refuses these. */
  changed: string[];
  /** Recorded in the database but not on disk: the code is older than the database. */
  unknown: string[];
}

/**
 * What `migrate` would do, without doing it: reads only. For a deployment's start-up and
 * configuration checks. A database that has never been migrated reports every file as pending.
 */
export async function migrationStatus(pool: pg.Pool, dir: string): Promise<MigrationStatus> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const has = await pool.query<{ t: string | null }>("select to_regclass('public.schema_migrations')::text as t");
  const done = new Map<string, string>(
    has.rows[0]?.t ? (await pool.query<{ name: string; checksum: string }>('select name, checksum from public.schema_migrations')).rows.map((r) => [r.name, r.checksum]) : [],
  );
  const out: MigrationStatus = { applied: [], pending: [], changed: [], unknown: [...done.keys()].filter((n) => !files.includes(n)).sort() };
  for (const file of files) {
    const prior = done.get(file);
    if (!prior) out.pending.push(file);
    else if (prior === createHash('sha256').update(await readFile(path.join(dir, file), 'utf8')).digest('hex')) out.applied.push(file);
    else out.changed.push(file);
  }
  return out;
}

export { sql };
