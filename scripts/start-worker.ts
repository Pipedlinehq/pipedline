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
/**
 * How long to wait for another process (the web app runs `pnpm db:migrate` on start) to apply
 * pending migrations before giving up. The web and the worker deploy together; without this the
 * worker lost the race and crash-looped until the migration landed.
 */
const MIGRATION_WAIT_MS = Number(process.env.ROS_MIGRATION_WAIT_SECONDS ?? 600) * 1000;
const isPendingMigration = (problem: string) => /not applied yet/i.test(problem);

export async function preflight(what: string): Promise<void> {
  const check = checkDeployment(process.env);
  if (!check.errors.length) {
    const deadline = Date.now() + MIGRATION_WAIT_MS;
    let problems = (await inspectDatabase(process.env.DATABASE_URL!.trim())).problems;
    let waited = false;
    while (problems.length && problems.every(isPendingMigration) && Date.now() < deadline) {
      if (!waited) console.log(`Waiting for pending migrations to be applied by the web app (up to ${MIGRATION_WAIT_MS / 1000}s)…`);
      waited = true;
      await new Promise((r) => setTimeout(r, 10_000));
      problems = (await inspectDatabase(process.env.DATABASE_URL!.trim())).problems;
    }
    if (waited && !problems.length) console.log('Migrations are in place.');
    check.errors.push(...problems);
  }
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
