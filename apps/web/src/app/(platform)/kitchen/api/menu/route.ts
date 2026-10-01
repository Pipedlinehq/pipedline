import { menu } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { asDevice } from '@/lib/ops-device';

export const dynamic = 'force-dynamic';

/** GET /kitchen/api/menu: what is being served now at the screen's venue, with each item's 86 state. */
export const GET = route(async (req) => {
  const items = await asDevice(req, async (ctx, s) => {
    const byId = new Map<string, { id: string; name: string; section: string; available: boolean }>();
    for (const surface of ['in_venue', 'online'] as const) {
      const m = await menu.getPublicMenu(ctx, s.principal.venueId, { surface });
      for (const mm of m.menus) for (const sec of mm.sections) for (const i of sec.items) if (!byId.has(i.id)) byId.set(i.id, { id: i.id, name: i.name, section: sec.name, available: i.isAvailable });
    }
    return [...byId.values()];
  });
  return { items };
});

/** POST /kitchen/api/menu { itemId, available }: the 86 button. An 86 lasts until the end of the current service. */
export const POST = route(async (req) => {
  const body = await readJson<{ itemId?: string; available?: boolean }>(req);
  const r = await asDevice(req, (ctx) =>
    menu.setItemAvailability(ctx, { itemId: String(body.itemId ?? ''), available: Boolean(body.available), until: body.available ? null : 'end_of_service' }),
  );
  return { itemId: r.itemId, available: r.available, until: r.until };
});
