import { ordering } from '@ros/modules';
import { readJson, route } from '@/lib/http';
import { asDevice } from '@/lib/ops-device';

export const dynamic = 'force-dynamic';

/** POST /kitchen/api/reject { orderId, reason }: turn a new order down. It is refunded and the guest is told the reason. Online only. */
export const POST = route(async (req) => {
  const body = await readJson<{ orderId?: string; reason?: string }>(req);
  const order = await asDevice(req, (ctx) => ordering.updateOrderStatus(ctx, { orderId: String(body.orderId ?? ''), status: 'rejected', reason: body.reason }));
  return { status: order.status };
});
