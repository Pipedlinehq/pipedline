/**
 * docs/SCHEMA.md section 2a rule 3: an anonymous payment keeps its amount, lines and time. It
 * does not keep a handle that could identify the guest later. Applied to every provider payload
 * before it is stored; the database also rejects a payload that still carries one.
 */
const CARD_IDENTIFIER_KEYS = new Set(['fingerprint', 'payment_account_reference', 'par', 'card_fingerprint']);

export function stripCardIdentifiers<T>(raw: T): T {
  if (raw === null || raw === undefined) return raw;
  if (Array.isArray(raw)) return raw.map((v) => stripCardIdentifiers(v)) as T;
  if (raw instanceof Date) return raw.toISOString() as T;
  if (typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (CARD_IDENTIFIER_KEYS.has(k.toLowerCase())) continue;
      out[k] = stripCardIdentifiers(v);
    }
    return out as T;
  }
  return raw;
}
