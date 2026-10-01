import type { Selectable } from 'kysely';
import { z } from 'zod';
import { type Ctx, type DB, assertModule, audit, invalid, json, notFound, requireStaff } from '@ros/core';
import { type DeliveryConfig, type FeeRule, deliveryModule, feeRule } from './module';

export type ZoneRow = Selectable<DB['delivery_zones']>;

/** Where a venue delivers. A radius from the venue, or a drawn area; either way never past max_radius_m. */
export interface ZoneView {
  id: string;
  venueId: string;
  name: string;
  kind: 'radius' | 'polygon';
  radiusM: number | null;
  /** [lat, lng] corners, in order. */
  polygon: Array<[number, number]> | null;
  minOrderCents: number;
  /** Null: the venue's fee rule applies. */
  feeRule: FeeRule | null;
  isActive: boolean;
}

const polygonOf = (v: unknown): Array<[number, number]> | null => (Array.isArray(v) ? (v as Array<[number, number]>) : null);

export function zoneView(r: ZoneRow): ZoneView {
  const rule = feeRule.safeParse(r.fee_rule);
  return {
    id: r.id,
    venueId: r.venue_id,
    name: r.name,
    kind: r.kind === 'polygon' ? 'polygon' : 'radius',
    radiusM: r.radius_m,
    polygon: polygonOf(r.polygon),
    minOrderCents: r.min_order_cents,
    // A zone saved with the default '{"kind":"pass_through"}' and no explicit rule is stored as null on write.
    feeRule: r.fee_rule === null || !rule.success ? null : (r.fee_rule as { inherit?: boolean }).inherit ? null : rule.data,
    isActive: r.is_active,
  };
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting on [lat, lng] corners. Good enough at suburb scale. */
export function insidePolygon(p: { lat: number; lng: number }, polygon: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]!;
    const [yj, xj] = polygon[j]!;
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The zone an address falls in, or null. The address is within max_radius_m of the venue and
 * inside an active zone; when zones overlap, the smallest radius wins (it is the most specific).
 */
export async function zoneFor(ctx: Ctx, venue: { id: string; lat: number | null; lng: number | null }, cfg: DeliveryConfig, point: { lat: number; lng: number }): Promise<ZoneView | null> {
  if (venue.lat === null || venue.lng === null) return null;
  const d = distanceM({ lat: venue.lat, lng: venue.lng }, point);
  if (d > cfg.max_radius_m) return null;
  const zones = (await ctx.db.selectFrom('delivery_zones').selectAll().where('venue_id', '=', venue.id).where('is_active', '=', true).execute()).map(zoneView);
  const hits = zones.filter((z) => (z.kind === 'radius' ? z.radiusM !== null && d <= z.radiusM : !!z.polygon && z.polygon.length >= 3 && insidePolygon(point, z.polygon)));
  hits.sort((a, b) => (a.radiusM ?? Number.MAX_SAFE_INTEGER) - (b.radiusM ?? Number.MAX_SAFE_INTEGER));
  return hits[0] ?? null;
}

// ── Fees ─────────────────────────────────────────────────────────────────────

/** What the guest pays, from what the courier charges the venue and what the guest is buying. Whole cents, never negative. */
export function guestFee(rule: FeeRule, courierFeeCents: number, subtotalCents: number): number {
  const base = (r: Exclude<FeeRule, { kind: 'free_above' }>): number => {
    if (r.kind === 'flat') return r.cents;
    if (r.kind === 'subsidised') return Math.max(0, courierFeeCents - r.venue_pays_up_to_cents);
    return courierFeeCents;
  };
  if (rule.kind === 'free_above') return subtotalCents >= rule.threshold_cents ? 0 : base(rule.otherwise);
  return Math.max(0, Math.trunc(base(rule)));
}

// ── Console: zones ───────────────────────────────────────────────────────────

const LAT = z.number().min(-90).max(90);
const LNG = z.number().min(-180).max(180);

export const zoneInput = z
  .object({
    venueId: z.string().uuid(),
    /** Leave out to add a zone. */
    zoneId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(80),
    kind: z.enum(['radius', 'polygon']).default('radius'),
    radiusM: z.number().int().min(100).max(50_000).nullish(),
    polygon: z.array(z.tuple([LAT, LNG])).min(3).max(200).nullish(),
    minOrderCents: z.number().int().min(0).max(1_000_000).default(0),
    /** Null: the venue's fee rule applies. */
    feeRule: feeRule.nullish(),
    isActive: z.boolean().default(true),
  })
  .refine((v) => (v.kind === 'radius' ? !!v.radiusM : !!v.polygon), 'A radius zone needs a radius; a drawn zone needs at least three corners.');

async function loadZone(ctx: Ctx, zoneId: string): Promise<ZoneRow> {
  const row = await ctx.db.selectFrom('delivery_zones').selectAll().where('id', '=', z.string().uuid().parse(zoneId)).executeTakeFirst();
  if (!row) throw notFound('Zone not found');
  return row;
}

/** Add or change a delivery zone. A manager of the venue. Audited. */
export async function saveZone(ctx: Ctx, raw: z.input<typeof zoneInput>): Promise<ZoneView> {
  const input = zoneInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await assertModule(ctx, input.venueId, deliveryModule);
  const values = {
    name: input.name,
    kind: input.kind,
    radius_m: input.kind === 'radius' ? (input.radiusM ?? null) : null,
    polygon: input.kind === 'polygon' ? json(input.polygon) : null,
    min_order_cents: input.minOrderCents,
    // Stored marked as inheriting, so a zone that has no rule of its own follows the venue's.
    fee_rule: json(input.feeRule ?? { kind: 'pass_through', inherit: true }),
    is_active: input.isActive,
  };
  let before: ZoneView | null = null;
  let row: ZoneRow;
  if (input.zoneId) {
    const existing = await loadZone(ctx, input.zoneId);
    if (existing.venue_id !== input.venueId) throw notFound('Zone not found');
    before = zoneView(existing);
    row = await ctx.db.updateTable('delivery_zones').set(values).where('id', '=', existing.id).returningAll().executeTakeFirstOrThrow();
  } else {
    row = await ctx.db.insertInto('delivery_zones').values({ org_id: ctx.orgId, venue_id: input.venueId, ...values, created_at: ctx.now() }).returningAll().executeTakeFirstOrThrow();
  }
  const after = zoneView(row);
  await audit(ctx, { action: before ? 'delivery.zone_updated' : 'delivery.zone_created', entityType: 'delivery_zone', entityId: row.id, venueId: row.venue_id, before, after });
  return after;
}

/** Stop delivering to a zone. Kept, not deleted: past deliveries still name it. */
export async function deactivateZone(ctx: Ctx, zoneId: string): Promise<ZoneView> {
  const row = await loadZone(ctx, zoneId);
  requireStaff(ctx, { venueId: row.venue_id, minRole: 'manager' });
  await assertModule(ctx, row.venue_id, deliveryModule);
  const updated = await ctx.db.updateTable('delivery_zones').set({ is_active: false }).where('id', '=', row.id).returningAll().executeTakeFirstOrThrow();
  await audit(ctx, { action: 'delivery.zone_deactivated', entityType: 'delivery_zone', entityId: row.id, venueId: row.venue_id, before: zoneView(row), after: zoneView(updated) });
  return zoneView(updated);
}

export async function listZones(ctx: Ctx, venueId: string, opts: { includeInactive?: boolean } = {}): Promise<ZoneView[]> {
  const id = z.string().uuid().parse(venueId);
  requireStaff(ctx, { venueId: id, minRole: 'read_only' });
  await assertModule(ctx, id, deliveryModule);
  let q = ctx.db.selectFrom('delivery_zones').selectAll().where('venue_id', '=', id).orderBy('created_at');
  if (!opts.includeInactive) q = q.where('is_active', '=', true);
  return (await q.execute()).map(zoneView);
}

export function assertAddressPoint(lat: number | null | undefined, lng: number | null | undefined): { lat: number; lng: number } {
  if (typeof lat !== 'number' || typeof lng !== 'number') throw invalid('Choose the address from the suggestions so we can check it is in our delivery area.');
  return { lat, lng };
}
