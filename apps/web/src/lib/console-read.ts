import 'server-only';
import type { Ctx } from '@ros/core';
import { runAction } from './actions';
import { type ConsoleContext, inConsole } from './console';

export type Read<T> = { ok: true; data: T } | { ok: false; error: string; code: string };

/**
 * A read for one section of a page. A refusal or a switched-off module becomes a message in that
 * section instead of taking the whole page down; anything unexpected is logged and said plainly.
 */
export async function read<T>(fn: (ctx: Ctx, c: ConsoleContext) => Promise<T>): Promise<Read<T>> {
  const r = await runAction(() => inConsole(fn));
  return r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, code: r.code };
}
