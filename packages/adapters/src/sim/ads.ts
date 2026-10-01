import type { AdsAdapter, AdsConversion } from '@ros/core';

export const SIM_ADS_KEY = 'sim-ads';

export interface SimAdsBatch {
  accountRef: string;
  /** The payload exactly as the adapter would put it on the wire. */
  payload: string;
  conversions: AdsConversion[];
}

export interface SimAdsAdapter extends AdsAdapter {
  /** Every batch received, in order. */
  readonly batches: SimAdsBatch[];
  /** Conversions the platform kept, after de-duplicating on event id per account. */
  accepted(accountRef?: string): AdsConversion[];
  failNext(n: number): void;
  reset(): void;
}

/** An ad platform's conversions endpoint held in memory. De-duplicates on event id, as Meta does. */
export function createSimAdsAdapter(): SimAdsAdapter {
  const batches: SimAdsBatch[] = [];
  const kept = new Map<string, AdsConversion & { accountRef: string }>();
  let failures = 0;
  return {
    key: SIM_ADS_KEY,
    batches,
    async sendConversions(conn, conversions) {
      if (!conn.credentials.accessToken) throw new Error('sim-ads: 401 no access token');
      if (failures > 0) {
        failures--;
        throw new Error('sim-ads: simulated outage');
      }
      const payload = JSON.stringify(conversions);
      batches.push({ accountRef: conn.externalAccountId, payload, conversions: structuredClone(conversions) });
      let accepted = 0;
      for (const c of conversions) {
        const k = `${conn.externalAccountId}:${c.eventId}`;
        if (!kept.has(k)) {
          kept.set(k, { ...structuredClone(c), accountRef: conn.externalAccountId });
          accepted++;
        }
      }
      return { accepted };
    },
    accepted(accountRef) {
      return [...kept.values()].filter((c) => !accountRef || c.accountRef === accountRef);
    },
    failNext(n) {
      failures = n;
    },
    reset() {
      batches.length = 0;
      kept.clear();
      failures = 0;
    },
  };
}
