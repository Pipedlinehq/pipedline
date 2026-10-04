import { z } from 'zod';
import {
  type Ctx,
  AppError,
  addDays,
  assertModule,
  formatMoney,
  forbidden,
  getModule,
  invalid,
  isAppError,
  localParts,
  notFound,
  rateLimit,
  sha256Hex,
  stableStringify,
  track,
} from '@ros/core';
import { type BookingAvailability, getBookingAvailability, requestBooking } from '../bookings/bookings';
import { bookingsModule } from '../bookings/module';
import { partyLine, whenLine } from '../bookings/messages';
import { normaliseEmail, normalisePhone } from '../identity/normalise';
import type { PublicMenu, PublicMenuItem } from '../menu/contract';
import { getPublicMenu } from '../menu/public';
import { orderingModule } from '../ordering/module';
import { type PricedCart, priceCart } from '../ordering/pricing';
import { type SlotBoard, getPickupSlots } from '../ordering/slots';
import { getOrg } from '../tenancy/orgs';
import { openWindows } from '../tenancy/hours';
import { type VenueView, getVenue, listPublicVenues } from '../tenancy/venues';
import { websiteModule } from '../website/module';
import { type GuestPluginConfig, assistantCartCreated, assistantCartOpened, guestPluginModule } from './module';
import { mintCartToken, mintProposal, readCartToken, readProposal } from './tokens';

/**
 * What a guest's assistant may do at one venue (docs/modules/guest-plugin.md). Every function is
 * guest-facing: no role check, an anonymous caller, the organisation already fixed by the tenant
 * transaction it runs in. Each one checks that the plugin is on at the venue and the venue is
 * live, then calls the same function the venue's own site calls: bookings, ordering, menu. None
 * of them returns anything about another guest, a customer record or staff.
 */

/** How long a guest has to say yes to a booking or a cart, in minutes. */
export const PROPOSAL_MINUTES = 15;
/** How long a cart link works, in minutes. */
export const CART_LINK_MINUTES = 30;
/** Bookings through assistants, per guest contact and per address, per day. */
export const BOOKINGS_PER_CONTACT_PER_DAY = 5;
export const BOOKINGS_PER_IP_PER_DAY = 30;
/** Most lines in one cart from an assistant. */
export const MAX_CART_LINES = 20;

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-07.');
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 19:00.');
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const hhmm = (at: Date, tz: string) => {
  const p = localParts(at, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** "Wed 7 Oct at 7:00 pm", from the venue-local date and time the guest asked for. No clock involved, so the words never drift. */
function dayAndTime(date: string, time: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const [h, m] = time.split(':').map(Number) as [number, number];
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} at ${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

// ── The venue, as the guest connection may see it ────────────────────────────

export interface GuestVenue {
  venue: VenueView;
  cfg: GuestPluginConfig;
}

/** The plugin is on and the venue is live, or the venue is not found. A paired screen is refused. */
export async function guestVenue(ctx: Ctx, venueId: string): Promise<GuestVenue> {
  if (ctx.principal.kind === 'device') throw forbidden('This screen cannot do that.');
  const id = z.string().uuid().parse(venueId);
  const venue = await getVenue(ctx, id);
  // Assistants switched off here: the venue is simply not found, as if it were not on Pipedline.
  const state = await getModule(ctx, venue.id, guestPluginModule);
  if (!state.enabled) throw notFound('Venue not found');
  const cfg = await assertModule(ctx, venue.id, guestPluginModule);
  if (venue.status !== 'live' || (await getOrg(ctx)).status !== 'live') throw notFound('Venue not found');
  return { venue, cfg };
}

async function moduleOn(ctx: Ctx, venueId: string, def: Parameters<typeof getModule>[2]): Promise<boolean> {
  return (await getModule(ctx, venueId, def)).enabled;
}

function noBookings(venue: VenueView): AppError {
  return new AppError('module_disabled', `${venue.name} does not take bookings through assistants.${venue.phone ? ` Call them on ${venue.phone}.` : ''}`);
}

function noOrdering(venue: VenueView): AppError {
  return new AppError('module_disabled', `${venue.name} does not take pickup orders through assistants.`);
}

/** Whether pickup orders can be started here: the plugin allows it, ordering is on with pickup, and the venue has a site to pay on. */
async function orderingOffered(ctx: Ctx, g: GuestVenue): Promise<{ pickup: boolean; asap: boolean }> {
  if (!g.cfg.offer_ordering) return { pickup: false, asap: false };
  const ordering = await getModule(ctx, g.venue.id, orderingModule);
  if (!ordering.enabled || !ordering.config.pickup_enabled || !(await moduleOn(ctx, g.venue.id, websiteModule))) return { pickup: false, asap: false };
  return { pickup: true, asap: ordering.config.asap_enabled };
}

async function assertOrdering(ctx: Ctx, g: GuestVenue): Promise<void> {
  if (!(await orderingOffered(ctx, g)).pickup) throw noOrdering(g.venue);
}

async function assertBookings(ctx: Ctx, g: GuestVenue): Promise<void> {
  if (!g.cfg.offer_bookings || !(await moduleOn(ctx, g.venue.id, bookingsModule))) throw noBookings(g.venue);
}

/**
 * The venue's own site address and the path its order page is under: `/order` on the venue's
 * own host or a single-venue organisation's host, `/at/<venue>/order` on a group's host.
 */
export async function venueSite(ctx: Ctx, venue: VenueView): Promise<{ base: string; orderPath: string }> {
  const hosts = await ctx.db
    .selectFrom('domains')
    .select(['host', 'venue_id', 'is_primary'])
    .where('verified_at', 'is not', null)
    .where((eb) => eb.or([eb('venue_id', '=', venue.id), eb('venue_id', 'is', null)]))
    .orderBy('created_at')
    .execute();
  const pick = (list: typeof hosts) => list.find((h) => h.is_primary) ?? list[0];
  const own = pick(hosts.filter((h) => h.venue_id === venue.id));
  const orgHost = pick(hosts.filter((h) => h.venue_id === null));
  const host = own?.host ?? orgHost?.host ?? ctx.app.config.platformHost;
  const base = `${ctx.app.config.scheme}://${host}`;
  if (own) return { base, orderPath: '/order' };
  let withSite = 0;
  for (const v of await listPublicVenues(ctx)) if (await moduleOn(ctx, v.id, websiteModule)) withSite++;
  return { base, orderPath: withSite > 1 ? `/at/${venue.slug}/order` : '/order' };
}

/** What a guest's assistant may do at a venue, for a search result. */
export async function assistantOffers(ctx: Ctx, venueId: string): Promise<{ bookings: boolean; pickup: boolean }> {
  const g = await guestVenue(ctx, venueId);
  const bookings = g.cfg.offer_bookings && (await moduleOn(ctx, g.venue.id, bookingsModule));
  return { bookings, pickup: (await orderingOffered(ctx, g)).pickup };
}

// ── venue_info ───────────────────────────────────────────────────────────────

export interface GuestVenueInfo {
  venueId: string;
  name: string;
  address: string | null;
  suburb: string | null;
  phone: string | null;
  website: string;
  cuisine: string[];
  priceBand: number | null;
  timezone: string;
  today: string;
  openNow: boolean;
  /** The next seven venue-local days, today first. */
  hours: Array<{ date: string; day: string; periods: string[] }>;
  bookings: { offered: boolean; confirmation: 'instant' | 'request' | null; maxPartySize: number | null; phoneNumber: 'required' | 'optional' | 'not_asked' | null; note: string | null };
  ordering: { pickup: boolean; asap: boolean };
  note: string | null;
}

export async function assistantVenueInfo(ctx: Ctx, raw: { venueId: string }): Promise<GuestVenueInfo> {
  const input = z.object({ venueId: z.string().uuid() }).strict().parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  const { venue, cfg } = g;
  const org = await getOrg(ctx);
  const now = ctx.now();
  const today = localParts(now, venue.timezone).date;

  const hours: GuestVenueInfo['hours'] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(today, i);
    const windows = (await openWindows(ctx, venue.id, date)).sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
    hours.push({ date, day: DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!, periods: windows.map((w) => `${hhmm(w.opensAt, venue.timezone)}-${hhmm(w.closesAt, venue.timezone)}`) });
  }
  let openNow = false;
  for (const date of [addDays(today, -1), today]) {
    for (const w of await openWindows(ctx, venue.id, date)) if (now >= w.opensAt && now < w.closesAt) openNow = true;
  }

  const bookingState = cfg.offer_bookings ? await getModule(ctx, venue.id, bookingsModule) : null;
  const bookings: GuestVenueInfo['bookings'] = bookingState?.enabled
    ? {
        offered: true,
        confirmation: bookingState.config.auto_confirm ? 'instant' : 'request',
        maxPartySize: bookingState.config.max_party_size_online,
        phoneNumber: bookingState.config.phone_number,
        note: bookingState.config.booking_note || null,
      }
    : { offered: false, confirmation: null, maxPartySize: null, phoneNumber: null, note: null };

  const address = [venue.addressLine1, venue.addressLine2, [venue.suburb, venue.state, venue.postcode].filter(Boolean).join(' ')].filter((x) => x && x.trim()).join(', ');
  const site = await venueSite(ctx, venue);
  return {
    venueId: venue.id,
    name: venue.name,
    address: address || null,
    suburb: venue.suburb,
    phone: venue.phone,
    website: `${site.base}${site.orderPath === '/order' ? '' : site.orderPath.replace(/\/order$/, '')}`,
    cuisine: venue.cuisineTags.length ? venue.cuisineTags : org.cuisineTags,
    priceBand: venue.priceBand ?? org.priceBand,
    timezone: venue.timezone,
    today,
    openNow,
    hours,
    bookings,
    ordering: await orderingOffered(ctx, g),
    note: cfg.assistant_note || null,
  };
}

// ── menu_read ────────────────────────────────────────────────────────────────

/** The online menu being served at `at`, cut to the menus the venue shows assistants. */
async function visibleMenu(ctx: Ctx, g: GuestVenue, at: Date): Promise<PublicMenu> {
  const menu = await getPublicMenu(ctx, g.venue.id, { surface: 'online', at });
  const names = new Set(g.cfg.visible_menus.map((n) => n.toLowerCase()));
  return names.size ? { ...menu, menus: menu.menus.filter((m) => names.has(m.name.trim().toLowerCase())) } : menu;
}

export const assistantMenuInput = z.object({ venueId: z.string().uuid(), at: z.date().optional() }).strict();

/** The menu as getPublicMenu gives it (surface `online`), limited to the menus the venue allows. Alcohol is marked, never orderable here. */
export async function assistantMenu(ctx: Ctx, raw: z.input<typeof assistantMenuInput>): Promise<PublicMenu & { venueName: string; orderable: boolean }> {
  const input = assistantMenuInput.parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  const menu = await visibleMenu(ctx, g, input.at ?? ctx.now());
  return { ...menu, venueName: g.venue.name, orderable: (await orderingOffered(ctx, g)).pickup };
}

// ── booking_times ────────────────────────────────────────────────────────────

export const assistantBookingTimesInput = z.object({ venueId: z.string().uuid(), date: DAY, partySize: z.number().int().min(1).max(100) }).strict();

export async function assistantBookingTimes(ctx: Ctx, raw: z.input<typeof assistantBookingTimesInput>): Promise<BookingAvailability> {
  const input = assistantBookingTimesInput.parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  await assertBookings(ctx, g);
  return getBookingAvailability(ctx, { venueId: g.venue.id, date: input.date, partySize: input.partySize });
}

// ── pickup_times ─────────────────────────────────────────────────────────────

export const assistantPickupTimesInput = z.object({ venueId: z.string().uuid(), date: DAY.optional() }).strict();

export async function assistantPickupTimes(ctx: Ctx, raw: z.input<typeof assistantPickupTimesInput>): Promise<SlotBoard> {
  const input = assistantPickupTimesInput.parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  await assertOrdering(ctx, g);
  return getPickupSlots(ctx, { venueId: g.venue.id, date: input.date });
}

// ── Two-step confirmation ────────────────────────────────────────────────────

/**
 * Either a question for the guest (`ask`), or the thing done (`done`). The first call never
 * changes anything; it returns plain words and a short-lived signed proposal. The second call
 * carries the same details and the proposal, and acts only if the proposal is this
 * organisation's, unexpired, for these details at this venue, and the words rebuilt now read
 * exactly as the guest was shown. If the words would read differently (a price or a rule
 * changed), the guest is asked again with the new words.
 */
export type TwoStep<T> =
  | { step: 'ask'; summary: string; proposal: string; expiresAt: Date; changed: boolean }
  | { step: 'done'; result: T };

const digest = (value: unknown) => sha256Hex(stableStringify(value));

async function twoStep<T>(
  ctx: Ctx,
  kind: 'booking' | 'order',
  venueId: string,
  args: unknown,
  summary: string,
  proposal: string | null | undefined,
  act: (proposal: string) => Promise<T>,
): Promise<TwoStep<T>> {
  const claims = { kind, venueId, args: digest(args), asked: digest(summary) };
  const ask = async (changed: boolean): Promise<TwoStep<T>> => {
    const minted = await mintProposal(ctx, claims, PROPOSAL_MINUTES);
    return { step: 'ask', summary, proposal: minted.token, expiresAt: minted.expiresAt, changed };
  };
  if (!proposal) return ask(false);
  const read = await readProposal(ctx, proposal);
  const again = kind === 'booking' ? 'Call booking_request again without a proposal to ask the guest afresh.' : 'Call order_start again without a proposal to ask the guest afresh.';
  if (!read.ok) {
    throw invalid(read.why === 'expired' ? `Nothing was done. That confirmation has expired. ${again}` : `Nothing was done. That confirmation is not valid. ${again}`);
  }
  const c = read.value;
  if (c.kind !== kind || c.venueId !== venueId || c.args !== claims.args) {
    throw invalid(`Nothing was done. That confirmation was for different details. ${again}`);
  }
  // The guest agreed to particular words. If they would read differently now, ask again.
  if (c.asked !== claims.asked) return ask(true);
  return { step: 'done', result: await act(proposal) };
}

// ── booking_request ──────────────────────────────────────────────────────────

export const assistantBookingInput = z
  .object({
    venueId: z.string().uuid(),
    date: DAY,
    time: TIME,
    partySize: z.number().int().min(1).max(100),
    /** Guest-written. */
    name: z.string().trim().min(1, 'Add the name the booking is under.').max(100),
    email: z.string().trim().max(254).nullish(),
    phone: z.string().trim().max(30).nullish(),
    /** Guest-written: dietary needs, an occasion. Shown to staff as text. */
    note: z.string().trim().max(500).nullish(),
    proposal: z.string().max(4000).nullish(),
  })
  .strict();

export interface AssistantBooked {
  status: 'booked' | 'requested';
  reference: string;
  venueName: string;
  date: string;
  time: string;
  service: string;
  partySize: number;
  manageUrl: string;
  whatNext: string;
}

export async function assistantBooking(ctx: Ctx, raw: z.input<typeof assistantBookingInput>): Promise<TwoStep<AssistantBooked>> {
  const input = assistantBookingInput.parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  const { venue } = g;
  await assertBookings(ctx, g);

  const rules = (await getModule(ctx, venue.id, bookingsModule)).config;

  // Asking: only a time the venue lists can be put to the guest. Acting: requestBooking checks
  // everything again under its lock, and answers a replayed yes with the booking already made.
  if (!input.proposal) {
    const avail = await getBookingAvailability(ctx, { venueId: venue.id, date: input.date, partySize: input.partySize });
    if (!avail.times.some((x) => x.time === input.time)) {
      throw invalid(avail.reason ?? `${input.time} on ${input.date} cannot be booked for ${partyLine(input.partySize)}. Call booking_times for the times that can.`);
    }
  }

  // The contact is checked now, so a guest is never asked to agree to something that will be refused.
  const email = input.email ? normaliseEmail(input.email) : null;
  if (input.email && !email) throw invalid('That email address does not look right.');
  const phone = input.phone && rules.phone_number !== 'not_asked' ? normalisePhone(input.phone) : null;
  if (input.phone && rules.phone_number !== 'not_asked' && !phone) throw invalid('That phone number does not look right.');
  if (rules.phone_number === 'required' && !phone) throw invalid(`${venue.name} needs a phone number for a booking. Ask the guest for one.`);
  if (rules.phone_number === 'not_asked' && !email) throw invalid(`${venue.name} sends booking confirmations by email. Ask the guest for an email address.`);
  if (!email && !phone) throw invalid('Ask the guest for an email address or a phone number, so the confirmation can reach them.');

  const contact = [email, phone].filter(Boolean).join(' and ');
  const note = input.note?.length ? input.note : null;
  const summary = [
    `Book a table for ${partyLine(input.partySize)} at ${venue.name}${venue.suburb ? ` (${venue.suburb})` : ''} on ${dayAndTime(input.date, input.time)}, under the name "${input.name}".`,
    `The confirmation goes to ${contact}.`,
    note ? `Note for the venue: "${note}".` : '',
    rules.auto_confirm ? `${venue.name} confirms it straight away.` : `${venue.name} confirms each booking itself and replies by email or text.`,
    'Booking does not sign the guest up for anything else.',
  ]
    .filter(Boolean)
    .join(' ');

  const args = { venueId: venue.id, date: input.date, time: input.time, partySize: input.partySize, name: input.name, email, phone, note };
  return twoStep(ctx, 'booking', venue.id, args, summary, input.proposal, async (proposal) => {
    // A cap on bookings through assistants: per guest contact and per address, per day.
    const day = localParts(ctx.now(), venue.timezone).date;
    for (const c of [email, phone].filter((x): x is string => !!x)) {
      await rateLimit(ctx.app, `guest-plugin:book:contact:${sha256Hex(`${ctx.orgId}\0${c}`).slice(0, 32)}:${day}`, { limit: BOOKINGS_PER_CONTACT_PER_DAY, windowSeconds: 86_400 }, 'That guest has made as many bookings through an assistant as can be made in a day. They can call the venue.');
    }
    if (ctx.ip) await rateLimit(ctx.app, `guest-plugin:book:ip:${ctx.ip}:${day}`, { limit: BOOKINGS_PER_IP_PER_DAY, windowSeconds: 86_400 }, 'Too many bookings from this connection today. Try again tomorrow, or call the venue.');

    const made = await requestBooking(ctx, {
      venueId: venue.id,
      date: input.date,
      time: input.time,
      partySize: input.partySize,
      name: input.name,
      email,
      phone,
      note,
      // The same proposal always makes the same booking: a replayed yes is one booking.
      requestKey: `gp-${sha256Hex(proposal).slice(0, 40)}`,
      channel: 'assistant',
    });
    const confirmed = made.status === 'confirmed';
    return {
      status: confirmed ? 'booked' : 'requested',
      reference: made.reference,
      venueName: made.venueName,
      date: made.date,
      time: made.time,
      service: made.serviceName,
      partySize: made.partySize,
      manageUrl: made.manageUrl,
      whatNext: confirmed
        ? `Booked. ${made.venueName} has a table for ${partyLine(made.partySize)} on ${whenLine(made.startsAt, made.timezone)}, reference ${made.reference}. A confirmation was sent to ${contact}, with a link to see or cancel the booking.`
        : `Requested, not yet confirmed. ${made.venueName} confirms each booking itself and will reply to ${contact}. Reference ${made.reference}.`,
    };
  });
}

// ── order_start ──────────────────────────────────────────────────────────────

export const assistantOrderInput = z
  .object({
    venueId: z.string().uuid(),
    items: z
      .array(
        z.object({
          itemId: z.string().uuid(),
          quantity: z.number().int().min(1).max(20),
          optionIds: z.array(z.string().uuid()).max(30).default([]),
        }),
      )
      .min(1, 'Add at least one item.')
      .max(MAX_CART_LINES, `At most ${MAX_CART_LINES} different items in one order through an assistant.`),
    /** "asap", or the start of a slot from pickup_times. */
    pickupSlot: z.union([z.literal('asap'), z.string().datetime({ offset: true })]),
    proposal: z.string().max(4000).nullish(),
  })
  .strict();

export interface AssistantCart {
  venueName: string;
  currency: string;
  lines: Array<{ itemId: string; name: string; quantity: number; options: string[]; lineTotalCents: number }>;
  subtotalCents: number;
  taxCents: number;
  taxIncluded: boolean;
  totalCents: number;
  pickup: { asap: boolean; date: string; time: string; estimateMinutes: number | null };
}

export interface AssistantCheckout extends AssistantCart {
  checkoutUrl: string;
  linkExpiresAt: Date;
  whatNext: string;
}

interface CheckedLine {
  menuItemId: string;
  qty: number;
  modifierIds: string[];
}

/**
 * The lines a guest's assistant may order, judged against the menu it may read: refused in
 * words when an item is not on that menu at that time, is alcoholic, or is sold out, or when an
 * option is not the item's own or is sold out.
 */
function checkLines(menu: PublicMenu, venueName: string, lines: CheckedLine[]): string[] {
  const items = new Map<string, PublicMenuItem>();
  for (const m of menu.menus) for (const s of m.sections) for (const i of s.items) items.set(i.id, i);
  const problems: string[] = [];
  for (const l of lines) {
    const item = items.get(l.menuItemId);
    if (!item) {
      problems.push(`Item ${l.menuItemId} is not on ${venueName}'s menu at that time. Use menu_read for what can be ordered.`);
      continue;
    }
    if (item.isAlcohol) {
      problems.push(`${item.name} is an alcoholic drink. Alcohol cannot be ordered through an assistant; the guest can order it at the venue.`);
      continue;
    }
    if (!item.isAvailable) problems.push(`${item.name} is sold out.`);
    const mods = new Map(item.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.id, m] as const)));
    for (const id of l.modifierIds) {
      const m = mods.get(id);
      if (!m) problems.push(`Option ${id} is not one of ${item.name}'s options.`);
      else if (!m.isAvailable) problems.push(`${m.name} is not available with ${item.name} right now.`);
    }
  }
  return problems;
}

function cartView(priced: PricedCart, venue: VenueView, currency: string): AssistantCart {
  const t = priced.timing!;
  return {
    venueName: venue.name,
    currency,
    lines: priced.lines.map((l) => ({ itemId: l.menuItemId, name: l.name, quantity: l.qty, options: l.modifiers.map((m) => m.name), lineTotalCents: l.lineTotalCents })),
    subtotalCents: priced.subtotalCents,
    taxCents: priced.taxCents,
    taxIncluded: priced.taxInclusive,
    totalCents: priced.totalCents,
    pickup: {
      asap: t.requestedAsap,
      date: localParts(t.slotStart, venue.timezone).date,
      time: hhmm(t.requestedAsap ? t.promisedAt : t.slotStart, venue.timezone),
      estimateMinutes: t.requestedAsap ? t.estimateMinutes : null,
    },
  };
}

export async function assistantOrder(ctx: Ctx, raw: z.input<typeof assistantOrderInput>): Promise<TwoStep<AssistantCheckout> & { cart: AssistantCart }> {
  const input = assistantOrderInput.parse(raw);
  const g = await guestVenue(ctx, input.venueId);
  const { venue } = g;
  await assertOrdering(ctx, g);

  const slotStart = input.pickupSlot === 'asap' ? null : new Date(input.pickupSlot);
  const lines: CheckedLine[] = input.items.map((i) => ({ menuItemId: i.itemId, qty: i.quantity, modifierIds: [...new Set(i.optionIds)] }));
  const problems = checkLines(await visibleMenu(ctx, g, slotStart ?? ctx.now()), venue.name, lines);
  if (problems.length) throw invalid(`Nothing was ordered. ${problems.join(' ')}`);

  // Priced by the server from the menu, exactly as the venue's own cart page prices it.
  const priced = await priceCart(ctx, { venueId: venue.id, channel: 'pickup', lines: lines.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, modifierIds: l.modifierIds })), slotStart: slotStart?.toISOString() ?? null });
  if (priced.issues.length) {
    const timing = priced.issues.some((i) => i.code === 'timing');
    throw invalid(`Nothing was ordered. ${priced.issues.map((i) => i.message).join(' ')}${timing ? ' Call pickup_times for the times that can be chosen.' : ''}`);
  }
  const cart = cartView(priced, venue, priced.currency);
  const money = (c: number) => formatMoney(c, priced.currency);
  // Stable words only: an "about 20 minutes" estimate moves with the clock, so it is not in them.
  const when = slotStart ? whenLine(slotStart, venue.timezone) : 'as soon as possible after paying';
  const summary = [
    `A pickup order from ${venue.name}${venue.suburb ? ` (${venue.suburb})` : ''}, to collect ${when}:`,
    cart.lines.map((l) => `${l.quantity} × ${l.name}${l.options.length ? ` (${l.options.join(', ')})` : ''}, ${money(l.lineTotalCents)}`).join('; ') + '.',
    `Total ${money(cart.totalCents)}${cart.taxIncluded ? `, including ${money(cart.taxCents)} GST` : ` plus ${money(cart.taxCents)} tax`}.`,
    `The guest checks the order and pays on ${venue.name}'s own order page. Nothing is ordered until they have paid there.`,
  ].join(' ');

  const args = { venueId: venue.id, lines, slot: slotStart?.toISOString() ?? 'asap' };
  const out = await twoStep(ctx, 'order', venue.id, args, summary, input.proposal, async () => {
    const minted = await mintCartToken(ctx, { venueId: venue.id, lines, slotStart }, CART_LINK_MINUTES);
    const site = await venueSite(ctx, venue);
    await track(ctx, assistantCartCreated, { item_count: priced.itemCount, subtotal_cents: priced.subtotalCents, asap: slotStart === null }, { venueId: venue.id });
    return {
      ...cart,
      checkoutUrl: `${site.base}${site.orderPath}?cart=${minted.token}`,
      linkExpiresAt: minted.expiresAt,
      whatNext: `Give the guest this link. They check the order and pay on ${venue.name}'s own page; it goes to the kitchen only once they have paid. The link works for ${CART_LINK_MINUTES} minutes.`,
    };
  });
  return { ...out, cart };
}

// ── The venue's order page reads a cart link ─────────────────────────────────

export interface OpenedCart {
  lines: Array<{ menuItemId: string; name: string; qty: number; modifierIds: string[]; modifierNames: string[] }>;
  /** The slot to preselect (ISO), or null for as soon as possible. */
  slotStart: string | null;
  /** The venue-local date of that slot. */
  slotDate: string | null;
  /** Plain words about anything left out. */
  notices: string[];
}

export type OpenCartResult = { ok: true; cart: OpenedCart } | { ok: false; message: string };

export const openCartLinkInput = z.object({ venueId: z.string().uuid(), token: z.string().max(4000) }).strict();

const LINK_INVALID = 'This order link is not valid. You can start your order below.';

/**
 * The venue's order page, opened with `?cart=<token>`. The token must be this organisation's,
 * unaltered, unexpired and for this venue, and the venue must still have assistants switched
 * on. Then everything is checked and priced again by the server, as for any cart: alcohol and
 * anything off the menu are left out with a notice, a pickup time that has gone is dropped, and
 * prices come from the menu now. A refused link is answered in words; the page shows an empty cart.
 */
export async function openCartLink(ctx: Ctx, raw: z.input<typeof openCartLinkInput>): Promise<OpenCartResult> {
  const input = openCartLinkInput.parse(raw);
  if (ctx.principal.kind === 'device') throw forbidden('This screen cannot do that.');
  if (ctx.ip) await rateLimit(ctx.app, `guest-plugin:cart:ip:${ctx.ip}`, { limit: 60, windowSeconds: 600 }, 'Too many requests from this device. Try again shortly.');
  const refuse = async (message: string, items = 0): Promise<OpenCartResult> => {
    await track(ctx, assistantCartOpened, { item_count: items, ok: false }, { venueId: input.venueId });
    return { ok: false, message };
  };

  const read = await readCartToken(ctx, input.token);
  if (!read.ok) {
    return refuse(read.why === 'expired' ? `This order link has expired. Links from an assistant work for ${CART_LINK_MINUTES} minutes. You can start your order below, or ask your assistant for a new link.` : LINK_INVALID);
  }
  const claims = read.value;
  if (claims.venueId !== input.venueId) return refuse(LINK_INVALID);
  let g: GuestVenue;
  try {
    g = await guestVenue(ctx, input.venueId);
    await assertOrdering(ctx, g);
  } catch (e) {
    if (isAppError(e) && (e.code === 'not_found' || e.code === 'module_disabled')) return refuse('This order link no longer works here. You can start your order below.');
    throw e;
  }

  const notices: string[] = [];
  const menu = await visibleMenu(ctx, g, claims.slotStart ?? ctx.now());
  const kept = claims.lines.filter((l) => {
    const problems = checkLines(menu, g.venue.name, [{ ...l, modifierIds: [] }]);
    // Sold out stays in the cart, where the page says so; anything else is left out.
    return !problems.length || problems.every((p) => p.endsWith(' is sold out.'));
  });
  if (kept.length < claims.lines.length) notices.push('Some items from your assistant are not on the menu here and were left out.');
  if (!kept.length) return refuse(notices.concat('There is nothing left to order from that link. You can start your order below.').join(' '), claims.lines.length);

  const price = async (slotStart: Date | null): Promise<PricedCart | null> => {
    try {
      return await priceCart(ctx, { venueId: g.venue.id, channel: 'pickup', lines: kept, slotStart: slotStart?.toISOString() ?? null });
    } catch (e) {
      if (isAppError(e) && e.code === 'not_found') return null;
      throw e;
    }
  };
  let slotStart = claims.slotStart;
  let priced = await price(slotStart);
  if (!priced) return refuse(LINK_INVALID, claims.lines.length);
  if (slotStart && priced.issues.some((i) => i.code === 'timing')) {
    notices.push('The pickup time your assistant chose is no longer available. Choose another at checkout.');
    slotStart = null;
    priced = (await price(null)) ?? priced;
  }

  await track(ctx, assistantCartOpened, { item_count: priced.itemCount, ok: true }, { venueId: g.venue.id });
  return {
    ok: true,
    cart: {
      lines: priced.lines.map((l) => ({ menuItemId: l.menuItemId, name: l.name, qty: l.qty, modifierIds: l.modifiers.map((m) => m.id), modifierNames: l.modifiers.map((m) => m.name) })),
      slotStart: slotStart?.toISOString() ?? null,
      slotDate: slotStart ? localParts(slotStart, g.venue.timezone).date : null,
      notices,
    },
  };
}
