export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'conflict'
  | 'module_disabled'
  | 'rate_limited'
  | 'provider_error'
  | 'not_consented'
  | 'unavailable';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 422,
  conflict: 409,
  module_disabled: 404, // a disabled module's routes look like they do not exist
  rate_limited: 429,
  provider_error: 502,
  not_consented: 403,
  unavailable: 503,
};

/** An error a caller can act on. `message` is safe to show to the person; it never carries internals. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export const notFound = (what = 'Not found') => new AppError('not_found', what);
export const forbidden = (message = 'You do not have access to that.') => new AppError('forbidden', message);
export const invalid = (message: string, details?: Record<string, unknown>) => new AppError('invalid', message, details);
export const conflict = (message: string, details?: Record<string, unknown>) => new AppError('conflict', message, details);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Postgres unique-violation, for turning a lost race into a clean idempotent answer. */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  const err = e as { code?: string; constraint?: string } | null;
  if (!err || err.code !== '23505') return false;
  return constraint ? err.constraint === constraint : true;
}
