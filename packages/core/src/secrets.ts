import type { App } from './app';
import { open, seal } from './crypto';
import { randomBytes } from 'node:crypto';
import { notFound } from './errors';

/**
 * Provider tokens and per-org keys. Values are sealed with the platform master key and live in
 * a table no tenant role can read; modules hold only a reference. docs/THREAT_MODEL.md section 8.
 */
export interface SecretStore {
  put(orgId: string, purpose: string, value: string): Promise<string>;
  get(orgId: string, ref: string): Promise<string>;
  replace(orgId: string, ref: string, value: string): Promise<void>;
  remove(orgId: string, ref: string): Promise<void>;
  /** A 32-byte key unique to the org, created on first use. Used to hash card identifiers per org. */
  orgKey(orgId: string, name: 'identity_hmac' | 'unsubscribe_links'): Promise<Buffer>;
}

export function tableSecretStore(app: App): SecretStore {
  const key = () => app.config.masterKey;
  const aad = (orgId: string, purpose: string) => `${orgId}:${purpose}`;
  const orgKeyCache = new Map<string, Buffer>();

  return {
    async put(orgId, purpose, value) {
      const s = seal(key(), value, aad(orgId, purpose));
      const row = await app.db
        .insertInto('secrets')
        .values({ org_id: orgId, purpose, ciphertext: s.ciphertext, nonce: s.nonce })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    },

    async get(orgId, ref) {
      const row = await app.db
        .selectFrom('secrets')
        .select(['ciphertext', 'nonce', 'purpose'])
        .where('id', '=', ref)
        .where('org_id', '=', orgId) // a ref from another org resolves to nothing
        .executeTakeFirst();
      if (!row) throw notFound('Secret not found');
      return open(key(), { ciphertext: row.ciphertext, nonce: row.nonce }, aad(orgId, row.purpose));
    },

    async replace(orgId, ref, value) {
      const row = await app.db
        .selectFrom('secrets')
        .select('purpose')
        .where('id', '=', ref)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (!row) throw notFound('Secret not found');
      const s = seal(key(), value, aad(orgId, row.purpose));
      await app.db
        .updateTable('secrets')
        .set({ ciphertext: s.ciphertext, nonce: s.nonce, rotated_at: app.clock() })
        .where('id', '=', ref)
        .where('org_id', '=', orgId)
        .execute();
    },

    async remove(orgId, ref) {
      await app.db.deleteFrom('secrets').where('id', '=', ref).where('org_id', '=', orgId).execute();
    },

    async orgKey(orgId, name) {
      const cacheKey = `${orgId}:${name}`;
      const hit = orgKeyCache.get(cacheKey);
      if (hit) return hit;
      const purpose = `org:${name}`;
      const fresh = randomBytes(32).toString('base64');
      const s = seal(key(), fresh, aad(orgId, purpose));
      // Insert-if-absent; two racing callers converge on whichever row won.
      await app.db
        .insertInto('secrets')
        .values({ org_id: orgId, purpose, ciphertext: s.ciphertext, nonce: s.nonce })
        .onConflict((oc) => oc.columns(['org_id', 'purpose']).where('purpose', 'like', 'org:%').doNothing())
        .execute();
      const row = await app.db
        .selectFrom('secrets')
        .select(['ciphertext', 'nonce'])
        .where('org_id', '=', orgId)
        .where('purpose', '=', purpose)
        .executeTakeFirstOrThrow();
      const value = Buffer.from(open(key(), { ciphertext: row.ciphertext, nonce: row.nonce }, aad(orgId, purpose)), 'base64');
      orgKeyCache.set(cacheKey, value);
      return value;
    },
  };
}
