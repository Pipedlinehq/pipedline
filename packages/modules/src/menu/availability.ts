import { z } from 'zod';
import { type Ctx, addDays, audit, invalid, localParts, requireDevice, track, zonedTimeToUtc } from '@ros/core';
import { openWindows } from '../tenancy/hours';
import { getVenue } from '../tenancy/venues';
import { loadItemRow, loadModifierRow } from './edit';
import { itemAvailabilityChanged, modifierAvailabilityChanged } from './module';
import { itemAvailableAt, itemBackAt } from './public';

/**
 * The choices for how long a sold-out item stays off ("86'd until", docs/CONSOLE_IA.md section 9
 * pattern 11): the end of this service, tomorrow, a time, or until someone puts it back.
 */
export const UNTIL_CHOICES = ['end_of_service', 'tomorrow', 'until_changed'] as const;
export type UntilChoice = (typeof UNTIL_CHOICES)[number];

export const availabilityInput = z.object({
  itemId: z.string().uuid(),
  available: z.boolean(),
  /**
   * When an 86'd item comes back on its own. 'end_of_service' = when the current (or next)
   * trading period closes. 'tomorrow' = when the venue opens tomorrow (the venue's own day), or
   * tomorrow's midnight if it is closed then. An ISO time = then. Omitted, null or
   * 'until_changed' = until someone puts it back.
   */
  until: z.union([z.enum(UNTIL_CHOICES), z.string().datetime({ offset: true })]).nullish(),
});

export interface ItemAvailability {
  itemId: string;
  venueId: string;
  name: string;
  available: boolean;
  /** When it comes back on its own; null for "until someone puts it back" (and when available). */
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

/** When the venue opens tomorrow (its own calendar), or tomorrow's midnight when it is closed that day. */
async function tomorrowOpening(ctx: Ctx, venueId: string): Promise<Date> {
  const venue = await getVenue(ctx, venueId);
  const tomorrow = addDays(localParts(ctx.now(), venue.timezone).date, 1);
  const windows = (await openWindows(ctx, venueId, tomorrow)).sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
  return windows[0]?.opensAt ?? zonedTimeToUtc(tomorrow, '00:00:00', venue.timezone);
}

/** The instant an `until` choice stands for, at this venue, now. Null = until someone puts it back. */
export async function resolveUntil(ctx: Ctx, venueId: string, until: z.output<typeof availabilityInput>['until']): Promise<Date | null> {
  if (!until || until === 'until_changed') return null;
  if (until === 'end_of_service') return endOfService(ctx, venueId);
  if (until === 'tomorrow') return tomorrowOpening(ctx, venueId);
  const at = new Date(until);
  if (at.getTime() <= ctx.now().getTime()) throw invalid('That time has already passed. Pick a time still to come, or "until someone puts it back".');
  return at;
}

/**
 * The 86 button: one tap from the kitchen's phone or screen. Kitchen staff, anyone above them,
 * and a paired kitchen screen may use it. The change shows on the site, the QR menu, in ordering
 * and inside assistants at once, because they all read these rows. The return is automatic and
 * needs no job: readers compare `unavailable_until` with the clock (`itemAvailableAt`).
 */
export async function setItemAvailability(ctx: Ctx, raw: z.input<typeof availabilityInput>): Promise<ItemAvailability> {
  const input = availabilityInput.parse(raw);
  const item = await loadItemRow(ctx, input.itemId);
  requireDevice(ctx, item.venue_id, 'kitchen');

  const until = input.available ? null : await resolveUntil(ctx, item.venue_id, input.until);

  await ctx.db.updateTable('menu_items').set({ is_available: input.available, unavailable_until: until }).where('id', '=', item.id).execute();

  await audit(ctx, {
    action: input.available ? 'menu.item_restored' : 'menu.item_86',
    entityType: 'menu_item',
    entityId: item.id,
    venueId: item.venue_id,
    before: { name: item.name, isAvailable: itemAvailableAt(item, ctx.now()), unavailableUntil: itemBackAt(item, ctx.now()) },
    after: { name: item.name, isAvailable: input.available, unavailableUntil: until },
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
    before: { name: mod.name, isAvailable: mod.is_available },
    after: { name: mod.name, isAvailable: input.available },
  });
  await track(ctx, modifierAvailabilityChanged, { modifier_id: mod.id, name: mod.name, available: input.available, by: ctx.principal.kind }, { venueId: mod.venue_id });
  return { modifierId: mod.id, name: mod.name, available: input.available };
}

/** "back 9:30 pm" / "back Sat 8:00 am" / "until put back", for screens and tools, in the venue's zone. */
export function backWords(until: Date | null, now: Date, timeZone: string): string {
  if (!until) return 'until put back';
  const sameDay = localParts(until, timeZone).date === localParts(now, timeZone).date;
  const time = new Intl.DateTimeFormat('en-AU', { timeZone, hour: 'numeric', minute: '2-digit' }).format(until);
  if (sameDay) return `back ${time}`;
  const day = new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(until).replace(/^(\w+),/, '$1');
  return `back ${day}, ${time}`;
}
