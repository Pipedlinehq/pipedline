import { AppError } from '@ros/core';
import { analytics } from '@ros/modules';
import { errorResponse } from '@/lib/http';
import { asStaff, getStaffSession } from '@/lib/staff';

export const dynamic = 'force-dynamic';

/**
 * A metric question's answer as a file. The question comes from the URL; the org and the venues
 * the person may see come from their session, and exportMetrics checks both and records the export.
 */
export async function GET(req: Request): Promise<Response> {
  // Signed out: the sign-in redirect happens here, outside the error mapping below.
  await getStaffSession();
  try {
    return await answer(req);
  } catch (e) {
    return errorResponse(e);
  }
}

async function answer(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let query: unknown;
  try {
    query = JSON.parse(url.searchParams.get('q') ?? '');
  } catch {
    throw new AppError('invalid', 'That export link is not complete. Ask the question again and download from there.');
  }
  const format = url.searchParams.get('format') === 'ndjson' ? 'ndjson' : 'csv';
  const out = await asStaff((ctx) => analytics.exportMetrics(ctx, { query: query as analytics.MetricQuery, format }));
  return new Response(out.body, {
    headers: {
      'content-type': out.contentType,
      'content-disposition': `attachment; filename="${out.filename.replace(/[^\w.-]/g, '_')}"`,
      'cache-control': 'no-store',
    },
  });
}
