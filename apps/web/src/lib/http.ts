import 'server-only';
import { NextResponse } from 'next/server';
import { unstable_rethrow } from 'next/navigation';
import { ZodError } from 'zod';
import { AppError, isAppError } from '@ros/core';
import { app } from './runtime';

export interface ErrorBody {
  error: { code: string; message: string; issues?: unknown };
}

export function errorResponse(e: unknown): NextResponse<ErrorBody> {
  if (isAppError(e)) {
    return NextResponse.json({ error: { code: e.code, message: e.message, issues: e.details?.issues } }, { status: e.status });
  }
  if (e instanceof ZodError) {
    return NextResponse.json({ error: { code: 'invalid', message: 'Some of that was not valid.', issues: e.issues } }, { status: 422 });
  }
  // Never leak internals: log the detail, answer in general terms.
  app().log.error('unhandled route error', { error: (e as Error)?.message, stack: (e as Error)?.stack?.split('\n').slice(0, 6).join(' | ') });
  return NextResponse.json({ error: { code: 'internal', message: 'Something went wrong on our side. Nothing was changed.' } }, { status: 500 });
}

/**
 * Wraps a route handler: maps errors to a JSON body with the right status, and for anything
 * that changes state refuses a cross-site request (the Origin must be the host being called).
 */
export function route<A extends unknown[]>(fn: (req: Request, ...args: A) => Promise<Response | object>) {
  return async (req: Request, ...args: A): Promise<Response> => {
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertSameOrigin(req);
      const out = await fn(req, ...args);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      // notFound() and redirect() are Next's own control flow (an unknown host is a 404), not failures.
      unstable_rethrow(e);
      return errorResponse(e);
    }
  };
}

export function requestHost(req: Request): string {
  const production = app().config.env === 'production';
  const override = production ? null : req.headers.get('x-ros-host');
  return (override ?? req.headers.get('host') ?? '').toLowerCase();
}

function assertSameOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  // Non-browser callers (webhooks, assistants, tests) send no Origin and authenticate another way.
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    throw new AppError('forbidden', 'Cross-site request refused.');
  }
  if (originHost !== requestHost(req)) throw new AppError('forbidden', 'Cross-site request refused.');
}

export function clientIp(req: Request): string | undefined {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd ? fwd.split(',')[0]!.trim() : undefined;
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError('invalid', 'Send a JSON body.');
  }
}
