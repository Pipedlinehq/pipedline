import type { App } from './app';
import { AppError } from './errors';
import { json } from './json';

export interface OnceResult<T> {
  result: T;
  /** True when the action had already succeeded and the stored result was returned. */
  replayed: boolean;
}

/**
 * Exactly-once for anything that leaves the building: a send, a charge, a courier request.
 * The key must also be given to the provider as its idempotency key, so a retry after an
 * unknown outcome cannot act twice. Never call this inside a tenant transaction.
 */
export async function once<T>(
  app: App,
  args: { orgId: string; key: string; kind: string },
  fn: () => Promise<T>,
): Promise<OnceResult<T>> {
  const inserted = await app.db
    .insertInto('side_effects')
    .values({ org_id: args.orgId, key: args.key, kind: args.kind, status: 'started' })
    .onConflict((oc) => oc.columns(['org_id', 'key']).doNothing())
    .returning('id')
    .executeTakeFirst();

  if (!inserted) {
    const existing = await app.db
      .selectFrom('side_effects')
      .select(['status', 'result'])
      .where('org_id', '=', args.orgId)
      .where('key', '=', args.key)
      .executeTakeFirstOrThrow();
    if (existing.status === 'succeeded') return { result: existing.result as T, replayed: true };
    // 'started' (a crash mid-call) or 'failed': run again. The provider de-duplicates on the same key.
  }

  try {
    const result = await fn();
    await app.db
      .updateTable('side_effects')
      .set({ status: 'succeeded', result: json(result), error: null })
      .where('org_id', '=', args.orgId)
      .where('key', '=', args.key)
      .execute();
    return { result, replayed: false };
  } catch (e) {
    await app.db
      .updateTable('side_effects')
      .set({ status: 'failed', error: (e as Error).message?.slice(0, 2000) ?? 'unknown error' })
      .where('org_id', '=', args.orgId)
      .where('key', '=', args.key)
      .execute();
    if (e instanceof AppError) throw e;
    throw new AppError('provider_error', 'That could not be completed just now. Nothing was changed twice; try again shortly.', {
      cause: (e as Error).message,
    });
  }
}
