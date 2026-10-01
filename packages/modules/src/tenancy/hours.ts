import { z } from 'zod';
import { type Ctx, addDays, audit, invalid, localParts, requireStaff, zonedTimeToUtc } from '@ros/core';
import { getVenue } from './venues';

const TIME = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Use a 24-hour time such as 17:30.');

export const tradingHoursInput = z.array(
  z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    opensAt: TIME,
    closesAt: TIME,
    serviceType: z.string().default('all'),
  }),
);

export interface TradingHour {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  serviceType: string;
}

export async function getTradingHours(ctx: Ctx, venueId: string): Promise<TradingHour[]> {
  const rows = await ctx.db
    .selectFrom('trading_hours')
    .select(['day_of_week', 'opens_at', 'closes_at', 'service_type'])
    .where('venue_id', '=', venueId)
    .orderBy('day_of_week')
    .orderBy('opens_at')
    .execute();
  return rows.map((r) => ({ dayOfWeek: r.day_of_week, opensAt: r.opens_at, closesAt: r.closes_at, serviceType: r.service_type }));
}

/** Replace a venue's weekly hours. A period that closes after midnight is written with closesAt < opensAt. */
export async function setTradingHours(ctx: Ctx, venueId: string, raw: z.input<typeof tradingHoursInput>): Promise<TradingHour[]> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const hours = tradingHoursInput.parse(raw);
  const before = await getTradingHours(ctx, venueId);
  await ctx.db.deleteFrom('trading_hours').where('venue_id', '=', venueId).execute();
  if (hours.length) {
    await ctx.db
      .insertInto('trading_hours')
      .values(
        hours.map((h) => ({
          org_id: ctx.orgId,
          venue_id: venueId,
          day_of_week: h.dayOfWeek,
          opens_at: h.opensAt,
          closes_at: h.closesAt,
          service_type: h.serviceType,
        })),
      )
      .execute();
  }
  const after = await getTradingHours(ctx, venueId);
  await audit(ctx, { action: 'hours.set', entityType: 'venue', entityId: venueId, venueId, before, after });
  return after;
}

export const hourExceptionInput = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    closed: z.boolean().default(true),
    opensAt: TIME.nullish(),
    closesAt: TIME.nullish(),
    reason: z.string().max(200).nullish(),
  })
  .refine((v) => v.closed || (v.opensAt && v.closesAt), 'Give opening and closing times, or mark the day closed.');

export interface HourException {
  date: string;
  closed: boolean;
  opensAt: string | null;
  closesAt: string | null;
  reason: string | null;
}

export async function listHourExceptions(ctx: Ctx, venueId: string, from: string, to: string): Promise<HourException[]> {
  const rows = await ctx.db
    .selectFrom('hour_exceptions')
    .select(['date', 'closed', 'opens_at', 'closes_at', 'reason'])
    .where('venue_id', '=', venueId)
    .where('date', '>=', from)
    .where('date', '<=', to)
    .orderBy('date')
    .execute();
  return rows.map((r) => ({ date: r.date, closed: r.closed, opensAt: r.opens_at, closesAt: r.closes_at, reason: r.reason }));
}

/** Add or replace the exception for one date (a public holiday, a private event, a closure). */
export async function setHourException(ctx: Ctx, venueId: string, raw: z.input<typeof hourExceptionInput>): Promise<HourException> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const input = hourExceptionInput.parse(raw);
  const values = {
    closed: input.closed,
    opens_at: input.closed ? null : (input.opensAt ?? null),
    closes_at: input.closed ? null : (input.closesAt ?? null),
    reason: input.reason ?? null,
  };
  await ctx.db
    .insertInto('hour_exceptions')
    .values({ org_id: ctx.orgId, venue_id: venueId, date: input.date, ...values })
    .onConflict((oc) => oc.columns(['venue_id', 'date']).doUpdateSet(values))
    .execute();
  await audit(ctx, { action: 'hours.exception_set', entityType: 'venue', entityId: venueId, venueId, after: input });
  return { date: input.date, closed: values.closed, opensAt: values.opens_at, closesAt: values.closes_at, reason: values.reason };
}

export async function removeHourException(ctx: Ctx, venueId: string, date: string): Promise<void> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('Use a date such as 2026-12-25.');
  await ctx.db.deleteFrom('hour_exceptions').where('venue_id', '=', venueId).where('date', '=', date).execute();
  await audit(ctx, { action: 'hours.exception_removed', entityType: 'venue', entityId: venueId, venueId, after: { date } });
}

export interface OpenWindow {
  opensAt: Date;
  closesAt: Date;
  serviceType: string;
}

/**
 * The periods a venue is open on a venue-local date, as instants. An exception for the date
 * replaces the weekly hours. A period that runs past midnight ends on the following day.
 */
export async function openWindows(ctx: Ctx, venueId: string, date: string): Promise<OpenWindow[]> {
  const venue = await getVenue(ctx, venueId);
  const exception = await ctx.db
    .selectFrom('hour_exceptions')
    .select(['closed', 'opens_at', 'closes_at'])
    .where('venue_id', '=', venueId)
    .where('date', '=', date)
    .executeTakeFirst();

  const toWindow = (opens: string, closes: string, serviceType: string): OpenWindow => {
    const opensAt = zonedTimeToUtc(date, opens, venue.timezone);
    const closeDate = closes <= opens ? addDays(date, 1) : date;
    return { opensAt, closesAt: zonedTimeToUtc(closeDate, closes, venue.timezone), serviceType };
  };

  if (exception) {
    if (exception.closed || !exception.opens_at || !exception.closes_at) return [];
    return [toWindow(exception.opens_at, exception.closes_at, 'all')];
  }

  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const hours = (await getTradingHours(ctx, venueId)).filter((h) => h.dayOfWeek === weekday);
  return hours.map((h) => toWindow(h.opensAt, h.closesAt, h.serviceType));
}

/** Whether the venue is trading at an instant, counting a late period that began the previous day. */
export async function isOpenAt(ctx: Ctx, venueId: string, at: Date): Promise<boolean> {
  const venue = await getVenue(ctx, venueId);
  const today = localParts(at, venue.timezone).date;
  for (const date of [addDays(today, -1), today]) {
    for (const w of await openWindows(ctx, venueId, date)) {
      if (at >= w.opensAt && at < w.closesAt) return true;
    }
  }
  return false;
}
