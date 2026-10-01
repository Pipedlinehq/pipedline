import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migrate } from '@ros/core';

/**
 * A real Postgres for development and tests, with no Docker and no root: the embedded binary,
 * a throwaway data directory, a free port. Production is Supabase; the migrations are the same.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'db/migrations');

export interface LocalPg {
  port: number;
  url(database?: string): string;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export async function startLocalPg(opts: { dataDir?: string; port?: number; persistent?: boolean } = {}): Promise<LocalPg> {
  const port = opts.port ?? (await freePort());
  const dataDir = opts.dataDir ?? (await mkdtemp(path.join(os.tmpdir(), 'ros-pg-')));
  const persistent = opts.persistent ?? false;
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent,
    onLog: () => {},
    onError: () => {},
  });
  let initialised = false;
  try {
    await server.initialise();
    initialised = true;
  } catch (e) {
    // A persistent directory that already holds a cluster is fine; anything else is not.
    if (!persistent) throw e;
  }
  await server.start();
  return {
    port,
    url: (database = 'postgres') => `postgres://postgres:postgres@127.0.0.1:${port}/${database}`,
    async stop() {
      await server.stop();
      if (!persistent && initialised) await rm(dataDir, { recursive: true, force: true });
    },
  };
}

export async function createDatabase(server: LocalPg, name: string, template?: string): Promise<string> {
  const admin = new pg.Client({ connectionString: server.url('postgres') });
  await admin.connect();
  try {
    await admin.query(`create database "${name}"${template ? ` template "${template}"` : ''}`);
  } finally {
    await admin.end();
  }
  return server.url(name);
}

export async function dropDatabase(server: LocalPg, name: string): Promise<void> {
  const admin = new pg.Client({ connectionString: server.url('postgres') });
  await admin.connect();
  try {
    await admin.query(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

export async function migrateDatabase(url: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    return (await migrate(pool, MIGRATIONS_DIR)).applied;
  } finally {
    await pool.end();
  }
}
