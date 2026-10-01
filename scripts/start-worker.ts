/**
 * Start the background worker for a real deployment: it drains the job queue and ticks the
 * schedules (apps/worker/src/index.ts), configured only from the environment.
 *
 *   pnpm start:worker
 *
 * One worker is enough to begin with; several may run against one database (a job is claimed
 * by one of them). Like `pnpm start:web` it first checks the configuration and the database
 * and refuses, saying why, if the app could not run.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeployment, formatDeploymentCheck } from '../packages/runtime/src/check';
import { inspectDatabase } from './db-migrate';

/** Refuse to start on a configuration or database the app cannot run with. Exits the process. */
export async function preflight(what: string): Promise<void> {
  const check = checkDeployment(process.env);
  if (!check.errors.length) check.errors.push(...(await inspectDatabase(process.env.DATABASE_URL!.trim())).problems);
  if (check.errors.length) {
    console.error(`The ${what} was not started.\n`);
    console.error(formatDeploymentCheck({ ...check, summary: [] }));
    console.error('\nThe full picture: pnpm check:config   (docs/SELF_HOSTING.md)');
    process.exit(1);
  }
  for (const w of check.warnings) console.warn(`WARN  ${w}`);
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (invokedDirectly) {
  await preflight('worker');
  await import('../apps/worker/src/index');
}
