/**
 * A whole local stack in one command, isolated from any other running copy: its own throwaway
 * Postgres (migrated and seeded), and the web app with simulated providers and the worker
 * loop in-process.
 *
 * Providers are simulated, including Square's sign-in page ("Connect Square" opens a stand-in on
 * this host). To click through the REAL Square sandbox instead, put SQUARE_APPLICATION_ID,
 * SQUARE_APPLICATION_SECRET and SQUARE_ENVIRONMENT=sandbox in .env.local at the repo root and run
 * `ROS_ADAPTERS=mixed pnpm dev:stack`: Square is then real and everything else stays simulated
 * (docs/GOING_LIVE.md section 6). .env.local is read here; a variable already set in the shell wins.
 *
 *   pnpm dev:stack                       port 3000, clock = now
 *   pnpm dev:stack -- --port 3101        another port (several stacks can run side by side)
 *   pnpm dev:stack -- --friday           the clock starts on a Friday dinner service (every fixture venue is open)
 *   pnpm dev:stack -- --scale 0.3        smaller fixtures, faster start
 *
 * Venue sites are at http://oak-diner.tables.localhost:<port>/ and http://oak-group.tables.localhost:<port>/
 * The console is at http://localhost:<port>/console (sign in as owner@oak-diner.test, manager@oak-group.test …)
 * Sign-in codes and every other "sent" message are at http://localhost:<port>/dev/inbox
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { seedFixtures } from '@ros/fixtures';
import { createTestApp, fakeClock } from '../packages/testkit/src/app';
import { REPO_ROOT, createDatabase, migrateDatabase, startLocalPg } from '../packages/testkit/src/local-pg';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg('port') ?? 3000);
const scale = Number(arg('scale') ?? 0.35);
const friday = process.argv.includes('--friday');
const clockStart = friday ? '2026-10-02T09:30:00.000Z' : undefined;

// Provider credentials for mixed mode live in .env.local at the repo root (never committed). Next
// only reads env files beside the app, so they are loaded here and inherited by the web process.
const envLocal = path.join(REPO_ROOT, '.env.local');
if (existsSync(envLocal)) {
  for (const line of readFileSync(envLocal, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]!] !== undefined) continue;
    process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
}
// A development stack is never live: the fixtures, the inbox and the clock all need the simulators.
const adapters = process.env.ROS_ADAPTERS ?? 'sim';
if (adapters !== 'sim' && adapters !== 'mixed') throw new Error(`pnpm dev:stack runs with ROS_ADAPTERS=sim or mixed (it is "${adapters}").`);

Object.assign(process.env, {
  ROS_ENV: 'development',
  ROS_ADAPTERS: adapters,
  // Without real Square credentials, "Connect Square" opens a simulated sign-in page on this host.
  // With them (mixed), the runtime ignores this and Square is real.
  ROS_SIM_SQUARE_OAUTH: process.env.ROS_SIM_SQUARE_OAUTH ?? '1',
  ROS_INLINE_WORKER: '1',
  ROS_PLATFORM_HOST: `localhost:${port}`,
  ROS_TENANT_ROOT_DOMAIN: 'tables.localhost',
  ROS_SCHEME: 'http',
  NEXT_TELEMETRY_DISABLED: '1',
    // A runaway dev server must die alone rather than exhaust the machine (it has reached 14 GB).
    NODE_OPTIONS: '--max-old-space-size=4096',
  NEXT_DIST_DIR: port === 3000 ? '.next' : `.next-${port}`,
  ...(clockStart ? { ROS_CLOCK_START: clockStart } : {}),
});

const pg = await startLocalPg();
const url = await createDatabase(pg, 'ros_dev');
await migrateDatabase(url);
process.env.DATABASE_URL = url;

const { configFromEnv } = await import('../packages/runtime/src/index');
const now = clockStart ? new Date(clockStart) : new Date();
const clock = fakeClock(now);
const t = createTestApp(url, { clock, config: configFromEnv() });
const started = Date.now();
await seedFixtures(t.app, { now, setNow: (at) => clock.set(at), scale });
await t.close();
console.log(`seeded in ${Math.round((Date.now() - started) / 1000)}s · DATABASE_URL=${url}`);

const webDir = path.join(REPO_ROOT, 'apps/web');
const web = spawn(path.join(webDir, 'node_modules/.bin/next'), ['dev', '--port', String(port)], { cwd: webDir, env: process.env, stdio: 'inherit' });

const stop = async () => {
  web.kill('SIGTERM');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
web.on('exit', () => void stop());
