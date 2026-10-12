import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { app } from '@/lib/runtime';
import { pick, siteActor } from '@/lib/site-api';
import { readTable } from '@/lib/site-table';

/**
 * Checkout, step one (ordering.createOrder): priced by the server, the guest resolved, the boxes
 * they ticked recorded with the wording version they were shown, the slot held. Nothing is
 * charged here. The visitor session and the table code are the server's to add, not the body's.
 */
export const POST = route(async (req, { params }: { params: Promise<{ host: string }> }) => {
  const actor = await siteActor(req, (await params).host);
  const body = await readJson<Record<string, unknown>>(req);
  // `source` says where the guest came from (their own assistant handed them a cart); the service accepts only website or assistant.
  const input = pick(body, ['venueId', 'channel', 'lines', 'codes', 'tipCents', 'slotStart', 'deliveryId', 'idempotencyKey', 'customer', 'note', 'consents', 'flags', 'source'] as const);
  const table = input.channel === 'dine-in-qr' ? await readTable(input.venueId) : null;
  const order = await app().tenant(
    actor.site.orgId,
    actor.principal,
    (ctx) => ordering.createOrder(ctx, { ...(input as object), qrCode: table?.code ?? null, sessionId: actor.visitorSessionId } as never),
    { ip: actor.ip },
  );
  return { reference: order.reference, trackingToken: order.trackingToken, totalCents: order.totalCents, currency: order.currency, status: order.status, paymentStatus: order.paymentStatus };
});
