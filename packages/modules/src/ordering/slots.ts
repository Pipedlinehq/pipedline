import { z } from 'zod';
import { type Ctx, AppError, addDays, addMinutes, assertModule, localParts, sql } from '@ros/core';
import { openWindows } from '../tenancy/hours';
import { getVenue } from '../tenancy/venues';
import { type OrderingConfig, orderingModule } from './module';

/**
 * Pickup capacity. A kitchen has a throughput ceiling, so every order, scheduled or ASAP,
 * pickup or table, occupies a slot, and a slot that is full disappears from the picker
 * (docs/modules/ordering.md section 3). Slots are computed from the venue's trading hours;
 * nothing is stored but the orders themselves.
 */

/** Orders in these states occupy their slot. An unpaid order holds its slot for a short while. */
const OCCUPYING = ['placed', 'accepted', 'preparing', 'ready', 'completed'] as const;

export interface GridSlot {
  start: Date;
  end: Date;
  /** The trading period the slot sits in. */
  opensAt: Date;
  closesAt: Date;
}

interface Load {
  orders: number;
  items: number;
}

export function windowSlots(window: { opensAt: Date; closesAt: Date }, slotMinutes: number): GridSlot[] {
  const out: GridSlot[] = [];
  for (let t = window.opensAt; t < window.closesAt; t = addMinutes(t, slotMinutes)) {
    const end = addMinutes(t, slotMinutes);
    out.push({ start: t, end: end > window.closesAt ? window.closesAt : end, opensAt: window.opensAt, closesAt: window.closesAt });
  }
  return out;
}

/** Every slot in the trading periods that open on a venue-local date. */
export async function slotGrid(ctx: Ctx, venueId: string, date: string, cfg: OrderingConfig): Promise<GridSlot[]> {
  const windows = (await openWindows(ctx, venueId, date)).sort((a, b) => a.opensAt.getTime() - b.opensAt.getTime());
  return windows.flatMap((w) => windowSlots(w, cfg.slot_minutes));
}

export async function slotLoads(ctx: Ctx, venueId: string, from: Date, to: Date, cfg: OrderingConfig, excludeOrderId?: string | null): Promise<Map<number, Load>> {
  const holdSince = addMinutes(ctx.now(), -cfg.payment_hold_minutes);
  let q = ctx.db
    .selectFrom('orders')
    .select((eb) => ['pickup_slot_start', eb.fn.countAll<number>().as('orders'), eb.fn.sum<number>('item_count').as('items')])
    .where('venue_id', '=', venueId)
    .where('pickup_slot_start', '>=', from)
    .where('pickup_slot_start', '<', to)
    .where((eb) => eb.or([eb('status', 'in', OCCUPYING), eb.and([eb('status', '=', 'pending_payment'), eb('created_at', '>', holdSince)])]))
    .groupBy('pickup_slot_start');
  if (excludeOrderId) q = q.where('id', '!=', excludeOrderId);
  const rows = await q.execute();
  return new Map(rows.map((r) => [r.pickup_slot_start!.getTime(), { orders: Number(r.orders), items: Number(r.items ?? 0) }]));
}

function hasRoom(load: Load | undefined, cfg: OrderingConfig, itemCount: number): boolean {
  const l = load ?? { orders: 0, items: 0 };
  if (l.orders >= cfg.max_orders_per_slot) return false;
  // One order bigger than the item cap still fits an empty slot: the venue took it on.
  if (cfg.max_items_per_slot !== null && l.orders > 0 && l.items + itemCount > cfg.max_items_per_slot) return false;
  return true;
}

export interface Timing {
  requestedAsap: boolean;
  slotStart: Date;
  slotEnd: Date;
  /** When the guest is told it will be ready. */
  promisedAt: Date;
  estimateMinutes: number;
}

export type TimingIssue = 'closed' | 'asap_unavailable' | 'at_capacity' | 'slot_unknown' | 'slot_too_soon' | 'slot_too_far' | 'slot_full';
export type TimingResult = { ok: true; timing: Timing } | { ok: false; code: TimingIssue; message: string };

const fail = (code: TimingIssue, message: string): TimingResult => ({ ok: false, code, message });
const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

export interface TimingArgs {
  /** The start of the slot the guest chose, or null for "as soon as possible". */
  slotStart: Date | null;
  itemCount: number;
  /** The longest prep time in the cart. */
  prepMinutes: number;
  /** A table order is always as-soon-as-possible, whatever asap_enabled says. */
  tableOrder?: boolean;
  excludeOrderId?: string | null;
}

/** Decide when an order can be ready: the slot it occupies and the time the guest is promised. */
export async function resolveTiming(ctx: Ctx, cfg: OrderingConfig, venueId: string, args: TimingArgs): Promise<TimingResult> {
  const venue = await getVenue(ctx, venueId);
  const now = ctx.now();
  const today = localParts(now, venue.timezone).date;
  const lead = Math.max(cfg.lead_time_minutes, args.prepMinutes);

  if (!args.slotStart) {
    if (!args.tableOrder && !cfg.asap_enabled) return fail('asap_unavailable', 'Choose a pickup time.');
    // A late period that began yesterday may still be running.
    let current: { opensAt: Date; closesAt: Date } | undefined;
    for (const date of [addDays(today, -1), today]) {
      current ??= (await openWindows(ctx, venueId, date)).find((w) => w.opensAt <= now && now < w.closesAt);
    }
    if (!current) return fail('closed', 'The kitchen is closed right now.');
    const target = addMinutes(now, lead);
    if (now > addMinutes(current.closesAt, -cfg.cutoff_before_close_minutes) || target > current.closesAt) {
      return fail('closed', 'The kitchen is about to close and is not taking more orders.');
    }
    const loads = await slotLoads(ctx, venueId, current.opensAt, current.closesAt, cfg, args.excludeOrderId);
    for (const slot of windowSlots(current, cfg.slot_minutes)) {
      if (slot.end <= target) continue;
      if (!hasRoom(loads.get(slot.start.getTime()), cfg, args.itemCount)) continue;
      // When the kitchen is at its cap, the quoted time extends to the next slot with room.
      const promisedAt = slot.start > target ? slot.start : target;
      return { ok: true, timing: { requestedAsap: true, slotStart: slot.start, slotEnd: slot.end, promisedAt, estimateMinutes: minutesBetween(now, promisedAt) } };
    }
    return fail('at_capacity', 'The kitchen is at capacity for the rest of this service.');
  }

  const wanted = args.slotStart;
  const date = localParts(wanted, venue.timezone).date;
  if (date > addDays(today, cfg.max_days_ahead)) return fail('slot_too_far', 'That time is too far ahead.');
  let slot: GridSlot | undefined;
  for (const d of [addDays(date, -1), date]) {
    slot ??= (await slotGrid(ctx, venueId, d, cfg)).find((s) => s.start.getTime() === wanted.getTime());
  }
  if (!slot || slot.start > addMinutes(slot.closesAt, -cfg.cutoff_before_close_minutes)) return fail('slot_unknown', 'That pickup time is not available.');
  const earliest = addMinutes(now > slot.opensAt ? now : slot.opensAt, lead);
  if (slot.start < earliest) return fail('slot_too_soon', 'That pickup time is too soon. Choose a later one.');
  const loads = await slotLoads(ctx, venueId, slot.start, slot.end, cfg, args.excludeOrderId);
  if (!hasRoom(loads.get(slot.start.getTime()), cfg, args.itemCount)) return fail('slot_full', 'That pickup time has just filled. Choose another.');
  return { ok: true, timing: { requestedAsap: false, slotStart: slot.start, slotEnd: slot.end, promisedAt: slot.start, estimateMinutes: minutesBetween(now, slot.start) } };
}

/** Serialises capacity checks for one venue inside the transaction that creates an order. */
export async function lockVenueSlots(ctx: Ctx, venueId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`order-slots:${venueId}`}, 0))`.execute(ctx.db);
}

export const slotsInput = z.object({
  venueId: z.string().uuid(),
  /** Venue-local date, YYYY-MM-DD. Defaults to today. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Units in the cart, for the item cap. */
  itemCount: z.number().int().min(0).max(5000).default(1),
  /** The longest prep time in the cart (priceCart returns it). */
  prepMinutes: z.number().int().min(0).max(600).default(0),
});

export interface SlotBoard {
  venueId: string;
  timezone: string;
  date: string;
  /** The dates a guest may choose from, today first. */
  dates: string[];
  slotMinutes: number;
  asap: { available: boolean; promisedAt: Date | null; estimateMinutes: number | null; reason: string | null };
  /** Slots with room, in order. A full slot is not listed. */
  slots: Array<{ start: Date; end: Date; remainingOrders: number }>;
}

/**
 * What the pickup-time picker shows: "ASAP (about 25 min)" when the kitchen is open and has
 * room, then the scheduled slots that still have capacity. Public: no role check.
 */
export async function getPickupSlots(ctx: Ctx, raw: z.input<typeof slotsInput>): Promise<SlotBoard> {
  const input = slotsInput.parse(raw);
  const cfg = await assertModule(ctx, input.venueId, orderingModule);
  if (!cfg.pickup_enabled) throw new AppError('module_disabled', 'That is not available at this venue.');
  const venue = await getVenue(ctx, input.venueId);
  const now = ctx.now();
  const today = localParts(now, venue.timezone).date;
  const dates = Array.from({ length: cfg.max_days_ahead + 1 }, (_, i) => addDays(today, i));
  const date = input.date ?? today;
  const lead = Math.max(cfg.lead_time_minutes, input.prepMinutes);

  const asapResult = await resolveTiming(ctx, cfg, input.venueId, { slotStart: null, itemCount: input.itemCount, prepMinutes: input.prepMinutes });
  const asap = asapResult.ok
    ? { available: true, promisedAt: asapResult.timing.promisedAt, estimateMinutes: asapResult.timing.estimateMinutes, reason: null }
    : { available: false, promisedAt: null, estimateMinutes: null, reason: asapResult.message };

  const slots: SlotBoard['slots'] = [];
  if (dates.includes(date)) {
    const grid = await slotGrid(ctx, input.venueId, date, cfg);
    if (grid.length) {
      const loads = await slotLoads(ctx, input.venueId, grid[0]!.start, grid[grid.length - 1]!.end, cfg);
      for (const s of grid) {
        if (s.start > addMinutes(s.closesAt, -cfg.cutoff_before_close_minutes)) continue;
        if (s.start < addMinutes(now > s.opensAt ? now : s.opensAt, lead)) continue;
        const load = loads.get(s.start.getTime());
        if (!hasRoom(load, cfg, input.itemCount)) continue;
        slots.push({ start: s.start, end: s.end, remainingOrders: cfg.max_orders_per_slot - (load?.orders ?? 0) });
      }
    }
  }
  return { venueId: input.venueId, timezone: venue.timezone, date, dates, slotMinutes: cfg.slot_minutes, asap, slots };
}
