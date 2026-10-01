import { sql } from 'kysely';
import type { App } from './app';
import { AppError } from './errors';

export interface RateLimit {
  limit: number;
  windowSeconds: number;
}

/**
 * Fixed-window counter in Postgres. Enough for per-key and per-org limits at this scale;
 * swap the body for a shared cache when request volume warrants it.
 */
export async function rateLimit(app: App, key: string, rule: RateLimit, message?: string): Promise<void> {
  const now = app.clock().getTime();
  const windowStart = new Date(Math.floor(now / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000);
  const row = await app.db
    .insertInto('rate_limits')
    .values({ key, window_start: windowStart, count: 1 })
    .onConflict((oc) => oc.columns(['key', 'window_start']).doUpdateSet({ count: sql`rate_limits.count + 1` }))
    .returning('count')
    .executeTakeFirstOrThrow();
  if (row.count > rule.limit) {
    throw new AppError('rate_limited', message ?? 'Too many requests. Try again shortly.');
  }
}

export async function pruneRateLimits(app: App, olderThanHours = 48): Promise<void> {
  const cutoff = new Date(app.clock().getTime() - olderThanHours * 3_600_000);
  await app.db.deleteFrom('rate_limits').where('window_start', '<', cutoff).execute();
}
