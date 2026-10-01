import { type Ctx, type StaffRole, forbidden, localDate, notFound, requireStaff, visibleVenueIds } from '@ros/core';

/** The venues an analytics answer covers, decided by who is asking and what they asked for. */
export interface VenueScope {
  venues: Array<{ id: string; slug: string; name: string; timezone: string }>;
  venueIds: string[];
  /** True when the scope is every venue the org has. Org-wide facts may only be used then. */
  all: boolean;
  /** The zone "today" is resolved in: the venues' shared zone, else the org's. */
  timezone: string;
  /** The org's own zone: what a session or customer with no venue is dated in. */
  orgTimezone: string;
  /** True when the venues are in more than one zone; each venue's days are still its own. */
  mixedZones: boolean;
  currency: string;
  /** Today's venue-local date. */
  today: string;
}

/**
 * Every analytics read starts here. Read-only staff and above; a venue the caller has no role
 * at is answered as not-found; with no venue named, the scope is every venue the caller can
 * see (and, for an assistant, that its key was limited to). Internal callers see the whole org.
 */
export async function resolveScope(ctx: Ctx, requested?: string[] | null, minRole: StaffRole = 'read_only'): Promise<VenueScope> {
  requireStaff(ctx, { minRole });
  let visible = visibleVenueIds(ctx);
  if (ctx.principal.kind === 'agent' && ctx.principal.venueIds) {
    const allowed = new Set(ctx.principal.venueIds);
    visible = (visible ?? []).filter((id) => allowed.has(id));
  }

  const org = await ctx.db.selectFrom('orgs').select(['timezone', 'currency']).where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
  const rows = await ctx.db.selectFrom('venues').select(['id', 'slug', 'name', 'timezone']).where('org_id', '=', ctx.orgId).orderBy('name').orderBy('id').execute();

  let inScope = visible === null ? rows : rows.filter((v) => visible.includes(v.id));
  if (requested?.length) {
    const wanted = [...new Set(requested)];
    for (const id of wanted) {
      if (!inScope.some((v) => v.id === id)) throw notFound('Venue not found');
      requireStaff(ctx, { venueId: id, minRole });
    }
    inScope = inScope.filter((v) => wanted.includes(v.id));
  }
  if (!inScope.length) throw forbidden('Your role does not cover any venue.');

  const zones = [...new Set(inScope.map((v) => v.timezone))];
  const timezone = zones.length === 1 ? zones[0]! : org.timezone;
  return {
    venues: inScope.map((v) => ({ id: v.id, slug: v.slug, name: v.name, timezone: v.timezone })),
    venueIds: inScope.map((v) => v.id),
    all: inScope.length === rows.length,
    timezone,
    orgTimezone: org.timezone,
    mixedZones: zones.length > 1,
    currency: org.currency,
    today: localDate(ctx.now(), timezone),
  };
}

/**
 * Resolve a venue an assistant named (its id, its address slug, or its name) among the venues
 * the caller can see. A tool never takes an org; a venue only chooses among what is visible.
 */
export function pickVenue(scope: VenueScope, ref: string | null | undefined): string[] | undefined {
  if (!ref) return undefined;
  const needle = ref.trim().toLowerCase();
  const hit = scope.venues.find((v) => v.id === needle || v.slug.toLowerCase() === needle || v.name.toLowerCase() === needle);
  if (!hit) throw notFound('Venue not found');
  return [hit.id];
}
