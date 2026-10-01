import { z } from 'zod';
import type { Ctx } from '@ros/core';
import { getOrgSettings, setOrgSettings } from '../tenancy/orgs';
import { registerOrgPluginSettings } from '../tenancy/plugins';

/**
 * Org-level analytics settings, stored under orgs.settings.analytics. Everything a venue might
 * reasonably want different is here, so no code path ever asks which venue it is.
 */
const daypart = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/),
  /** Venue-local hour the daypart starts at, inclusive. */
  fromHour: z.number().int().min(0).max(23),
  /** Venue-local hour it ends at, exclusive. A value at or below fromHour wraps past midnight. */
  toHour: z.number().int().min(0).max(24),
});

export const analyticsSettings = z.object({
  /**
   * The smallest group of guests a campaign or creator figure may describe. The platform floor
   * is 5; an org may raise it, never lower it (docs/modules/hub.md section 7).
   */
  minCohort: z.number().int().min(5).max(1000).default(5),
  /** No campaign or creator result is shown until this many days after its first activity. */
  campaignQuietDays: z.number().int().min(7).max(90).default(7),
  dayparts: z
    .array(daypart)
    .min(1)
    .max(8)
    .default([
      { key: 'breakfast', fromHour: 5, toHour: 11 },
      { key: 'lunch', fromHour: 11, toHour: 15 },
      { key: 'afternoon', fromHour: 15, toHour: 17 },
      { key: 'dinner', fromHour: 17, toHour: 22 },
      { key: 'late', fromHour: 22, toHour: 5 },
    ]),
  segments: z
    .object({
      /** A guest with one order is "new" for this many days, then a "one_timer". */
      newWindowDays: z.number().int().min(1).max(365).default(30),
      /** A repeat guest not seen for longer than this is "at_risk". */
      atRiskDays: z.number().int().min(1).max(730).default(60),
      /** … and for longer than this, "lapsed". */
      lapsedDays: z.number().int().min(2).max(1095).default(120),
      frequentOrders: z.number().int().min(3).max(100).default(5),
      loyalOrders: z.number().int().min(4).max(500).default(10),
    })
    .default({ newWindowDays: 30, atRiskDays: 60, lapsedDays: 120, frequentOrders: 5, loyalOrders: 10 }),
  digest: z
    .object({
      /** How many earlier like-for-like periods make the baseline. */
      baselinePeriods: z.number().int().min(4).max(26).default(8),
      /** A change beyond this many standard deviations of the baseline is worth mentioning. */
      notableSd: z.number().min(1).max(5).default(2),
      strongSd: z.number().min(1.5).max(8).default(3),
      /** … and it must also be at least this large relative to the baseline. */
      minChangeRatio: z.number().min(0).max(1).default(0.05),
      topMovers: z.number().int().min(1).max(10).default(3),
    })
    .default({ baselinePeriods: 8, notableSd: 2, strongSd: 3, minChangeRatio: 0.05, topMovers: 3 }),
});
export type AnalyticsSettings = z.infer<typeof analyticsSettings>;
export const defaultAnalyticsSettings: AnalyticsSettings = analyticsSettings.parse({});

export async function getAnalyticsSettings(ctx: Ctx): Promise<AnalyticsSettings> {
  return getOrgSettings(ctx, 'analytics', analyticsSettings, defaultAnalyticsSettings);
}

/** Manager and above. A partial value is merged over what is stored and validated as a whole. */
export async function setAnalyticsSettings(ctx: Ctx, patch: Partial<z.input<typeof analyticsSettings>>): Promise<AnalyticsSettings> {
  const current = await getAnalyticsSettings(ctx);
  // setOrgSettings validates the merged value and answers an invalid one as an AppError.
  return setOrgSettings(ctx, 'analytics', analyticsSettings, { ...current, ...patch } as AnalyticsSettings);
}

// Analytics is always on, so its settings are the organisation's: listed and changed as this plugin's settings.
registerOrgPluginSettings({ module: 'analytics', schema: analyticsSettings, get: getAnalyticsSettings, set: (ctx, patch) => setAnalyticsSettings(ctx, patch as Partial<z.input<typeof analyticsSettings>>) });

/** Which daypart a venue-local hour falls in. The first matching entry wins; unmatched hours are "other". */
export function daypartOf(hour: number, dayparts: AnalyticsSettings['dayparts']): string {
  for (const d of dayparts) {
    const wraps = d.toHour <= d.fromHour;
    if (wraps ? hour >= d.fromHour || hour < d.toHour : hour >= d.fromHour && hour < d.toHour) return d.key;
  }
  return 'other';
}
