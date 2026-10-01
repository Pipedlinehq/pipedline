/**
 * In development and end-to-end tests the web process also runs the worker loop, so the
 * simulated providers (the inbox a sign-in code lands in, the POS a sale appears on) live in
 * one memory. In production the worker is its own service (apps/worker).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.ROS_INLINE_WORKER !== '1') return;
  const { getRuntime, startWorkerLoop } = await import('@ros/runtime');
  const g = globalThis as { __rosWorker?: unknown };
  if (g.__rosWorker) return;
  const { app } = getRuntime();
  g.__rosWorker = startWorkerLoop(app, { intervalMs: 500, scheduleEveryMs: 15_000, workerId: 'inline' });
  app.log.info('inline worker started');
}
