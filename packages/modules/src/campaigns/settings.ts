import { type Ctx, AppError, getModule, requireStaff, visibleVenueIds } from '@ros/core';
import { getOrgSettings, setOrgSettings } from '../tenancy/orgs';
import { CAMPAIGNS_SETTINGS_NAMESPACE, type CampaignsSettings, campaignsModule, campaignsSettings, defaultCampaignsSettings } from './module';

export async function getCampaignsSettings(ctx: Ctx): Promise<CampaignsSettings> {
  return getOrgSettings(ctx, CAMPAIGNS_SETTINGS_NAMESPACE, campaignsSettings, defaultCampaignsSettings);
}

/** Manager and above. A partial value is merged over what is stored and validated as a whole. */
export async function setCampaignsSettings(ctx: Ctx, patch: Partial<CampaignsSettings>): Promise<CampaignsSettings> {
  requireStaff(ctx, { minRole: 'manager' });
  await assertCampaignsOnSomewhere(ctx);
  const current = await getCampaignsSettings(ctx);
  return setOrgSettings(ctx, CAMPAIGNS_SETTINGS_NAMESPACE, campaignsSettings, { ...current, ...patch });
}

/** Venues where the campaigns module is on, in creation order. */
export async function campaignVenueIds(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .selectFrom('venue_modules as m')
    .innerJoin('venues as v', 'v.id', 'm.venue_id')
    .select('m.venue_id')
    .where('m.module_key', '=', campaignsModule.key)
    .where('m.enabled', '=', true)
    .orderBy('v.created_at')
    .execute();
  return rows.map((r) => r.venue_id);
}

/**
 * Org-level surfaces (segments, flows): the module must be on at a venue the caller can see.
 * A caller who sees none of the venues it is on gets not-found, like a module that is off.
 */
export async function assertCampaignsOnSomewhere(ctx: Ctx): Promise<string[]> {
  const on = await campaignVenueIds(ctx);
  const visible = visibleVenueIds(ctx);
  const mine = visible ? on.filter((v) => visible.includes(v)) : on;
  if (!mine.length) throw new AppError('module_disabled', 'That is not available at this venue.');
  return mine;
}

export async function campaignsOnAt(ctx: Ctx, venueId: string): Promise<boolean> {
  return (await getModule(ctx, venueId, campaignsModule)).enabled;
}

/** The org's first venue: the home of a guest whose history names none. */
export async function primaryVenueId(ctx: Ctx): Promise<string> {
  const r = await ctx.db.selectFrom('venues').select('id').orderBy('created_at').orderBy('id').executeTakeFirstOrThrow();
  return r.id;
}
