import { z } from 'zod';
import { defineEvent, defineModule } from '@ros/core';

/**
 * Config surface: docs/modules/bookings.md, "v1 as built". One row per venue in `venue_modules`.
 * Every setting has a default, so `bookingsConfig.parse({})` is a working config (bookings follow
 * the opening hours), and every setting has a `.describe()`: that text is what an assistant reads
 * in `plugins_list`.
 */

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 17:30.');

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const servicePeriod = z
  .object({
    name: z.string().trim().min(1).max(40).describe('What the service is called, e.g. "Lunch" or "Dinner". Guests and staff see it.'),
    days: z
      .array(z.enum(WEEKDAYS))
      .min(1)
      .max(7)
      .describe('The weekdays the service runs, e.g. ["tue","wed","thu","fri","sat"].'),
    starts_at: TIME.describe('When the service starts, 24-hour venue-local time, e.g. "17:30". The first bookable time.'),
    ends_at: TIME.describe('When the service ends, e.g. "22:00". A time earlier than starts_at means it ends after midnight.'),
    last_booking_at: TIME.nullable()
      .default(null)
      .describe('The latest time a table may be booked for, e.g. "20:30". Null: last_booking_before_close_minutes before ends_at.'),
  })
  .strict();
export type ServicePeriod = z.infer<typeof servicePeriod>;

export const sittingLength = z
  .object({
    up_to_party_size: z.number().int().min(1).max(500).describe('The largest party this sitting length applies to.'),
    minutes: z.number().int().min(15).max(720).describe('How long a party of this size usually keeps its table, in minutes.'),
  })
  .strict();

export const bookingsConfig = z.object({
  service_periods: z
    .array(servicePeriod)
    .max(28)
    .default([])
    .describe(
      'The services guests can book, per weekday, e.g. Lunch tue-sun 12:00-15:00 and Dinner tue-sat 17:30-22:00. Empty (the default): bookings follow the venue\'s opening hours, one service per opening period. A closed day in the venue\'s hour exceptions closes bookings that day either way.',
    ),
  last_booking_before_close_minutes: z
    .number()
    .int()
    .min(0)
    .max(600)
    .default(60)
    .describe('When a service has no last_booking_at (and always when bookings follow the opening hours), the last bookable time is this many minutes before it ends.'),
  slot_minutes: z
    .union([z.literal(15), z.literal(30), z.literal(60)])
    .default(30)
    .describe('The gap between bookable times: 15, 30 or 60 minutes. With 30, guests choose 18:00, 18:30, 19:00 …'),
  max_covers_per_slot: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe('Kitchen pacing: the most guests (covers) whose bookings may start in one slot. A party that would take a slot past this is offered other times.'),
  max_covers_per_service: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .default(80)
    .describe('The most guests (covers) that may be booked across one service (e.g. all of Friday dinner).'),
  max_covers_seated: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .nullable()
    .default(null)
    .describe('The most booked guests in the room at the same moment, using the typical sitting lengths. Null: no limit beyond the slot and service caps.'),
  max_party_size_online: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(8)
    .describe('The largest party a guest may book online or through an assistant. Bigger groups are told to contact the venue; staff can still book them.'),
  sitting_minutes: z
    .array(sittingLength)
    .min(1)
    .max(10)
    .default([
      { up_to_party_size: 2, minutes: 75 },
      { up_to_party_size: 4, minutes: 90 },
      { up_to_party_size: 8, minutes: 120 },
      { up_to_party_size: 500, minutes: 150 },
    ])
    .describe('Typical sitting length by party size. Each booking is held for the first entry whose up_to_party_size fits the party; a party larger than every entry takes the longest.'),
  booking_window_days: z
    .number()
    .int()
    .min(0)
    .max(365)
    .default(60)
    .describe('How many days ahead guests may book. 0 means today only.'),
  cutoff_minutes: z
    .number()
    .int()
    .min(0)
    .max(10080)
    .default(60)
    .describe('Guests cannot book a time less than this many minutes away. Staff taking a phone booking are not held to it.'),
  auto_confirm: z
    .boolean()
    .default(true)
    .describe('True: a booking within capacity is confirmed straight away. False: every booking is a request that staff confirm or decline.'),
  phone_number: z
    .enum(['required', 'optional', 'not_asked'])
    .default('optional')
    .describe('Whether guests are asked for a phone number. With not_asked an email address is required.'),
  booking_note: z
    .string()
    .trim()
    .max(300)
    .default('')
    .describe('A short note shown to guests when they book, e.g. "Groups over 8, please call us." Empty: none.'),
  send_reminders: z.boolean().default(true).describe('Whether confirmed guests get a reminder before their booking.'),
  reminder_hours_before: z
    .number()
    .int()
    .min(1)
    .max(72)
    .default(24)
    .describe('How long before the booking the reminder goes out, in hours. A booking made later than that gets no reminder.'),
});
export type BookingsConfig = z.infer<typeof bookingsConfig>;

export const bookingsModule = defineModule({
  key: 'bookings',
  name: 'Table bookings',
  description:
    'Guests book a table for a time and party size on the venue\'s site or through an assistant; staff confirm, seat and manage bookings. Capacity is counted in guests per time slot and per service, without a floor plan.',
  dependsOn: [],
  manifest: {
    name: 'Table bookings',
    purpose: 'Guests book a table for a time and party size on the venue\'s site or through an assistant; staff confirm, seat and manage bookings. Capacity is counted in covers per time slot and per service, with no floor plan to draw.',
    category: 'channels',
    kind: 'channel',
    needs: ['Opening hours, or service times set in the bookings settings. A booking page for guests needs the Website switched on.'],
    reads: ['opening hours and closed days', 'guest records (a guest who books is recorded)'],
    writes: ['bookings and their status', 'confirmation and reminder messages'],
    consent: 'A booking never adds a guest to a marketing list.',
    publicAddress: ({ siteOrigin }) => siteOrigin,
  },
  tables: ['bookings', 'booking_status_history'],
  configSchema: bookingsConfig,
  configVersion: 1,
  defaultConfig: bookingsConfig.parse({}),
});

/**
 * Events. Ids and numbers only: no names, contact details or notes. Covers booked is the sum of
 * `party_size` over `booking.confirmed`; the no-show rate is `booking.no_show` over
 * `booking.seated` + `booking.no_show`; cancellations are `booking.cancelled` (split by `by`).
 */
const SOURCE = z.enum(['web', 'assistant', 'phone', 'staff']);

export const bookingRequested = defineEvent({
  name: 'booking.requested',
  module: 'bookings',
  description:
    'A booking was made: by a guest on the site or through an assistant, or by staff taking a phone booking. `status` is what it started as: confirmed (within capacity and auto-confirmed, or staff-made) or requested (waiting for staff).',
  properties: z.object({
    booking_id: z.string(),
    party_size: z.number().int(),
    source: SOURCE,
    status: z.enum(['requested', 'confirmed']),
    service: z.string(),
    /** Minutes between the booking being made and the sitting. */
    lead_minutes: z.number().int(),
    over_capacity: z.boolean(),
  }),
});

export const bookingConfirmed = defineEvent({
  name: 'booking.confirmed',
  module: 'bookings',
  description: 'A booking became confirmed (straight away, or when staff accepted the request). Sum `party_size` for covers booked.',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int(), source: SOURCE, auto: z.boolean() }),
});

export const bookingDeclined = defineEvent({
  name: 'booking.declined',
  module: 'bookings',
  description: 'Staff turned down a booking request.',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int() }),
});

export const bookingCancelled = defineEvent({
  name: 'booking.cancelled',
  module: 'bookings',
  description: 'A request or confirmed booking was cancelled, by the guest (with their link) or by staff. `minutes_before` is how long before the sitting.',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int(), by: z.enum(['guest', 'staff']), was: z.enum(['requested', 'confirmed']), minutes_before: z.number().int() }),
});

export const bookingSeated = defineEvent({
  name: 'booking.seated',
  module: 'bookings',
  description: 'The party arrived and was seated.',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int(), minutes_late: z.number().int() }),
});

export const bookingNoShow = defineEvent({
  name: 'booking.no_show',
  module: 'bookings',
  description: 'Staff marked a confirmed booking as a no-show.',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int() }),
});

export const bookingCompleted = defineEvent({
  name: 'booking.completed',
  module: 'bookings',
  description: 'Staff marked a booking finished (the party has left).',
  properties: z.object({ booking_id: z.string(), party_size: z.number().int() }),
});
