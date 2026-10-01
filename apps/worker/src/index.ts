/**
 * The background worker: drains the job queue and ticks schedules. Runs on Railway in
 * production (docs/ARCHITECTURE.md section 5). In development the web process runs the same
 * loop in-process, so simulated providers share one memory.
 */
import { getRuntime, startWorkerLoop } from '@ros/runtime';

const { app, mode } = getRuntime();
app.log.info('worker started', { mode, env: app.config.env });
const loop = startWorkerLoop(app, { workerId: `worker-${process.pid}` });

const stop = async (signal: string) => {
  app.log.info('worker stopping', { signal });
  // Finish the batch in hand, then exit: jobs are safe to resume (docs/DEPLOYMENT.md section 7).
  await loop.stop();
  await app.db.destroy();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
