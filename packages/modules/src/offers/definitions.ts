import { z } from 'zod';
import { type Ctx, AppError, audit, formatMoney, getModule, invalid, localParts, notFound, percentOf, requireStaff } from '@ros/core';
import { loadSegment, segmentNames } from '../campaigns/segments';
import { getOrg } from '../tenancy/orgs';
import { type OffersConfig, offersModule } from './module';

/**
 * Offer definitions (docs/CONSOLE_IA.md section 9, pattern 6): what an offer gives, how it is
 * used (a code, or automatically), what it applies to (a dish, a category, the whole bill, the
 * delivery fee), who may use it, when, what it combines with, and its limits. Org-wide; a manager
 * or owner sets them up. The welcome, come-back, voucher, birthday and creator offers of before
 * are the same object with method 'code', applies_to 'bill' and audience 'everyone'.
 */

export type OfferKind = 'welcome' | 'comeback' | 'voucher' | 'birthday' | 'creator' | 'manual';
export type OrderChannel = 'pickup' | 'delivery' | 'dine-in-qr';
export type OfferMethod = 'code' | 'automatic';
export type OfferAppliesTo = 'item' | 'category' | 'bill' | 'delivery';
export type OfferAudience = 'everyone' | 'list' | 'new_guests' | 'loyalty_members';
/** Active · Scheduled · Expired · Switched off: the console's views. Worked out from the dates, never stored. */
export type OfferStatus = 'active' | 'scheduled' | 'expired' | 'off';

export interface OfferRow {
  id: string;
  kind: OfferKind;
  name: string;
  description: string | null;
  discount_kind: 'fixed' | 'percent' | 'free_item';
  value_cents: number | null;
  percent_off: number | null;
  menu_item_id: string | null;
  price_cents: number;
  min_spend_cents: number;
  validity_days: number;
  requires_claim: boolean;
  channels: OrderChannel[];
  valid_venue_ids: string[] | null;
  max_codes: number | null;
  code_prefix: string;
  campaign_id: string | null;
  creator_id: string | null;
  is_active: boolean;
  method: OfferMethod;
  applies_to: OfferAppliesTo;
  category: string | null;
  audience: OfferAudience;
  segment_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  /** 0 = Sunday … 6 = Saturday; null = any day. */
  days: number[] | null;
  services: string[] | null;
  /** HH:MM:SS, venue-local; null = all day. */
  time_from: string | null;
  time_to: string | null;
  combine_item: boolean;
  combine_bill: boolean;
  combine_delivery: boolean;
  per_guest_limit: number | null;
  total_limit: number | null;
}

export const OFFER_COLS = [
  'id',
  'kind',
  'name',
  'description',
  'discount_kind',
  'value_cents',
  'percent_off',
  'menu_item_id',
  'price_cents',
  'min_spend_cents',
  'validity_days',
  'requires_claim',
  'channels',
  'valid_venue_ids',
  'max_codes',
  'code_prefix',
  'campaign_id',
  'creator_id',
  'is_active',
  'method',
  'applies_to',
  'category',
  'audience',
  'segment_id',
  'starts_at',
  'ends_at',
  'days',
  'services',
  'time_from',
  'time_to',
  'combine_item',
  'combine_bill',
  'combine_delivery',
  'per_guest_limit',
  'total_limit',
] as const;

export interface OfferView {
  id: string;
  kind: OfferKind;
  name: string;
  description: string | null;
  discountKind: 'fixed' | 'percent' | 'free_item';
  valueCents: number | null;
  percentOff: number | null;
  menuItemId: string | null;
  /** What the guest pays for a voucher. 0 = free. */
  priceCents: number;
  minSpendCents: number;
  validityDays: number;
  /** True: a code starts as issued and the guest claims it. False: it is issued already claimed. */
  requiresClaim: boolean;
  /** The online order types the offer works on. A code always works at the till. */
  channels: OrderChannel[];
  validVenueIds: string[] | null;
  maxCodes: number | null;
  codePrefix: string;
  campaignId: string | null;
  creatorId: string | null;
  isActive: boolean;
  /** A code the guest holds, or applied by itself at checkout and matched from the till. */
  method: OfferMethod;
  appliesTo: OfferAppliesTo;
  category: string | null;
  audience: OfferAudience;
  segmentId: string | null;
  /** The guest list's name when audience is 'list'. */
  segmentName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  days: number[] | null;
  services: string[] | null;
  /** HH:MM, venue-local. */
  timeFrom: string | null;
  timeTo: string | null;
  combineItem: boolean;
  combineBill: boolean;
  combineDelivery: boolean;
  perGuestLimit: number | null;
  totalLimit: number | null;
  status: OfferStatus;
  /** Plain words, written here: "$10 off any main for Lapsed 60+ days, Tuesday to Thursday dinner, until 30 Nov, one per guest". */
  summary: string;
}

// ── Plain words ───────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Tuesday to Thursday", "Monday and Wednesday", "Friday to Sunday"; nothing for every day. */
export function daysWords(days: number[] | null): string | null {
  if (!days || !days.length || days.length >= 7) return null;
  // Runs are found on the Monday-first week, so Friday–Sunday reads as one run.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const set = new Set(days);
  const runs: number[][] = [];
  for (const d of order) {
    if (!set.has(d)) continue;
    const last = runs[runs.length - 1];
    if (last && order.indexOf(last[last.length - 1]!) === order.indexOf(d) - 1) last.push(d);
    else runs.push([d]);
  }
  const words = runs.map((r) => (r.length >= 3 ? `${DAY_NAMES[r[0]!]} to ${DAY_NAMES[r[r.length - 1]!]}` : r.map((d) => DAY_NAMES[d]!).join(' and ')));
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** "4pm", "6:30pm", "12 noon". */
export function clockWords(t: string | null): string | null {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number) as [number, number];
  if (h === 12 && m === 0) return '12 noon';
  if (h === 0 && m === 0) return 'midnight';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

const dayMonth = (at: Date, tz: string) => {
  const p = localParts(at, tz);
  return `${p.day} ${MONTHS[p.month - 1]}`;
};

/** "any main" from "Mains"; "any dessert" from "Desserts"; "any pizza" stays. */
export function categoryWords(category: string): string {
  const c = category.trim().toLowerCase();
  const singular = /[a-z]s$/.test(c) && !/ss$/.test(c) ? c.slice(0, -1) : c;
  return `any ${singular}`;
}

export interface SummaryExtras {
  /** The guest list's name, when the offer is for one. */
  segmentName?: string | null;
  /** The dish's name, when the offer is for one dish. */
  itemName?: string | null;
  /** For dates in the summary; the org's zone. */
  timezone?: string;
}

type SummaryRow = Pick<OfferRow, 'discount_kind' | 'value_cents' | 'percent_off' | 'min_spend_cents'> &
  Partial<Pick<OfferRow, 'method' | 'applies_to' | 'category' | 'audience' | 'starts_at' | 'ends_at' | 'days' | 'services' | 'time_from' | 'time_to' | 'combine_item' | 'combine_bill' | 'combine_delivery' | 'per_guest_limit' | 'total_limit'>>;

/**
 * What the offer is, in one plain sentence the server writes. An offer with none of the newer
 * settings reads exactly as before ("$10 off when you spend $40 or more"), so what a guest was
 * told in a message does not change under them.
 */
export function offerSummary(o: SummaryRow, currency = 'AUD', extra: SummaryExtras = {}): string {
  const money = (cents: number) => formatMoney(cents, currency).replace(/\.00$/, '');
  const appliesTo = o.applies_to ?? 'bill';
  let what: string;
  if (appliesTo === 'delivery' && o.discount_kind === 'percent' && (o.percent_off ?? 0) >= 100) what = 'Free delivery';
  else if (o.discount_kind === 'fixed') what = `${money(o.value_cents ?? 0)} off`;
  else if (o.discount_kind === 'percent') what = `${o.percent_off ?? 0}% off`;
  else what = extra.itemName ? `A free ${extra.itemName}` : 'A free item';
  if (appliesTo === 'category' && o.category && o.discount_kind !== 'free_item') what += ` ${categoryWords(o.category)}`;
  else if (appliesTo === 'item' && o.discount_kind !== 'free_item') what += extra.itemName ? ` ${extra.itemName}` : ' one dish';
  else if (appliesTo === 'delivery' && what !== 'Free delivery') what += ' the delivery fee';
  if (o.min_spend_cents > 0) what += ` when you spend ${money(o.min_spend_cents)} or more`;

  const parts: string[] = [];
  const who = o.audience === 'list' ? (extra.segmentName ?? 'a guest list') : o.audience === 'new_guests' ? 'new guests' : o.audience === 'loyalty_members' ? 'loyalty members' : null;
  if (who) what += ` for ${who}`;

  const when: string[] = [];
  const days = daysWords(o.days ?? null);
  if (days) when.push(days);
  if (o.services?.length) when.push(o.services.join(' and '));
  if (o.time_from && o.time_to) when.push(`${clockWords(o.time_from)} to ${clockWords(o.time_to)}`);
  if (when.length) parts.push(when.join(' '));

  const tz = extra.timezone ?? 'Australia/Sydney';
  if (o.starts_at && o.ends_at) parts.push(`${dayMonth(o.starts_at, tz)} to ${dayMonth(o.ends_at, tz)}`);
  else if (o.starts_at) parts.push(`from ${dayMonth(o.starts_at, tz)}`);
  else if (o.ends_at) parts.push(`until ${dayMonth(o.ends_at, tz)}`);

  if (o.per_guest_limit === 1) parts.push('one per guest');
  else if (o.per_guest_limit) parts.push(`up to ${o.per_guest_limit} per guest`);
  if (o.total_limit) parts.push(`first ${o.total_limit} uses`);

  if (o.method === 'automatic') {
    parts.push('applied automatically');
    if (!o.combine_item && !o.combine_bill && !o.combine_delivery) parts.push('not with other offers');
  }
  return parts.length ? `${what}, ${parts.join(', ')}` : what;
}

/** What the offer takes off a sale of this size. For a free item the caller supplies the item's price. */
export function offerDiscountCents(o: Pick<OfferRow, 'discount_kind' | 'value_cents' | 'percent_off'>, subtotalCents: number, freeItemPriceCents?: number | null): number {
  let off = 0;
  if (o.discount_kind === 'fixed') off = o.value_cents ?? 0;
  else if (o.discount_kind === 'percent') off = percentOf(subtotalCents, o.percent_off ?? 0);
  else off = freeItemPriceCents ?? o.value_cents ?? 0;
  return Math.max(0, Math.min(off, subtotalCents));
}

/** Active, scheduled, expired or switched off, at an instant. */
export function offerStatus(o: Pick<OfferRow, 'is_active' | 'starts_at' | 'ends_at'>, now: Date): OfferStatus {
  if (!o.is_active) return 'off';
  if (o.starts_at && o.starts_at > now) return 'scheduled';
  if (o.ends_at && o.ends_at <= now) return 'expired';
  return 'active';
}

/** "HH:MM:SS" from the database to "HH:MM" for people. */
const hhmm = (t: string | null) => (t ? t.slice(0, 5) : null);

export const offerView = (o: OfferRow, currency: string | undefined, now: Date, extra: SummaryExtras = {}): OfferView => ({
  id: o.id,
  kind: o.kind,
  name: o.name,
  description: o.description,
  discountKind: o.discount_kind,
  valueCents: o.value_cents,
  percentOff: o.percent_off,
  menuItemId: o.menu_item_id,
  priceCents: o.price_cents,
  minSpendCents: o.min_spend_cents,
  validityDays: o.validity_days,
  requiresClaim: o.requires_claim,
  channels: o.channels,
  validVenueIds: o.valid_venue_ids,
  maxCodes: o.max_codes,
  codePrefix: o.code_prefix,
  campaignId: o.campaign_id,
  creatorId: o.creator_id,
  isActive: o.is_active,
  method: o.method,
  appliesTo: o.applies_to,
  category: o.category,
  audience: o.audience,
  segmentId: o.segment_id,
  segmentName: extra.segmentName ?? null,
  startsAt: o.starts_at,
  endsAt: o.ends_at,
  days: o.days,
  services: o.services,
  timeFrom: hhmm(o.time_from),
  timeTo: hhmm(o.time_to),
  combineItem: o.combine_item,
  combineBill: o.combine_bill,
  combineDelivery: o.combine_delivery,
  perGuestLimit: o.per_guest_limit,
  totalLimit: o.total_limit,
  status: offerStatus(o, now),
  summary: offerSummary(o, currency, extra),
});

/**
 * Offers are org-wide but switched on per venue. With a venue, the module must be on there.
 * Without one (the claim page, offer settings) it must be on somewhere.
 */
export async function assertOffersOn(ctx: Ctx, venueId?: string | null): Promise<OffersConfig> {
  if (venueId) {
    const state = await getModule(ctx, venueId, offersModule);
    if (!state.enabled) throw new AppError('module_disabled', 'That is not available at this venue.');
    return state.config;
  }
  const on = await ctx.db.selectFrom('venue_modules').select('venue_id').where('module_key', '=', offersModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  if (!on) throw new AppError('module_disabled', 'That is not available at this venue.');
  return offersModule.defaultConfig;
}

/** The venue's offers config, or null when the module is off there. */
export async function venueOffers(ctx: Ctx, venueId: string): Promise<OffersConfig | null> {
  const state = await getModule(ctx, venueId, offersModule);
  return state.enabled ? state.config : null;
}

/** A Postgres array that the driver handed back as text ("{a,b}"), or as an array, as an array. */
function pgArray<T extends string | number>(v: unknown, map: (s: string) => T): T[] | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? map(x) : (x as T)));
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean).map(map);
  return null;
}

/**
 * The driver hands back an array of a custom enum as its Postgres text form ("{pickup,delivery}"),
 * not as an array. Every offer row read from the database passes through here.
 */
export function toOfferRow(raw: Omit<OfferRow, 'channels' | 'days' | 'services'> & { channels: unknown; days: unknown; services: unknown }): OfferRow {
  return {
    ...raw,
    channels: pgArray(raw.channels, (s) => s as OrderChannel) ?? [],
    days: pgArray(raw.days, Number),
    services: pgArray(raw.services, String),
  };
}

export async function loadOffer(ctx: Ctx, offerId: string): Promise<OfferRow | null> {
  const r = await ctx.db.selectFrom('offers').select(OFFER_COLS).where('id', '=', offerId).executeTakeFirst();
  return r ? toOfferRow(r) : null;
}

const CHANNELS = ['pickup', 'delivery', 'dine-in-qr'] as const;
const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time such as 16:00.');

export const offerInput = z
  .object({
    id: z.string().uuid().optional(),
    kind: z.enum(['welcome', 'comeback', 'voucher', 'birthday', 'creator', 'manual']),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).nullable().default(null),
    discountKind: z.enum(['fixed', 'percent', 'free_item']),
    valueCents: z.number().int().min(1).max(10_000_000).nullable().default(null),
    percentOff: z.number().int().min(1).max(100).nullable().default(null),
    menuItemId: z.string().uuid().nullable().default(null),
    priceCents: z.number().int().min(0).max(10_000_000).default(0),
    minSpendCents: z.number().int().min(0).max(10_000_000).default(0),
    validityDays: z.number().int().min(1).max(1825).default(30),
    requiresClaim: z.boolean().default(true),
    channels: z.array(z.enum(CHANNELS)).min(1).default([...CHANNELS]),
    validVenueIds: z.array(z.string().uuid()).min(1).nullable().default(null),
    maxCodes: z.number().int().min(1).nullable().default(null),
    /** What every code for this offer starts with, e.g. "OAK-W". */
    codePrefix: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{2,8}(-[A-Z0-9]{1,4})?$/, 'Use 2 to 8 letters or numbers, optionally a hyphen and up to 4 more.')
      .default('ROS'),
    campaignId: z.string().trim().min(1).max(120).nullable().default(null),
    creatorId: z.string().trim().min(1).max(120).nullable().default(null),
    isActive: z.boolean().default(true),
    /** How it is used: a code each guest holds, or applied by itself at checkout and matched from the till. */
    method: z.enum(['code', 'automatic']).default('code'),
    /** What it comes off: one dish, a menu category, the whole bill, or the delivery fee. */
    appliesTo: z.enum(['item', 'category', 'bill', 'delivery']).default('bill'),
    /** The menu category's name, as the menu shows it, for a category offer. */
    category: z.string().trim().min(1).max(80).nullable().default(null),
    /** Who may use it. */
    audience: z.enum(['everyone', 'list', 'new_guests', 'loyalty_members']).default('everyone'),
    /** The guest list, for audience 'list'. */
    segmentId: z.string().uuid().nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    /** Days of the week it runs, 0 = Sunday … 6 = Saturday. Empty or null = every day. */
    days: z.array(z.number().int().min(0).max(6)).max(7).nullable().default(null),
    /** Services it runs in, by the names the venue's hours use (lunch, dinner). Empty or null = any. */
    services: z.array(z.string().trim().min(1).max(40)).max(10).nullable().default(null),
    /** A daily window, venue-local, HH:MM. Both or neither. */
    timeFrom: TIME.nullable().default(null),
    timeTo: TIME.nullable().default(null),
    combineItem: z.boolean().default(false),
    combineBill: z.boolean().default(false),
    combineDelivery: z.boolean().default(false),
    /** Times one guest may use it. Null = no limit (a code is still one live code at a time). */
    perGuestLimit: z.number().int().min(1).max(1000).nullable().default(null),
    /** Times it may be used in total. Null = no limit. */
    totalLimit: z.number().int().min(1).max(1_000_000).nullable().default(null),
  })
  .superRefine((v, c) => {
    if (v.discountKind === 'fixed' && !v.valueCents) c.addIssue({ code: 'custom', message: 'Say how much this offer takes off.', path: ['valueCents'] });
    if (v.discountKind === 'percent' && !v.percentOff) c.addIssue({ code: 'custom', message: 'Say what percentage this offer takes off.', path: ['percentOff'] });
    if (v.discountKind === 'free_item' && !v.menuItemId && !v.valueCents) c.addIssue({ code: 'custom', message: 'Choose the free item, or say what it is worth.', path: ['menuItemId'] });
    if (v.kind === 'creator' && !v.creatorId) c.addIssue({ code: 'custom', message: 'A creator offer needs the creator it belongs to.', path: ['creatorId'] });
    if (v.appliesTo === 'category' && !v.category) c.addIssue({ code: 'custom', message: 'Name the menu category the offer is for.', path: ['category'] });
    if (v.appliesTo === 'item' && !v.menuItemId) c.addIssue({ code: 'custom', message: 'Choose the dish the offer is for.', path: ['menuItemId'] });
    if (v.audience === 'list' && !v.segmentId) c.addIssue({ code: 'custom', message: 'Choose the guest list the offer is for.', path: ['segmentId'] });
    if (v.startsAt && v.endsAt && v.endsAt <= v.startsAt) c.addIssue({ code: 'custom', message: 'The offer must end after it starts.', path: ['endsAt'] });
    if ((v.timeFrom === null) !== (v.timeTo === null)) c.addIssue({ code: 'custom', message: 'Give both the start and the end of the daily window, or neither.', path: ['timeTo'] });
    if (v.timeFrom && v.timeTo && v.timeTo <= v.timeFrom) c.addIssue({ code: 'custom', message: 'The daily window must end after it starts.', path: ['timeTo'] });
    if (v.method === 'automatic' && v.kind === 'creator') c.addIssue({ code: 'custom', message: 'A creator offer works by code, so the creator can be credited.', path: ['method'] });
  });
export type OfferInput = z.input<typeof offerInput>;

/** The names an offer's summary needs beside the row: its guest list and its dish. */
async function summaryExtras(ctx: Ctx, rows: Array<Pick<OfferRow, 'segment_id' | 'menu_item_id'>>): Promise<{ segments: Map<string, string>; items: Map<string, string>; timezone: string }> {
  const segments = await segmentNames(ctx, rows.map((r) => r.segment_id).filter((x): x is string => !!x));
  const itemIds = [...new Set(rows.map((r) => r.menu_item_id).filter((x): x is string => !!x))];
  // menu_items is a spine table: a read is allowed; the name is all that is taken.
  const items = itemIds.length ? new Map((await ctx.db.selectFrom('menu_items').select(['id', 'name']).where('id', 'in', itemIds).execute()).map((r) => [r.id, r.name])) : new Map<string, string>();
  const org = await getOrg(ctx);
  return { segments, items, timezone: org.timezone };
}

const extrasFor = (o: OfferRow, x: Awaited<ReturnType<typeof summaryExtras>>): SummaryExtras => ({
  segmentName: o.segment_id ? (x.segments.get(o.segment_id) ?? null) : null,
  itemName: o.menu_item_id ? (x.items.get(o.menu_item_id) ?? null) : null,
  timezone: x.timezone,
});

/** One row as the console sees it, with the names its summary needs. */
export async function viewOf(ctx: Ctx, o: OfferRow): Promise<OfferView> {
  const x = await summaryExtras(ctx, [o]);
  return offerView(o, await orgCurrency(ctx), ctx.now(), extrasFor(o, x));
}

/**
 * Create an offer, or change one. Switching an offer off stops new codes and stops it applying;
 * codes already with guests stay good until they expire. Audited.
 */
export async function saveOffer(ctx: Ctx, raw: z.input<typeof offerInput>): Promise<OfferView> {
  const parsed = offerInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That offer is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { minRole: 'manager' });
  await assertOffersOn(ctx);

  if (input.validVenueIds) {
    // Row-level security hides other orgs' venues, so an id from elsewhere simply is not found.
    const found = await ctx.db.selectFrom('venues').select('id').where('id', 'in', input.validVenueIds).execute();
    if (found.length !== new Set(input.validVenueIds).size) throw notFound('Venue not found');
  }
  // The guest list must be one of this org's (another org's is not found); the dish likewise.
  if (input.audience === 'list' && input.segmentId) await loadSegment(ctx, input.segmentId);
  if (input.menuItemId) {
    const item = await ctx.db.selectFrom('menu_items').select('id').where('id', '=', input.menuItemId).executeTakeFirst();
    if (!item) throw notFound('Menu item not found');
  }

  const values = {
    kind: input.kind,
    name: input.name,
    description: input.description,
    discount_kind: input.discountKind,
    value_cents: input.valueCents,
    percent_off: input.discountKind === 'percent' ? input.percentOff : null,
    menu_item_id: input.discountKind === 'free_item' || input.appliesTo === 'item' ? input.menuItemId : null,
    price_cents: input.priceCents,
    min_spend_cents: input.minSpendCents,
    validity_days: input.validityDays,
    requires_claim: input.requiresClaim,
    channels: input.channels,
    valid_venue_ids: input.validVenueIds,
    max_codes: input.maxCodes,
    code_prefix: input.codePrefix,
    campaign_id: input.campaignId,
    creator_id: input.creatorId,
    is_active: input.isActive,
    method: input.method,
    applies_to: input.appliesTo,
    category: input.appliesTo === 'category' ? input.category : null,
    audience: input.audience,
    segment_id: input.audience === 'list' ? input.segmentId : null,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    days: input.days && input.days.length && input.days.length < 7 ? [...new Set(input.days)].sort() : null,
    services: input.services && input.services.length ? [...new Set(input.services.map((s) => s.toLowerCase()))] : null,
    time_from: input.timeFrom,
    time_to: input.timeTo,
    combine_item: input.combineItem,
    combine_bill: input.combineBill,
    combine_delivery: input.combineDelivery,
    per_guest_limit: input.perGuestLimit,
    total_limit: input.totalLimit,
    updated_at: ctx.now(),
  };
  let id = input.id;
  let before: OfferRow | null = null;
  if (id) {
    before = await loadOffer(ctx, id);
    if (!before) throw notFound('Offer not found');
    await ctx.db.updateTable('offers').set(values).where('id', '=', id).execute();
  } else {
    const row = await ctx.db
      .insertInto('offers')
      .values({ org_id: ctx.orgId, ...values, created_at: ctx.now() })
      .returning('id')
      .executeTakeFirstOrThrow();
    id = row.id;
  }
  const after = (await loadOffer(ctx, id))!;
  await audit(ctx, { action: before ? 'offer.updated' : 'offer.created', entityType: 'offer', entityId: id, before: before ?? undefined, after });
  return viewOf(ctx, after);
}

/** Switch an offer on or off without touching anything else about it. Audited. */
export async function switchOffer(ctx: Ctx, offerId: string, on: boolean): Promise<OfferView> {
  const id = z.string().uuid().parse(offerId);
  requireStaff(ctx, { minRole: 'manager' });
  await assertOffersOn(ctx);
  const before = await loadOffer(ctx, id);
  if (!before) throw notFound('Offer not found');
  if (before.is_active !== on) {
    await ctx.db.updateTable('offers').set({ is_active: on, updated_at: ctx.now() }).where('id', '=', id).execute();
    await audit(ctx, { action: 'offer.switched', entityType: 'offer', entityId: id, before: { isActive: before.is_active }, after: { isActive: on, name: before.name } });
  }
  return viewOf(ctx, (await loadOffer(ctx, id))!);
}

export interface ListOffersOptions {
  includeInactive?: boolean;
  /** Switched on or off (wave 1's views). `status` is the finer cut. */
  active?: boolean;
  kind?: OfferKind;
  status?: OfferStatus;
  method?: OfferMethod;
  /** Offers whose "who" is this guest list. */
  segmentId?: string;
}

/**
 * Every offer, for the console, newest first. `status` narrows to Active, Scheduled, Expired or
 * Switched off at this moment; `active` to switched on or off; `kind` and `method` to one each.
 */
export async function listOffers(ctx: Ctx, opts: ListOffersOptions = {}): Promise<OfferView[]> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  const now = ctx.now();
  let q = ctx.db.selectFrom('offers').select(OFFER_COLS).orderBy('created_at', 'desc');
  if (opts.status) {
    switch (opts.status) {
      case 'off':
        q = q.where('is_active', '=', false);
        break;
      case 'scheduled':
        q = q.where('is_active', '=', true).where('starts_at', '>', now);
        break;
      case 'expired':
        q = q.where('is_active', '=', true).where('ends_at', '<=', now);
        break;
      case 'active':
        q = q
          .where('is_active', '=', true)
          .where((eb) => eb.or([eb('starts_at', 'is', null), eb('starts_at', '<=', now)]))
          .where((eb) => eb.or([eb('ends_at', 'is', null), eb('ends_at', '>', now)]));
        break;
    }
  } else if (opts.active !== undefined) q = q.where('is_active', '=', opts.active);
  else if (!opts.includeInactive) q = q.where('is_active', '=', true);
  if (opts.kind) q = q.where('kind', '=', opts.kind);
  if (opts.method) q = q.where('method', '=', opts.method);
  if (opts.segmentId) q = q.where('segment_id', '=', opts.segmentId);
  const rows = (await q.execute()).map(toOfferRow);
  const currency = await orgCurrency(ctx);
  const x = await summaryExtras(ctx, rows);
  return rows.map((o) => offerView(o, currency, now, extrasFor(o, x)));
}

/** The offers whose "who" is a guest list: the list page's "where it is used". */
export async function offersUsingList(ctx: Ctx, segmentId: string): Promise<OfferView[]> {
  requireStaff(ctx, { minRole: 'read_only' });
  if (!z.string().uuid().safeParse(segmentId).success) return [];
  // Offers off everywhere: nothing uses anything.
  const on = await ctx.db.selectFrom('venue_modules').select('venue_id').where('module_key', '=', offersModule.key).where('enabled', '=', true).limit(1).executeTakeFirst();
  if (!on) return [];
  return listOffers(ctx, { includeInactive: true, segmentId });
}

export async function getOffer(ctx: Ctx, offerId: string): Promise<OfferView> {
  const id = z.string().uuid().parse(offerId);
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  const o = await loadOffer(ctx, id);
  if (!o) throw notFound('Offer not found');
  return viewOf(ctx, o);
}

/** What the public may see of an offer: what it gives and who sent it, nothing about who holds it. */
export interface PublicOfferView {
  id: string;
  kind: OfferKind;
  name: string;
  description: string | null;
  /** Plain words, e.g. "$10 off when you spend $40 or more". */
  summary: string;
  minSpendCents: number;
  validityDays: number;
  channels: OrderChannel[];
  campaignId: string | null;
  creatorId: string | null;
  /** True for a welcome or creator offer: anyone may ask for a code on the sign-up page. */
  signupOpen: boolean;
}

/**
 * An active offer as the venue's own site shows it, on the sign-up and claim pages. Public: no
 * role check. A switched-off offer, an unknown id and another org's offer are all not found.
 */
export async function getPublicOffer(ctx: Ctx, offerId: string): Promise<PublicOfferView> {
  const parsed = z.string().uuid().safeParse(offerId);
  if (!parsed.success) throw notFound('Offer not found');
  await assertOffersOn(ctx);
  const o = await loadOffer(ctx, parsed.data);
  if (!o || offerStatus(o, ctx.now()) !== 'active') throw notFound('Offer not found');
  const x = await summaryExtras(ctx, [o]);
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    description: o.description,
    summary: offerSummary(o, await orgCurrency(ctx), extrasFor(o, x)),
    minSpendCents: o.min_spend_cents,
    validityDays: o.validity_days,
    channels: o.channels,
    campaignId: o.campaign_id,
    creatorId: o.creator_id,
    signupOpen: o.method === 'code' && (o.kind === 'welcome' || o.kind === 'creator'),
  };
}

/** The org's currency, for amounts shown in plain words. */
export async function orgCurrency(ctx: Ctx): Promise<string> {
  const r = await ctx.db.selectFrom('orgs').select('currency').where('id', '=', ctx.orgId).executeTakeFirst();
  return r?.currency ?? 'AUD';
}
