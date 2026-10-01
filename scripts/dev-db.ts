/**
 * A persistent local database for development and end-to-end tests: embedded Postgres in
 * .pgdata on port 54329, migrated, and seeded with the fixture orgs the first time.
 *
 *   pnpm dev:db            start (migrate, seed if empty) and keep running
 *   pnpm dev:db -- --reset wipe and reseed first
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { seedFixtures } from '@ros/fixtures';
import { createTestApp, fakeClock } from '../packages/testkit/src/app';
import { REPO_ROOT, migrateDatabase, startLocalPg } from '../packages/testkit/src/local-pg';
import { configFromEnv } from '../packages/runtime/src/index';

const PORT = Number(process.env.ROS_DEV_PG_PORT ?? 54329);
const DATA_DIR = path.join(REPO_ROOT, '.pgdata');
const DB = 'ros_dev';
const reset = process.argv.includes('--reset');
const scale = process.env.ROS_FIXTURE_SCALE ? Number(process.env.ROS_FIXTURE_SCALE) : 1;

if (reset) await rm(DATA_DIR, { recursive: true, force: true });
const server = await startLocalPg({ dataDir: DATA_DIR, port: PORT, persistent: true });

const admin = new pg.Client({ connectionString: server.url('postgres') });
await admin.connect();
const exists = await admin.query('select 1 from pg_database where datname = $1', [DB]);
if (!exists.rowCount) await admin.query(`create database "${DB}"`);
await admin.end();

const url = server.url(DB);
const applied = await migrateDatabase(url);
if (applied.length) console.log(`applied ${applied.length} migration(s)`);

const clock = fakeClock(new Date());
// The same keys and hosts the running app will use, or sealed secrets would not open later.
const t = createTestApp(url, { clock, config: configFromEnv() });
const orgs = await t.db.selectFrom('orgs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
if (Number(orgs.n) === 0) {
  const started = Date.now();
  const now = new Date();
  await seedFixtures(t.app, { now, setNow: (at) => clock.set(at), scale });
  console.log(`seeded fixtures in ${Math.round((Date.now() - started) / 1000)}s`);
}
await t.close();

console.log(`\nDATABASE_URL=${url}\n`);
console.log('dev database is running; Ctrl-C to stop');
const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await new Promise(() => {});
