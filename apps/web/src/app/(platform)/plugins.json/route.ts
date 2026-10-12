import { auth, tenancy } from '@ros/modules';
import { VENUE_COOKIE } from '@/lib/console';
import { STAFF_COOKIE, readCookie } from '@/lib/cookies';
import { route } from '@/lib/http';
import { app } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

/**
 * The public plugin catalogue (docs/CONSOLE_IA.md section 6; docs/PIPEDLINE.md "What has to
 * change" 3): every module's manifest and every plug, the tools each adds and its settings as
 * JSON Schema, generated from the module definitions (tenancy.pluginCatalogue). Platform host only.
 *
 * Anyone may read it, and the public answer is cacheable. A staff member signed in to the console
 * gets the same catalogue for the venue they are looking at, with `on` and (for a manager) the
 * settings; that answer is private. Nothing about a venue is given to a visitor who is not signed
 * in, and a cookie that does not resolve to a staff session is treated as absent.
 */
export const GET = route(async () => {
  const token = await readCookie(STAFF_COOKIE);
  const who = token ? await auth.authenticate(app(), token) : null;
  if (who?.orgId && who.principal.kind === 'staff') {
    const orgId = who.orgId;
    const principal = who.principal;
    const wanted = await readCookie(VENUE_COOKIE);
    const personal = await app().tenant(orgId, principal, async (ctx) => {
      // The selected venue, checked against the venues this person has a role at; never widened by the cookie.
      const venues = await tenancy.listVenues(ctx);
      const venue = venues.find((v) => v.id === wanted) ?? venues[0];
      return venue ? tenancy.pluginCatalogueForVenue(ctx, venue.id) : null;
    });
    if (personal) return tenancy.pluginsJsonResponse(personal, { personal: true });
  }
  return tenancy.pluginsJsonResponse(tenancy.pluginCatalogue(app()), { personal: false });
});
