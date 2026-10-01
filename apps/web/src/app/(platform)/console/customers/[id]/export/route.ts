import { AppError } from '@ros/core';
import { identity } from '@ros/modules';
import { route } from '@/lib/http';
import { asStaff } from '@/lib/staff';

/**
 * Everything held about one guest, as a JSON download, for the guest's access request. POST
 * only (route() refuses a cross-site request), owner only (the service checks), audited by the
 * service.
 */
export const POST = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError('not_found', 'Customer not found');
  const data = await asStaff((ctx) => identity.exportCustomer(ctx, id));
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="customer-${id}.json"`,
      'cache-control': 'no-store',
    },
  });
});
