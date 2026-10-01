/**
 * End-to-end setup: a fresh Postgres, migrated and seeded, and the real web app running against
 * it with simulated providers and the worker loop in-process. Tests then drive it the way a
 * person would, in a browser, and read the database back to prove what happened.
 *
 *   E2E_MODE=dev    next dev (default; compiles pages on first visit)
 *   E2E_MODE=build  next build && next start (what ships)
 */
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { seedFixtures } from '@ros/fixtures';
import { configFromEnv } from '@ros/runtime';
import { createTestApp, fakeClock } from '../../packages/testkit/src/app';
import { REPO_ROOT, createDatabase, migrateDatabase, startLocalPg, type LocalPg } from '../../packages/testkit/src/local-pg';

/** Friday 2 October 2026, 19:30 in Sydney: mid dinner service at every fixture venue. */
export const E2E_CLOCK_START = '2026-10-02T09:30:00.000Z';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor(url: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the web app exited with code ${child.exitCode} before it was ready`);
    try {
      const r = await fetch(url, { redirect: 'manual' });
      if (r.status < 500) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the web app did not answer at ${url} within ${timeoutMs}ms`);
}

let pg: LocalPg | undefined;
let web: ChildProcess | undefined;
let watchdog: NodeJS.Timeout | undefined;
const killWeb = () => {
  if (watchdog) clearInterval(watchdog);
  try {
    if (web?.pid) process.kill(-web.pid, 'SIGTERM');
  } catch {
    // already gone
  }
};

export default async function setup(): Promise<() => Promise<void>> {
  // The production build is the default: it is what ships, and the dev compiler's memory use grows without bound over a long run.
  const mode = process.env.E2E_MODE ?? 'build';
  const port = await freePort();
  const platformHost = `localhost:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ROS_ENV: 'development',
    ROS_ADAPTERS: 'sim',
    // "Connect Square" is answered by a simulated sign-in provider on this host (packages/adapters/src/sim/oauth.ts).
    ROS_SIM_SQUARE_OAUTH: '1',
    ROS_INLINE_WORKER: '1',
    ROS_PLATFORM_HOST: platformHost,
    ROS_TENANT_ROOT_DOMAIN: 'tables.localhost',
    ROS_CLOCK_START: E2E_CLOCK_START,
    ROS_SCHEME: 'http',
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: '1',
    // A runaway dev server must die alone rather than exhaust the machine (it has reached 14 GB).
    NODE_OPTIONS: '--max-old-space-size=4096',
    // Its own build directory, so a development server can keep running alongside.
    NEXT_DIST_DIR: '.next-e2e',
  };

  // The test runner's own markers must not leak into the app: there they would switch on test-only strictness.
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  delete env.NODE_ENV;
  // Third-party tags on venue sites stay off, as in a deployment that has not switched them on; the scenario that needs them flips the switch itself.
  delete env.ROS_SITE_TAGS;

  pg = await startLocalPg();
  try {
    const url = await createDatabase(pg, 'ros_e2e');
    await migrateDatabase(url);
    env.DATABASE_URL = url;

    // Seed with the keys and hosts the running app will use, at the e2e clock's start.
    Object.assign(process.env, { ROS_PLATFORM_HOST: platformHost, ROS_TENANT_ROOT_DOMAIN: 'tables.localhost', ROS_ENV: 'development', ROS_SCHEME: 'http' });
    const now = new Date(E2E_CLOCK_START);
    const clock = fakeClock(now);
    const t = createTestApp(url, { clock, config: configFromEnv() });
    try {
      process.env.ROS_STRICT_SEEDERS = '1';
      await seedFixtures(t.app, { now, setNow: (at) => clock.set(at), scale: Number(process.env.E2E_FIXTURE_SCALE ?? 0.35) });
    } finally {
      await t.close();
    }

    const webDir = path.join(REPO_ROOT, 'apps/web');
    const next = path.join(webDir, 'node_modules/.bin/next');
    if (mode === 'build') execFileSync(next, ['build'], { cwd: webDir, env, stdio: 'inherit' });
    // Its own process group, watched: if the server's memory passes the limit it is killed on
    // its own rather than exhausting the machine (a dev server has reached 14 GB here).
    const nextArgs = [mode === 'build' ? 'start' : 'dev', '--port', String(port)];
    web = spawn(next, nextArgs, { cwd: webDir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const limitKb = Number(process.env.E2E_MEMORY_MAX_MB ?? 5000) * 1024;
    const pgid = web.pid!;
    watchdog = setInterval(() => {
      try {
        const out = execFileSync('ps', ['-o', 'rss=', '-g', String(pgid)], { encoding: 'utf8' });
        const rss = out.split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0);
        if (rss > limitKb) {
          console.error(`\nweb app passed ${Math.round(limitKb / 1024)} MB (${Math.round(rss / 1024)} MB): killing it`);
          process.kill(-pgid, 'SIGKILL');
        }
      } catch {
        // the group is gone
      }
    }, 2000);
    watchdog.unref();
    const log: string[] = [];
    web.stdout?.on('data', (d) => log.push(String(d)));
    web.stderr?.on('data', (d) => log.push(String(d)));
    try {
      await waitFor(`http://${platformHost}/login`, 120_000, web);
    } catch (e) {
      console.error(log.join('').slice(-4000));
      throw e;
    }

    process.env.E2E_BASE_URL = `http://${platformHost}`;
    process.env.E2E_PORT = String(port);
    process.env.E2E_DATABASE_URL = url;
  } catch (e) {
    killWeb();
    await pg.stop();
    throw e;
  }

  return async () => {
    killWeb();
    await new Promise((r) => setTimeout(r, 500));
    await pg?.stop();
  };
}
