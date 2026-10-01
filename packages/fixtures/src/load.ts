import type { App, StaffPrincipal } from '@ros/core';
import { auth } from '@ros/modules';

export interface FixtureVenue {
  id: string;
  slug: string;
  name: string;
}

export interface FixtureOrg {
  orgId: string;
  slug: string;
  host: string;
  venues: Record<string, FixtureVenue>;
  /** The first venue, for single-venue tests. */
  venueId: string;
  staff: Record<string, { staffId: string; userId: string; email: string }>;
  /** A ready-made principal for a fixture staff member, by the local part of their email. */
  as(who: 'owner' | 'manager' | 'host' | 'kitchen' | 'accounts'): Promise<StaffPrincipal>;
}

export interface Fixture {
  diner: FixtureOrg;
  group: FixtureOrg;
}

async function loadOrg(app: App, slug: string): Promise<FixtureOrg> {
  const org = await app.db.selectFrom('orgs').select(['id', 'slug']).where('slug', '=', slug).executeTakeFirstOrThrow();
  const venues = await app.db.selectFrom('venues').select(['id', 'slug', 'name']).where('org_id', '=', org.id).orderBy('created_at').execute();
  const staffRows = await app.db.selectFrom('staff').select(['id', 'user_id', 'email']).where('org_id', '=', org.id).execute();
  const domain = await app.db.selectFrom('domains').select('host').where('org_id', '=', org.id).where('is_primary', '=', true).executeTakeFirstOrThrow();
  const staff: FixtureOrg['staff'] = {};
  for (const s of staffRows) staff[s.email.split('@')[0]!] = { staffId: s.id, userId: s.user_id, email: s.email };
  return {
    orgId: org.id,
    slug: org.slug,
    host: domain.host,
    venues: Object.fromEntries(venues.map((v) => [v.slug, { id: v.id, slug: v.slug, name: v.name }])),
    venueId: venues[0]!.id,
    staff,
    async as(who) {
      const s = staff[who];
      if (!s) throw new Error(`No fixture staff member "${who}" at ${slug}`);
      const p = await auth.staffPrincipal(app, s.userId, org.id);
      if (!p) throw new Error(`Fixture staff member "${who}" has no principal`);
      return p;
    },
  };
}

/** Look up the seeded fixture orgs by their slugs. */
export async function loadFixture(app: App): Promise<Fixture> {
  return { diner: await loadOrg(app, 'oak-diner'), group: await loadOrg(app, 'oak-group') };
}
