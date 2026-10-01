import { type App, hmacHex, type IdentityHint } from '@ros/core';

export function normaliseEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254 ? v : null;
}

/** E.164, defaulting to Australia when no country code is given. */
export function normalisePhone(raw: string, defaultCountry = '61'): string | null {
  let v = raw.replace(/[\s().-]/g, '');
  if (v.startsWith('+')) v = v.slice(1);
  else if (v.startsWith('00')) v = v.slice(2);
  else if (v.startsWith('0')) v = defaultCountry + v.slice(1);
  else if (!v.startsWith(defaultCountry) && v.length <= 9) v = defaultCountry + v;
  return /^\d{8,15}$/.test(v) ? `+${v}` : null;
}

export type StoredKind = 'email' | 'phone' | 'card_fingerprint' | 'card_par' | 'loyalty_qr' | 'pos_customer_id' | 'device_id';

export interface StoredIdentity {
  kind: StoredKind;
  value: string;
  isCard: boolean;
}

/**
 * A card identifier as stored: a keyed hash unique to the org, so the same card at two venues
 * on this platform produces two unrelated values (docs/SCHEMA.md section 2a rule 2).
 */
export async function hashCardIdentifier(app: App, orgId: string, kind: 'card_fingerprint' | 'card_par', raw: string): Promise<string> {
  const key = await app.secrets.orgKey(orgId, 'identity_hmac');
  return hmacHex(key, `${kind}:${raw.trim()}`);
}

/** Normalise hints into what the identity table stores. Unusable values are dropped. */
export async function toStoredIdentities(app: App, orgId: string, hints: IdentityHint[]): Promise<StoredIdentity[]> {
  const out = new Map<string, StoredIdentity>();
  for (const h of hints) {
    if (!h.value) continue;
    let value: string | null;
    let isCard = false;
    switch (h.kind) {
      case 'email':
        value = normaliseEmail(h.value);
        break;
      case 'phone':
        value = normalisePhone(h.value);
        break;
      case 'card_fingerprint':
      case 'card_par':
        value = await hashCardIdentifier(app, orgId, h.kind, h.value);
        isCard = true;
        break;
      default:
        value = h.value.trim() || null;
    }
    if (value) out.set(`${h.kind}:${value}`, { kind: h.kind, value, isCard });
  }
  return [...out.values()];
}
