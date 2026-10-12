import { AppError } from '@ros/core';
import { analytics } from '@ros/modules';
import { errorResponse } from '@/lib/http';
import { asStaff, getStaffSession } from '@/lib/staff';

export const dynamic = 'force-dynamic';

/**
 * A report's rows as a file: the same question the page ran, through exportReport, which is
 * owner only and records the export. The period, comparison and venue come from the URL; the
 * organisation from the session.
 */
export async function GET(req: Request, { params }: { params: Promise<{ key: string }> }): Promise<Response> {
  await getStaffSession();
  try {
    const { key } = await params;
    const url = new URL(req.url);
    const q = url.searchParams;
    const periodKey = q.get('period') ?? 'last_28_days';
    const from = q.get('from') ?? '';
    const to = q.get('to') ?? '';
    const period = periodKey === 'custom' ? { from, to } : periodKey;
    const compare = q.get('compare');
    const venue = q.get('venue');
    const grain = q.get('grain');
    const format = q.get('format') === 'ndjson' ? 'ndjson' : 'csv';
    if (periodKey === 'custom' && !(/^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to))) throw new AppError('invalid', 'That export link is not complete. Open the report again and download from there.');
    const out = await asStaff((ctx) =>
      analytics.exportReport(ctx, {
        report: decodeURIComponent(key),
        period: period as analytics.RunReportInput['period'],
        ...(compare === 'previous_period' || compare === 'same_period_last_year' ? { compareTo: compare } : {}),
        ...(venue && venue !== 'all' ? { venueId: venue } : {}),
        ...(grain === 'day' || grain === 'week' || grain === 'month' ? { grain } : {}),
        format,
      }),
    );
    return new Response(out.body, {
      headers: { 'content-type': out.contentType, 'content-disposition': `attachment; filename="${out.filename.replace(/[^\w.-]/g, '_')}"`, 'cache-control': 'no-store' },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
