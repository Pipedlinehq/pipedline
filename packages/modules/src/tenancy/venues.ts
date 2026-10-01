import { z } from 'zod';
import { type Ctx, audit, conflict, isUniqueViolation, notFound, requireOwner, requireStaff, visibleVenueIds } from '@ros/core';
import { assertVenueQuota } from './quota';

export interface VenueView {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
  status: 'setup' | 'live' | 'paused' | 'closed';
  capacity: number | null;
  cuisineTags: string[];
  priceBand: number | null;
}

const COLS = [
  'id',
  'slug',
  'name',
  'timezone',
  'address_line1',
  'address_line2',
  'suburb',
  'state',
  'postcode',
  'lat',
  'lng',
  'phone',
  'email',
  'status',
  'capacity',
  'cuisine_tags',
  'price_band',
] as const;

type Row = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address_line1: string | null;
  address_line2: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  email: string | null;
  status: VenueView['status'];
  capacity: number | null;
  cuisine_tags: string[];
  price_band: number | null;
};

const view = (r: Row): VenueView => ({
  id: r.id,
  slug: r.slug,
  name: r.name,
  timezone: r.timezone,
  addressLine1: r.address_line1,
  addressLine2: r.address_line2,
  suburb: r.suburb,
  state: r.state,
  postcode: r.postcode,
  lat: r.lat,
  lng: r.lng,
  phone: r.phone,
  email: r.email,
  status: r.status,
  capacity: r.capacity,
  cuisineTags: r.cuisine_tags,
  priceBand: r.price_band,
});

/**
 * A venue's public details. No role check: this is what the venue's own site shows. Any venue
 * id from another org is simply not found (row-level security).
 */
export async function getVenue(ctx: Ctx, venueId: string): Promise<VenueView> {
  const r = await ctx.db.selectFrom('venues').select(COLS).where('id', '=', venueId).executeTakeFirst();
  if (!r) throw notFound('Venue not found');
  return view(r);
}

export async function getVenueBySlug(ctx: Ctx, slug: string): Promise<VenueView> {
  const r = await ctx.db.selectFrom('venues').select(COLS).where('slug', '=', slug).executeTakeFirst();
  if (!r) throw notFound('Venue not found');
  return view(r);
}

/** Venues open to the public (for the org-level site's location picker). */
export async function listPublicVenues(ctx: Ctx): Promise<VenueView[]> {
  const rows = await ctx.db.selectFrom('venues').select(COLS).where('status', 'in', ['live', 'setup']).orderBy('name').execute();
  return rows.map(view);
}

/** Venues the caller has a role at. */
export async function listVenues(ctx: Ctx): Promise<VenueView[]> {
  requireStaff(ctx);
  const visible = visibleVenueIds(ctx);
  let q = ctx.db.selectFrom('venues').select(COLS).orderBy('name');
  if (visible) {
    if (!visible.length) return [];
    q = q.where('id', 'in', visible);
  }
  return (await q.execute()).map(view);
}

export const venueInput = z.object({
  slug: z
    .string()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/),
  name: z.string().min(1).max(200),
  timezone: z.string().default('Australia/Sydney'),
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  suburb: z.string().nullish(),
  state: z.string().nullish(),
  postcode: z.string().nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish(),
  capacity: z.number().int().positive().nullish(),
  cuisineTags: z.array(z.string()).default([]),
  priceBand: z.number().int().min(1).max(4).nullish(),
});

export async function createVenue(ctx: Ctx, raw: z.input<typeof venueInput>): Promise<VenueView> {
  const owner = requireOwner(ctx);
  const input = venueInput.parse(raw);
  await assertVenueQuota(ctx);
  try {
    const r = await ctx.db
      .insertInto('venues')
      .values({
        org_id: ctx.orgId,
        slug: input.slug,
        name: input.name,
        timezone: input.timezone,
        address_line1: input.addressLine1 ?? null,
        address_line2: input.addressLine2 ?? null,
        suburb: input.suburb ?? null,
        state: input.state ?? null,
        postcode: input.postcode ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        capacity: input.capacity ?? null,
        cuisine_tags: input.cuisineTags,
        price_band: input.priceBand ?? null,
      })
      .returning(COLS)
      .executeTakeFirstOrThrow();
    // Every owner holds every venue.
    const owners = await ctx.db.selectFrom('staff').select('id').where('is_owner', '=', true).execute();
    for (const o of owners) {
      await ctx.db
        .insertInto('staff_venues')
        .values({ org_id: ctx.orgId, staff_id: o.id, venue_id: r.id, role: 'owner' })
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    await audit(ctx, { action: 'venue.created', entityType: 'venue', entityId: r.id, venueId: r.id, after: view(r) });
    // The acting owner's principal was built before this venue existed.
    if (owner) owner.venueRoles[r.id] = 'owner';
    return view(r);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('A venue with that short name already exists.');
    throw e;
  }
}

// The two fields with defaults are redeclared without them: zod applies a default inside an
// optional field, so a partial update would otherwise reset the time zone and the cuisine tags.
export const updateVenueInput = venueInput.omit({ slug: true, timezone: true, cuisineTags: true }).partial().extend({
  timezone: z.string().optional(),
  cuisineTags: z.array(z.string()).optional(),
  status: z.enum(['setup', 'live', 'paused', 'closed']).optional(),
});

export async function updateVenue(ctx: Ctx, venueId: string, raw: z.input<typeof updateVenueInput>): Promise<VenueView> {
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const input = updateVenueInput.parse(raw);
  const before = await getVenue(ctx, venueId);
  const set: Record<string, unknown> = {};
  const map: Record<string, string> = {
    name: 'name',
    timezone: 'timezone',
    addressLine1: 'address_line1',
    addressLine2: 'address_line2',
    suburb: 'suburb',
    state: 'state',
    postcode: 'postcode',
    lat: 'lat',
    lng: 'lng',
    phone: 'phone',
    email: 'email',
    capacity: 'capacity',
    cuisineTags: 'cuisine_tags',
    priceBand: 'price_band',
    status: 'status',
  };
  for (const [k, col] of Object.entries(map)) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined) set[col] = v;
  }
  if (Object.keys(set).length) await ctx.db.updateTable('venues').set(set).where('id', '=', venueId).execute();
  const after = await getVenue(ctx, venueId);
  await audit(ctx, { action: 'venue.updated', entityType: 'venue', entityId: venueId, venueId, before, after });
  return after;
}
