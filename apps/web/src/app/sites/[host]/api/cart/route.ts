import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { pick, siteActor } from '@/lib/site-api';
import { readTable } from '@/lib/site-table';

/**
 * Price a cart. The browser sends item ids, modifier ids, quantities, codes, a tip and a slot;
 * every price, discount, tax and total comes back from the server (ordering.priceCart). The
 * table code comes from the scanned-table cookie, and is resolved again by ordering.
 */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const body = await readJson<Record<string, unknown>>(req);
  const input = pick(body, ['venueId', 'channel', 'lines', 'codes', 'tipCents', 'slotStart', 'deliveryId'] as const);
  const table = input.channel === 'dine-in-qr' ? await readTable(input.venueId) : null;
  return app().tenant(actor.site.orgId, actor.principal, (ctx) => ordering.priceCart(ctx, { ...(input as object), qrCode: table?.code ?? null } as never), { ip: actor.ip });
});
