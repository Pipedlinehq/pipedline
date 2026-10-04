import { z } from 'zod';
import { type App, type Ctx, type Principal, isAppError, notFound, rateLimit } from '@ros/core';
import { findListedVenues, listedVenueOrg } from './directory';
import {
  type TwoStep,
  CART_LINK_MINUTES,
  MAX_CART_LINES,
  PROPOSAL_MINUTES,
  assistantBooking,
  assistantBookingTimes,
  assistantMenu,
  assistantOffers,
  assistantOrder,
  assistantPickupTimes,
  assistantVenueInfo,
} from './guest';
import type { AssistantBooked } from './guest';

/**
 * The seven tools of the PUBLIC assistant connection (docs/modules/guest-plugin.md section 3).
 *
 * These are deliberately not `defineTool` tools. Those are the hub's: they act for a staff
 * member through an access key, and the hub offers every declared tool to keys holding its
 * scope. These act for an anonymous member of the public, at any venue that listed itself, and
 * are served only by the guest endpoint (`server.ts`). They keep the same discipline: each is a
 * thin wrapper over a guest-facing service function in `guest.ts`; inputs and outputs are zod
 * objects; the output is an allowlist (what it does not name does not leave); nothing that
 * creates something happens without the two-step confirmation.
 */

export interface GuestLimits {
  /** Requests to the endpoint, per address, per minute. */
  requestsPerIpPerMinute: number;
  /** Tool calls, per address, per minute. */
  callsPerIpPerMinute: number;
  /** Tool calls about one venue, from everyone, per minute. */
  callsPerVenuePerMinute: number;
}

/**
 * Guests' assistants call from their provider's servers, so one address can carry many guests.
 * These are set for that; bookings keep their own per-address and per-venue limits beneath them.
 */
export const GUEST_LIMITS: GuestLimits = { requestsPerIpPerMinute: 300, callsPerIpPerMinute: 120, callsPerVenuePerMinute: 300 };

export interface GuestCall {
  app: App;
  /** The caller's address, as the host that mounted the endpoint trusts it. */
  ip?: string;
  limits: GuestLimits;
}

export interface GuestTool<I = any, O = any> {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject;
  output: z.ZodObject;
  /** False for the two tools that create something (a booking, a cart link). */
  readOnly: boolean;
  /** True when the outcome reaches outside this platform (the guest is emailed or texted). */
  openWorld: boolean;
  run(call: GuestCall, input: I): Promise<O>;
}

const ANON: Principal = { kind: 'anon' };
const NOT_LISTED = 'No venue with that id can be reached through this connection. Use find_venue to look one up.';

/** One venue's tenant transaction, entered only for a venue the directory lists, and counted against the venue's allowance. */
async function atVenue<T>(call: GuestCall, venueId: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const orgId = await listedVenueOrg(call.app, venueId);
  if (!orgId) throw notFound(NOT_LISTED);
  await rateLimit(call.app, `guest-plugin:venue:${venueId}`, { limit: call.limits.callsPerVenuePerMinute, windowSeconds: 60 }, 'This venue is getting a lot of requests just now. Try again in a minute.');
  try {
    return await call.app.tenant(orgId, ANON, fn, { ip: call.ip });
  } catch (e) {
    // The venue switched assistants off or stopped trading since the directory was read.
    if (isAppError(e) && e.code === 'not_found' && e.message === 'Venue not found') throw notFound(NOT_LISTED);
    throw e;
  }
}

const venueIdArg = z.string().uuid().describe('The venue_id from find_venue.');
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-07.');
const iso = (d: Date | null) => (d ? d.toISOString() : null);

function guard<T>(def: GuestTool<T>): GuestTool<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`Guest tool name ${def.name} must be snake_case`);
  return def;
}

// ── find_venue ───────────────────────────────────────────────────────────────

const venueCard = z.object({
  venue_id: z.string(),
  name: z.string(),
  suburb: z.string().nullable(),
  state: z.string().nullable(),
  cuisine: z.array(z.string()),
  price_band: z.number().int().nullable().describe('1 (cheapest) to 4 (most expensive), when the venue gave one.'),
  takes_bookings: z.boolean(),
  takes_pickup_orders: z.boolean(),
});

export const findVenueTool = guard<{ query: string }>({
  name: 'find_venue',
  title: 'Find a venue',
  description:
    'Find restaurants and cafes on Pipedline by name, suburb, postcode or cuisine (for example "Oak Diner", "Newtown", "italian Surry Hills"). Returns each venue\'s venue_id, which the other tools take. Only venues that have chosen to be reachable through assistants are listed.',
  input: z.object({ query: z.string().trim().min(2).max(80).describe('A venue name, suburb, postcode or cuisine, or several of these words together.') }),
  output: z.object({ venues: z.array(venueCard), note: z.string().nullable() }),
  readOnly: true,
  openWorld: false,
  async run(call, input) {
    const found = await findListedVenues(call.app, input.query);
    const venues: Array<z.infer<typeof venueCard>> = [];
    for (const v of found) {
      // What each venue offers is read inside its own tenant; a venue that left since the search is skipped.
      const card = await call.app
        .tenant(v.orgId, ANON, async (ctx) => {
          const offers = await assistantOffers(ctx, v.venueId);
          return { takes_bookings: offers.bookings, takes_pickup_orders: offers.pickup };
        })
        .catch((e) => {
          if (isAppError(e) && (e.code === 'not_found' || e.code === 'module_disabled')) return null;
          throw e;
        });
      if (card) venues.push({ venue_id: v.venueId, name: v.name, suburb: v.suburb, state: v.state, cuisine: v.cuisine, price_band: v.priceBand, ...card });
    }
    return { venues, note: venues.length ? null : 'No venue on Pipedline matched. Try a different name, the suburb, or a cuisine.' };
  },
});

// ── venue_info ───────────────────────────────────────────────────────────────

export const venueInfoTool = guard<{ venue_id: string }>({
  name: 'venue_info',
  title: 'Venue details and hours',
  description:
    'A venue\'s address, phone, website, cuisine, price band, opening hours for the next seven days (venue-local time), whether it is open now, and whether it takes bookings and pickup orders through this connection.',
  input: z.object({ venue_id: venueIdArg }),
  output: z.object({
    venue_id: z.string(),
    name: z.string(),
    address: z.string().nullable(),
    phone: z.string().nullable(),
    website: z.string(),
    cuisine: z.array(z.string()),
    price_band: z.number().int().nullable(),
    timezone: z.string(),
    today: z.string(),
    open_now: z.boolean(),
    hours: z.array(z.object({ date: z.string(), day: z.string(), periods: z.array(z.string()).describe('"HH:MM-HH:MM", venue-local. Empty: closed that day.') })),
    bookings: z.object({
      offered: z.boolean(),
      confirmation: z.enum(['instant', 'request']).nullable().describe('instant: confirmed straight away. request: the venue confirms each booking itself.'),
      max_party_size: z.number().int().nullable(),
      phone_number: z.enum(['required', 'optional', 'not_asked']).nullable(),
      note: z.string().nullable(),
    }),
    pickup_orders: z.object({ offered: z.boolean(), asap: z.boolean() }),
    note: z.string().nullable().describe('A line from the venue for guests\' assistants.'),
  }),
  readOnly: true,
  openWorld: false,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const v = await assistantVenueInfo(ctx, { venueId: input.venue_id });
      return {
        venue_id: v.venueId,
        name: v.name,
        address: v.address,
        phone: v.phone,
        website: v.website,
        cuisine: v.cuisine,
        price_band: v.priceBand,
        timezone: v.timezone,
        today: v.today,
        open_now: v.openNow,
        hours: v.hours,
        bookings: { offered: v.bookings.offered, confirmation: v.bookings.confirmation, max_party_size: v.bookings.maxPartySize, phone_number: v.bookings.phoneNumber, note: v.bookings.note },
        pickup_orders: { offered: v.ordering.pickup, asap: v.ordering.asap },
        note: v.note,
      };
    });
  },
});

// ── menu_read ────────────────────────────────────────────────────────────────

const menuItemShape = z.object({
  item_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price_cents: z.number().int(),
  dietary: z.array(z.string()),
  allergens: z.array(z.string()),
  sold_out: z.boolean(),
  alcoholic: z.boolean(),
  orderable_here: z.boolean().describe('False for alcohol, sold-out items, and at venues that take no pickup orders here.'),
  max_per_order: z.number().int().nullable(),
  options: z.array(
    z.object({
      group_id: z.string(),
      name: z.string(),
      required: z.boolean(),
      choose_min: z.number().int(),
      choose_max: z.number().int(),
      choices: z.array(z.object({ option_id: z.string(), name: z.string(), extra_cents: z.number().int(), sold_out: z.boolean() })),
    }),
  ),
});

export const menuReadTool = guard<{ venue_id: string; at?: string }>({
  name: 'menu_read',
  title: 'Read the menu',
  description:
    'The menu a venue is serving now (or at a given time), with prices in cents, dietary tags, allergens, options, and what is sold out. Alcoholic items are marked and cannot be ordered through this connection. Item and option ids are what order_start takes.',
  input: z.object({
    venue_id: venueIdArg,
    at: z.string().datetime({ offset: true }).optional().describe('An ISO time to see the menu served then, e.g. a pickup slot\'s start. Default: now.'),
  }),
  output: z.object({
    venue_id: z.string(),
    venue_name: z.string(),
    currency: z.string(),
    prices_include_tax: z.boolean(),
    menus: z.array(z.object({ menu: z.string(), sections: z.array(z.object({ section: z.string(), items: z.array(menuItemShape) })) })),
    note: z.string(),
  }),
  readOnly: true,
  openWorld: false,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const m = await assistantMenu(ctx, { venueId: input.venue_id, at: input.at ? new Date(input.at) : undefined });
      return {
        venue_id: m.venueId,
        venue_name: m.venueName,
        currency: m.currency,
        prices_include_tax: m.taxInclusive,
        menus: m.menus.map((menu) => ({
          menu: menu.name,
          sections: menu.sections.map((s) => ({
            section: s.name,
            items: s.items.map((i) => ({
              item_id: i.id,
              name: i.name,
              description: i.description,
              price_cents: i.priceCents,
              dietary: i.dietaryTags,
              allergens: i.allergens,
              sold_out: !i.isAvailable,
              alcoholic: i.isAlcohol,
              orderable_here: m.orderable && i.isAvailable && !i.isAlcohol,
              max_per_order: i.maxPerOrder,
              options: i.modifierGroups.map((g) => ({
                group_id: g.id,
                name: g.name,
                required: g.minSelections > 0,
                choose_min: g.minSelections,
                choose_max: g.maxSelections,
                choices: g.modifiers.map((c) => ({ option_id: c.id, name: c.name, extra_cents: c.priceDeltaCents, sold_out: !c.isAvailable })),
              })),
            })),
          })),
        })),
        note: m.menus.length
          ? `Prices are in ${m.currency} cents${m.taxInclusive ? ', tax included' : ''}. Names and descriptions are the venue's own words. Allergens are as the venue lists them; a guest with an allergy should confirm with the venue.`
          : `${m.venueName} is not serving a menu at that time. Check venue_info for the hours.`,
      };
    });
  },
});

// ── booking_times ────────────────────────────────────────────────────────────

export const bookingTimesTool = guard<{ venue_id: string; date: string; party_size: number }>({
  name: 'booking_times',
  title: 'Times a table can be booked',
  description: 'The times a table for a party can be booked at a venue on a date (venue-local). When there are none, `reason` says why in words to pass on.',
  input: z.object({
    venue_id: venueIdArg,
    date: DATE.describe('The venue-local date, YYYY-MM-DD.'),
    party_size: z.number().int().min(1).max(100).describe('How many people, including the guest.'),
  }),
  output: z.object({
    venue_id: z.string(),
    venue_name: z.string(),
    date: z.string(),
    party_size: z.number().int(),
    times: z.array(z.object({ time: z.string().describe('"HH:MM", venue-local. Pass it as booking_request.time.'), service: z.string() })),
    reason: z.string().nullable(),
    confirmation: z.enum(['instant', 'request']),
    max_party_size: z.number().int(),
    first_date: z.string(),
    last_date: z.string(),
    phone_number: z.enum(['required', 'optional', 'not_asked']),
    note: z.string().nullable(),
  }),
  readOnly: true,
  openWorld: false,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const a = await assistantBookingTimes(ctx, { venueId: input.venue_id, date: input.date, partySize: input.party_size });
      return {
        venue_id: a.venueId,
        venue_name: a.venueName,
        date: a.date,
        party_size: a.partySize,
        times: a.times.map((x) => ({ time: x.time, service: x.service })),
        reason: a.reason,
        confirmation: a.confirmation,
        max_party_size: a.maxPartySize,
        first_date: a.firstDate,
        last_date: a.lastDate,
        phone_number: a.phoneNumber,
        note: a.note,
      };
    });
  },
});

// ── booking_request ──────────────────────────────────────────────────────────

const twoStepFields = {
  summary: z.string().describe('Plain words for the guest: what would be done, or what was done.'),
  proposal: z.string().nullable().describe('Send this back unchanged, with the same details, once the guest has agreed to the summary.'),
  proposal_expires_at: z.string().nullable(),
  changed: z.boolean().describe('True when something changed since the guest was last asked: show them this summary again.'),
  next_step: z.string(),
};

interface BookingArgs {
  venue_id: string;
  date: string;
  time: string;
  party_size: number;
  name: string;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  proposal?: string | null;
}

export const bookingRequestTool = guard<BookingArgs>({
  name: 'booking_request',
  title: 'Book a table',
  description:
    'Book a table for the guest, in two steps. First call it without `proposal`: nothing is booked; you get a `summary` to show the guest and a `proposal`. Only if the guest agrees, call it again with exactly the same details plus that `proposal`; then it books and returns the reference. The guest\'s name and an email or phone come from the guest; they are used for this booking only and sign the guest up to nothing.',
  input: z.object({
    venue_id: venueIdArg,
    date: DATE.describe('The venue-local date, YYYY-MM-DD.'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).describe('One of the times booking_times returned, "HH:MM".'),
    party_size: z.number().int().min(1).max(100).describe('How many people.'),
    name: z.string().trim().min(1).max(100).describe('The name the booking is under, as the guest gave it.'),
    email: z.string().trim().max(254).nullish().describe('The guest\'s email for the confirmation.'),
    phone: z.string().trim().max(30).nullish().describe('The guest\'s mobile, for the confirmation by text and for the venue to call.'),
    note: z.string().trim().max(500).nullish().describe('Anything the guest wants the venue to know: a dietary need, an occasion.'),
    proposal: z.string().max(4000).nullish().describe(`The proposal from the first call, sent back only after the guest agreed. It expires after ${PROPOSAL_MINUTES} minutes.`),
  }),
  output: z.object({
    status: z.enum(['confirm_with_guest', 'booked', 'requested']),
    ...twoStepFields,
    reference: z.string().nullable(),
    venue_name: z.string().nullable(),
    date: z.string().nullable(),
    time: z.string().nullable(),
    party_size: z.number().int().nullable(),
    manage_url: z.string().nullable().describe('The guest\'s own link to see or cancel the booking. Give it to the guest only.'),
  }),
  readOnly: false,
  openWorld: true,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const r = await assistantBooking(ctx, {
        venueId: input.venue_id,
        date: input.date,
        time: input.time,
        partySize: input.party_size,
        name: input.name,
        email: input.email ?? null,
        phone: input.phone ?? null,
        note: input.note ?? null,
        proposal: input.proposal ?? null,
      });
      return bookingOut(r);
    });
  },
});

function bookingOut(r: TwoStep<AssistantBooked>) {
  if (r.step === 'ask') {
    return {
      status: 'confirm_with_guest' as const,
      summary: r.summary,
      proposal: r.proposal,
      proposal_expires_at: iso(r.expiresAt),
      changed: r.changed,
      next_step: r.changed
        ? 'Something changed since the guest was asked. Nothing is booked. Show the guest this summary; if they agree, call booking_request again with the same details and this proposal.'
        : 'Nothing is booked yet. Show the guest this summary; if they agree, call booking_request again with the same details and this proposal.',
      reference: null,
      venue_name: null,
      date: null,
      time: null,
      party_size: null,
      manage_url: null,
    };
  }
  const b = r.result;
  return {
    status: b.status,
    summary: b.whatNext,
    proposal: null,
    proposal_expires_at: null,
    changed: false,
    next_step: b.status === 'booked' ? 'Tell the guest it is booked, with the reference.' : 'Tell the guest the venue will confirm, with the reference.',
    reference: b.reference,
    venue_name: b.venueName,
    date: b.date,
    time: b.time,
    party_size: b.partySize,
    manage_url: b.manageUrl,
  };
}

// ── pickup_times ─────────────────────────────────────────────────────────────

export const pickupTimesTool = guard<{ venue_id: string; date?: string }>({
  name: 'pickup_times',
  title: 'Pickup times',
  description: 'When a pickup order could be collected: "as soon as possible" when the kitchen is open and has room, and the pickup slots with room on a date. Pass a slot\'s `start`, or "asap", to order_start.',
  input: z.object({ venue_id: venueIdArg, date: DATE.optional().describe('The venue-local date, YYYY-MM-DD. Default: today.') }),
  output: z.object({
    venue_id: z.string(),
    timezone: z.string(),
    date: z.string(),
    dates: z.array(z.string()).describe('The dates that can be chosen, today first.'),
    asap: z.object({ available: z.boolean(), ready_in_minutes: z.number().int().nullable(), reason: z.string().nullable() }),
    slots: z.array(z.object({ start: z.string().describe('Pass this as order_start.pickup_slot.'), time: z.string().describe('"HH:MM", venue-local.') })),
  }),
  readOnly: true,
  openWorld: false,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const b = await assistantPickupTimes(ctx, { venueId: input.venue_id, date: input.date });
      const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: b.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
      return {
        venue_id: b.venueId,
        timezone: b.timezone,
        date: b.date,
        dates: b.dates,
        asap: { available: b.asap.available, ready_in_minutes: b.asap.estimateMinutes, reason: b.asap.reason },
        slots: b.slots.map((s) => ({ start: s.start.toISOString(), time: time(s.start) })),
      };
    });
  },
});

// ── order_start ──────────────────────────────────────────────────────────────

interface OrderArgs {
  venue_id: string;
  items: Array<{ item_id: string; quantity: number; option_ids?: string[] }>;
  pickup_slot: string;
  proposal?: string | null;
}

export const orderStartTool = guard<OrderArgs>({
  name: 'order_start',
  title: 'Start a pickup order',
  description:
    'Build a pickup order and get a link to the venue\'s own order page, where the guest checks it and pays. No payment happens here and nothing reaches the kitchen until the guest pays on that page. Two steps: first call without `proposal` to get the priced `summary` for the guest; if they agree, call again with the same details plus the `proposal` to get `checkout_url`. Prices always come from the venue\'s menu. Alcohol cannot be ordered here.',
  input: z.object({
    venue_id: venueIdArg,
    items: z
      .array(
        z.object({
          item_id: z.string().uuid().describe('An item_id from menu_read.'),
          quantity: z.number().int().min(1).max(20),
          option_ids: z.array(z.string().uuid()).max(30).optional().describe('option_ids from the item\'s options in menu_read. Required groups need a choice.'),
        }),
      )
      .min(1)
      .max(MAX_CART_LINES),
    pickup_slot: z.string().max(40).describe('"asap", or a slot `start` from pickup_times.'),
    proposal: z.string().max(4000).nullish().describe(`The proposal from the first call, sent back only after the guest agreed. It expires after ${PROPOSAL_MINUTES} minutes.`),
  }),
  output: z.object({
    status: z.enum(['confirm_with_guest', 'ready_to_pay']),
    ...twoStepFields,
    venue_name: z.string(),
    currency: z.string(),
    lines: z.array(z.object({ item_id: z.string(), name: z.string(), quantity: z.number().int(), options: z.array(z.string()), line_total_cents: z.number().int() })),
    subtotal_cents: z.number().int(),
    tax_cents: z.number().int(),
    tax_included: z.boolean(),
    total_cents: z.number().int(),
    pickup: z.object({ asap: z.boolean(), date: z.string(), time: z.string().describe('"HH:MM", venue-local: the slot, or the estimate for as soon as possible.'), ready_in_minutes: z.number().int().nullable() }),
    checkout_url: z.string().nullable().describe('The venue\'s own order page with this order filled in. The guest pays there.'),
    link_expires_at: z.string().nullable(),
  }),
  readOnly: false,
  openWorld: false,
  async run(call, input) {
    return atVenue(call, input.venue_id, async (ctx) => {
      const r = await assistantOrder(ctx, {
        venueId: input.venue_id,
        items: input.items.map((i) => ({ itemId: i.item_id, quantity: i.quantity, optionIds: i.option_ids ?? [] })),
        pickupSlot: input.pickup_slot,
        proposal: input.proposal ?? null,
      });
      const c = r.step === 'done' ? r.result : r.cart;
      const cart = {
        venue_name: c.venueName,
        currency: c.currency,
        lines: c.lines.map((l) => ({ item_id: l.itemId, name: l.name, quantity: l.quantity, options: l.options, line_total_cents: l.lineTotalCents })),
        subtotal_cents: c.subtotalCents,
        tax_cents: c.taxCents,
        tax_included: c.taxIncluded,
        total_cents: c.totalCents,
        pickup: { asap: c.pickup.asap, date: c.pickup.date, time: c.pickup.time, ready_in_minutes: c.pickup.estimateMinutes },
      };
      if (r.step === 'ask') {
        return {
          status: 'confirm_with_guest' as const,
          summary: r.summary,
          proposal: r.proposal,
          proposal_expires_at: iso(r.expiresAt),
          changed: r.changed,
          next_step: r.changed
            ? 'Something changed since the guest was asked. Nothing is ordered. Show the guest this summary; if they agree, call order_start again with the same details and this proposal.'
            : 'Nothing is ordered. Show the guest this summary; if they agree, call order_start again with the same details and this proposal to get the link to pay.',
          ...cart,
          checkout_url: null,
          link_expires_at: null,
        };
      }
      return {
        status: 'ready_to_pay' as const,
        summary: r.result.whatNext,
        proposal: null,
        proposal_expires_at: null,
        changed: false,
        next_step: `Give the guest checkout_url. It works for ${CART_LINK_MINUTES} minutes. Do not say the order is placed: it is placed when they pay on that page.`,
        ...cart,
        checkout_url: r.result.checkoutUrl,
        link_expires_at: iso(r.result.linkExpiresAt),
      };
    });
  },
});

/** Every tool the guest endpoint serves, in the order an assistant would use them. */
export const GUEST_TOOLS: GuestTool[] = [findVenueTool, venueInfoTool, menuReadTool, bookingTimesTool, bookingRequestTool, pickupTimesTool, orderStartTool];
