import type { z } from 'zod';
import { invalid } from '@ros/core';

/** Validate input with its zod schema; a failure is answered as an AppError a person can read. */
export function parseInput<S extends z.ZodType>(schema: S, raw: unknown, what = 'That request'): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw invalid(`${what} is not valid.`, { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return parsed.data;
}
