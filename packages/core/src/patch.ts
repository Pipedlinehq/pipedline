import type { z } from 'zod';

/**
 * Parse the input of an update. An update schema is usually a create schema made partial, and a
 * field with a default then comes back filled in even when the caller left it out, which would
 * overwrite the stored value. Only the fields the caller actually gave are returned.
 */
export function parsePatch<S extends z.ZodType<Record<string, unknown>>>(schema: S, raw: unknown): Partial<z.output<S>> {
  const parsed = schema.parse(raw);
  const given = (raw ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => given[k] !== undefined)) as Partial<z.output<S>>;
}
