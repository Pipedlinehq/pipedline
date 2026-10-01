import 'server-only';
import type { Ctx } from '@ros/core';
import { getModule } from '@ros/core';
import { tenancy, website } from '@ros/modules';

/**
 * The public address of a venue's site: its primary domain when the website module can say,
 * otherwise the platform subdomain. Outside production the platform host's port is kept, so a
 * link printed from a local stack opens on that stack.
 */
export async function siteBase(ctx: Ctx, venueId: string): Promise<string> {
  let base: string | null = null;
  if ((await getModule(ctx, venueId, website.websiteModule)).enabled) {
    try {
      base = (await website.getSite(ctx, { venueId })).canonicalBase;
    } catch {
      base = null;
    }
  }
  if (!base) {
    const org = await tenancy.getOrg(ctx);
    base = `${ctx.app.config.scheme}://${org.slug}.${ctx.app.config.tenantRootDomain}`;
  }
  const port = ctx.app.config.platformHost.match(/:(\d+)$/)?.[1];
  if (ctx.app.config.env !== 'production' && port && !/:\d+$/.test(base)) base = `${base}:${port}`;
  return base;
}

/** True for addresses that can never load (the simulated asset store uses the reserved .invalid TLD). */
export function unloadable(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('.invalid');
  } catch {
    return false;
  }
}
