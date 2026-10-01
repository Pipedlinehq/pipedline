import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { seedFixtures } from '@ros/fixtures';
import { FIXTURE_NOW, createTestApp, fakeClock } from './app';
import { MIGRATIONS_DIR, REPO_ROOT, createDatabase, migrateDatabase, startLocalPg, type LocalPg } from './local-pg';

/**
 * One Postgres per test run. The migrations are applied and the fixtures seeded once, into a
 * template database; each test file then clones the template, which takes a fraction of a second.
 */
export const TEMPLATE_DB = 'ros_template';
let server: LocalPg | undefined;

export default async function setup(): Promise<() => Promise<void>> {
  const started = Date.now();
  server = await startLocalPg();
  const scale = process.env.ROS_FIXTURE_SCALE ? Number(process.env.ROS_FIXTURE_SCALE) : 1;
  try {
    const url = await createDatabase(server, TEMPLATE_DB);
    await migrateDatabase(url);
    const clock = fakeClock();
    const t = createTestApp(url, { clock });
    try {
      await seedFixtures(t.app, { now: FIXTURE_NOW, setNow: (at) => clock.set(at), scale });
    } finally {
      await t.close();
    }
  } catch (e) {
    // Never leave a Postgres running behind a failed setup.
    await server.stop();
    throw e;
  }

  process.env.ROS_TEST_PG_PORT = String(server.port);
  if (process.env.ROS_TEST_VERBOSE) console.log(`test database ready in ${Date.now() - started}ms (fixture scale ${scale})`);
  return async () => {
    await server?.stop();
  };
}

/** A fingerprint of everything the template depends on, for anyone caching it between runs. */
export async function templateFingerprint(): Promise<string> {
  const h = createHash('sha256');
  for (const dir of [MIGRATIONS_DIR, path.join(REPO_ROOT, 'packages/fixtures/src'), path.join(REPO_ROOT, 'packages/fixtures/src/seeders')]) {
    for (const f of (await readdir(dir)).sort()) {
      const p = path.join(dir, f);
      if ((await stat(p)).isFile()) h.update(f).update(await readFile(p));
    }
  }
  return h.digest('hex');
}
