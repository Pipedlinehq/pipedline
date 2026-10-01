/**
 * Start the web app for a real deployment: the built app (`pnpm build`), configured only from
 * the environment. No embedded database, no fixtures, no simulated clock.
 *
 *   pnpm start:web                        listens on PORT (default 3000), all interfaces
 *   pnpm start:web --hostname 127.0.0.1   only this machine (behind a reverse proxy)
 *
 * Before it starts anything it checks the configuration and the database and refuses, saying
 * why, if the app could not run: a variable missing for the chosen mode, migrations pending.
 * The same checks, without starting: pnpm check:config.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight } from './start-worker';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web');

await preflight('web app');

const dist = path.join(webDir, process.env.NEXT_DIST_DIR ?? '.next');
if (!existsSync(path.join(dist, 'BUILD_ID'))) {
  console.error('The web app has not been built. Run: pnpm build');
  process.exit(1);
}

const port = process.env.PORT ?? '3000';
// Anything after the command goes to `next start`, e.g. `pnpm start:web --hostname 127.0.0.1` behind a reverse proxy.
const args = ['start', '--port', port, ...process.argv.slice(2).filter((a) => a !== '--')];
const web = spawn(path.join(webDir, 'node_modules/.bin/next'), args, { cwd: webDir, env: { ...process.env, NEXT_TELEMETRY_DISABLED: process.env.NEXT_TELEMETRY_DISABLED ?? '1' }, stdio: 'inherit' });

// The signal goes to the server; this process leaves when the server has.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void web.kill(signal));
web.on('exit', (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
