'use server';

import { analytics } from '@ros/modules';
import type { FormState } from '@/ui/client';
import { act, bool, nullableText, optText, text } from '@/lib/console-actions';

/** Reports changes. The services make every role check; the venue comes from the console, never the form. */
const REPORTS = '/console/analytics/reports';

export async function saveReportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  let query: unknown;
  try {
    query = JSON.parse(text(fd, 'query'));
  } catch {
    return { ok: false, error: 'That report could not be read. Open it again, then save.' };
  }
  const category = text(fd, 'category') as analytics.ReportCategory;
  const chart = text(fd, 'chart') as analytics.ReportChart;
  return act((ctx) => analytics.saveReport(ctx, { name: text(fd, 'name'), description: optText(fd, 'description') ?? null, category, chart, query: query as analytics.ReportQuery }), {
    success: (r) => `Saved as “${r.name}” under ${analytics.REPORT_CATEGORY_WORDS[r.category].title}.`,
    revalidate: [REPORTS, '/console'],
  });
}

export async function deleteReportAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return act((ctx) => analytics.deleteReport(ctx, text(fd, 'id')), { success: 'Deleted. The numbers it asked about are untouched.', revalidate: [REPORTS] });
}

export async function addAnnotationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const path = text(fd, 'path') || REPORTS;
  return act((ctx, c) => analytics.addAnnotation(ctx, { date: text(fd, 'date'), label: text(fd, 'label'), venueId: bool(fd, 'everyVenue') ? null : c.venue.id }), {
    success: (a) => `Marked ${a.date}: ${a.label}.`,
    revalidate: [path, REPORTS],
  });
}

export async function deleteAnnotationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const path = text(fd, 'path') || REPORTS;
  return act((ctx) => analytics.deleteAnnotation(ctx, text(fd, 'id')), { success: 'The mark is gone.', revalidate: [path, REPORTS] });
}

export async function setTargetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const path = text(fd, 'path') || REPORTS;
  const metric = text(fd, 'metric');
  const unit = text(fd, 'unit');
  const raw = text(fd, 'target').replace(/[$,%\s]/g, '');
  if (raw === '' || !Number.isFinite(Number(raw))) return { ok: false, error: 'Give the target as a number.' };
  // Money is typed in dollars and kept in cents; a rate is typed as a percentage and kept as a share.
  const target = unit === 'cents' ? Math.round(Number(raw) * 100) : unit === 'ratio' ? Number(raw) / 100 : Number(raw);
  return act((ctx, c) => analytics.setTarget(ctx, { metric, month: text(fd, 'month'), target, venueId: bool(fd, 'everyVenue') ? null : c.venue.id }), {
    success: 'Target set. Progress is read from the same numbers as the report.',
    revalidate: [path, REPORTS],
  });
}

export async function deleteTargetAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const path = text(fd, 'path') || REPORTS;
  return act((ctx) => analytics.deleteTarget(ctx, text(fd, 'id')), { success: nullableText(fd, 'name') ? `The ${text(fd, 'name')} target is gone.` : 'The target is gone.', revalidate: [path, REPORTS] });
}
