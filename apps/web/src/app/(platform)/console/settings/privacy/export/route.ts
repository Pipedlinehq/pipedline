import { onboarding } from '@ros/modules';
import { route } from '@/lib/http';
import { asStaff } from '@/lib/staff';

export const dynamic = 'force-dynamic';

/**
 * The organisation's data as one JSON file, for its owner (onboarding.exportOrgData checks
 * that and audits the export). POST only, from the console's own page: `route()` refuses a
 * cross-site request, so another site cannot make a signed-in owner's browser start one.
 */
export const POST = route(async () => {
  const data = await asStaff((ctx) => onboarding.exportOrgData(ctx));
  const day = data.exportedAt.slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="organisation-export-${day}.json"`,
      'cache-control': 'no-store',
    },
  });
});
