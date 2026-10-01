import 'server-only';
import type { Principal } from '@ros/core';
import { clientIp } from './http';
import { type Site, getSite, getVisitor } from './site';

/**
 * Who is calling a venue site's route handler: the org from the host (never the body), the
 * visitor's principal from their cookies, and the visitor session for attribution.
 */
export async function siteActor(req: Request, host: string): Promise<{ site: Site; principal: Principal; visitorSessionId: string | null; customerId: string | null; ip: string | undefined }> {
  const site = await getSite(host);
  const v = await getVisitor(site.orgId);
  return { site, principal: v.principal, visitorSessionId: v.visitorSessionId, customerId: v.customerId, ip: clientIp(req) };
}

/** Only the named keys of a JSON body, so a browser cannot add fields the server sets itself. */
export function pick<T extends Record<string, unknown>, K extends string>(body: T, keys: readonly K[]): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}
