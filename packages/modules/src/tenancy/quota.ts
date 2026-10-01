import { z } from 'zod';
import { type Ctx, audit, conflict, forbidden, isInternal, json } from '@ros/core';

/**
 * What a free organisation may hold (docs/PIPEDLINE.md sections 1 and 6: "quotas per free org").
 * Stored under orgs.settings.quota. Read by anyone in the org; written only by platform code:
 * an organisation never sets its own quota, so `setOrgSettings` refuses this namespace.
 */
export const ORG_QUOTA_NAMESPACE = 'quota';

export const orgQuota = z.object({
  /** Venues that are not closed. Reaching it stops a further venue being added; nothing existing is touched. */
  max_venues: z.number().int().min(1).max(500).default(5),
});
export type OrgQuota = z.infer<typeof orgQuota>;

/** Namespaces of orgs.settings that only platform code may write. */
export const PLATFORM_ONLY_NAMESPACES: ReadonlySet<string> = new Set([ORG_QUOTA_NAMESPACE]);

export async function getOrgQuota(ctx: Ctx): Promise<OrgQuota> {
  const r = await ctx.db.selectFrom('orgs').select('settings').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const parsed = orgQuota.safeParse(((r.settings ?? {}) as Record<string, unknown>)[ORG_QUOTA_NAMESPACE] ?? {});
  return parsed.success ? parsed.data : orgQuota.parse({});
}

/** Write the organisation's quota. Platform code and workers only (provisioning, the platform console). */
export async function writeOrgQuota(ctx: Ctx, patch: Partial<OrgQuota>): Promise<OrgQuota> {
  if (!isInternal(ctx)) throw forbidden('Only the platform team can change that.');
  const before = await getOrgQuota(ctx);
  const next = orgQuota.parse({ ...before, ...patch });
  const r = await ctx.db.selectFrom('orgs').select('settings').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  await ctx.db
    .updateTable('orgs')
    .set({ settings: json({ ...((r.settings ?? {}) as Record<string, unknown>), [ORG_QUOTA_NAMESPACE]: next }) })
    .where('id', '=', ctx.orgId)
    .execute();
  await audit(ctx, { action: 'org.quota_set', entityType: 'org', entityId: ctx.orgId, before, after: next });
  return next;
}

/** Refuse a further venue once the organisation holds as many as its quota allows. Provisioning is not held to it. */
export async function assertVenueQuota(ctx: Ctx): Promise<void> {
  if (isInternal(ctx)) return;
  const { max_venues } = await getOrgQuota(ctx);
  const held = await ctx.db
    .selectFrom('venues')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('status', '!=', 'closed')
    .executeTakeFirstOrThrow();
  if (Number(held.n) >= max_venues) {
    throw conflict(`This organisation can have up to ${max_venues} ${max_venues === 1 ? 'venue' : 'venues'}. Contact us to add more.`);
  }
}
