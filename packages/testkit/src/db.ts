import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import { loadFixture, type Fixture } from '@ros/fixtures';
import { clearHostCache } from '@ros/modules/tenancy';
import { type TestApp, createTestApp, fakeClock, FIXTURE_NOW } from './app';
import { TEMPLATE_DB } from './global-setup';

function serverUrl(database: string): string {
  const port = process.env.ROS_TEST_PG_PORT;
  if (!port) throw new Error('The test database is not running. Tests must run through the repo vitest config (globalSetup).');
  return `postgres://postgres:postgres@127.0.0.1:${port}/${database}`;
}

export interface TestEnv extends TestApp {
  fixture: Fixture;
  url: string;
}

/**
 * A private copy of the seeded fixture database for one test file, with an App wired to
 * simulated providers and a clock at FIXTURE_NOW. Call at the top of a describe block:
 *
 *   const t = useTestEnv();
 *   it('…', async () => { await t.app.tenant(t.fixture.diner.orgId, …) });
 */
export function useTestEnv(): TestEnv {
  const name = `t_${randomBytes(6).toString('hex')}`;
  const env = {} as TestEnv;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: serverUrl('postgres') });
    await admin.connect();
    try {
      await admin.query(`create database "${name}" template "${TEMPLATE_DB}"`);
    } finally {
      await admin.end();
    }
    clearHostCache();
    const t = createTestApp(serverUrl(name), { clock: fakeClock(FIXTURE_NOW) });
    Object.assign(env, t, { url: serverUrl(name), fixture: await loadFixture(t.app) });
  });

  afterAll(async () => {
    await env.close?.();
    const admin = new pg.Client({ connectionString: serverUrl('postgres') });
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end();
    }
  });

  return env;
}
