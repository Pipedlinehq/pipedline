import { z } from 'zod';
import { type Ctx, defineTool, invalid, notFound, requireStaff } from '@ros/core';
import { listSegments } from '../campaigns/segments';
import { type OfferInput, type OfferView, assertOffersOn, getOffer, listOffers, offerInput, offerSummary, saveOffer, switchOffer } from './definitions';
import { type SurchargeInput, CARD_SURCHARGE_REFUSAL, getSurcharge, isCardSurchargeName, listSurcharges, percentWords, saveSurcharge, surchargeInput, whenWords } from './surcharges';

/**
 * Assistant tools for offers and surcharges (docs/CONSOLE_IA.md section 9, pattern 6). Every
 * write is propose then commit, pinned to the console's own service functions; the question the
 * person answers is the offer's server-written summary, so what they say yes to is what applies.
 */

async function findOffer(ctx: Ctx, ref: string): Promise<OfferView> {
  if (z.string().uuid().safeParse(ref).success) return getOffer(ctx, ref);
  const all = await listOffers(ctx, { includeInactive: true });
  const hit = all.find((o) => o.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw notFound(`There is no offer called "${ref}". Offers: ${all.map((o) => o.name).join(', ')}.`);
  return hit;
}

async function findList(ctx: Ctx, ref: string): Promise<{ id: string; name: string }> {
  const all = await listSegments(ctx);
  const hit = z.string().uuid().safeParse(ref).success ? all.find((s) => s.id === ref) : all.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw notFound(`There is no guest list called "${ref}". Lists: ${all.map((s) => s.name).join(', ')}.`);
  return { id: hit.id, name: hit.name };
}

const offerOut = z.object({
  offer_id: z.string(),
  name: z.string(),
  status: z.enum(['active', 'scheduled', 'expired', 'off']),
  method: z.enum(['code', 'automatic']),
  summary: z.string(),
});
const shapeOffer = (o: OfferView) => ({ offer_id: o.id, name: o.name, status: o.status, method: o.method, summary: o.summary });

export const offerSetTool = defineTool({
  name: 'offer_set',
  module: 'offers',
  title: 'Create or change an offer',
  description:
    'Create an offer, or change one by id. Method: "code" (each guest holds a single-use code) or "automatic" (applied by itself at checkout and matched from the till). It can come off one dish, a menu category, the whole bill or the delivery fee; be for everyone, a guest list, new guests or loyalty members; run between dates, on certain days, in certain services (lunch, dinner) or a daily window; and be limited per guest and in total. The question you are asked repeats the offer in plain words, as guests will see it.',
  effect: 'write',
  scope: 'offers:write',
  minRole: 'manager',
  input: z.object({
    offer_id: z.string().uuid().optional().describe('To change an existing offer: its id'),
    name: z.string().trim().min(1).max(120).describe('What guests see, e.g. "Tuesday pasta night"'),
    method: z.enum(['code', 'automatic']).default('automatic'),
    kind: z.enum(['welcome', 'comeback', 'voucher', 'birthday', 'manual']).default('manual').describe('For code offers: what kind of code it is. "manual" for a special'),
    gives: z.enum(['dollars_off', 'percent_off']).describe('Dollars off or a percentage off'),
    amount: z.number().positive().max(100_000).describe('Dollars (e.g. 10 for $10 off) or percent (e.g. 15 for 15% off)'),
    applies_to: z.enum(['bill', 'category', 'item', 'delivery']).default('bill'),
    category: z.string().trim().min(1).max(80).optional().describe('The menu category, as the menu names it, for applies_to "category"'),
    menu_item_id: z.string().uuid().optional().describe('The dish, for applies_to "item"'),
    min_spend: z.number().min(0).max(100_000).optional().describe('Dollars the guest must spend first. Leave out for none'),
    who: z.enum(['everyone', 'list', 'new_guests', 'loyalty_members']).default('everyone'),
    list: z.string().trim().min(1).max(80).optional().describe('The guest list by name or id, for who "list"'),
    starts: z.string().datetime().optional().describe('When it starts (ISO 8601). Leave out for now'),
    ends: z.string().datetime().optional().describe('When it ends (ISO 8601). Leave out for no end'),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('Days of the week, 0 = Sunday … 6 = Saturday. Leave out for every day'),
    services: z.array(z.string().trim().min(1).max(40)).max(10).optional().describe('Services by the names the venue\'s hours use, e.g. ["dinner"]'),
    time_from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().describe('A daily window start, 24-hour venue time, e.g. "16:00"'),
    time_to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    per_guest_limit: z.number().int().min(1).max(1000).optional().describe('Times one guest may use it. Leave out for no limit'),
    total_limit: z.number().int().min(1).max(1_000_000).optional().describe('Times it may be used in total. Leave out for no limit'),
    combines_with: z.array(z.enum(['item', 'bill', 'delivery'])).max(3).default([]).describe('Other offer classes this may be used together with. Empty: not with other offers'),
    channels: z.array(z.enum(['pickup', 'delivery', 'dine-in-qr'])).min(1).optional().describe('Online order types it works on. Leave out for all; codes always work at the till'),
    switched_on: z.boolean().default(true),
  }),
  output: offerOut,
  async propose({ ctx }, input) {
    requireStaff(ctx, { minRole: 'manager' });
    await assertOffersOn(ctx);
    const before = input.offer_id ? await getOffer(ctx, input.offer_id) : null;
    const list = input.who === 'list' ? await findList(ctx, input.list ?? '') : null;
    if (input.who === 'list' && !input.list) throw invalid('Say which guest list the offer is for.');
    const args: OfferInput = {
      id: input.offer_id,
      kind: before?.kind ?? input.kind,
      name: input.name,
      description: before?.description ?? null,
      discountKind: input.gives === 'dollars_off' ? 'fixed' : 'percent',
      valueCents: input.gives === 'dollars_off' ? Math.round(input.amount * 100) : null,
      percentOff: input.gives === 'percent_off' ? Math.round(input.amount) : null,
      menuItemId: input.menu_item_id ?? null,
      minSpendCents: Math.round((input.min_spend ?? 0) * 100),
      validityDays: before?.validityDays ?? 30,
      requiresClaim: before?.requiresClaim ?? false,
      channels: input.channels ?? before?.channels ?? undefined,
      validVenueIds: before?.validVenueIds ?? null,
      maxCodes: before?.maxCodes ?? null,
      codePrefix: before?.codePrefix ?? undefined,
      campaignId: before?.campaignId ?? null,
      creatorId: before?.creatorId ?? null,
      isActive: input.switched_on,
      method: input.method,
      appliesTo: input.applies_to,
      category: input.category ?? null,
      audience: input.who,
      segmentId: list?.id ?? null,
      startsAt: input.starts ? new Date(input.starts) : null,
      endsAt: input.ends ? new Date(input.ends) : null,
      days: input.days ?? null,
      services: input.services ?? null,
      timeFrom: input.time_from ?? null,
      timeTo: input.time_to ?? null,
      combineItem: input.combines_with.includes('item'),
      combineBill: input.combines_with.includes('bill'),
      combineDelivery: input.combines_with.includes('delivery'),
      perGuestLimit: input.per_guest_limit ?? null,
      totalLimit: input.total_limit ?? null,
    };
    // Validate now, so a bad offer is refused before anyone is asked about it.
    const parsed = offerInput.safeParse(args);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That offer is not valid.');
    // The summary the person agrees to is written by the same code that will write the saved one.
    const preview = offerSummary(
      {
        discount_kind: parsed.data.discountKind,
        value_cents: parsed.data.valueCents,
        percent_off: parsed.data.percentOff,
        min_spend_cents: parsed.data.minSpendCents,
        method: parsed.data.method,
        applies_to: parsed.data.appliesTo,
        category: parsed.data.category,
        audience: parsed.data.audience,
        starts_at: parsed.data.startsAt,
        ends_at: parsed.data.endsAt,
        days: parsed.data.days,
        services: parsed.data.services,
        time_from: parsed.data.timeFrom ? `${parsed.data.timeFrom}:00` : null,
        time_to: parsed.data.timeTo ? `${parsed.data.timeTo}:00` : null,
        combine_item: parsed.data.combineItem,
        combine_bill: parsed.data.combineBill,
        combine_delivery: parsed.data.combineDelivery,
        per_guest_limit: parsed.data.perGuestLimit,
        total_limit: parsed.data.totalLimit,
      },
      'AUD',
      { segmentName: list?.name ?? null },
    );
    const how = input.method === 'automatic' ? 'applied automatically at checkout and matched from the till' : 'used by code';
    return {
      question: before
        ? `Change the offer "${before.name}" to "${input.name}": ${preview}, ${how}${input.switched_on ? '' : ', switched off'}?`
        : `Create the offer "${input.name}": ${preview}, ${how}${input.switched_on ? ', switched on now' : ', switched off until you turn it on'}?`,
      commit: async () => shapeOffer(await saveOffer(ctx, args)),
    };
  },
});

export const offerSwitchTool = defineTool({
  name: 'offer_switch',
  module: 'offers',
  title: 'Switch an offer on or off',
  description: 'Switch an offer on or off by name or id. Off stops it applying and stops new codes; codes guests already hold stay good until they expire.',
  effect: 'write',
  scope: 'offers:write',
  minRole: 'manager',
  input: z.object({ offer: z.string().trim().min(1).max(120).describe('The offer by name or id'), on: z.boolean() }),
  output: offerOut,
  async propose({ ctx }, input) {
    requireStaff(ctx, { minRole: 'manager' });
    const o = await findOffer(ctx, input.offer);
    if (o.isActive === input.on) throw invalid(`"${o.name}" is already switched ${input.on ? 'on' : 'off'}.`);
    return {
      question: input.on ? `Switch on the offer "${o.name}" (${o.summary})? It applies from now.` : `Switch off the offer "${o.name}"? It stops applying and no new codes are issued; codes guests already hold stay good.`,
      commit: async () => shapeOffer(await switchOffer(ctx, o.id, input.on)),
    };
  },
});

const surchargeOut = z.object({ surcharge_id: z.string(), name: z.string(), percent: z.string(), when: z.string(), notice: z.string(), switched_on: z.boolean() });

export const surchargeSetTool = defineTool({
  name: 'surcharge_set',
  module: 'offers',
  title: 'Set a surcharge',
  description:
    'Create or change a public holiday, Sunday or named-days surcharge: a percentage added to the bill after discounts, shown on menus and dockets with the line "A surcharge of X% applies on …". A surcharge for paying by card is refused: from 1 October 2026 a business may not add one for eftpos, Mastercard or Visa (Reserve Bank of Australia).',
  effect: 'write',
  scope: 'offers:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    surcharge_id: z.string().uuid().optional().describe('To change an existing surcharge: its id'),
    name: z.string().trim().min(1).max(80).describe('e.g. "Public holiday surcharge"'),
    kind: z.enum(['public_holiday', 'sunday', 'days']),
    percent: z.number().min(0.01).max(100).describe('e.g. 10 for 10%, 15 for 15%'),
    days: z.array(z.number().int().min(0).max(6)).max(7).optional().describe('For kind "days": 0 = Sunday … 6 = Saturday'),
    dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).optional().describe('For public holidays: this state\'s own holiday dates, YYYY-MM-DD. National days are built in'),
    every_venue: z.boolean().default(false).describe('Apply at every venue of the organisation rather than this one'),
    switched_on: z.boolean().default(true),
  }),
  output: surchargeOut,
  async propose({ ctx, venueId }, input) {
    requireStaff(ctx, { minRole: 'manager' });
    if (isCardSurchargeName(input.name)) throw invalid(CARD_SURCHARGE_REFUSAL);
    if (!input.every_venue && !venueId) throw invalid('Say which venue the surcharge is for.');
    const before = input.surcharge_id ? await getSurcharge(ctx, input.surcharge_id) : null;
    const args: SurchargeInput = {
      id: input.surcharge_id,
      venueId: input.every_venue ? null : venueId,
      name: input.name,
      kind: input.kind,
      percent: input.percent,
      days: input.days ?? null,
      dates: input.dates ?? before?.dates ?? [],
      isActive: input.switched_on,
    };
    const parsed = surchargeInput.safeParse(args);
    if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That surcharge is not valid.');
    const when = whenWords(input.kind, input.days ?? null);
    return {
      question: `${before ? `Change the surcharge "${before.name}" to` : 'Set up'} "${input.name}": ${percentWords(Math.round(input.percent * 100))} on the bill after discounts ${when}, ${input.every_venue ? 'at every venue' : 'at this venue'}? Menus and dockets will carry the line "A surcharge of ${percentWords(Math.round(input.percent * 100))} applies ${when}."`,
      commit: async () => {
        const s = await saveSurcharge(ctx, args);
        return { surcharge_id: s.id, name: s.name, percent: percentWords(s.percentBp), when: whenWords(s.kind, s.days), notice: s.notice, switched_on: s.isActive };
      },
    };
  },
});

export const surchargesListTool = defineTool({
  name: 'surcharges_list',
  module: 'offers',
  title: 'List surcharges',
  description: 'The surcharges set up at this venue (its own and organisation-wide), with the line each puts on menus and dockets.',
  effect: 'read',
  scope: 'offers:read',
  venueScoped: true,
  input: z.object({}),
  output: z.object({ surcharges: z.array(surchargeOut), note: z.string() }),
  async run({ ctx, venueId }) {
    const rows = await listSurcharges(ctx, { venueId: venueId ?? undefined, includeInactive: true });
    return {
      surcharges: rows.map((s) => ({ surcharge_id: s.id, name: s.name, percent: percentWords(s.percentBp), when: whenWords(s.kind, s.days), notice: s.notice, switched_on: s.isActive })),
      note: 'Card-payment surcharges are not available: banned for eftpos, Mastercard and Visa from 1 October 2026.',
    };
  },
});
