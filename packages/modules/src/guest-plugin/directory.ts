import { type App, sql } from '@ros/core';
import { guestPluginModule } from './module';

/**
 * The public directory: which venues a guest's assistant can see at all. This is the one place
 * the guest connection reads across organisations, and it reads only what a venue publishes by
 * switching the plugin on (name, suburb, cuisine, price band) and only for venues that did so
 * and are live, in an organisation that is live.
 *
 * Why `app.db` (no row-level security): the caller is an anonymous member of the public on the
 * platform host, so there is no host, session or key to take an organisation from. The venue id
 * a tool receives is resolved to its organisation here, exactly as a host is resolved to an
 * organisation from `domains` (tenancy.resolveHost); everything after this runs inside
 * `app.tenant(orgId, anon, …)` with row-level security on. A venue that is not listed resolves
 * to nothing, whatever id is sent.
 */

export interface ListedVenue {
  orgId: string;
  venueId: string;
  name: string;
  suburb: string | null;
  state: string | null;
  cuisine: string[];
  priceBand: number | null;
}

/** Search terms: words of at least two characters, wildcards escaped, at most five. */
function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}'&-]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2)
    .slice(0, 5)
    .map((w) => w.replace(/[\\%_]/g, (c) => `\\${c}`));
}

function listed(app: App) {
  return app.db
    .selectFrom('venues as v')
    .innerJoin('orgs as o', 'o.id', 'v.org_id')
    .innerJoin('venue_modules as m', (j) =>
      j.onRef('m.venue_id', '=', 'v.id').onRef('m.org_id', '=', 'v.org_id').on('m.module_key', '=', guestPluginModule.key).on('m.enabled', '=', true),
    )
    .where('v.status', '=', 'live')
    .where('o.status', '=', 'live');
}

/** Venues on the guest connection matching every word of a name, suburb, postcode or cuisine. */
export async function findListedVenues(app: App, query: string, limit = 10): Promise<ListedVenue[]> {
  const words = terms(query);
  if (!words.length) return [];
  let q = listed(app).select([
    'v.id',
    'v.org_id',
    'v.name',
    'v.suburb',
    'v.state',
    'v.cuisine_tags',
    'v.price_band',
    'o.cuisine_tags as org_cuisine',
    'o.price_band as org_price_band',
  ]);
  for (const w of words) {
    const like = `%${w}%`;
    q = q.where(
      sql<boolean>`(lower(v.name) like ${like} or lower(o.trading_name) like ${like} or lower(coalesce(v.suburb, '')) like ${like} or coalesce(v.postcode, '') = ${w} or lower(array_to_string(v.cuisine_tags || o.cuisine_tags, ' ')) like ${like})`,
    );
  }
  const rows = await q.orderBy('v.name').orderBy('v.id').limit(limit).execute();
  return rows.map((r) => ({
    orgId: r.org_id,
    venueId: r.id,
    name: r.name,
    suburb: r.suburb,
    state: r.state,
    cuisine: [...new Set([...(r.cuisine_tags.length ? r.cuisine_tags : r.org_cuisine)])],
    priceBand: r.price_band ?? r.org_price_band,
  }));
}

/** The organisation of a listed venue, or null when the id is not a venue on the guest connection. */
export async function listedVenueOrg(app: App, venueId: string): Promise<string | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(venueId)) return null;
  const row = await listed(app).select('v.org_id').where('v.id', '=', venueId).executeTakeFirst();
  return row?.org_id ?? null;
}
