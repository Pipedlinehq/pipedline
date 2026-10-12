import { menu, tenancy } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { asDevice } from '@/lib/ops-device';

export const dynamic = 'force-dynamic';

const UNTIL = new Set<string>(menu.UNTIL_CHOICES);

/**
 * GET /kitchen/api/menu: what is being served now at the screen's venue on any channel, with
 * each item's 86 state and, for a sold-out item, when it is back ("back 9:30 pm" / "until put back").
 */
export const GET = route(async (req) => {
  const items = await asDevice(req, async (ctx, s) => {
    const venue = await tenancy.getVenue(ctx, s.principal.venueId);
    const now = ctx.now();
    const byId = new Map<string, { id: string; name: string; section: string; available: boolean; backAt: string | null; backWords: string | null }>();
    for (const surface of menu.MENU_CHANNELS) {
      const m = await menu.getPublicMenu(ctx, s.principal.venueId, { surface });
      for (const mm of m.menus) {
        for (const sec of mm.sections) {
          for (const i of sec.items) {
            if (byId.has(i.id)) continue;
            const backAt = i.availableFrom ?? null;
            byId.set(i.id, { id: i.id, name: i.name, section: sec.name, available: i.isAvailable, backAt: backAt ? backAt.toISOString() : null, backWords: i.isAvailable ? null : menu.backWords(backAt, now, venue.timezone) });
          }
        }
      }
    }
    return [...byId.values()];
  });
  return { items };
});

/**
 * POST /kitchen/api/menu { itemId, available, until? }: the 86 button. `until` is one of
 * end_of_service (the default), tomorrow, until_changed, or an ISO time; the item comes back on
 * its own when it passes.
 */
export const POST = route(async (req) => {
  const body = await readJson<{ itemId?: string; available?: boolean; until?: string | null }>(req);
  const until = typeof body.until === 'string' && body.until ? body.until : 'end_of_service';
  const r = await asDevice(req, async (ctx, s) => {
    const venue = await tenancy.getVenue(ctx, s.principal.venueId);
    const a = await menu.setItemAvailability(ctx, {
      itemId: String(body.itemId ?? ''),
      available: Boolean(body.available),
      until: body.available ? null : UNTIL.has(until) ? (until as menu.UntilChoice) : until,
    });
    return { ...a, backWords: a.available ? null : menu.backWords(a.until, ctx.now(), venue.timezone) };
  });
  return { itemId: r.itemId, available: r.available, until: r.until, backWords: r.backWords };
});
