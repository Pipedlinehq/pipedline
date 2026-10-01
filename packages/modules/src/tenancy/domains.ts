import { z } from 'zod';
import { type App, type Ctx, audit, conflict, forbidden, invalid, isUniqueViolation, notFound, requireOwner } from '@ros/core';

export interface ResolvedHost {
  orgId: string;
  /** Set when the host is one venue's own site; null for the org-level (group) site. */
  venueId: string | null;
  host: string;
  /** The host this one should redirect to, when it is not the primary. */
  primaryHost: string;
  orgStatus: 'onboarding' | 'live' | 'paused' | 'closed';
}

const cache = new Map<string, { at: number; value: ResolvedHost | null }>();
const TTL_MS = 30_000;

/**
 * Host → tenant. The only way a public request learns which org it is for: from the domains
 * table, for verified hosts only, never from a path or a header the client controls
 * (docs/ARCHITECTURE.md section 2, docs/THREAT_MODEL.md section 5).
 */
export async function resolveHost(app: App, rawHost: string): Promise<ResolvedHost | null> {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return null;
  const hit = cache.get(host);
  const now = app.clock().getTime();
  if (hit && now - hit.at < TTL_MS) return hit.value;

  const row = await app.db
    .selectFrom('domains as d')
    .innerJoin('orgs as o', 'o.id', 'd.org_id')
    .select(['d.org_id', 'd.venue_id', 'd.host', 'd.is_primary', 'o.status'])
    .where('d.host', '=', host)
    .where('d.verified_at', 'is not', null)
    .executeTakeFirst();

  let value: ResolvedHost | null = null;
  if (row) {
    let primaryHost = row.host;
    if (!row.is_primary) {
      const primary = await app.db
        .selectFrom('domains')
        .select('host')
        .where('org_id', '=', row.org_id)
        .where((eb) => (row.venue_id ? eb('venue_id', '=', row.venue_id) : eb('venue_id', 'is', null)))
        .where('is_primary', '=', true)
        .where('verified_at', 'is not', null)
        .executeTakeFirst();
      if (primary) primaryHost = primary.host;
    }
    value = { orgId: row.org_id, venueId: row.venue_id, host: row.host, primaryHost, orgStatus: row.status };
  }
  cache.set(host, { at: now, value });
  return value;
}

export function clearHostCache(): void {
  cache.clear();
}

export interface DomainView {
  id: string;
  host: string;
  kind: string;
  venueId: string | null;
  isPrimary: boolean;
  verified: boolean;
}

/** The verified host a venue's (or the organisation's) public site answers on. No role check: it is public. */
export async function getPrimaryHost(ctx: Ctx, venueId?: string | null): Promise<string | null> {
  const rows = await ctx.db.selectFrom('domains').select(['host', 'venue_id', 'is_primary']).where('verified_at', 'is not', null).orderBy('created_at').execute();
  const pick = (list: typeof rows) => list.find((r) => r.is_primary) ?? list[0];
  return (pick(rows.filter((r) => venueId && r.venue_id === venueId)) ?? pick(rows.filter((r) => r.venue_id === null)))?.host ?? null;
}

export async function listDomains(ctx: Ctx): Promise<DomainView[]> {
  requireOwner(ctx);
  const rows = await ctx.db.selectFrom('domains').select(['id', 'host', 'kind', 'venue_id', 'is_primary', 'verified_at']).orderBy('created_at').execute();
  return rows.map((r) => ({ id: r.id, host: r.host, kind: r.kind, venueId: r.venue_id, isPrimary: r.is_primary, verified: r.verified_at !== null }));
}

export const customDomainInput = z.object({
  host: z
    .string()
    .toLowerCase()
    .regex(/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/, 'Enter a domain such as bellastrattoria.com.au.'),
  venueId: z.string().uuid().nullish(),
});

/** Register a custom domain. It serves nothing until verified; the subdomain keeps working throughout. */
export async function addCustomDomain(ctx: Ctx, raw: z.input<typeof customDomainInput>): Promise<DomainView> {
  requireOwner(ctx);
  const input = customDomainInput.parse(raw);
  const root = ctx.app.config.tenantRootDomain;
  if (input.host === root || input.host.endsWith(`.${root}`) || input.host === ctx.app.config.platformHost) {
    throw invalid('That domain belongs to the platform.');
  }
  try {
    const r = await ctx.db
      .insertInto('domains')
      .values({ org_id: ctx.orgId, venue_id: input.venueId ?? null, host: input.host, kind: 'custom', is_primary: false })
      .returning(['id', 'host', 'kind', 'venue_id', 'is_primary', 'verified_at'])
      .executeTakeFirstOrThrow();
    await audit(ctx, { action: 'domain.added', entityType: 'domain', entityId: r.id, after: { host: r.host } });
    return { id: r.id, host: r.host, kind: r.kind, venueId: r.venue_id, isPrimary: r.is_primary, verified: false };
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('That domain is already registered.');
    throw e;
  }
}

/**
 * Mark a custom domain verified and make it primary; the subdomain then redirects to it.
 * Called by provisioning once the hosting provider confirms the DNS records.
 */
export async function markDomainVerified(ctx: Ctx, domainId: string, providerDomainId?: string): Promise<void> {
  // Never an owner: a venue cannot declare its own domain verified (docs/THREAT_MODEL.md section 6).
  if (ctx.principal.kind !== 'platform' && ctx.principal.kind !== 'worker') throw forbidden('Verification is confirmed by the hosting provider.');
  const d = await ctx.db.selectFrom('domains').select(['id', 'venue_id', 'host']).where('id', '=', domainId).executeTakeFirst();
  if (!d) throw notFound('Domain not found');
  await ctx.db
    .updateTable('domains')
    .set({ is_primary: false })
    .where((eb) => (d.venue_id ? eb('venue_id', '=', d.venue_id) : eb('venue_id', 'is', null)))
    .execute();
  await ctx.db
    .updateTable('domains')
    .set({ verified_at: ctx.now(), is_primary: true, provider_domain_id: providerDomainId ?? null })
    .where('id', '=', domainId)
    .execute();
  await audit(ctx, { action: 'domain.verified', entityType: 'domain', entityId: domainId, after: { host: d.host } });
  ctx.afterCommit(clearHostCache);
}

/** Remove a custom domain (offboarding, or a lapsed registration) so it can never be pointed at other content. */
export async function removeDomain(ctx: Ctx, domainId: string): Promise<void> {
  requireOwner(ctx);
  const d = await ctx.db.selectFrom('domains').select(['id', 'kind', 'host', 'venue_id', 'is_primary']).where('id', '=', domainId).executeTakeFirst();
  if (!d) throw notFound('Domain not found');
  if (d.kind === 'subdomain') throw invalid('The platform subdomain cannot be removed.');
  await ctx.db.deleteFrom('domains').where('id', '=', domainId).execute();
  if (d.is_primary) {
    await ctx.db
      .updateTable('domains')
      .set({ is_primary: true })
      .where('kind', '=', 'subdomain')
      .where((eb) => (d.venue_id ? eb('venue_id', '=', d.venue_id) : eb('venue_id', 'is', null)))
      .execute();
  }
  await audit(ctx, { action: 'domain.removed', entityType: 'domain', entityId: domainId, before: { host: d.host } });
  ctx.afterCommit(clearHostCache);
}
