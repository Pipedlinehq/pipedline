/**
 * Domains we attach on a venue's behalf: a custom domain on the web project, and the org's own
 * marketing sending domain at the email provider. Both follow the same shape: register, show
 * the venue which DNS records to add, then poll until the provider confirms them
 * (docs/modules/website.md section 6, docs/ONBOARDING.md section 3).
 *
 * A venue never declares its own domain verified: only the provider's answer does
 * (docs/THREAT_MODEL.md section 6, "Custom domains").
 */
export interface DnsRecord {
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX';
  /** The record name as the registrar wants it, e.g. "@", "www", "_vercel", "send". */
  name: string;
  value: string;
  priority?: number;
}

export interface DomainRegistration {
  providerDomainId: string;
  /** What the venue must add at its registrar. */
  records: DnsRecord[];
  verified: boolean;
}

export interface DomainCheck {
  verified: boolean;
  records: DnsRecord[];
  /** Plain words when not verified, e.g. "The CNAME record has not been found yet." */
  reason?: string;
}

/** The web host (one project, many domains). Registered under the `hosting` adapter kind. */
export interface HostingPort {
  key: string;
  /** Attach a domain to the project. The same idempotency key returns the same registration. */
  addDomain(args: { host: string; idempotencyKey: string }): Promise<DomainRegistration>;
  checkDomain(args: { host: string; providerDomainId: string }): Promise<DomainCheck>;
  /** Detach a domain so a lapsed DNS record cannot be pointed at someone else's content. Removing an absent domain is not an error. */
  removeDomain(args: { host: string; providerDomainId: string | null }): Promise<void>;
}

/**
 * The email provider's side of a per-org marketing sending domain. Registered under the
 * `sending_domain` adapter kind with the same key as the message adapter that sends through it.
 */
export interface SendingDomainPort {
  key: string;
  createDomain(args: { domain: string; idempotencyKey: string }): Promise<DomainRegistration>;
  checkDomain(args: { domain: string; providerDomainId: string }): Promise<DomainCheck>;
  removeDomain(args: { domain: string; providerDomainId: string | null }): Promise<void>;
}
