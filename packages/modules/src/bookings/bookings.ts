import { z } from 'zod';
import {
  type Ctx,
  GUEST_FACING_ROLES,
  actorOf,
  addDays,
  addMinutes,
  assertModule,
  audit,
  conflict,
  enqueue,
  forbidden,
  invalid,
  isInternal,
  isUniqueViolation,
  localDate,
  newCode,
  notFound,
  rateLimit,
  requireStaff,
  sql,
  staffOf,
  track,
  zonedTimeToUtc,
} from '@ros/core';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import { resolveCustomer } from '../identity/resolve';
import { getVenue, type VenueView } from '../tenancy/venues';
import { REFUSAL_WORDS, type Service, heldBookings, localTime, refusalFor, servicesOn, sittingMinutes, slotOf } from './availability';
import { bookingIdFromToken, bookingReminderJob, manageToken, manageUrl, notifyGuest } from './messages';
import {
  type BookingsConfig,
  bookingCancelled,
  bookingCompleted,
  bookingConfirmed,
  bookingDeclined,
  bookingNoShow,
  bookingRequested,
  bookingSeated,
  bookingsModule,
} from './module';

/**
 * Table bookings, v1: capacity without a floor plan. A booking holds covers (guests) against the
 * venue's pacing caps; tables are the host's business on the night. Guests book without an
 * account and manage their booking with the token in their link. Staff confirm, decline, cancel,
 * seat and mark no-shows. docs/modules/bookings.md, "v1 as built".
 */

// ── Shapes ───────────────────────────────────────────────────────────────────

const DAY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-02.')
  .refine((d) => addDays(d, 0) === d, 'That is not a day on the calendar.');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 19:30.');

export type BookingStatus = 'requested' | 'confirmed' | 'declined' | 'cancelled' | 'seated' | 'no_show' | 'completed';
export type BookingSource = 'web' | 'assistant' | 'phone' | 'staff';

const COLS = [
  'id',
  'venue_id',
  'customer_id',
  'reference',
  'booked_for',
  'service_date',
  'service_name',
  'party_size',
  'duration_minutes',
  'status',
  'source',
  'guest_name',
  'guest_email',
  'guest_phone',
  'guest_note',
  'staff_note',
  'over_capacity',
  'request_key',
  'status_reason',
  'cancelled_by',
  'decided_at',
  'cancelled_at',
  'seated_at',
  'finished_at',
  'reminded_at',
  'created_at',
] as const;

export interface BookingRow {
  id: string;
  venue_id: string;
  customer_id: string | null;
  reference: string;
  booked_for: Date;
  service_date: string;
  service_name: string;
  party_size: number;
  duration_minutes: number;
  status: BookingStatus;
  source: BookingSource;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  guest_note: string | null;
  staff_note: string | null;
  over_capacity: boolean;
  request_key: string | null;
  status_reason: string | null;
  cancelled_by: string | null;
  decided_at: Date | null;
  cancelled_at: Date | null;
  seated_at: Date | null;
  finished_at: Date | null;
  reminded_at: Date | null;
  created_at: Date;
}

/** A booking as staff see it. Guest-written text (`guestName`, `guestNote`) is untrusted: render it as text. */
export interface BookingView {
  id: string;
  reference: string;
  venueId: string;
  status: BookingStatus;
  source: BookingSource;
  /** The sitting time. */
  startsAt: Date;
  endsAt: Date;
  /** The venue-local day and service the booking belongs to. */
  date: string;
  /** "HH:MM", venue-local. */
  time: string;
  serviceName: string;
  partySize: number;
  durationMinutes: number;
  guestName: string | null;
  guestEmail: string | null;
  guestPhone: string | null;
  guestNote: string | null;
  staffNote: string | null;
  overCapacity: boolean;
  statusReason: string | null;
  cancelledBy: 'guest' | 'staff' | null;
  customerId: string | null;
  createdAt: Date;
  remindedAt: Date | null;
}

const view = (r: BookingRow, tz: string): BookingView => ({
  id: r.id,
  reference: r.reference,
  venueId: r.venue_id,
  status: r.status,
  source: r.source,
  startsAt: r.booked_for,
  endsAt: addMinutes(r.booked_for, r.duration_minutes),
  date: r.service_date,
  time: localTime(r.booked_for, tz),
  serviceName: r.service_name,
  partySize: r.party_size,
  durationMinutes: r.duration_minutes,
  guestName: r.guest_name,
  guestEmail: r.guest_email,
  guestPhone: r.guest_phone,
  guestNote: r.guest_note,
  staffNote: r.staff_note,
  overCapacity: r.over_capacity,
  statusReason: r.status_reason,
  cancelledBy: (r.cancelled_by as 'guest' | 'staff' | null) ?? null,
  customerId: r.customer_id,
  createdAt: r.created_at,
  remindedAt: r.reminded_at,
});

/** What a guest sees of their own booking. No staff notes, no contact details, no internal ids. */
export interface GuestBookingView {
  reference: string;
  venueId: string;
  venueName: string;
  venuePhone: string | null;
  status: BookingStatus;
  /** The venue-local day the guest booked for (YYYY-MM-DD) and the time ("HH:MM"). */
  date: string;
  time: string;
  startsAt: Date;
  timezone: string;
  serviceName: string;
  partySize: number;
  /** How long the table is held, in minutes. */
  durationMinutes: number;
  firstName: string | null;
  /** The guest's own note, as they wrote it. */
  note: string | null;
  /** Staff words when it was declined or cancelled by the venue. */
  venueMessage: string | null;
  /** Whether the guest may still cancel it with their link. */
  canCancel: boolean;
}

function guestView(r: BookingRow, venue: VenueView, now: Date): GuestBookingView {
  return {
    reference: r.reference,
    venueId: r.venue_id,
    venueName: venue.name,
    venuePhone: venue.phone,
    status: r.status,
    date: r.service_date,
    time: localTime(r.booked_for, venue.timezone),
    startsAt: r.booked_for,
    timezone: venue.timezone,
    serviceName: r.service_name,
    partySize: r.party_size,
    durationMinutes: r.duration_minutes,
    firstName: r.guest_name ? (r.guest_name.trim().split(/\s+/)[0] ?? null) : null,
    note: r.guest_note,
    venueMessage: r.status === 'declined' || (r.status === 'cancelled' && r.cancelled_by === 'staff') ? r.status_reason : null,
    canCancel: (r.status === 'requested' || r.status === 'confirmed') && r.booked_for > now,
  };
}

/** What `requestBooking` returns: the booking, and the guest's private handle on it. */
export interface RequestedBooking extends GuestBookingView {
  /** Opens and cancels this booking with `getBookingByToken` / `cancelBookingByToken`. Give it only to the guest. */
  manageToken: string;
  /** The guest's page for the booking on the venue's site. */
  manageUrl: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** One booking write at a time per venue: two guests cannot both take the last place. */
async function lockVenueBookings(ctx: Ctx, venueId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`bookings:${venueId}`}, 0))`.execute(ctx.db);
}

async function newReference(ctx: Ctx, venueId: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const reference = newCode(attempt < 5 ? 6 : 8);
    const taken = await ctx.db.selectFrom('bookings').select('id').where('venue_id', '=', venueId).where('reference', '=', reference).executeTakeFirst();
    if (!taken) return reference;
  }
  throw conflict('Could not give the booking a reference. Try again.');
}

async function recordHistory(ctx: Ctx, bookingId: string, from: BookingStatus | null, to: BookingStatus): Promise<void> {
  const actor = actorOf(ctx.principal);
  await ctx.db.insertInto('booking_status_history').values({ org_id: ctx.orgId, booking_id: bookingId, from_status: from, to_status: to, at: ctx.now(), by_kind: actor.kind, by_id: actor.id }).execute();
}

/** Who may run the room: hosts and front of house, and managers and owners above them. */
const requireFrontOfHouse = (ctx: Ctx, venueId: string) => requireStaff(ctx, { venueId, minRole: 'host', anyOf: GUEST_FACING_ROLES });

const minutesBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 60_000);

async function enqueueReminder(ctx: Ctx, cfg: BookingsConfig, b: Pick<BookingRow, 'id' | 'booked_for'>): Promise<void> {
  if (!cfg.send_reminders) return;
  const runAt = addMinutes(b.booked_for, -cfg.reminder_hours_before * 60);
  // Booked inside the reminder window: the confirmation is the reminder.
  if (runAt <= ctx.now()) return;
  await enqueue(ctx, bookingReminderJob, { bookingId: b.id }, { key: `remind:${b.id}`, runAt });
}

function contactFrom(cfg: BookingsConfig, raw: { email?: string | null; phone?: string | null }, who: 'guest' | 'staff'): { email: string | null; phone: string | null } {
  let email: string | null = null;
  let phone: string | null = null;
  if (raw.email) {
    email = normaliseEmail(raw.email);
    if (!email) throw invalid('That email address does not look right.');
  }
  if (raw.phone && (who === 'staff' || cfg.phone_number !== 'not_asked')) {
    phone = normalisePhone(raw.phone);
    if (!phone) throw invalid('That phone number does not look right.');
  }
  if (who === 'guest') {
    if (cfg.phone_number === 'required' && !phone) throw invalid('Add a phone number so the venue can reach you about your booking.');
    if (cfg.phone_number === 'not_asked' && !email) throw invalid('Add an email address so we can send your confirmation.');
    if (!email && !phone) throw invalid('Add an email address or a phone number so we can send your confirmation.');
  }
  return { email, phone };
}

// ── Availability ─────────────────────────────────────────────────────────────

export const availabilityInput = z
  .object({
    venueId: z.string().uuid(),
    /** Venue-local date, YYYY-MM-DD. */
    date: DAY,
    partySize: z.number().int().min(1).max(500),
  })
  .strict();

export interface BookableTime {
  /** "HH:MM", venue-local. */
  time: string;
  startsAt: Date;
  service: string;
}

export interface BookingAvailability {
  venueId: string;
  venueName: string;
  venuePhone: string | null;
  timezone: string;
  date: string;
  partySize: number;
  /** The times a party of this size can book on this date, in order. Empty when none. */
  times: BookableTime[];
  /** Why there are no times, in words a guest can read. Null when there are some. */
  reason: string | null;
  /** The services that day, whether or not they have room. */
  services: Array<{ name: string; startsAt: Date; endsAt: Date }>;
  /** The largest party that can book online. */
  maxPartySize: number;
  /** The first and last dates a guest may book. */
  firstDate: string;
  lastDate: string;
  /** instant = confirmed straight away; request = the venue confirms each booking. */
  confirmation: 'instant' | 'request';
  phoneNumber: 'required' | 'optional' | 'not_asked';
  /** The venue's note to guests, e.g. "Groups over 8, please call." Null when none. */
  note: string | null;
}

interface Slotted {
  service: Service;
  slot: Date;
}

/**
 * The times a guest can book for a party on a venue-local date. Public: no role check, an
 * anonymous visitor (or an assistant acting for one) may call it. Another organisation's venue,
 * or a venue with bookings off, is not found.
 */
export async function getBookingAvailability(ctx: Ctx, raw: z.input<typeof availabilityInput>): Promise<BookingAvailability> {
  const input = availabilityInput.parse(raw);
  if (!isInternal(ctx) && ctx.ip) await rateLimit(ctx.app, `booking-avail:ip:${ctx.ip}`, { limit: 300, windowSeconds: 600 }, 'Too many requests from this device. Try again shortly.');
  const venue = await getVenue(ctx, input.venueId);
  const cfg = await assertModule(ctx, venue.id, bookingsModule);
  const now = ctx.now();
  const today = localDate(now, venue.timezone);
  const lastDate = addDays(today, cfg.booking_window_days);
  const base = {
    venueId: venue.id,
    venueName: venue.name,
    venuePhone: venue.phone,
    timezone: venue.timezone,
    date: input.date,
    partySize: input.partySize,
    maxPartySize: cfg.max_party_size_online,
    firstDate: today,
    lastDate,
    confirmation: cfg.auto_confirm ? ('instant' as const) : ('request' as const),
    phoneNumber: cfg.phone_number,
    note: cfg.booking_note || null,
  };
  const none = (reason: string, services: Service[] = []) => ({ ...base, times: [], reason, services: services.map((s) => ({ name: s.name, startsAt: s.startsAt, endsAt: s.endsAt })) });

  if (input.partySize > cfg.max_party_size_online) return none(bigGroupWords(venue, cfg));
  if (input.date < today) return none('That day has passed.');
  if (input.date > lastDate) return none(`Bookings open ${cfg.booking_window_days} days ahead. Choose a day up to ${lastDate}.`);
  const services = await servicesOn(ctx, venue, input.date, cfg);
  if (!services.length) return none(`${venue.name} is not taking bookings on that day.`);

  const earliest = addMinutes(now, cfg.cutoff_minutes);
  const held = await heldBookings(ctx, venue.id, services[0]!.startsAt, services[services.length - 1]!.endsAt);
  const times: BookableTime[] = [];
  for (const s of services) {
    for (const slot of s.slots) {
      if (slot < earliest) continue;
      if (refusalFor(cfg, s, slot, slot, input.partySize, held)) continue;
      times.push({ time: localTime(slot, venue.timezone), startsAt: slot, service: s.name });
    }
  }
  if (!times.length) {
    const anyAhead = services.some((s) => s.slots.some((slot) => slot >= earliest));
    return none(anyAhead ? `${venue.name} is fully booked for ${input.partySize === 1 ? 'one' : input.partySize} on that day.` : 'There are no times left to book on that day.', services);
  }
  return { ...base, times, reason: null, services: services.map((s) => ({ name: s.name, startsAt: s.startsAt, endsAt: s.endsAt })) };
}

function bigGroupWords(venue: VenueView, cfg: BookingsConfig): string {
  return `Bookings online are for up to ${cfg.max_party_size_online} people. For a bigger group, please contact ${venue.name}${venue.phone ? ` on ${venue.phone}` : ''}.`;
}

/** The service and grid slot a venue-local date and time fall in, or null. `onGrid`: the time must be a bookable time itself. */
async function findSlot(ctx: Ctx, venue: VenueView, cfg: BookingsConfig, date: string, time: string, onGrid: boolean): Promise<(Slotted & { at: Date }) | null> {
  for (const service of await servicesOn(ctx, venue, date, cfg)) {
    if (onGrid) {
      const slot = service.slots.find((s) => localTime(s, venue.timezone) === time);
      if (slot) return { service, slot, at: slot };
      continue;
    }
    // Staff may book any time inside a service, not only on the grid. A late service may run past midnight.
    for (const day of [date, addDays(date, 1)]) {
      const candidate = zonedTimeToUtc(day, time, venue.timezone);
      if (candidate >= service.startsAt && candidate < service.endsAt) {
        const slot = slotOf(service, candidate);
        if (slot) return { service, slot, at: candidate };
      }
    }
  }
  return null;
}

// ── Guest: request a booking ─────────────────────────────────────────────────

export const requestBookingInput = z
  .object({
    venueId: z.string().uuid(),
    /** Venue-local date, YYYY-MM-DD. */
    date: DAY,
    /** One of the times `getBookingAvailability` returned, "HH:MM". */
    time: TIME,
    partySize: z.number().int().min(1).max(100),
    /** Guest-written. Stored and shown as text. */
    name: z.string().trim().min(1, 'Add the name the booking is under.').max(100),
    email: z.string().trim().max(254).nullish(),
    phone: z.string().trim().max(30).nullish(),
    /** Guest-written: dietary needs, an occasion. Shown to staff as text, never as instructions. */
    note: z.string().trim().max(500).nullish(),
    /** Made once by the client for this booking attempt. The same key always answers with the same booking. */
    requestKey: z.string().min(16).max(100).regex(/^[A-Za-z0-9_.:-]+$/, 'That request key has characters it cannot have.'),
    /** Where the guest booked: the venue's site, or an assistant acting for them. */
    channel: z.enum(['web', 'assistant']).default('web'),
  })
  .strict();

/**
 * A guest books a table. No account needed: anyone may call it (an anonymous visitor, a signed-in
 * guest, an assistant acting for a guest). Capacity is checked again inside a per-venue lock, so
 * two guests cannot both take the last place. Within capacity, the booking is confirmed (or, if
 * the venue confirms each one, waits as a request). The guest is sent a transactional message
 * and given a private token to see or cancel the booking. Booking grants no marketing consent.
 * The same `requestKey` twice is one booking.
 */
export async function requestBooking(ctx: Ctx, raw: z.input<typeof requestBookingInput>): Promise<RequestedBooking> {
  const input = requestBookingInput.parse(raw);
  const p = ctx.principal;
  if (p.kind === 'device') throw forbidden('This screen cannot make bookings.');
  if (staffOf(ctx)) requireStaff(ctx, { venueId: input.venueId });
  const venue = await getVenue(ctx, input.venueId);
  const cfg = await assertModule(ctx, venue.id, bookingsModule);

  await lockVenueBookings(ctx, venue.id);
  const existing = await ctx.db.selectFrom('bookings').select(COLS).where('request_key', '=', input.requestKey).executeTakeFirst();
  if (existing) {
    if (existing.venue_id !== venue.id) throw conflict('That booking request has already been used.');
    return withToken(ctx, existing, venue);
  }

  if (!isInternal(ctx)) {
    if (ctx.ip) await rateLimit(ctx.app, `booking:ip:${ctx.ip}`, { limit: 20, windowSeconds: 600 }, 'Too many bookings from this device. Try again shortly.');
    await rateLimit(ctx.app, `booking:venue:${venue.id}`, { limit: 600, windowSeconds: 600 });
  }

  if (input.partySize > cfg.max_party_size_online) throw invalid(bigGroupWords(venue, cfg));
  const now = ctx.now();
  const today = localDate(now, venue.timezone);
  if (input.date < today) throw invalid('That day has passed.');
  if (input.date > addDays(today, cfg.booking_window_days)) throw invalid(`Bookings open ${cfg.booking_window_days} days ahead. Choose an earlier day.`);
  const found = await findSlot(ctx, venue, cfg, input.date, input.time, true);
  if (!found) throw invalid('That time is not one of the bookable times. Choose one from the list.');
  if (found.slot < addMinutes(now, cfg.cutoff_minutes)) throw invalid('That time is too soon to book online. Choose a later time.');
  const held = await heldBookings(ctx, venue.id, found.service.startsAt, found.service.endsAt);
  if (refusalFor(cfg, found.service, found.slot, found.slot, input.partySize, held)) throw conflict('That time has just been booked up. Choose another time.');

  const contact = contactFrom(cfg, input, 'guest');
  let customerId: string | null = null;
  if (p.kind === 'guest') {
    const c = await ctx.db.selectFrom('customers').select(['id', 'status']).where('id', '=', p.customerId).executeTakeFirst();
    if (!c || c.status !== 'active') throw notFound('Customer not found');
    customerId = c.id;
  } else {
    customerId = await resolveGuest(ctx, venue.id, input.name, contact);
  }

  const status: BookingStatus = cfg.auto_confirm ? 'confirmed' : 'requested';
  const row = await insertBooking(ctx, {
    venueId: venue.id,
    customerId,
    found,
    partySize: input.partySize,
    duration: sittingMinutes(cfg, input.partySize),
    status,
    source: input.channel,
    name: input.name,
    contact,
    guestNote: input.note?.length ? input.note : null,
    staffNote: null,
    overCapacity: false,
    requestKey: input.requestKey,
  });
  await afterCreate(ctx, cfg, row, { auto: true, notify: true });
  return withToken(ctx, row, venue);
}

async function resolveGuest(ctx: Ctx, venueId: string, name: string, contact: { email: string | null; phone: string | null }): Promise<string | null> {
  if (!contact.email && !contact.phone) return null;
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  // A booking links to the guest record (or makes one); it records no consent and joins no list.
  const resolved = await resolveCustomer(ctx, {
    hints: [...(contact.email ? [{ kind: 'email' as const, value: contact.email }] : []), ...(contact.phone ? [{ kind: 'phone' as const, value: contact.phone }] : [])],
    via: 'booking',
    venueId,
    profile: { firstName: first ?? null, lastName: rest.join(' ') || null },
  });
  return resolved.customerId;
}

interface NewBooking {
  venueId: string;
  customerId: string | null;
  found: Slotted & { at: Date };
  partySize: number;
  duration: number;
  status: 'requested' | 'confirmed';
  source: BookingSource;
  name: string;
  contact: { email: string | null; phone: string | null };
  guestNote: string | null;
  staffNote: string | null;
  overCapacity: boolean;
  requestKey: string | null;
}

async function insertBooking(ctx: Ctx, b: NewBooking): Promise<BookingRow> {
  const actor = actorOf(ctx.principal);
  const now = ctx.now();
  try {
    const row = await ctx.db
      .insertInto('bookings')
      .values({
        org_id: ctx.orgId,
        venue_id: b.venueId,
        customer_id: b.customerId,
        reference: await newReference(ctx, b.venueId),
        booked_for: b.found.at,
        service_date: b.found.service.date,
        service_name: b.found.service.name,
        party_size: b.partySize,
        duration_minutes: b.duration,
        status: b.status,
        source: b.source,
        guest_name: b.name,
        guest_email: b.contact.email,
        guest_phone: b.contact.phone,
        guest_note: b.guestNote,
        staff_note: b.staffNote,
        over_capacity: b.overCapacity,
        request_key: b.requestKey,
        decided_at: b.status === 'confirmed' ? now : null,
        created_by_kind: actor.kind,
        created_by_id: actor.id,
        created_at: now,
        updated_at: now,
      })
      .returning(COLS)
      .executeTakeFirstOrThrow();
    return row as BookingRow;
  } catch (e) {
    if (isUniqueViolation(e, 'bookings_request_key')) throw conflict('That booking request has already been used.');
    throw e;
  }
}

/** History, audit, events, the guest's message and the reminder for a booking just made. */
async function afterCreate(ctx: Ctx, cfg: BookingsConfig, row: BookingRow, opts: { auto: boolean; notify: boolean }): Promise<void> {
  await recordHistory(ctx, row.id, null, row.status);
  await audit(ctx, {
    action: row.source === 'phone' || row.source === 'staff' ? 'bookings.added' : 'bookings.requested',
    entityType: 'booking',
    entityId: row.id,
    venueId: row.venue_id,
    after: { reference: row.reference, status: row.status, partySize: row.party_size, startsAt: row.booked_for, service: row.service_name, source: row.source, overCapacity: row.over_capacity },
  });
  await track(
    ctx,
    bookingRequested,
    {
      booking_id: row.id,
      party_size: row.party_size,
      source: row.source,
      status: row.status === 'confirmed' ? 'confirmed' : 'requested',
      service: row.service_name,
      lead_minutes: minutesBetween(ctx.now(), row.booked_for),
      over_capacity: row.over_capacity,
    },
    { venueId: row.venue_id, customerId: row.customer_id },
  );
  if (row.status === 'confirmed') {
    await track(ctx, bookingConfirmed, { booking_id: row.id, party_size: row.party_size, source: row.source, auto: opts.auto }, { venueId: row.venue_id, customerId: row.customer_id });
    if (opts.notify) {
      await notifyGuest(ctx, row, 'confirmed');
      await enqueueReminder(ctx, cfg, row);
    }
  } else if (opts.notify) {
    await notifyGuest(ctx, row, 'requested');
  }
}

async function withToken(ctx: Ctx, row: BookingRow, venue: VenueView): Promise<RequestedBooking> {
  const token = await manageToken(ctx.app, ctx.orgId, row.id);
  return { ...guestView(row, venue, ctx.now()), manageToken: token, manageUrl: await manageUrl(ctx, venue.id, token) };
}

// ── Guest: the manage link ───────────────────────────────────────────────────

async function loadByToken(ctx: Ctx, token: string, opts: { lock?: boolean } = {}): Promise<BookingRow> {
  if (!isInternal(ctx) && ctx.ip) await rateLimit(ctx.app, `booking-token:ip:${ctx.ip}`, { limit: 120, windowSeconds: 600 }, 'Too many requests from this device. Try again shortly.');
  const id = await bookingIdFromToken(ctx.app, ctx.orgId, token);
  if (!id) throw notFound('Booking not found');
  let q = ctx.db.selectFrom('bookings').select(COLS).where('id', '=', id);
  if (opts.lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw notFound('Booking not found');
  return row as BookingRow;
}

/**
 * A guest's own booking, by the token in their link. No sign-in: holding the token is the
 * permission. It shows the booking and nothing else about the guest.
 */
export async function getBookingByToken(ctx: Ctx, token: string): Promise<GuestBookingView> {
  const row = await loadByToken(ctx, token);
  await assertModule(ctx, row.venue_id, bookingsModule);
  return guestView(row, await getVenue(ctx, row.venue_id), ctx.now());
}

/**
 * The guest cancels their own booking (or request) with their link, up to its start time. The
 * covers go back at once and the guest is sent a cancellation. Cancelling a booking that is
 * already cancelled changes nothing and is not an error.
 */
export async function cancelBookingByToken(ctx: Ctx, token: string): Promise<GuestBookingView> {
  const row = await loadByToken(ctx, token, { lock: true });
  await assertModule(ctx, row.venue_id, bookingsModule);
  const venue = await getVenue(ctx, row.venue_id);
  if (row.status === 'cancelled') return guestView(row, venue, ctx.now());
  if (row.status !== 'requested' && row.status !== 'confirmed') throw invalid(`This booking is ${STATUS_WORDS[row.status]} and can no longer be cancelled here.`);
  if (row.booked_for <= ctx.now()) throw invalid(`This booking has started. Please contact ${venue.name} directly.`);
  const after = await applyStatus(ctx, row, 'cancelled', { by: 'guest', reason: null });
  return guestView(after, venue, ctx.now());
}

// ── Status changes ───────────────────────────────────────────────────────────

const STATUS_WORDS: Record<BookingStatus, string> = {
  requested: 'waiting to be confirmed',
  confirmed: 'confirmed',
  declined: 'declined',
  cancelled: 'cancelled',
  seated: 'seated',
  no_show: 'marked as a no-show',
  completed: 'finished',
};

const NEXT: Record<BookingStatus, BookingStatus[]> = {
  requested: ['confirmed', 'declined', 'cancelled'],
  confirmed: ['cancelled', 'seated', 'no_show', 'completed'],
  seated: ['completed'],
  // A party marked a no-show who turns up late can still be seated.
  no_show: ['seated'],
  declined: [],
  cancelled: [],
  completed: [],
};

/** The change itself, inside the caller's checks: the row is locked and its move is allowed. */
async function applyStatus(ctx: Ctx, row: BookingRow, to: BookingStatus, opts: { by: 'guest' | 'staff'; reason: string | null }): Promise<BookingRow> {
  const now = ctx.now();
  const set: Record<string, unknown> = { status: to, updated_at: now };
  if (to === 'confirmed' || to === 'declined') set.decided_at = now;
  if (to === 'declined' || to === 'cancelled') set.status_reason = opts.reason;
  if (to === 'cancelled') {
    set.cancelled_at = now;
    set.cancelled_by = opts.by;
  }
  if (to === 'seated') set.seated_at = now;
  if (to === 'completed' || to === 'no_show') set.finished_at = now;
  const after = (await ctx.db.updateTable('bookings').set(set).where('id', '=', row.id).returning(COLS).executeTakeFirstOrThrow()) as BookingRow;
  await recordHistory(ctx, row.id, row.status, to);
  await audit(ctx, {
    action: `bookings.${to}`,
    entityType: 'booking',
    entityId: row.id,
    venueId: row.venue_id,
    before: { status: row.status },
    after: { status: to, reference: row.reference, partySize: row.party_size, startsAt: row.booked_for, ...(opts.reason ? { reason: opts.reason } : {}), ...(to === 'cancelled' ? { by: opts.by } : {}) },
  });
  const ev = { venueId: row.venue_id, customerId: row.customer_id };
  const cfg = await assertModule(ctx, row.venue_id, bookingsModule);
  switch (to) {
    case 'confirmed':
      await track(ctx, bookingConfirmed, { booking_id: row.id, party_size: row.party_size, source: row.source, auto: false }, ev);
      await notifyGuest(ctx, after, 'confirmed');
      await enqueueReminder(ctx, cfg, after);
      break;
    case 'declined':
      await track(ctx, bookingDeclined, { booking_id: row.id, party_size: row.party_size }, ev);
      await notifyGuest(ctx, after, 'declined');
      break;
    case 'cancelled':
      await track(ctx, bookingCancelled, { booking_id: row.id, party_size: row.party_size, by: opts.by, was: row.status === 'requested' ? 'requested' : 'confirmed', minutes_before: minutesBetween(now, row.booked_for) }, ev);
      await notifyGuest(ctx, after, 'cancelled');
      break;
    case 'seated':
      await track(ctx, bookingSeated, { booking_id: row.id, party_size: row.party_size, minutes_late: Math.max(0, minutesBetween(row.booked_for, now)) }, ev);
      break;
    case 'no_show':
      await track(ctx, bookingNoShow, { booking_id: row.id, party_size: row.party_size }, ev);
      break;
    case 'completed':
      await track(ctx, bookingCompleted, { booking_id: row.id, party_size: row.party_size }, ev);
      break;
    default:
      break;
  }
  return after;
}

export const bookingIdInput = z.object({ bookingId: z.string().uuid() }).strict();
export const bookingReasonInput = z
  .object({
    bookingId: z.string().uuid(),
    /** Staff words, sent to the guest with the decline or cancellation. */
    reason: z.string().trim().max(300).nullish(),
  })
  .strict();

/** Load a booking for staff: another organisation's id is not there (row-level security), a venue the caller has no role at is not found. */
async function loadForStaff(ctx: Ctx, bookingId: string, opts: { lock?: boolean } = {}): Promise<{ row: BookingRow; venue: VenueView }> {
  let q = ctx.db.selectFrom('bookings').select(COLS).where('id', '=', bookingId);
  if (opts.lock) q = q.forUpdate();
  const row = (await q.executeTakeFirst()) as BookingRow | undefined;
  if (!row) throw notFound('Booking not found');
  requireFrontOfHouse(ctx, row.venue_id);
  await assertModule(ctx, row.venue_id, bookingsModule);
  return { row, venue: await getVenue(ctx, row.venue_id) };
}

/** Everything a staff status change checks, without the change. Used by the assistant tools to ask first. */
export async function checkStatusChange(ctx: Ctx, bookingId: string, to: BookingStatus): Promise<BookingView> {
  const { row, venue } = await loadForStaff(ctx, z.string().uuid().parse(bookingId));
  if (row.status !== to) assertMove(row, to, ctx.now());
  return view(row, venue.timezone);
}

function assertMove(row: BookingRow, to: BookingStatus, now: Date): void {
  if (!NEXT[row.status].includes(to)) {
    throw invalid(`Booking ${row.reference} is ${STATUS_WORDS[row.status]}, so it cannot be ${STATUS_WORDS[to]}.`);
  }
  if (to === 'no_show' && row.booked_for > now) throw invalid(`Booking ${row.reference} has not started yet, so it cannot be marked as a no-show.`);
}

async function staffChange(ctx: Ctx, bookingId: string, to: BookingStatus, reason: string | null): Promise<BookingView> {
  const { row, venue } = await loadForStaff(ctx, bookingId, { lock: true });
  // The same change twice is one change.
  if (row.status === to) return view(row, venue.timezone);
  assertMove(row, to, ctx.now());
  return view(await applyStatus(ctx, row, to, { by: 'staff', reason }), venue.timezone);
}

/** Confirm a booking request. Host or front of house and above. The guest is sent a confirmation. */
export async function confirmBooking(ctx: Ctx, raw: z.input<typeof bookingIdInput>): Promise<BookingView> {
  const input = bookingIdInput.parse(raw);
  return staffChange(ctx, input.bookingId, 'confirmed', null);
}

/** Turn down a booking request. Host or front of house and above. The guest is told, with the reason if given. */
export async function declineBooking(ctx: Ctx, raw: z.input<typeof bookingReasonInput>): Promise<BookingView> {
  const input = bookingReasonInput.parse(raw);
  return staffChange(ctx, input.bookingId, 'declined', input.reason?.length ? input.reason : null);
}

/** Cancel a request or a confirmed booking for the guest. Host or front of house and above. The guest is told. */
export async function cancelBooking(ctx: Ctx, raw: z.input<typeof bookingReasonInput>): Promise<BookingView> {
  const input = bookingReasonInput.parse(raw);
  return staffChange(ctx, input.bookingId, 'cancelled', input.reason?.length ? input.reason : null);
}

/** The party has arrived. Host or front of house and above. */
export async function seatBooking(ctx: Ctx, raw: z.input<typeof bookingIdInput>): Promise<BookingView> {
  return staffChange(ctx, bookingIdInput.parse(raw).bookingId, 'seated', null);
}

/** The party did not come. Only once the booking time has passed. Host or front of house and above. */
export async function markNoShow(ctx: Ctx, raw: z.input<typeof bookingIdInput>): Promise<BookingView> {
  return staffChange(ctx, bookingIdInput.parse(raw).bookingId, 'no_show', null);
}

/** The party has left. Host or front of house and above. */
export async function completeBooking(ctx: Ctx, raw: z.input<typeof bookingIdInput>): Promise<BookingView> {
  return staffChange(ctx, bookingIdInput.parse(raw).bookingId, 'completed', null);
}

// ── Staff: phone bookings ────────────────────────────────────────────────────

export const addBookingInput = z
  .object({
    venueId: z.string().uuid(),
    date: DAY,
    /** Any time inside a service, "HH:MM", venue-local. Need not be on the slot grid. */
    time: TIME,
    partySize: z.number().int().min(1).max(500),
    name: z.string().trim().min(1, 'Add the name the booking is under.').max(100),
    email: z.string().trim().max(254).nullish(),
    phone: z.string().trim().max(30).nullish(),
    /** Staff words about the booking (an occasion, a high chair). Not shown to the guest. */
    note: z.string().trim().max(500).nullish(),
    /** Book it even though it takes the time or service past the venue's caps. Audited. */
    overCapacity: z.boolean().default(false),
    /** Send the guest a confirmation when they gave an email or phone. */
    notifyGuest: z.boolean().default(true),
  })
  .strict();

/** A phone booking checked and ready to make. Nothing has been written. */
export interface StaffBookingPlan {
  venue: { id: string; name: string; timezone: string };
  date: string;
  time: string;
  startsAt: Date;
  service: string;
  partySize: number;
  durationMinutes: number;
  name: string;
  email: string | null;
  phone: string | null;
  note: string | null;
  /** Set when the booking goes past a cap (and overCapacity was given): which one, in words. */
  overCapacity: string | null;
  notifyGuest: boolean;
}

/**
 * Everything `addBooking` checks, without the write. Host or front of house and above. Staff are
 * not held to the online party limit, the booking window or the cut-off, but the time must be
 * inside a service that day and must not have passed. Over a cap is refused unless `overCapacity`.
 */
export async function checkStaffBooking(ctx: Ctx, raw: z.input<typeof addBookingInput>): Promise<StaffBookingPlan & { found: Slotted & { at: Date } }> {
  const input = addBookingInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  const cfg = await assertModule(ctx, input.venueId, bookingsModule);
  const venue = await getVenue(ctx, input.venueId);
  const now = ctx.now();
  if (input.date > addDays(localDate(now, venue.timezone), 365)) throw invalid('That day is more than a year away.');
  const found = await findSlot(ctx, venue, cfg, input.date, input.time, false);
  if (!found) throw invalid(`${venue.name} has no service taking bookings at ${input.time} on ${input.date}.`);
  if (found.at < addMinutes(now, -15)) throw invalid('That time has passed.');
  const contact = contactFrom(cfg, input, 'staff');
  const held = await heldBookings(ctx, venue.id, found.service.startsAt, found.service.endsAt);
  const refusal = refusalFor(cfg, found.service, found.slot, found.at, input.partySize, held);
  if (refusal && !input.overCapacity) {
    throw conflict(`A party of ${input.partySize} at ${input.time} would go past ${REFUSAL_WORDS[refusal]}. Choose another time, or book it anyway over capacity.`);
  }
  return {
    venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
    date: found.service.date,
    time: localTime(found.at, venue.timezone),
    startsAt: found.at,
    service: found.service.name,
    partySize: input.partySize,
    durationMinutes: sittingMinutes(cfg, input.partySize),
    name: input.name,
    email: contact.email,
    phone: contact.phone,
    note: input.note?.length ? input.note : null,
    overCapacity: refusal ? REFUSAL_WORDS[refusal] : null,
    notifyGuest: input.notifyGuest,
    found,
  };
}

/**
 * Staff take a booking by phone (or in person). Host or front of house and above. It is
 * confirmed at once. The guest is sent a confirmation if they gave an email or phone and
 * `notifyGuest` is on. Audited `bookings.added`.
 */
export async function addBooking(ctx: Ctx, raw: z.input<typeof addBookingInput>): Promise<BookingView> {
  const input = addBookingInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  await lockVenueBookings(ctx, input.venueId);
  const plan = await checkStaffBooking(ctx, input);
  const cfg = await assertModule(ctx, input.venueId, bookingsModule);
  const customerId = await resolveGuest(ctx, plan.venue.id, plan.name, { email: plan.email, phone: plan.phone });
  const row = await insertBooking(ctx, {
    venueId: plan.venue.id,
    customerId,
    found: plan.found,
    partySize: plan.partySize,
    duration: plan.durationMinutes,
    status: 'confirmed',
    source: 'phone',
    name: plan.name,
    // Without notifyGuest the contact is still kept for the host; it is the message that is skipped.
    contact: { email: plan.email, phone: plan.phone },
    guestNote: null,
    staffNote: plan.note,
    overCapacity: plan.overCapacity !== null,
    requestKey: null,
  });
  await afterCreate(ctx, cfg, row, { auto: false, notify: plan.notifyGuest });
  return view(row, plan.venue.timezone);
}

// ── Staff: reading ───────────────────────────────────────────────────────────

/** A booking by id, as staff see it. Host or front of house and above. */
export async function getBooking(ctx: Ctx, raw: z.input<typeof bookingIdInput>): Promise<BookingView> {
  const { row, venue } = await loadForStaff(ctx, bookingIdInput.parse(raw).bookingId);
  return view(row, venue.timezone);
}

export const findBookingInput = z.object({ venueId: z.string().uuid(), reference: z.string().trim().min(1).max(20) }).strict();

/** A booking by its reference at a venue (case-insensitive). Host or front of house and above. */
export async function findBookingByReference(ctx: Ctx, raw: z.input<typeof findBookingInput>): Promise<BookingView> {
  const input = findBookingInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  await assertModule(ctx, input.venueId, bookingsModule);
  const venue = await getVenue(ctx, input.venueId);
  const row = await ctx.db.selectFrom('bookings').select(COLS).where('venue_id', '=', input.venueId).where('reference', '=', input.reference.toUpperCase()).executeTakeFirst();
  if (!row) throw notFound('No booking here has that reference.');
  return view(row as BookingRow, venue.timezone);
}

export const searchBookingsInput = z.object({ venueId: z.string().uuid(), q: z.string().trim().min(2).max(100), limit: z.number().int().min(1).max(50).default(10) }).strict();

/**
 * Bookings at a venue whose guest name or reference contains the words typed (the console's
 * search box). Soonest first among the ones still ahead, then the most recent past ones. Host or
 * front of house and above.
 */
export async function searchBookings(ctx: Ctx, raw: z.input<typeof searchBookingsInput>): Promise<BookingView[]> {
  const input = searchBookingsInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  await assertModule(ctx, input.venueId, bookingsModule);
  const venue = await getVenue(ctx, input.venueId);
  const like = `%${input.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const now = ctx.now();
  const rows = (await ctx.db
    .selectFrom('bookings')
    .select(COLS)
    .where('venue_id', '=', venue.id)
    .where((eb) => eb.or([eb('guest_name', 'ilike', like), eb('reference', 'ilike', like)]))
    .orderBy(sql`case when booked_for >= ${now} then 0 else 1 end`)
    .orderBy(sql`abs(extract(epoch from (booked_for - ${now})))`)
    .limit(input.limit)
    .execute()) as BookingRow[];
  return rows.map((r) => view(r, venue.timezone));
}

const STATUS_LIST = z.array(z.enum(['requested', 'confirmed', 'declined', 'cancelled', 'seated', 'no_show', 'completed'])).min(1).max(7);

export const listBookingsInput = z
  .object({
    venueId: z.string().uuid(),
    /** Venue-local date. Defaults to today. */
    date: DAY.optional(),
    /**
     * The last venue-local day of a run of days ("this week"), inclusive; at most 62 days from
     * `date`. Omitted: the one day. With a run, covers per service are not worked out.
     */
    to: DAY.optional(),
    /** One service by name, e.g. "Dinner". Omitted: the whole day. */
    service: z.string().trim().min(1).max(40).optional(),
    /** active = requests, confirmed and seated (the default); all = also declined, cancelled, no-shows and finished. */
    show: z.enum(['active', 'all']).default('active'),
    /** Only these statuses, whatever `show` says ("needs confirming" = ['requested']). */
    status: STATUS_LIST.optional(),
  })
  .strict();

export interface ServiceCovers {
  name: string;
  startsAt: Date | null;
  endsAt: Date | null;
  /** Guests booked and confirmed (including seated and finished). */
  covers: number;
  /** Guests in requests still waiting for staff. */
  requestedCovers: number;
  bookings: number;
  /** The service's cap from the config. */
  maxCovers: number;
}

export interface BookingDay {
  venueId: string;
  timezone: string;
  date: string;
  /** The last day of the run asked for, when more than one day was. */
  to?: string;
  services: ServiceCovers[];
  bookings: BookingView[];
  totals: { bookings: number; covers: number; requests: number; requestedCovers: number; noShows: number; cancelled: number };
}

const ACTIVE: BookingStatus[] = ['requested', 'confirmed', 'seated'];
const COUNTED: BookingStatus[] = ['confirmed', 'seated', 'completed'];

/**
 * The bookings for a venue-local day (or one service of it), in time order, with covers per
 * service. Host or front of house and above: it holds guests' names and contact details.
 */
export async function listBookings(ctx: Ctx, raw: z.input<typeof listBookingsInput>): Promise<BookingDay> {
  const input = listBookingsInput.parse(raw);
  requireFrontOfHouse(ctx, input.venueId);
  const cfg = await assertModule(ctx, input.venueId, bookingsModule);
  const venue = await getVenue(ctx, input.venueId);
  const date = input.date ?? localDate(ctx.now(), venue.timezone);
  const to = input.to && input.to > date ? input.to : undefined;
  if (to && addDays(date, 62) < to) throw invalid('Ask for at most 62 days at a time.');
  let q = ctx.db.selectFrom('bookings').select(COLS).where('venue_id', '=', venue.id).orderBy('booked_for').orderBy('created_at');
  q = to ? q.where('service_date', '>=', date).where('service_date', '<=', to) : q.where('service_date', '=', date);
  if (input.service) q = q.where(sql`lower(service_name)`, '=', input.service.toLowerCase());
  if (input.status) q = q.where('status', 'in', input.status);
  const rows = (await q.execute()) as BookingRow[];

  // Covers per service are a one-day picture; a run of days lists the bookings and totals only.
  const services: ServiceCovers[] = to
    ? []
    : (await servicesOn(ctx, venue, date, cfg))
        .filter((s) => !input.service || s.name.toLowerCase() === input.service.toLowerCase())
        .map((s) => ({ name: s.name, startsAt: s.startsAt, endsAt: s.endsAt, covers: 0, requestedCovers: 0, bookings: 0, maxCovers: cfg.max_covers_per_service }));
  for (const r of rows) {
    if (to) break;
    let s = services.find((x) => x.name === r.service_name);
    if (!s) {
      // A service that is no longer in the settings (or a closed day) still shows what was booked for it.
      s = { name: r.service_name, startsAt: null, endsAt: null, covers: 0, requestedCovers: 0, bookings: 0, maxCovers: cfg.max_covers_per_service };
      services.push(s);
    }
    if (COUNTED.includes(r.status)) {
      s.covers += r.party_size;
      s.bookings += 1;
    } else if (r.status === 'requested') {
      s.requestedCovers += r.party_size;
      s.bookings += 1;
    }
  }
  const shown = input.status || input.show === 'all' ? rows : rows.filter((r) => ACTIVE.includes(r.status));
  return {
    venueId: venue.id,
    timezone: venue.timezone,
    date,
    ...(to ? { to } : {}),
    services,
    bookings: shown.map((r) => view(r, venue.timezone)),
    totals: {
      bookings: rows.filter((r) => COUNTED.includes(r.status) || r.status === 'requested').length,
      covers: rows.filter((r) => COUNTED.includes(r.status)).reduce((n, r) => n + r.party_size, 0),
      requests: rows.filter((r) => r.status === 'requested').length,
      requestedCovers: rows.filter((r) => r.status === 'requested').reduce((n, r) => n + r.party_size, 0),
      noShows: rows.filter((r) => r.status === 'no_show').length,
      cancelled: rows.filter((r) => r.status === 'cancelled').length,
    },
  };
}

export const bookingSummaryInput = z
  .object({
    venueId: z.string().uuid(),
    /** First and last venue-local service dates, inclusive. */
    from: DAY,
    to: DAY,
  })
  .strict()
  .refine((v) => v.to >= v.from, 'The last day is before the first day.');

export interface BookingSummary {
  venueId: string;
  from: string;
  to: string;
  /** Confirmed, seated, finished and no-show bookings, and their guests. */
  bookings: number;
  covers: number;
  cancelled: number;
  cancelledCovers: number;
  cancelledByGuest: number;
  declined: number;
  noShows: number;
  noShowCovers: number;
  /** No-shows over bookings that reached their time (seated, finished or no-show). Null when none did. */
  noShowRate: number | null;
  bySource: Record<BookingSource, number>;
}

/**
 * Totals for a run of days: covers booked, cancellations, no-shows and the no-show rate. Numbers
 * only, no guest details, so any staff at the venue may read it (read-only and above, kitchen too).
 */
export async function bookingSummary(ctx: Ctx, raw: z.input<typeof bookingSummaryInput>): Promise<BookingSummary> {
  const input = bookingSummaryInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  await assertModule(ctx, input.venueId, bookingsModule);
  if (addDays(input.from, 366) < input.to) throw invalid('Ask for at most a year at a time.');
  const rows = await ctx.db
    .selectFrom('bookings')
    .select(['status', 'party_size', 'source', 'cancelled_by'])
    .where('venue_id', '=', input.venueId)
    .where('service_date', '>=', input.from)
    .where('service_date', '<=', input.to)
    .execute();
  const kept = rows.filter((r) => ['confirmed', 'seated', 'completed', 'no_show'].includes(r.status));
  const reached = rows.filter((r) => ['seated', 'completed', 'no_show'].includes(r.status)).length;
  const noShows = rows.filter((r) => r.status === 'no_show');
  const cancelled = rows.filter((r) => r.status === 'cancelled');
  const bySource: Record<BookingSource, number> = { web: 0, assistant: 0, phone: 0, staff: 0 };
  for (const r of kept) bySource[r.source] += 1;
  return {
    venueId: input.venueId,
    from: input.from,
    to: input.to,
    bookings: kept.length,
    covers: kept.reduce((n, r) => n + r.party_size, 0),
    cancelled: cancelled.length,
    cancelledCovers: cancelled.reduce((n, r) => n + r.party_size, 0),
    cancelledByGuest: cancelled.filter((r) => r.cancelled_by === 'guest').length,
    declined: rows.filter((r) => r.status === 'declined').length,
    noShows: noShows.length,
    noShowCovers: noShows.reduce((n, r) => n + r.party_size, 0),
    noShowRate: reached ? Math.round((noShows.length / reached) * 10_000) / 10_000 : null,
    bySource,
  };
}
