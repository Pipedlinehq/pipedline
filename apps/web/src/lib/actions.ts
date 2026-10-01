import 'server-only';
import { ZodError } from 'zod';
import { isAppError } from '@ros/core';
import { unstable_rethrow } from 'next/navigation';
import { app } from './runtime';

export type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string; code: string; issues?: unknown };

/**
 * Wraps the body of a server action so the page gets a result it can show, never a thrown
 * internal error. Redirects and not-found raised inside still work.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    if (isAppError(e)) return { ok: false, error: e.message, code: e.code, issues: e.details?.issues };
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join(' '), code: 'invalid', issues: e.issues };
    app().log.error('unhandled action error', { error: (e as Error)?.message });
    return { ok: false, error: 'Something went wrong on our side. Nothing was changed.', code: 'internal' };
  }
}
