import type { DnsRecord, DomainCheck, DomainRegistration, HostingPort, SendingDomainPort } from '@ros/core';

interface SimDomain {
  name: string;
  providerDomainId: string;
  records: DnsRecord[];
  verified: boolean;
  removed: boolean;
}

interface SimDomainControls {
  /** Every domain ever registered, by name. Removed ones stay, marked `removed`. */
  readonly domains: Map<string, SimDomain>;
  /** Act as the venue adding the DNS records: the next check reports the domain verified. */
  verify(name: string): void;
  /** Make the next n calls fail, to exercise retries. */
  failNext(n: number, message?: string): void;
  /** Whether the provider currently holds the domain (registered and not removed). */
  has(name: string): boolean;
  reset(): void;
}

export interface SimHosting extends HostingPort, SimDomainControls {}
export interface SimSendingDomains extends SendingDomainPort, SimDomainControls {}

function createDomainSim(prefix: string, recordsFor: (name: string) => DnsRecord[]) {
  const domains = new Map<string, SimDomain>();
  const byKey = new Map<string, string>();
  let failures = 0;
  let failureMessage = 'simulated provider outage';
  let seq = 0;

  const maybeFail = () => {
    if (failures > 0) {
      failures--;
      throw new Error(failureMessage);
    }
  };

  return {
    domains,
    async register(name: string, idempotencyKey: string): Promise<DomainRegistration> {
      maybeFail();
      const prior = byKey.get(idempotencyKey);
      let d = domains.get(prior ?? name);
      if (!d || d.removed) {
        d = { name, providerDomainId: `${prefix}_${++seq}`, records: recordsFor(name), verified: false, removed: false };
        domains.set(name, d);
      }
      byKey.set(idempotencyKey, name);
      return { providerDomainId: d.providerDomainId, records: d.records, verified: d.verified };
    },
    async check(name: string, providerDomainId: string): Promise<DomainCheck> {
      maybeFail();
      const d = domains.get(name);
      if (!d || d.removed || d.providerDomainId !== providerDomainId) return { verified: false, records: [], reason: 'That domain is not registered with the provider.' };
      return d.verified ? { verified: true, records: d.records } : { verified: false, records: d.records, reason: 'The DNS records have not been found yet.' };
    },
    async remove(name: string): Promise<void> {
      maybeFail();
      const d = domains.get(name);
      if (d) {
        d.removed = true;
        d.verified = false;
      }
    },
    verify(name: string) {
      const d = domains.get(name);
      if (!d || d.removed) throw new Error(`${name} is not registered with the simulated provider`);
      d.verified = true;
    },
    failNext(n: number, message?: string) {
      failures = n;
      if (message) failureMessage = message;
    },
    has(name: string) {
      const d = domains.get(name);
      return !!d && !d.removed;
    },
    reset() {
      domains.clear();
      byKey.clear();
      failures = 0;
      seq = 0;
    },
  };
}

/**
 * A web host that attaches domains to nothing. A domain stays unverified until a test (or the
 * development console) calls verify(host), the way a venue eventually adds its DNS records.
 */
export function createSimHosting(key = 'sim-hosting'): SimHosting {
  const s = createDomainSim('simdom', (host) => [
    { type: 'CNAME', name: host.split('.').length > 2 ? host.split('.')[0]! : 'www', value: 'cname.sim-hosting.invalid' },
    { type: 'TXT', name: '_verify', value: `sim-verify=${host}` },
  ]);
  return {
    key,
    domains: s.domains,
    addDomain: ({ host, idempotencyKey }) => s.register(host, idempotencyKey),
    checkDomain: ({ host, providerDomainId }) => s.check(host, providerDomainId),
    removeDomain: ({ host }) => s.remove(host),
    verify: s.verify,
    failNext: s.failNext,
    has: s.has,
    reset: s.reset,
  };
}

/** The email provider's sending-domain side. Registered with the same key as the simulated email adapter. */
export function createSimSendingDomains(key = 'sim-email'): SimSendingDomains {
  const s = createDomainSim('simsend', (domain) => [
    { type: 'TXT', name: `sim._domainkey.${domain}`, value: 'v=DKIM1; k=rsa; p=SIMULATED' },
    { type: 'MX', name: `bounce.${domain}`, value: 'feedback.sim-email.invalid', priority: 10 },
    { type: 'TXT', name: `bounce.${domain}`, value: 'v=spf1 include:sim-email.invalid ~all' },
  ]);
  return {
    key,
    domains: s.domains,
    createDomain: ({ domain, idempotencyKey }) => s.register(domain, idempotencyKey),
    checkDomain: ({ domain, providerDomainId }) => s.check(domain, providerDomainId),
    removeDomain: ({ domain }) => s.remove(domain),
    verify: s.verify,
    failNext: s.failNext,
    has: s.has,
    reset: s.reset,
  };
}
