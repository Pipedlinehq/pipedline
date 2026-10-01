import { z } from 'zod';
import { type Ctx, listPlugs } from '@ros/core';
import { getOrgSettings } from '../tenancy/orgs';

/**
 * Which tier sends this org's marketing email (docs/modules/comms.md section 7).
 *
 *   native     we send it through the outbox
 *   connected  the venue's own email platform sends it, from its own flows; we keep consent and
 *              push profiles, consents and events to it
 *
 * Transactional messages are always native, whatever this says.
 */
export const ESP_SETTINGS_NAMESPACE = 'comms_esp';
export const espSettings = z.object({
  emailMarketingTier: z.enum(['native', 'connected']).default('native'),
});
export type EspSettings = z.infer<typeof espSettings>;
export const defaultEspSettings: EspSettings = espSettings.parse({});

/**
 * 'connected' when the org chose the connected tier AND still has an email-platform connection
 * that is not revoked. Revoking the connection puts marketing email back on the native tier.
 */
export async function emailMarketingTier(ctx: Ctx): Promise<'native' | 'connected'> {
  const settings = await getOrgSettings(ctx, ESP_SETTINGS_NAMESPACE, espSettings, defaultEspSettings);
  if (settings.emailMarketingTier !== 'connected') return 'native';
  const keys = listPlugs()
    .filter((p) => p.adapters.esp)
    .map((p) => p.key);
  if (!keys.length) return 'native';
  const live = await ctx.db
    .selectFrom('connections')
    .select('id')
    .where('plug_key', 'in', keys)
    .where('venue_id', 'is', null)
    .where('status', 'in', ['connected', 'unhealthy'])
    .executeTakeFirst();
  return live ? 'connected' : 'native';
}
