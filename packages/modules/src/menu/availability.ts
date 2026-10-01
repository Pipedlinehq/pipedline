import { z } from 'zod';
import { type Ctx, addDays, audit, localParts, requireDevice, track, zonedTimeToUtc } from '@ros/core';
import { openWindows } from '../tenancy/hours';
import { getVenue } from '../tenancy/venues';
import { loadItemRow, loadModifierRow } from './edit';
import { itemAvailabilityChanged, modifierAvailabilityChanged } from './module';
import { itemAvailableAt } from './public';

export const availabilityInput = z.object({
  itemId: z.string().uuid(),
  available: z.boolean(),
  /**
   * When an 86'd item comes back on its own. 'end_of_service' = when the current (or next)
   * trading period closes. An ISO time = then. Omitted or null = until someone puts it back.
   */
  until: z.union([z.literal('end_of_service'), z.string().datetime()]).nullish(),
});

export interface ItemAvailability {
  itemId: string;
  venueId: string;
  name: string;
  available: boolean;
  until: Date | null;
}

/** When the trading period a kitchen is in (or about to start) ends; the end of the local day if there is none. */
async function endOfService(ctx: Ctx, venueId: string): Promise<Date> {
  const venue = await getVenue(ctx, venueId);
  const now = ctx.now();
  const today = localParts(now, venue.timezone).date;
  // Yesterday's late period may still be running.
  for (const date of [addDays(today, -1), today]) {
    const windows = (await openWindows(ctx, venueId, date)).sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
    for (const w of windows) if (w.closesAt > now && (date === today || w.opensAt <= now)) return w.closesAt;
  }
  return zonedTimeToUtc(addDays(today, 1), '00:00:00', venue.timezone);
}

/**
 * The 86 button: one tap from the kitchen's phone or screen. Kitchen staff, anyone above them,
 * and a paired kitchen screen may use it. The change shows on the site, the QR menu and in
 * ordering at once, because they all read these rows.
 */
export async function setItemAvailability(ctx: Ctx, raw: z.input<typeof availabilityInput>): Promise<ItemAvailability> {
  const input = availabilityInput.parse(raw);
  const item = await loadItemRow(ctx, input.itemId);
  requireDevice(ctx, item.venue_id, 'kitchen');

  let until: Date | null = null;
  if (!input.available && input.until) {
    until = input.until === 'end_of_service' ? await endOfService(ctx, item.venue_id) : new Date(input.until);
    if (until <= ctx.now()) until = null;
  }

  await ctx.db.updateTable('menu_items').set({ is_available: input.available, unavailable_until: until }).where('id', '=', item.id).execute();

  await audit(ctx, {
    action: input.available ? 'menu.item_restored' : 'menu.item_86',
    entityType: 'menu_item',
    entityId: item.id,
    venueId: item.venue_id,
    before: { isAvailable: itemAvailableAt(item, ctx.now()), unavailableUntil: item.unavailable_until },
    after: { isAvailable: input.available, unavailableUntil: until },
  });
  await track(
    ctx,
    itemAvailabilityChanged,
    { menu_item_id: item.id, name: item.name, available: input.available, until: until ? until.toISOString() : null, by: ctx.principal.kind },
    { venueId: item.venue_id },
  );
  return { itemId: item.id, venueId: item.venue_id, name: item.name, available: input.available, until };
}

export const modifierAvailabilityInput = z.object({ modifierId: z.string().uuid(), available: z.boolean() });

/** The same button for one option in a group: "no oat milk today". */
export async function setModifierAvailability(ctx: Ctx, raw: z.input<typeof modifierAvailabilityInput>): Promise<{ modifierId: string; name: string; available: boolean }> {
  const input = modifierAvailabilityInput.parse(raw);
  const mod = await loadModifierRow(ctx, input.modifierId);
  requireDevice(ctx, mod.venue_id, 'kitchen');
  await ctx.db.updateTable('modifiers').set({ is_available: input.available }).where('id', '=', mod.id).execute();
  await audit(ctx, {
    action: input.available ? 'menu.modifier_restored' : 'menu.modifier_86',
    entityType: 'menu_modifier',
    entityId: mod.id,
    venueId: mod.venue_id,
    before: { isAvailable: mod.is_available },
    after: { isAvailable: input.available },
  });
  await track(ctx, modifierAvailabilityChanged, { modifier_id: mod.id, name: mod.name, available: input.available, by: ctx.principal.kind }, { venueId: mod.venue_id });
  return { modifierId: mod.id, name: mod.name, available: input.available };
}
