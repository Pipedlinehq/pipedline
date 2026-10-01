import 'server-only';
import { notFound } from 'next/navigation';
import { app, sim } from './runtime';

/**
 * Development tools (the simulated inbox, simulated POS controls) exist only when providers
 * are simulated, which the runtime refuses to do in production. Anything under /dev or
 * /api/dev calls this first and is a 404 otherwise.
 */
export function requireSim() {
  const s = sim();
  if (!s || app().config.env === 'production') notFound();
  return s;
}
