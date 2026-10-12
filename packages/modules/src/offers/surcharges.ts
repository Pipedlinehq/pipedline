import { z } from 'zod';
import { type Ctx, audit, formatMoney, invalid, localParts, notFound, requireStaff } from '@ros/core';
import { getVenue } from '../tenancy/venues';

/**
 * Surcharges as their own object (docs/CONSOLE_IA.md section 9, pattern 6; COMMERCE_ADMIN_PATTERNS
 * 2.6.4): a public-holiday, Sunday or named-days percentage on the bill after discounts, shown
 * on menus and dockets with the line the law asks for. They are not negative discounts: they
 * apply after offers and have their own display rule.
 *
 * There is no card-payment surcharge here, on purpose. From 1 October 2026 a business may not
 * add a surcharge for paying by eftpos, Mastercard or Visa (Reserve Bank of Australia, Review of
 * Retail Payments Regulation, conclusions paper, March 2026). `saveSurcharge` refuses one and
 * says why. Service and booking fees are outside that rule and outside this module.
 *
 * Ordering applies surcharges to totals by calling `applicableSurcharges(ctx, venueId, at)`
 * after discounts and before tax; this module does not reach into ordering (see CLAUDE.md).
 */

export const CARD_SURCHARGE_BAN_DATE = '2026-10-01';
export const CARD_SURCHARGE_BAN_SOURCE = 'https://www.rba.gov.au/payments-and-infrastructure/review-of-retail-payments-regulation/2026-03/conclusions-paper/faqs/';
export const CARD_SURCHARGE_REFUSAL =
  'Pipedline will not set up a surcharge for paying by card. From 1 October 2026 a business in Australia may not add a surcharge for paying by eftpos, Mastercard or Visa (Reserve Bank of Australia, Review of Retail Payments Regulation, conclusions paper, March 2026). ' +
  'Put the cost of taking cards into your menu prices instead. Public holiday, Sunday and other day-based surcharges are still allowed, and this is where they live.';

/** Words in a surcharge's name that mean a payment-method surcharge, which is refused. */
const CARD_WORDS = /\b(card|cards|eftpos|visa|mastercard|master card|amex|american express|credit|debit|payment|paywave|tap|tap and go|contactless|surcharge for paying|merchant fee|processing fee|transaction fee)\b/i;

export const isCardSurchargeName = (name: string): boolean => CARD_WORDS.test(name);

export type SurchargeKind = 'public_holiday' | 'sunday' | 'days';

export interface SurchargeView {
  id: string;
  /** Null: every venue of the organisation. */
  venueId: string | null;
  name: string;
  kind: SurchargeKind;
  /** 1000 = 10%. */
  percentBp: number;
  /** For kind 'days'. */
  days: number[] | null;
  /** The venue's own public-holiday dates, YYYY-MM-DD. */
  dates: string[];
  isActive: boolean;
  /** The line a menu and a docket carry, as the law asks: "A surcharge of 10% applies on Sundays." */
  notice: string;
  updatedAt: Date;
}

const COLS = ['id', 'venue_id', 'name', 'kind', 'percent_bp', 'days', 'dates', 'is_active', 'updated_at'] as const;
type Row = { id: string; venue_id: string | null; name: string; kind: SurchargeKind; percent_bp: number; days: unknown; dates: unknown; is_active: boolean; updated_at: Date };

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pgArray(v: unknown): string[] {
  if (v == null) return [];
  // The driver parses a date[] to local-midnight Dates: read the calendar day back, not the UTC instant.
  if (Array.isArray(v)) return v.map((x) => (x instanceof Date ? `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` : String(x)));
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').map((s) => s.replace(/^"|"$/g, '')).filter(Boolean);
  return [];
}

/** "10%" or "12.5%". */
export const percentWords = (bp: number): string => `${(bp / 100).toString().replace(/\.0+$/, '')}%`;

/** "on Sundays", "on public holidays", "on Fridays and Saturdays". */
export function whenWords(kind: SurchargeKind, days: number[] | null): string {
  if (kind === 'sunday') return 'on Sundays';
  if (kind === 'public_holiday') return 'on public holidays';
  const names = (days ?? []).slice().sort().map((d) => `${DAY_NAMES[d]}s`);
  if (!names.length) return 'on the days listed';
  return `on ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`;
}

/** The legal line: "A surcharge of X% applies on …". */
export const surchargeNoticeLine = (percentBp: number, kind: SurchargeKind, days: number[] | null): string => `A surcharge of ${percentWords(percentBp)} applies ${whenWords(kind, days)}.`;

const view = (r: Row): SurchargeView => {
  const days = r.days == null ? null : pgArray(r.days).map(Number);
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    kind: r.kind,
    percentBp: r.percent_bp,
    days,
    dates: pgArray(r.dates),
    isActive: r.is_active,
    notice: surchargeNoticeLine(r.percent_bp, r.kind, days),
    updatedAt: r.updated_at,
  };
};

// ── Public holidays ───────────────────────────────────────────────────────────

/**
 * The national public holidays, by year. State and territory days (King's Birthday, Labour Day,
 * the Melbourne Cup, picnic days) differ by state: a venue adds its own dates on the surcharge.
 * Easter moves; the dates here are the gazetted ones for each year listed.
 */
export const AU_NATIONAL_PUBLIC_HOLIDAYS: Record<string, Array<{ date: string; name: string }>> = {
  2026: [
    { date: '2026-01-01', name: "New Year's Day" },
    { date: '2026-01-26', name: 'Australia Day' },
    { date: '2026-04-03', name: 'Good Friday' },
    { date: '2026-04-04', name: 'Easter Saturday' },
    { date: '2026-04-05', name: 'Easter Sunday' },
    { date: '2026-04-06', name: 'Easter Monday' },
    { date: '2026-04-25', name: 'Anzac Day' },
    { date: '2026-12-25', name: 'Christmas Day' },
    { date: '2026-12-26', name: 'Boxing Day' },
    { date: '2026-12-28', name: 'Boxing Day holiday' },
  ],
  2027: [
    { date: '2027-01-01', name: "New Year's Day" },
    { date: '2027-01-26', name: 'Australia Day' },
    { date: '2027-03-26', name: 'Good Friday' },
    { date: '2027-03-27', name: 'Easter Saturday' },
    { date: '2027-03-28', name: 'Easter Sunday' },
    { date: '2027-03-29', name: 'Easter Monday' },
    { date: '2027-04-25', name: 'Anzac Day' },
    { date: '2027-04-26', name: 'Anzac Day holiday' },
    { date: '2027-12-25', name: 'Christmas Day' },
    { date: '2027-12-26', name: 'Boxing Day' },
    { date: '2027-12-27', name: 'Christmas Day holiday' },
    { date: '2027-12-28', name: 'Boxing Day holiday' },
  ],
  2028: [
    { date: '2028-01-01', name: "New Year's Day" },
    { date: '2028-01-03', name: "New Year's Day holiday" },
    { date: '2028-01-26', name: 'Australia Day' },
    { date: '2028-04-14', name: 'Good Friday' },
    { date: '2028-04-15', name: 'Easter Saturday' },
    { date: '2028-04-16', name: 'Easter Sunday' },
    { date: '2028-04-17', name: 'Easter Monday' },
    { date: '2028-04-25', name: 'Anzac Day' },
    { date: '2028-12-25', name: 'Christmas Day' },
    { date: '2028-12-26', name: 'Boxing Day' },
  ],
};

/** The holiday's name when the venue-local date is a public holiday (national, or one the venue listed); else null. */
export function publicHolidayName(date: string, venueDates: string[] = []): string | null {
  const national = AU_NATIONAL_PUBLIC_HOLIDAYS[date.slice(0, 4)]?.find((h) => h.date === date);
  if (national) return national.name;
  return venueDates.includes(date) ? 'Public holiday' : null;
}

// ── Setting them up ───────────────────────────────────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use dates like 2026-10-05.');

export const surchargeInput = z
  .object({
    id: z.string().uuid().optional(),
    /** Null: every venue of the organisation. */
    venueId: z.string().uuid().nullable().default(null),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['public_holiday', 'sunday', 'days']),
    /** As a person writes it: 10 for 10%, 12.5 for 12.5%. */
    percent: z.number().min(0.01).max(100),
    /** For kind 'days': 0 = Sunday … 6 = Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7).nullable().default(null),
    /** The venue's own public-holiday dates (state days), for kind 'public_holiday'. */
    dates: z.array(DATE).max(60).default([]),
    isActive: z.boolean().default(true),
  })
  .superRefine((v, c) => {
    if (isCardSurchargeName(v.name)) c.addIssue({ code: 'custom', message: CARD_SURCHARGE_REFUSAL, path: ['name'] });
    if (v.kind === 'days' && !v.days?.length) c.addIssue({ code: 'custom', message: 'Say which days the surcharge applies on.', path: ['days'] });
  });
export type SurchargeInput = z.input<typeof surchargeInput>;

async function loadSurcharge(ctx: Ctx, id: string): Promise<Row | null> {
  const r = await ctx.db.selectFrom('surcharges').select(COLS).where('id', '=', id).executeTakeFirst();
  return (r as Row | undefined) ?? null;
}

/**
 * Create or change a surcharge. A manager. A surcharge named for a payment method is refused
 * with the reason and the date of the ban. Audited.
 */
export async function saveSurcharge(ctx: Ctx, raw: SurchargeInput): Promise<SurchargeView> {
  const parsed = surchargeInput.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That surcharge is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;
  requireStaff(ctx, { ...(input.venueId ? { venueId: input.venueId } : {}), minRole: 'manager' });
  if (input.venueId) await getVenue(ctx, input.venueId);
  const values = {
    venue_id: input.venueId,
    name: input.name,
    kind: input.kind,
    percent_bp: Math.round(input.percent * 100),
    days: input.kind === 'days' ? [...new Set(input.days ?? [])].sort() : null,
    dates: input.kind === 'public_holiday' ? [...new Set(input.dates)].sort() : [],
    is_active: input.isActive,
    updated_at: ctx.now(),
  };
  let id = input.id;
  let before: SurchargeView | null = null;
  if (id) {
    const b = await loadSurcharge(ctx, id);
    if (!b) throw notFound('Surcharge not found');
    before = view(b);
    await ctx.db.updateTable('surcharges').set(values).where('id', '=', id).execute();
  } else {
    id = (await ctx.db.insertInto('surcharges').values({ org_id: ctx.orgId, ...values, created_at: ctx.now() }).returning('id').executeTakeFirstOrThrow()).id;
  }
  const after = view((await loadSurcharge(ctx, id))!);
  await audit(ctx, { action: 'surcharge.set', entityType: 'surcharge', entityId: id, venueId: input.venueId ?? undefined, before: before ?? undefined, after });
  return after;
}

/** The org's surcharges, for the console. `venueId` keeps those that apply at one venue (its own and org-wide). */
export async function listSurcharges(ctx: Ctx, opts: { venueId?: string; includeInactive?: boolean } = {}): Promise<SurchargeView[]> {
  requireStaff(ctx, { ...(opts.venueId ? { venueId: opts.venueId } : {}), minRole: 'read_only' });
  let q = ctx.db.selectFrom('surcharges').select(COLS).orderBy('created_at');
  if (opts.venueId) q = q.where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', opts.venueId!)]));
  if (!opts.includeInactive) q = q.where('is_active', '=', true);
  return (await q.execute()).map((r) => view(r as Row));
}

export async function getSurcharge(ctx: Ctx, id: string): Promise<SurchargeView> {
  requireStaff(ctx, { minRole: 'read_only' });
  if (!z.string().uuid().safeParse(id).success) throw notFound('Surcharge not found');
  const r = await loadSurcharge(ctx, id);
  if (!r) throw notFound('Surcharge not found');
  return view(r);
}

export async function deleteSurcharge(ctx: Ctx, id: string): Promise<void> {
  requireStaff(ctx, { minRole: 'manager' });
  if (!z.string().uuid().safeParse(id).success) throw notFound('Surcharge not found');
  const r = await loadSurcharge(ctx, id);
  if (!r) throw notFound('Surcharge not found');
  await ctx.db.deleteFrom('surcharges').where('id', '=', id).execute();
  await audit(ctx, { action: 'surcharge.deleted', entityType: 'surcharge', entityId: id, venueId: r.venue_id ?? undefined, before: view(r) });
}

// ── Applying them ─────────────────────────────────────────────────────────────

export interface ApplicableSurcharge {
  id: string;
  name: string;
  percentBp: number;
  /** Why it applies today: "Sunday", "Christmas Day", "Saturday". */
  reason: string;
  /** The legal line for the docket and the menu. */
  notice: string;
}

/**
 * The surcharges in force at a venue at an instant, in the venue's own day. Ordering adds each
 * to the bill after discounts (`surchargeAmountCents`) and prints `notice` on the docket.
 */
export async function applicableSurcharges(ctx: Ctx, venueId: string, at: Date): Promise<ApplicableSurcharge[]> {
  const venue = await getVenue(ctx, venueId);
  const local = localParts(at, venue.timezone);
  const rows = await ctx.db
    .selectFrom('surcharges')
    .select(COLS)
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', venueId)]))
    .orderBy('created_at')
    .execute();
  const out: ApplicableSurcharge[] = [];
  for (const raw of rows) {
    const s = view(raw as Row);
    let reason: string | null = null;
    if (s.kind === 'public_holiday') reason = publicHolidayName(local.date, s.dates);
    else if (s.kind === 'sunday') reason = local.weekday === 0 ? 'Sunday' : null;
    else if (s.days?.includes(local.weekday)) reason = DAY_NAMES[local.weekday]!;
    if (reason) out.push({ id: s.id, name: s.name, percentBp: s.percentBp, reason, notice: s.notice });
  }
  return out;
}

/** What a surcharge adds to a bill of this size (after discounts), in whole cents. */
export const surchargeAmountCents = (baseCents: number, percentBp: number): number => Math.max(0, Math.round((baseCents * percentBp) / 10_000));

export interface DocketLine {
  label: string;
  amountCents: number;
}

/** The lines a docket prints for the surcharges in force: one per surcharge, then the notice each carries. */
export function surchargeDocketLines(surcharges: ApplicableSurcharge[], baseCents: number, currency = 'AUD'): { lines: DocketLine[]; notices: string[]; totalCents: number } {
  const lines = surcharges.map((s) => ({ label: `${s.name} (${percentWords(s.percentBp)}, ${s.reason})`, amountCents: surchargeAmountCents(baseCents, s.percentBp) }));
  return { lines, notices: [...new Set(surcharges.map((s) => s.notice))], totalCents: lines.reduce((t, l) => t + l.amountCents, 0) };
}

/** The docket lines as text, for a printed docket: "Sunday surcharge (10%, Sunday)   $5.90". */
export function surchargeDocketText(surcharges: ApplicableSurcharge[], baseCents: number, currency = 'AUD'): string[] {
  const d = surchargeDocketLines(surcharges, baseCents, currency);
  return [...d.lines.map((l) => `${l.label}  ${formatMoney(l.amountCents, currency)}`), ...d.notices];
}

/**
 * The notice a menu shows, for every active surcharge at the venue: "A surcharge of 10% applies
 * on Sundays. A surcharge of 15% applies on public holidays." Null when there are none.
 */
export async function surchargeNotice(ctx: Ctx, venueId: string): Promise<string | null> {
  const rows = await ctx.db
    .selectFrom('surcharges')
    .select(COLS)
    .where('is_active', '=', true)
    .where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', venueId)]))
    .orderBy('created_at')
    .execute();
  if (!rows.length) return null;
  return [...new Set(rows.map((r) => view(r as Row).notice))].join(' ');
}
