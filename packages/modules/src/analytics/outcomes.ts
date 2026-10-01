import { z } from 'zod';
import { sql } from 'kysely';
import { type Ctx, addDays, invalid, notFound } from '@ros/core';
import { criotaSharing, isCriotaPlug } from '../hub/plugs';
import { inList, runGrouped } from './engine';
import { CAMPAIGN_AGGS, campaignCtes } from './families/campaigns';
import { periodInput, resolvePeriod } from './period';
import { resolveScope } from './scope';
import { getAnalyticsSettings } from './settings';

/**
 * Campaign and creator outcomes: the only shape in which results leave toward a creator, an
 * advertiser or a plug (docs/modules/hub.md section 7). The rules are enforced here, in one
 * place, and nothing below them can be asked for:
 *
 *   totals only          never a guest, an order, or anything that could be one
 *   a minimum cohort     fewer guests than the floor and there is no number at all
 *   a quiet period       nothing for the first days after a campaign's first activity
 *   a band, not a number for spend
 *   "aligned with"       never "drove" or "caused"
 *   unmeasured ≠ low     a withheld result is reported as withheld, with the reason
 */
export const campaignOutcomesInput = z
  .object({
    /** One venue. Omitted: every venue the caller can see, as one total. */
    venueId: z.string().uuid().optional(),
    campaignId: z.string().min(1).max(100).optional(),
    creatorId: z.string().min(1).max(100).optional(),
    /** Default: everything since the campaign's first activity. */
    period: periodInput.optional(),
  })
  .strict();
export type CampaignOutcomesInput = z.input<typeof campaignOutcomesInput>;

export interface RevenueBand {
  label: string;
  low_cents: number;
  /** Null for the open-ended top band. */
  high_cents: number | null;
}

export interface CampaignOutcome {
  campaign_id: string | null;
  creator_id: string | null;
  status: 'measured' | 'too_early' | 'not_enough_guests';
  status_note: string;
  first_activity_on: string | null;
  sessions: number | null;
  new_customers: number | null;
  orders: number | null;
  revenue_band: RevenueBand | null;
  repeat_rate: number | null;
  summary: string;
}

export interface CampaignOutcomes {
  venue: string | null;
  venues_covered: number;
  period: { from: string; to: string } | { from: null; to: string };
  min_cohort: number;
  quiet_days: number;
  currency: string;
  outcomes: CampaignOutcome[];
  wording: string;
  caveats: string[];
  as_of: string;
}

const BAND_EDGES = [0, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000, 10_000_000];
const dollars = (cents: number) => `$${String(Math.round(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

/** Spend is only ever reported as one of these bands. */
export function revenueBand(cents: number): RevenueBand {
  const v = Math.max(0, cents);
  for (let i = BAND_EDGES.length - 1; i >= 0; i--) {
    if (v >= BAND_EDGES[i]!) {
      const low = BAND_EDGES[i]!;
      const high = BAND_EDGES[i + 1] ?? null;
      const label = high === null ? `over ${dollars(low)}` : low === 0 ? `under ${dollars(high)}` : `${dollars(low)} to ${dollars(high)}`;
      return { label, low_cents: low, high_cents: high };
    }
  }
  return { label: `under ${dollars(BAND_EDGES[1]!)}`, low_cents: 0, high_cents: BAND_EDGES[1]! };
}

const EPOCH = '1970-01-01';
const DIMS = { campaign: `coalesce(nullif(r.campaign_id, ''), '')`, creator: `coalesce(nullif(r.creator_id, ''), '')` };

/**
 * Outcomes per campaign and creator, for one venue or for the venues the caller can see.
 * Read-only staff and above; an assistant needs the outcomes:read scope to reach it.
 */
export async function campaignOutcomes(ctx: Ctx, raw: CampaignOutcomesInput = {}): Promise<CampaignOutcomes> {
  const parsed = campaignOutcomesInput.safeParse(raw);
  if (!parsed.success) throw invalid('That request is not valid.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  let scope = await resolveScope(ctx, input.venueId ? [input.venueId] : undefined);
  const settings = await getAnalyticsSettings(ctx);
  const service = serviceAudience(ctx);
  let min = settings.minCohort;
  if (service !== null) {
    // A connected service's key (docs/modules/hub.md section 7). Only Criota has outcomes to
    // receive, only from venues that switched sharing on, one venue at a time (never a total
    // across venues), never below the larger of the two floors, and only Criota's campaigns.
    if (!isCriotaPlug(service)) throw notFound('There are no outcomes for this service.');
    const sharing = [];
    for (const v of scope.venues) {
      const s = await criotaSharing(ctx, v.id);
      if (s.enabled) sharing.push({ venue: v, minCohort: s.minCohort });
    }
    // A named venue that does not share is, to the service, a venue that does not exist.
    if (input.venueId && !sharing.length) throw notFound('Venue not found');
    if (!sharing.length) return withheldForService(ctx, scope, settings);
    if (sharing.length > 1) throw invalid(`Name one venue: outcomes are released for each venue on its own. One of: ${sharing.map((x) => x.venue.slug).join(', ')}.`);
    scope = await resolveScope(ctx, [sharing[0]!.venue.id]);
    min = Math.max(settings.minCohort, sharing[0]!.minCohort);
  }
  const today = scope.today;
  const period = input.period ? resolvePeriod(input.period, today, null) : null;

  const where = [service !== null ? CRIOTA_ROWS : sql`(r.campaign_id <> '' or r.creator_id <> '')`];
  if (input.campaignId) where.push(inList('r.campaign_id', [input.campaignId]));
  if (input.creatorId) where.push(inList('r.creator_id', [input.creatorId]));
  const dims = [
    { key: 'campaign', expr: DIMS.campaign },
    { key: 'creator', expr: DIMS.creator },
  ];
  const ctesFor = (from: string, to: string) =>
    campaignCtes({ orgId: ctx.orgId, venueIds: scope.venueIds, includeOrgLevel: scope.all, orgTimezone: scope.orgTimezone, from, to });

  // First activity is measured over all time, whatever period was asked for: the quiet period
  // belongs to the campaign, not to the question.
  const allTime = await runGrouped(ctx, {
    ctes: ctesFor(EPOCH, today),
    relation: 'a_camp',
    bucket: null,
    dims,
    where,
    aggs: { ...CAMPAIGN_AGGS, first_day: `min(day) - '${EPOCH}'::date` },
  });
  const inPeriod = period
    ? await runGrouped(ctx, { ctes: ctesFor(period.from, period.to > today ? today : period.to), relation: 'a_camp', bucket: null, dims, where, aggs: CAMPAIGN_AGGS })
    : allTime;
  const measuredBy = new Map(inPeriod.rows.map((r) => [`${r.dims.campaign}\u0001${r.dims.creator}`, r.m]));

  const outcomes: CampaignOutcome[] = [];
  for (const r of allTime.rows) {
    const campaign = r.dims.campaign || null;
    const creator = r.dims.creator || null;
    const what = [campaign ? `campaign ${campaign}` : null, creator ? `creator ${creator}` : null].filter(Boolean).join(', ');
    const firstDay = addDays(EPOCH, Number(r.m.first_day ?? 0));
    const measurableFrom = addDays(firstDay, settings.campaignQuietDays);
    const blank = { campaign_id: campaign, creator_id: creator, first_activity_on: firstDay, sessions: null, new_customers: null, orders: null, revenue_band: null, repeat_rate: null };
    if (today < measurableFrom) {
      const note = `Too early to say. Results appear ${settings.campaignQuietDays} days after first activity, from ${measurableFrom}.`;
      outcomes.push({ ...blank, status: 'too_early', status_note: note, summary: `${what}: ${note}` });
      continue;
    }
    const m = measuredBy.get(`${r.dims.campaign}\u0001${r.dims.creator}`);
    const cohort = Number(m?.cohort ?? 0);
    if (cohort < min) {
      const note = `Not enough guests yet: fewer than ${min}. This is unmeasured, not a low result.`;
      outcomes.push({ ...blank, status: 'not_enough_guests', status_note: note, summary: `${what}: ${note}` });
      continue;
    }
    const buyers = Number(m!.buyers ?? 0);
    const newCustomers = Number(m!.new_customers ?? 0);
    const spendShown = buyers >= min;
    const band = spendShown ? revenueBand(Number(m!.revenue ?? 0)) : null;
    const repeat = spendShown ? Math.round((Number(m!.repeat_buyers ?? 0) / buyers) * 100) / 100 : null;
    const parts = [
      newCustomers >= min ? `${newCustomers} new guests` : null,
      spendShown ? `${Number(m!.orders ?? 0)} orders, spend in the range ${band!.label}` : 'too few purchasing guests to report spend',
      repeat !== null ? `${Math.round(repeat * 100)}% of purchasing guests came back` : null,
    ].filter(Boolean);
    outcomes.push({
      campaign_id: campaign,
      creator_id: creator,
      status: 'measured',
      status_note: spendShown ? 'Measured.' : `Measured in part: fewer than ${min} guests have purchased, so orders, spend and repeat rate are withheld.`,
      first_activity_on: firstDay,
      sessions: Number(m!.sessions ?? 0),
      new_customers: newCustomers >= min ? newCustomers : null,
      orders: spendShown ? Number(m!.orders ?? 0) : null,
      revenue_band: band,
      repeat_rate: repeat,
      summary: `Aligned with ${what}: ${parts.join('; ')}.`,
    });
  }
  outcomes.sort((a, b) => (a.campaign_id ?? '').localeCompare(b.campaign_id ?? '') || (a.creator_id ?? '').localeCompare(b.creator_id ?? ''));

  return {
    venue: input.venueId || service !== null ? scope.venues[0]!.name : null,
    venues_covered: scope.venues.length,
    period: period ? { from: period.from, to: period.to } : { from: null, to: today },
    min_cohort: min,
    quiet_days: settings.campaignQuietDays,
    currency: scope.currency,
    outcomes,
    wording: 'These results are aligned with each campaign or creator. They are not proof that it caused them.',
    caveats: [
      'A guest is tied to a campaign or creator only by the link or code they first arrived with; guests who saw the campaign and arrived another way are not counted.',
      'Spend is what those guests paid after refunds, shown only as a band.',
      `Anything describing fewer than ${min} guests is withheld, and nothing is shown for the first ${settings.campaignQuietDays} days. Withheld means unmeasured, not low.`,
    ],
    as_of: ctx.now().toISOString(),
  };
}

/** Rows that are Criota's: a creator stamped on them, or Criota named as the source. */
const CRIOTA_ROWS = sql`(r.creator_id <> '' or lower(r.channel) = 'criota')`;

/** The plug a service key is for, or null for a person or their own assistant. */
function serviceAudience(ctx: Ctx): string | null {
  const p = ctx.principal;
  if (p.kind !== 'agent' || !p.audience || !p.audience.startsWith('service:')) return null;
  return p.audience.slice('service:'.length);
}

/** No venue this service key can see is sharing: an answer with nothing in it, saying why. */
function withheldForService(ctx: Ctx, scope: { today: string; currency: string }, settings: { minCohort: number; campaignQuietDays: number }): CampaignOutcomes {
  return {
    venue: null,
    venues_covered: 0,
    period: { from: null, to: scope.today },
    min_cohort: settings.minCohort,
    quiet_days: settings.campaignQuietDays,
    currency: scope.currency,
    outcomes: [],
    wording: 'No venue has switched on sharing its campaign outcomes with this service.',
    caveats: ['Each venue decides for itself whether its outcomes are shared. Nothing is released for a venue that has not.'],
    as_of: ctx.now().toISOString(),
  };
}
