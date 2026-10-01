import 'server-only';
import { cache } from 'react';
import { getModule, type ModuleDef } from '@ros/core';
import { campaigns, delivery, hub, loyalty, offers, ordering, qr, reviews, website } from '@ros/modules';
import { inConsole } from './console';

/** The toggleable modules whose surfaces appear in the console, by key. */
export const CONSOLE_MODULES = {
  ordering: ordering.orderingModule,
  delivery: delivery.deliveryModule,
  qr: qr.qrModule,
  loyalty: loyalty.loyaltyModule,
  offers: offers.offersModule,
  website: website.websiteModule,
  hub: hub.hubModule,
  campaigns: campaigns.campaignsModule,
  reviews: reviews.reviewsModule,
} satisfies Record<string, ModuleDef<any>>;

export type ConsoleModuleKey = keyof typeof CONSOLE_MODULES;

/**
 * Which modules are on at the selected venue. Hiding a switched-off module's screens is a
 * courtesy; its services answer as not-found whatever the page shows.
 */
export const moduleStates = cache(async (): Promise<Record<ConsoleModuleKey, boolean>> => {
  return inConsole(async (ctx, c) => {
    const out = {} as Record<ConsoleModuleKey, boolean>;
    for (const [key, def] of Object.entries(CONSOLE_MODULES) as Array<[ConsoleModuleKey, ModuleDef<any>]>) {
      out[key] = (await getModule(ctx, c.venue.id, def)).enabled;
    }
    return out;
  });
});

export async function moduleOn(key: ConsoleModuleKey): Promise<boolean> {
  return (await moduleStates())[key];
}
