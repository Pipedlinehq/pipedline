/**
 * jsonb columns: always pass through json() when writing. node-postgres turns a bare JS array
 * into a Postgres array literal, which a jsonb column rejects; a string is parsed as JSON.
 */
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}
