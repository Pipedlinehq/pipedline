import { type Ctx, addDays, addMinutes, localParts, zonedTimeToUtc } from '@ros/core';
import { listHourExceptions, openWindows } from '../tenancy/hours';
import type { VenueView } from '../tenancy/venues';
import { type BookingsConfig, WEEKDAYS } from './module';

/**
 * Availability is computed, never stored (docs/modules/bookings.md section 3): the services of a
 * venue-local day come from the module's config (or the opening hours), an hour exception for
 * the day closes or narrows them, and the bookings already held are counted against the caps.
 * Every time is a venue-local wall-clock time turned into an instant with the venue's zone, so a
 * 19:00 sitting is 19:00 on either side of a daylight-saving change.
 */

/** Bookings in these states hold their covers. A declined or cancelled booking gives them back. */
export const HOLDING = ['requested', 'confirmed', 'seated', 'completed', 'no_show'] as const;

export interface Service {
  name: string;
  /** The venue-local day the service belongs to (a late service may run past midnight). */
  date: string;
  startsAt: Date;
  endsAt: Date;
  /** The latest time a table may be booked for. */
  lastStartAt: Date;
  /** Bookable times on the slot grid, in order. */
  slots: Date[];
}

export interface Held {
  id: string;
  booked_for: Date;
  party_size: number;
  duration_minutes: number;
  service_date: string;
  service_name: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
const toMinutes = (t: string) => {
  const [h, m] = t.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** The instant of a venue-local wall-clock time, `minutes` after midnight at the start of `date` (may exceed a day). */
function wallClock(date: string, minutes: number, tz: string): Date {
  const day = Math.floor(minutes / 1440);
  const m = minutes - day * 1440;
  return zonedTimeToUtc(addDays(date, day), `${pad(Math.floor(m / 60))}:${pad(m % 60)}`, tz);
}

/** "HH:MM" of an instant in the venue's zone. */
export function localTime(at: Date, tz: string): string {
  return localParts(at, tz).time.slice(0, 5);
}

export function weekdayOf(date: string): (typeof WEEKDAYS)[number] {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

function label(serviceType: string): string {
  if (!serviceType || serviceType === 'all') return 'Open hours';
  return serviceType.charAt(0).toUpperCase() + serviceType.slice(1);
}

interface Clip {
  from: Date;
  to: Date;
}

function buildService(
  args: { name: string; date: string; startMin: number; endMin: number; lastStartMin: number; tz: string; slotMinutes: number },
  clip: Clip | null,
  lastBeforeClose: number,
): Service | null {
  let startsAt = wallClock(args.date, args.startMin, args.tz);
  let endsAt = wallClock(args.date, args.endMin, args.tz);
  let lastStartAt = wallClock(args.date, Math.min(args.lastStartMin, args.endMin), args.tz);
  if (clip) {
    // A day with special hours: the service runs only while the venue is open that day.
    if (clip.from > startsAt) startsAt = clip.from;
    if (clip.to < endsAt) endsAt = clip.to;
    const clipLast = addMinutes(clip.to, -lastBeforeClose);
    if (clipLast < lastStartAt) lastStartAt = clipLast;
  }
  const slots: Date[] = [];
  const seen = new Set<number>();
  for (let m = args.startMin; m <= args.lastStartMin && m < args.endMin; m += args.slotMinutes) {
    const at = wallClock(args.date, m, args.tz);
    // A wall-clock time that does not exist (a daylight-saving gap) lands on one that does: list it once.
    if (at < startsAt || at > lastStartAt || seen.has(at.getTime())) continue;
    seen.add(at.getTime());
    slots.push(at);
  }
  if (!slots.length) return null;
  return { name: args.name, date: args.date, startsAt, endsAt, lastStartAt, slots };
}

/**
 * The services a venue takes bookings for on a venue-local date. A closed day in the hour
 * exceptions has none. With no service periods configured, each opening period of the day is a
 * service (named after its service type), so bookings follow the opening hours.
 */
export async function servicesOn(ctx: Ctx, venue: VenueView, date: string, cfg: BookingsConfig): Promise<Service[]> {
  const tz = venue.timezone;
  const [exception] = await listHourExceptions(ctx, venue.id, date, date);
  if (exception?.closed) return [];
  const out: Service[] = [];

  if (!cfg.service_periods.length) {
    // openWindows applies the day's exception itself.
    const windows = (await openWindows(ctx, venue.id, date)).sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
    for (const w of windows) {
      const open = localParts(w.opensAt, tz);
      const close = localParts(w.closesAt, tz);
      const startMin = (open.date > date ? 1440 : 0) + open.hour * 60 + open.minute;
      const endMin = (close.date > date ? 1440 : 0) + close.hour * 60 + close.minute;
      const s = buildService(
        { name: label(w.serviceType), date, startMin, endMin, lastStartMin: endMin - cfg.last_booking_before_close_minutes, tz, slotMinutes: cfg.slot_minutes },
        null,
        cfg.last_booking_before_close_minutes,
      );
      if (s) out.push(s);
    }
    return out;
  }

  let clip: Clip | null = null;
  if (exception && exception.opensAt && exception.closesAt) {
    const closeDate = toMinutes(exception.closesAt) <= toMinutes(exception.opensAt) ? addDays(date, 1) : date;
    clip = { from: zonedTimeToUtc(date, exception.opensAt, tz), to: zonedTimeToUtc(closeDate, exception.closesAt, tz) };
  }
  const weekday = weekdayOf(date);
  for (const p of cfg.service_periods) {
    if (!p.days.includes(weekday)) continue;
    const startMin = toMinutes(p.starts_at);
    let endMin = toMinutes(p.ends_at);
    if (endMin <= startMin) endMin += 1440;
    let lastStartMin = endMin - cfg.last_booking_before_close_minutes;
    if (p.last_booking_at) {
      lastStartMin = toMinutes(p.last_booking_at);
      if (lastStartMin < startMin) lastStartMin += 1440;
    }
    const s = buildService({ name: p.name, date, startMin, endMin, lastStartMin, tz, slotMinutes: cfg.slot_minutes }, clip, cfg.last_booking_before_close_minutes);
    if (s) out.push(s);
  }
  return out.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** Bookings holding covers around a span of time (with room either side for sittings that overlap it). */
export async function heldBookings(ctx: Ctx, venueId: string, from: Date, to: Date): Promise<Held[]> {
  return ctx.db
    .selectFrom('bookings')
    .select(['id', 'booked_for', 'party_size', 'duration_minutes', 'service_date', 'service_name'])
    .where('venue_id', '=', venueId)
    .where('status', 'in', [...HOLDING])
    .where('booked_for', '>=', addMinutes(from, -720))
    .where('booked_for', '<', addMinutes(to, 720))
    .execute();
}

/** How long a party of this size keeps its table. */
export function sittingMinutes(cfg: BookingsConfig, partySize: number): number {
  const sorted = [...cfg.sitting_minutes].sort((a, b) => a.up_to_party_size - b.up_to_party_size);
  return (sorted.find((s) => s.up_to_party_size >= partySize) ?? sorted.reduce((a, b) => (b.minutes > a.minutes ? b : a))).minutes;
}

/** The grid slot a time falls in: the latest slot of the service that starts at or before it. */
export function slotOf(service: Service, at: Date): Date | null {
  let found: Date | null = null;
  for (const s of service.slots) if (s <= at) found = s;
  return found;
}

export type Refusal = 'slot_full' | 'service_full' | 'room_full';

export interface Load {
  slotCovers: number;
  serviceCovers: number;
}

/** Covers already booked in the slot and in the service. */
export function loadAt(cfg: BookingsConfig, service: Service, slotStart: Date, held: Held[]): Load {
  const slotEnd = addMinutes(slotStart, cfg.slot_minutes);
  let slotCovers = 0;
  let serviceCovers = 0;
  for (const b of held) {
    if (b.booked_for >= slotStart && b.booked_for < slotEnd) slotCovers += b.party_size;
    if (b.service_date === service.date && b.service_name === service.name) serviceCovers += b.party_size;
  }
  return { slotCovers, serviceCovers };
}

/**
 * Whether a party fits a time. Three caps: guests starting in the slot (kitchen pacing), guests
 * across the service, and (when set) guests in the room at once over the party's sitting.
 */
export function refusalFor(cfg: BookingsConfig, service: Service, slotStart: Date, at: Date, partySize: number, held: Held[]): Refusal | null {
  const load = loadAt(cfg, service, slotStart, held);
  if (load.slotCovers + partySize > cfg.max_covers_per_slot) return 'slot_full';
  if (load.serviceCovers + partySize > cfg.max_covers_per_service) return 'service_full';
  if (cfg.max_covers_seated !== null) {
    const end = addMinutes(at, sittingMinutes(cfg, partySize));
    // The room is fullest at the start of this sitting or when another one starts during it.
    const points = [at, ...held.filter((b) => b.booked_for > at && b.booked_for < end).map((b) => b.booked_for)];
    for (const p of points) {
      let seated = 0;
      for (const b of held) if (b.booked_for <= p && p < addMinutes(b.booked_for, b.duration_minutes)) seated += b.party_size;
      if (seated + partySize > cfg.max_covers_seated) return 'room_full';
    }
  }
  return null;
}

export const REFUSAL_WORDS: Record<Refusal, string> = {
  slot_full: 'the most guests that may start at that time',
  service_full: 'the most guests that may be booked for that service',
  room_full: 'the most guests that may be seated at once',
};
