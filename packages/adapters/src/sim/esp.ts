import type { ConnectionHandle, EspAdapter, EspProfile, EspSuppression } from '@ros/core';

export const SIM_ESP_KEY = 'sim-esp';

export interface SimEspEvent {
  accountRef: string;
  profileExternalId: string;
  name: string;
  occurredAt: Date;
  properties: Record<string, unknown>;
  idempotencyKey: string;
}

export interface SimEspAccount {
  /** Profiles as the platform holds them, by our external id. */
  profiles: Map<string, EspProfile>;
  /** Every upsert call, in order (a replay that calls again shows up here). */
  upserts: EspProfile[];
  events: SimEspEvent[];
  /** Suppressions we pushed to the platform. */
  pushed: EspSuppression[];
  /** Suppressions that happened on the platform (a guest unsubscribing in one of its emails). */
  platformSuppressions: EspSuppression[];
}

export interface SimEspAdapter extends EspAdapter {
  account(accountRef: string): SimEspAccount;
  /** A guest unsubscribes, complains or bounces on the platform's side. */
  platformUnsubscribe(accountRef: string, s: Omit<EspSuppression, 'at'> & { at?: Date }): void;
  /** Accounts that have received anything at all. */
  accounts(): string[];
  failNext(n: number): void;
  reset(): void;
}

/**
 * A connected email platform held in memory (the "connected" tier, docs/modules/comms.md
 * section 7). Events with an idempotency key it has seen are ignored, as Klaviyo does with
 * `unique_id`.
 */
export function createSimEspAdapter(opts: { clock?: () => Date } = {}): SimEspAdapter {
  const byAccount = new Map<string, SimEspAccount>();
  let failures = 0;
  const now = () => (opts.clock ? opts.clock() : new Date());
  const acct = (ref: string) => {
    let a = byAccount.get(ref);
    if (!a) byAccount.set(ref, (a = { profiles: new Map(), upserts: [], events: [], pushed: [], platformSuppressions: [] }));
    return a;
  };
  const check = (conn: ConnectionHandle) => {
    if (!conn.credentials.apiKey) throw new Error('sim-esp: 401 no api key');
    if (failures > 0) {
      failures--;
      throw new Error('sim-esp: simulated outage');
    }
    return acct(conn.externalAccountId);
  };

  return {
    key: SIM_ESP_KEY,
    capabilities: { transactional: false, marketing: true, sms: true, flows: 'theirs', suppressionSync: 'both', engagementEvents: false },

    async upsertProfile(conn, profile) {
      const a = check(conn);
      a.upserts.push(structuredClone(profile));
      a.profiles.set(profile.externalId, structuredClone(profile));
    },

    async trackEvent(conn, event) {
      const a = check(conn);
      if (a.events.some((e) => e.idempotencyKey === event.idempotencyKey)) return;
      a.events.push({ accountRef: conn.externalAccountId, ...structuredClone(event) });
    },

    async pullSuppressions(conn, since) {
      const a = check(conn);
      return a.platformSuppressions.filter((s) => s.at > since).map((s) => ({ ...s }));
    },

    async pushSuppression(conn, s) {
      const a = check(conn);
      a.pushed.push({ ...s });
      for (const p of a.profiles.values()) {
        const matches = s.channel === 'email' ? p.email === s.value : p.phone === s.value;
        if (matches) p.consents = { ...p.consents, ...(s.channel === 'email' ? { marketingEmail: false } : { marketingSms: false }) };
      }
    },

    account: acct,

    platformUnsubscribe(accountRef, s) {
      acct(accountRef).platformSuppressions.push({ ...s, at: s.at ?? now() });
    },

    accounts: () => [...byAccount.keys()],

    failNext(n) {
      failures = n;
    },

    reset() {
      byAccount.clear();
      failures = 0;
    },
  };
}
