import { z } from 'zod';
import { type Ctx, AppError, audit, formatMoney, getModule, invalid, notFound, percentOf, requireStaff } from '@ros/core';
import { type OffersConfig, offersModule } from './module';

/** Offer definitions: what an offer gives, to whom, where and for how long. Org-wide; a manager or owner sets them up. */

export type OfferKind = 'welcome' | 'comeback' | 'voucher' | 'birthday' | 'creator' | 'manual';
export type OrderChannel = 'pickup' | 'delivery' | 'dine-in-qr';

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
  /** The online order types the code works on. It always works at the till. */
  channels: OrderChannel[];
  validVenueIds: string[] | null;
  maxCodes: number | null;
  codePrefix: string;
  campaignId: string | null;
  creatorId: string | null;
  isActive: boolean;
  /** Plain words, e.g. "$10 off when you spend $40 or more". */
  summary: string;
}

/** What the offer gives, in plain words. */
export function offerSummary(o: Pick<OfferRow, 'discount_kind' | 'value_cents' | 'percent_off' | 'min_spend_cents'>, currency = 'AUD'): string {
  const money = (cents: number) => formatMoney(cents, currency).replace(/\.00$/, '');
  const what = o.discount_kind === 'fixed' ? `${money(o.value_cents ?? 0)} off` : o.discount_kind === 'percent' ? `${o.percent_off ?? 0}% off` : 'A free item';
  return o.min_spend_cents > 0 ? `${what} when you spend ${money(o.min_spend_cents)} or more` : what;
}

/** What the offer takes off a sale of this size. For a free item the caller supplies the item's price. */
export function offerDiscountCents(o: Pick<OfferRow, 'discount_kind' | 'value_cents' | 'percent_off'>, subtotalCents: number, freeItemPriceCents?: number | null): number {
  let off = 0;
  if (o.discount_kind === 'fixed') off = o.value_cents ?? 0;
  else if (o.discount_kind === 'percent') off = percentOf(subtotalCents, o.percent_off ?? 0);
  else off = freeItemPriceCents ?? o.value_cents ?? 0;
  return Math.max(0, Math.min(off, subtotalCents));
}

export const offerView = (o: OfferRow, currency?: string): OfferView => ({
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
  summary: offerSummary(o, currency),
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

/**
 * The driver hands back an array of a custom enum as its Postgres text form ("{pickup,delivery}"),
 * not as an array. Every offer row read from the database passes through here.
 */
export function toOfferRow(raw: Omit<OfferRow, 'channels'> & { channels: unknown }): OfferRow {
  const c = raw.channels;
  const channels = Array.isArray(c)
    ? (c as OrderChannel[])
    : typeof c === 'string'
      ? (c.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean) as OrderChannel[])
      : [];
  return { ...raw, channels };
}

export async function loadOffer(ctx: Ctx, offerId: string): Promise<OfferRow | null> {
  const r = await ctx.db.selectFrom('offers').select(OFFER_COLS).where('id', '=', offerId).executeTakeFirst();
  return r ? toOfferRow(r) : null;
}

const CHANNELS = ['pickup', 'delivery', 'dine-in-qr'] as const;

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
  })
  .superRefine((v, c) => {
    if (v.discountKind === 'fixed' && !v.valueCents) c.addIssue({ code: 'custom', message: 'Say how much this offer takes off.', path: ['valueCents'] });
    if (v.discountKind === 'percent' && !v.percentOff) c.addIssue({ code: 'custom', message: 'Say what percentage this offer takes off.', path: ['percentOff'] });
    if (v.discountKind === 'free_item' && !v.menuItemId && !v.valueCents) c.addIssue({ code: 'custom', message: 'Choose the free item, or say what it is worth.', path: ['menuItemId'] });
    if (v.kind === 'creator' && !v.creatorId) c.addIssue({ code: 'custom', message: 'A creator offer needs the creator it belongs to.', path: ['creatorId'] });
  });

/** Create an offer, or change one. Switching an offer off stops new codes; codes already with guests stay good until they expire. */
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

  const values = {
    kind: input.kind,
    name: input.name,
    description: input.description,
    discount_kind: input.discountKind,
    value_cents: input.valueCents,
    percent_off: input.discountKind === 'percent' ? input.percentOff : null,
    menu_item_id: input.discountKind === 'free_item' ? input.menuItemId : null,
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
  return offerView(after, await orgCurrency(ctx));
}

/** Every offer, for the console. */
export async function listOffers(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Promise<OfferView[]> {
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  let q = ctx.db.selectFrom('offers').select(OFFER_COLS).orderBy('created_at', 'desc');
  if (!opts.includeInactive) q = q.where('is_active', '=', true);
  const currency = await orgCurrency(ctx);
  return (await q.execute()).map((o) => offerView(toOfferRow(o), currency));
}

export async function getOffer(ctx: Ctx, offerId: string): Promise<OfferView> {
  const id = z.string().uuid().parse(offerId);
  requireStaff(ctx, { minRole: 'read_only' });
  await assertOffersOn(ctx);
  const o = await loadOffer(ctx, id);
  if (!o) throw notFound('Offer not found');
  return offerView(o, await orgCurrency(ctx));
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
  if (!o || !o.is_active) throw notFound('Offer not found');
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    description: o.description,
    summary: offerSummary(o, await orgCurrency(ctx)),
    minSpendCents: o.min_spend_cents,
    validityDays: o.validity_days,
    channels: o.channels,
    campaignId: o.campaign_id,
    creatorId: o.creator_id,
    signupOpen: o.kind === 'welcome' || o.kind === 'creator',
  };
}

/** The org's currency, for amounts shown in plain words. */
export async function orgCurrency(ctx: Ctx): Promise<string> {
  const r = await ctx.db.selectFrom('orgs').select('currency').where('id', '=', ctx.orgId).executeTakeFirst();
  return r?.currency ?? 'AUD';
}
