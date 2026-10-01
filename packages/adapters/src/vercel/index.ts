import type { DnsRecord, DomainCheck, DomainRegistration, HostingPort } from '@ros/core';

/**
 * Vercel project domains: a venue's custom domain attached to the one web project
 * (ports/hosting.ts).
 *
 * UNVERIFIED LIVE. Written from Vercel's REST API reference as read on 2026-10-01 and tested
 * only against payloads built from that reference, with a stubbed fetch. It has never been
 * called against Vercel.
 *
 * Endpoints used (vercel.com/docs/rest-api, all `Authorization: Bearer <token>`, `?teamId=`):
 *   POST   /v10/projects/{idOrName}/domains                   { name } → { name, apexName, verified, verification[] }
 *   GET    /v9/projects/{idOrName}/domains/{domain}           the same shape
 *   POST   /v9/projects/{idOrName}/domains/{domain}/verify    re-check the ownership challenge (400 while it is unmet)
 *   DELETE /v9/projects/{idOrName}/domains/{domain}
 *   GET    /v9/projects/{idOrName}/domains                    list (smoke check only)
 *   GET    /v6/domains/{domain}/config                        { misconfigured, configuredBy, recommendedCNAME[], recommendedIPv4[] }
 *
 * How the port maps:
 *   - Vercel gives a project domain no id of its own: `providerDomainId` is the domain name.
 *   - Vercel has no idempotency key. Adding a domain the project already has is answered with
 *     an error; this adapter then reads the domain back and returns it, so a retry is the
 *     same registration. A domain held by ANOTHER project stays an error.
 *   - A domain counts as verified only when Vercel says both that it is verified for the
 *     project (`verified: true`) and that its DNS points at Vercel (`misconfigured: false`).
 *
 * Not confirmed by the pages read:
 *   - the JSON error body (read as `{ error: { code, message } }`)
 *   - the exact status of "already on this project": the reference lists it under both 400
 *     (prose) and 409, so both are treated as "read it back"
 *   - whether `recommendedIPv4[].value` is always an array of addresses (a string is accepted too)
 */
export const VERCEL_KEY = 'vercel';
const BASE = 'https://api.vercel.com';

export interface VercelOptions {
  token: string;
  /** The project every venue's site is served from: its id or its name. */
  projectId: string;
  teamId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
}

export class VercelApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, path: string) {
    super(`vercel: ${status} on ${path} (${code})`);
    this.name = 'VercelApiError';
    this.status = status;
    this.code = code;
  }
}

interface VercelProjectDomain {
  name: string;
  apexName: string;
  verified: boolean;
  verification?: Array<{ type: string; domain: string; value: string; reason?: string }>;
}

interface VercelDomainConfig {
  misconfigured: boolean;
  configuredBy?: string | null;
  recommendedCNAME?: Array<{ rank: number; value: string }>;
  recommendedIPv4?: Array<{ rank: number; value: string[] | string }>;
}

async function vercelCall<T>(opts: VercelOptions, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, opts.apiBase ?? BASE);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  if (opts.teamId) url.searchParams.set('teamId', opts.teamId);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      method,
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new Error(`vercel: request to ${path} did not complete (${(e as Error).name})`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const code = (parsed as { error?: { code?: unknown } } | null)?.error?.code;
    throw new VercelApiError(res.status, typeof code === 'string' ? code : 'unknown_error', path);
  }
  return (parsed ?? {}) as T;
}

/** The record name as a registrar wants it: the part of `fqdn` in front of the apex, or "@". */
export function relativeName(fqdn: string, apex: string): string {
  const f = fqdn.toLowerCase().replace(/\.$/, '');
  const a = apex.toLowerCase();
  if (f === a) return '@';
  return f.endsWith(`.${a}`) ? f.slice(0, -(a.length + 1)) : f;
}

/** What the venue must add: any ownership challenge Vercel set, plus the record that points the host at Vercel. */
export function vercelRecords(d: VercelProjectDomain, config: VercelDomainConfig | null): DnsRecord[] {
  const out: DnsRecord[] = [];
  for (const v of d.verification ?? []) {
    if (v.type === 'TXT') out.push({ type: 'TXT', name: relativeName(v.domain, d.apexName), value: v.value });
  }
  const best = <T extends { rank: number }>(list: T[] | undefined) => [...(list ?? [])].sort((x, y) => x.rank - y.rank)[0];
  const name = relativeName(d.name, d.apexName);
  if (name === '@') {
    const ip = best(config?.recommendedIPv4)?.value;
    const first = Array.isArray(ip) ? ip[0] : ip;
    if (first) out.push({ type: 'A', name, value: first });
  } else {
    const cname = best(config?.recommendedCNAME)?.value;
    if (cname) out.push({ type: 'CNAME', name, value: cname.replace(/\.$/, '') });
  }
  return out;
}

export function createVercelHosting(opts: VercelOptions): HostingPort {
  const project = `/projects/${encodeURIComponent(opts.projectId)}`;
  const domainPath = (host: string) => `/v9${project}/domains/${encodeURIComponent(host)}`;
  const getDomain = (host: string) => vercelCall<VercelProjectDomain>(opts, 'GET', domainPath(host));
  const getConfig = (host: string) => vercelCall<VercelDomainConfig>(opts, 'GET', `/v6/domains/${encodeURIComponent(host)}/config`, undefined, { projectIdOrName: opts.projectId });

  async function state(d: VercelProjectDomain): Promise<{ verified: boolean; records: DnsRecord[]; reason?: string }> {
    const config = await getConfig(d.name);
    const records = vercelRecords(d, config);
    if (!d.verified) return { verified: false, records, reason: 'The TXT record that proves the domain is yours has not been found yet.' };
    if (config.misconfigured) return { verified: false, records, reason: 'The domain does not point at the site yet: its DNS record has not been found.' };
    return { verified: true, records };
  }

  return {
    key: VERCEL_KEY,

    async addDomain({ host }): Promise<DomainRegistration> {
      let d: VercelProjectDomain;
      try {
        d = await vercelCall<VercelProjectDomain>(opts, 'POST', `/v10${project}/domains`, { name: host });
      } catch (e) {
        if (!(e instanceof VercelApiError) || (e.status !== 400 && e.status !== 409)) throw e;
        // Already on this project (a retry), or refused. Only the first can be read back.
        try {
          d = await getDomain(host);
        } catch {
          throw e;
        }
      }
      const s = await state(d);
      return { providerDomainId: d.name, records: s.records, verified: s.verified };
    },

    async checkDomain({ host, providerDomainId }): Promise<DomainCheck> {
      if (providerDomainId.toLowerCase() !== host.toLowerCase()) return { verified: false, records: [], reason: 'That domain is not registered with the web host.' };
      let d: VercelProjectDomain;
      try {
        d = await getDomain(host);
      } catch (e) {
        if (e instanceof VercelApiError && e.status === 404) return { verified: false, records: [], reason: 'That domain is not registered with the web host.' };
        throw e;
      }
      if (!d.verified) {
        try {
          const after = await vercelCall<VercelProjectDomain>(opts, 'POST', `${domainPath(host)}/verify`);
          // The verify answer carries no challenge list; keep the one already read.
          d = { ...d, verified: after.verified === true };
        } catch (e) {
          // 400: the challenge is still unmet. Anything else is a real failure.
          if (!(e instanceof VercelApiError) || e.status !== 400) throw e;
        }
      }
      return state(d);
    },

    async removeDomain({ host }): Promise<void> {
      try {
        await vercelCall(opts, 'DELETE', domainPath(host));
      } catch (e) {
        if (e instanceof VercelApiError && e.status === 404) return;
        throw e;
      }
    },
  };
}

/** Read-only: the project's domains. Used by scripts/smoke-live.ts to prove the token and project id work. */
export async function vercelListProjectDomains(opts: VercelOptions): Promise<Array<{ name: string; verified: boolean }>> {
  const res = await vercelCall<{ domains?: VercelProjectDomain[] }>(opts, 'GET', `/v9/projects/${encodeURIComponent(opts.projectId)}/domains`, undefined, { limit: '100' });
  return (res.domains ?? []).map((d) => ({ name: d.name, verified: d.verified === true }));
}
