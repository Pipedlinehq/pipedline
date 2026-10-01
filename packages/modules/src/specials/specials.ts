import { z } from 'zod';
import { type Ctx, actorOf, addDays, assertModule, audit, conflict, formatMoney, invalid, isUniqueViolation, localDate, notFound, requireStaff, track } from '@ros/core';
import { getVenue } from '../tenancy/venues';
import { specialEnded, specialPosted, specialsModule } from './module';

/**
 * The specials board. A special is a notice: a name, a description, a price and the venue-local
 * days it runs. A manager posts it and may take it down; guests read the ones running today.
 * The price is whatever the manager typed, in cents. No guest-facing function takes a price.
 */

const DAY = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-02.')
  .refine((d) => addDays(d, 0) === d, 'That is not a day on the calendar.');

export const specialInput = z
  .object({
    venueId: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullish(),
    /** Integer cents. 1850 is $18.50. */
    priceCents: z.number().int().min(0).max(1_000_000),
    /** First day it runs, in the venue's own time zone. Left out: today. */
    startsOn: DAY.optional(),
    /** Last day it runs, inclusive. Left out: the same day as `startsOn`. */
    endsOn: DAY.optional(),
  })
  .strict();

export type SpecialStatus = 'upcoming' | 'running' | 'over' | 'ended';

export interface SpecialView {
  id: string;
  venueId: string;
  name: string;
  description: string | null;
  priceCents: number;
  startsOn: string;
  endsOn: string;
  /** upcoming = not started; running = on the board today; over = its last day has passed; ended = a manager took it down. */
  status: SpecialStatus;
  endedAt: Date | null;
  createdAt: Date;
}

const COLS = ['id', 'venue_id', 'name', 'description', 'price_cents', 'starts_on', 'ends_on', 'ended_at', 'created_at'] as const;
interface Row {
  id: string;
  venue_id: string;
  name: string;
  description: string | null;
  price_cents: number;
  starts_on: string;
  ends_on: string;
  ended_at: Date | null;
  created_at: Date;
}

function statusOf(r: Pick<Row, 'starts_on' | 'ends_on' | 'ended_at'>, today: string): SpecialStatus {
  if (r.ended_at) return 'ended';
  if (today < r.starts_on) return 'upcoming';
  return today > r.ends_on ? 'over' : 'running';
}

const view = (r: Row, today: string): SpecialView => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  description: r.description,
  priceCents: r.price_cents,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  status: statusOf(r, today),
  endedAt: r.ended_at,
  createdAt: r.created_at,
});

const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** A special checked and ready to post: dates filled in, limits applied. Nothing has been written. */
export interface SpecialPlan {
  venue: { id: string; name: string };
  name: string;
  description: string | null;
  priceCents: number;
  startsOn: string;
  endsOn: string;
  days: number;
}

/**
 * Everything `postSpecial` checks, without the write. Manager at the venue. The assistant tool
 * builds its question from this, so the question and the change can never disagree.
 */
export async function checkSpecial(ctx: Ctx, raw: z.input<typeof specialInput>): Promise<SpecialPlan> {
  const input = specialInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const config = await assertModule(ctx, input.venueId, specialsModule);
  const venue = await getVenue(ctx, input.venueId);
  const today = localDate(ctx.now(), venue.timezone);
  const startsOn = input.startsOn ?? today;
  const endsOn = input.endsOn ?? startsOn;
  if (endsOn < startsOn) throw invalid('The last day is before the first day.');
  if (endsOn < today) throw invalid('Those days have already passed.');
  const days = dayCount(startsOn, endsOn);
  if (days > config.max_days) throw invalid(`A special may run for at most ${config.max_days} days here. That is ${days}.`);

  const open = await ctx.db
    .selectFrom('specials')
    .select(['name', 'starts_on'])
    .where('venue_id', '=', input.venueId)
    .where('ended_at', 'is', null)
    .where('ends_on', '>=', today)
    .execute();
  if (open.some((o) => o.name.toLowerCase() === input.name.toLowerCase() && o.starts_on === startsOn)) {
    throw conflict(`"${input.name}" is already on the board from ${startsOn}.`);
  }
  if (open.length >= config.max_running) {
    throw invalid(`The board already has ${open.length} specials running or scheduled, which is the most allowed here. End one first.`);
  }
  return { venue: { id: venue.id, name: venue.name }, name: input.name, description: input.description ?? null, priceCents: input.priceCents, startsOn, endsOn, days };
}

/** Post a special. Manager. Audited (`specials.posted`) and tracked (`special.posted`). */
export async function postSpecial(ctx: Ctx, raw: z.input<typeof specialInput>): Promise<SpecialView> {
  const plan = await checkSpecial(ctx, raw);
  const actor = actorOf(ctx.principal);
  let row: Row;
  try {
    row = await ctx.db
      .insertInto('specials')
      .values({
        org_id: ctx.orgId,
        venue_id: plan.venue.id,
        name: plan.name,
        description: plan.description,
        price_cents: plan.priceCents,
        starts_on: plan.startsOn,
        ends_on: plan.endsOn,
        created_by_kind: actor.kind,
        created_by_id: actor.id,
        created_at: ctx.now(),
        updated_at: ctx.now(),
      })
      .returning(COLS)
      .executeTakeFirstOrThrow();
  } catch (e) {
    // Two posts of the same special racing each other: the index lets one through.
    if (isUniqueViolation(e, 'specials_one_per_name_and_day')) throw conflict(`"${plan.name}" is already on the board from ${plan.startsOn}.`);
    throw e;
  }
  await audit(ctx, {
    action: 'specials.posted',
    entityType: 'special',
    entityId: row.id,
    venueId: row.venue_id,
    after: { name: row.name, priceCents: row.price_cents, startsOn: row.starts_on, endsOn: row.ends_on },
  });
  await track(ctx, specialPosted, { special_id: row.id, price_cents: row.price_cents, days: plan.days }, { venueId: row.venue_id });
  return view(row, localDate(ctx.now(), (await getVenue(ctx, row.venue_id)).timezone));
}

export const endSpecialInput = z.object({ specialId: z.string().uuid() }).strict();

/**
 * Take a special down now. Manager at its venue. The row is kept. Ending one that is already
 * ended changes nothing and is not an error: the answer is the special as it stands.
 */
export async function endSpecial(ctx: Ctx, raw: z.input<typeof endSpecialInput>): Promise<SpecialView> {
  const input = endSpecialInput.parse(raw);
  // Another organisation's id is simply absent here (row-level security): not found.
  const before = await ctx.db.selectFrom('specials').select(COLS).where('id', '=', input.specialId).executeTakeFirst();
  if (!before) throw notFound('Special not found');
  requireStaff(ctx, { venueId: before.venue_id, minRole: 'manager' });
  await assertModule(ctx, before.venue_id, specialsModule);
  const today = localDate(ctx.now(), (await getVenue(ctx, before.venue_id)).timezone);
  if (before.ended_at) return view(before, today);

  const row = await ctx.db
    .updateTable('specials')
    .set({ ended_at: ctx.now() })
    .where('id', '=', before.id)
    .where('ended_at', 'is', null)
    .returning(COLS)
    .executeTakeFirst();
  // Someone else ended it between the read and the write: one effect, theirs.
  if (!row) return view(await ctx.db.selectFrom('specials').select(COLS).where('id', '=', before.id).executeTakeFirstOrThrow(), today);

  await audit(ctx, {
    action: 'specials.ended',
    entityType: 'special',
    entityId: row.id,
    venueId: row.venue_id,
    before: { name: before.name, status: statusOf(before, today) },
    after: { status: 'ended' },
  });
  await track(ctx, specialEnded, { special_id: row.id, early: before.ends_on >= today }, { venueId: row.venue_id });
  return view(row, today);
}

export const listSpecialsInput = z
  .object({
    venueId: z.string().uuid(),
    /** open = running or scheduled (the default); all = also the ones that are over or were ended. */
    show: z.enum(['open', 'all']).default('open'),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();

/** The board as staff see it, latest first day first. Any staff at the venue (read_only and above). */
export async function listSpecials(ctx: Ctx, raw: z.input<typeof listSpecialsInput>): Promise<SpecialView[]> {
  const input = listSpecialsInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'read_only' });
  await assertModule(ctx, input.venueId, specialsModule);
  const today = localDate(ctx.now(), (await getVenue(ctx, input.venueId)).timezone);
  let q = ctx.db.selectFrom('specials').select(COLS).where('venue_id', '=', input.venueId).orderBy('starts_on', 'desc').orderBy('created_at', 'desc').limit(input.limit);
  if (input.show === 'open') q = q.where('ended_at', 'is', null).where('ends_on', '>=', today);
  return (await q.execute()).map((r) => view(r, today));
}

/** What a guest sees. No ids of staff, no dates beyond the last day, and no price when the venue hides prices. */
export interface PublicSpecials {
  heading: string;
  specials: Array<{ id: string; name: string; description: string | null; price: string | null; priceCents: number | null; lastDay: string }>;
}

/**
 * The specials running today at a venue, for its public menu surface. No role check: this is
 * what the venue's own site shows, so an anonymous visitor may call it. It takes a venue id and
 * nothing else. Another organisation's venue, or a venue with the module off, is not found.
 */
export async function getCurrentSpecials(ctx: Ctx, venueId: string): Promise<PublicSpecials> {
  const id = z.string().uuid().parse(venueId);
  const venue = await getVenue(ctx, id);
  const config = await assertModule(ctx, venue.id, specialsModule);
  const today = localDate(ctx.now(), venue.timezone);
  const rows = await ctx.db
    .selectFrom('specials')
    .select(COLS)
    .where('venue_id', '=', venue.id)
    .where('ended_at', 'is', null)
    .where('starts_on', '<=', today)
    .where('ends_on', '>=', today)
    .orderBy('starts_on')
    .orderBy('created_at')
    .orderBy('name')
    .execute();
  return {
    heading: config.heading,
    specials: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      price: config.show_prices ? formatMoney(r.price_cents) : null,
      priceCents: config.show_prices ? r.price_cents : null,
      lastDay: r.ends_on,
    })),
  };
}
