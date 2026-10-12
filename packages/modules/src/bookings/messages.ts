import { z } from 'zod';
import { type App, type Ctx, defineJob, getModule, hmacHex, localParts, safeEqual } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import { defineTemplate } from '../comms/templates';
import { getVenue } from '../tenancy/venues';
import { bookingsModule } from './module';

/**
 * Booking messages. All transactional: they go to whoever made the booking because they made
 * it, whether or not they agreed to marketing, and booking grants no marketing consent. Bodies
 * are plain text; the guest's name is rendered as text, never markup (docs/THREAT_MODEL.md §6).
 */

const vars = z.object({
  first_name: z.string().max(100),
  venue_name: z.string(),
  reference: z.string(),
  /** e.g. "a table for 4" */
  party_line: z.string(),
  /** e.g. "Fri 2 Oct at 7:00 pm" */
  when_line: z.string(),
  /** The guest's own page for the booking: see it, cancel it. */
  manage_url: z.string(),
  /** e.g. "Questions? Call Oak Diner on 02 9000 0000." or empty. */
  contact_line: z.string(),
  /** Staff words when a request is declined or a booking cancelled, or empty. */
  reason_line: z.string().max(400),
});
export type BookingMessageVars = z.infer<typeof vars>;

const t = (key: string, description: string, subject: string, email: string, sms: string) => [
  defineTemplate({ key, channel: 'email', kind: 'transactional', description, subject, body: email, variables: vars }),
  defineTemplate({ key, channel: 'sms', kind: 'transactional', description: `${description} (for a guest who gave only a phone number)`, body: sms, variables: vars }),
];

export const bookingTemplates = [
  ...t(
    'booking.confirmed',
    'Sent when a booking is confirmed: when, for how many, the reference and a link to see or cancel it.',
    'Your booking at {{venue_name}} is confirmed',
    'Hi {{first_name}},\n\nYour booking for {{party_line}} at {{venue_name}} on {{when_line}} is confirmed.\n\nReference: {{reference}}\n\nSee or cancel your booking: {{manage_url}}\n\n{{contact_line}}',
    '{{venue_name}}: booking {{reference}} confirmed, {{party_line}} on {{when_line}}. See or cancel: {{manage_url}}',
  ),
  ...t(
    'booking.requested',
    'Sent when a booking needs the venue to confirm it: the request was received, and the guest will hear back.',
    'We have your booking request at {{venue_name}}',
    'Hi {{first_name}},\n\nThanks for your request for {{party_line}} at {{venue_name}} on {{when_line}}. It is not confirmed yet: the venue will confirm it shortly and we will let you know.\n\nReference: {{reference}}\n\nSee or cancel your request: {{manage_url}}\n\n{{contact_line}}',
    '{{venue_name}}: we have your request {{reference}} for {{party_line}} on {{when_line}}. Not confirmed yet; we will text you. {{manage_url}}',
  ),
  ...t(
    'booking.declined',
    'Sent when the venue cannot take a booking request.',
    'Your booking request at {{venue_name}}',
    'Hi {{first_name}},\n\nSorry, {{venue_name}} cannot take your request for {{party_line}} on {{when_line}} (reference {{reference}}).\n\n{{reason_line}}\n\n{{contact_line}}',
    '{{venue_name}}: sorry, we cannot take request {{reference}} for {{when_line}}. {{reason_line}}',
  ),
  ...t(
    'booking.cancelled',
    'Sent when a booking is cancelled, by the guest with their link or by the venue.',
    'Your booking at {{venue_name}} is cancelled',
    'Hi {{first_name}},\n\nYour booking for {{party_line}} at {{venue_name}} on {{when_line}} (reference {{reference}}) is cancelled.\n\n{{reason_line}}\n\n{{contact_line}}',
    '{{venue_name}}: booking {{reference}} for {{when_line}} is cancelled. {{reason_line}}',
  ),
  ...t(
    'booking.reminder',
    'A reminder before a confirmed booking, when the venue has reminders switched on.',
    'See you soon at {{venue_name}}',
    'Hi {{first_name}},\n\nA reminder of your booking for {{party_line}} at {{venue_name}} on {{when_line}}.\n\nReference: {{reference}}\n\nCannot make it? Please cancel so someone else can have the table: {{manage_url}}\n\n{{contact_line}}',
    '{{venue_name}}: reminder, {{party_line}} on {{when_line}} (ref {{reference}}). Cannot make it? Cancel: {{manage_url}}',
  ),
  ...t(
    'booking.unanswered',
    'The one nudge staff may send about a booking request the venue has not answered: it is still waiting, how to reach the venue, and the guest\'s own link to see or cancel it. Never a second one, never an offer.',
    'Your booking request at {{venue_name}} is still waiting',
    'Hi {{first_name}},\n\nYour request for {{party_line}} at {{venue_name}} on {{when_line}} (reference {{reference}}) has not been confirmed yet. Sorry for the wait.\n\nIf you still want the table, we will be in touch; {{contact_line}}\n\nIf you no longer need it, you can cancel it here: {{manage_url}}',
    '{{venue_name}}: your request {{reference}} for {{party_line}} on {{when_line}} is still waiting on us, sorry. {{contact_line}} No longer needed? Cancel: {{manage_url}}',
  ),
];

// ── The guest's manage link ──────────────────────────────────────────────────

/**
 * The token in a guest's manage link: the booking id and a signature only this org's key can
 * make. Nothing is stored, so a reminder can carry the same link as the confirmation, and a
 * token can only ever open the one booking it was made for, at the one org.
 */
export async function manageToken(app: App, orgId: string, bookingId: string): Promise<string> {
  const key = await app.secrets.orgKey(orgId, 'booking_links');
  const id = Buffer.from(bookingId.replace(/-/g, ''), 'hex');
  const sig = Buffer.from(hmacHex(key, `booking:${bookingId}`).slice(0, 32), 'hex');
  return Buffer.concat([id, sig]).toString('base64url');
}

/** The booking id a token claims, if the token is well formed and its signature is this org's. Otherwise null. */
export async function bookingIdFromToken(app: App, orgId: string, token: string): Promise<string | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 32) return null;
  const hex = raw.subarray(0, 16).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = await manageToken(app, orgId, id);
  return safeEqual(expected, token) ? id : null;
}

/** The guest's manage page on the venue's own site. */
export async function manageUrl(ctx: Ctx, venueId: string, token: string): Promise<string> {
  const hosts = await ctx.db
    .selectFrom('domains')
    .select(['host', 'venue_id'])
    .where('is_primary', '=', true)
    .where('verified_at', 'is not', null)
    .where((eb) => eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]))
    .execute();
  const host = hosts.find((h) => h.venue_id === venueId)?.host ?? hosts[0]?.host ?? ctx.app.config.platformHost;
  return `${ctx.app.config.scheme}://${host}/booking/${token}`;
}

// ── Words ────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 2 Oct at 7:00 pm", in the venue's zone. */
export function whenLine(at: Date, tz: string): string {
  const p = localParts(at, tz);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${DAY_NAMES[p.weekday]} ${p.day} ${MONTHS[p.month - 1]} at ${h}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'am' : 'pm'}`;
}

export const partyLine = (n: number) => (n === 1 ? 'one person' : `${n} people`);

// ── Sending ──────────────────────────────────────────────────────────────────

export type BookingMessage = 'confirmed' | 'requested' | 'declined' | 'cancelled' | 'reminder' | 'unanswered';

export interface Notifiable {
  id: string;
  venue_id: string;
  customer_id: string | null;
  reference: string;
  booked_for: Date;
  party_size: number;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  status_reason: string | null;
}

/**
 * Queue one transactional message to whoever made the booking: by email if they gave one, by
 * SMS if they gave only a phone number, not at all if they gave neither. One message per booking
 * per `what`, however many times this is reached. Returns what the outbox did, or null when
 * there was no one to write to.
 */
export async function notifyGuest(ctx: Ctx, b: Notifiable, what: BookingMessage): Promise<{ messageId: string; status: 'queued' | 'suppressed'; reason?: string; via: 'email' | 'sms' } | null> {
  const channel = b.guest_email ? 'email' : b.guest_phone ? 'sms' : null;
  if (!channel) return null;
  const venue = await getVenue(ctx, b.venue_id);
  const token = await manageToken(ctx.app, ctx.orgId, b.id);
  const variables: BookingMessageVars = {
    first_name: (b.guest_name ?? '').trim().split(/\s+/)[0]?.slice(0, 100) || 'there',
    venue_name: venue.name,
    reference: b.reference,
    party_line: `a table for ${partyLine(b.party_size)}`,
    when_line: whenLine(b.booked_for, venue.timezone),
    manage_url: await manageUrl(ctx, venue.id, token),
    contact_line: venue.phone ? `Questions? Call ${venue.name} on ${venue.phone}.` : '',
    reason_line: b.status_reason ? `From ${venue.name}: ${b.status_reason}` : '',
  };
  const r = await queueMessage(ctx, {
    templateKey: `booking.${what}`,
    channel,
    idempotencyKey: `booking:${b.id}:${what}`,
    variables,
    customerId: b.customer_id,
    to: channel === 'email' ? b.guest_email : b.guest_phone,
    venueId: b.venue_id,
  });
  return { ...r, via: channel };
}

const WORKER = { kind: 'worker' as const, job: 'bookings.reminder' };

/**
 * The reminder before a confirmed booking. Enqueued when a booking is confirmed, to run
 * `reminder_hours_before` ahead of it. Safe to run twice: it sends only for a booking that is
 * still confirmed, still ahead, not yet reminded, at a venue that still has reminders on.
 */
export const bookingReminderJob = defineJob({
  kind: 'bookings.reminder',
  schema: z.object({ bookingId: z.string().uuid() }),
  async handler(app, job) {
    if (!job.orgId) throw new Error('bookings.reminder needs an org');
    await app.tenant(job.orgId, WORKER, async (ctx) => {
      const b = await ctx.db
        .selectFrom('bookings')
        .select(['id', 'venue_id', 'customer_id', 'reference', 'booked_for', 'party_size', 'guest_name', 'guest_email', 'guest_phone', 'status', 'reminded_at'])
        .where('id', '=', job.payload.bookingId)
        .forUpdate()
        .executeTakeFirst();
      if (!b || b.status !== 'confirmed' || b.reminded_at || b.booked_for <= ctx.now()) return;
      const state = await getModule(ctx, b.venue_id, bookingsModule);
      if (!state.enabled || !state.config.send_reminders) return;
      await notifyGuest(ctx, { ...b, status_reason: null }, 'reminder');
      await ctx.db.updateTable('bookings').set({ reminded_at: ctx.now() }).where('id', '=', b.id).execute();
    });
  },
});
