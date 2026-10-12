import Link from 'next/link';
import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { Badge, Card, EmptyState, PageHeader, dateTime } from '@/ui';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ConfirmAction } from '@/components/console/confirm';
import { ReadError } from '@/components/console/states';
import { deleteReportAction } from './actions';

export const metadata = { title: 'Reports · Analytics · Pipedline' };

const CHART_WORDS: Record<analytics.ReportChart, string> = { line: 'Over time', bars: 'Side by side', rank: 'Ranked', cohort: 'Cohorts', tiles: 'Figures' };

/**
 * The reports catalogue (docs/CONSOLE_IA.md section 9, pattern 9): every report by category,
 * the defaults created by Pipedline and the venue's own beside them with who saved them. Each
 * opens as a report page with a date range, a comparison, a chart, a table and a download.
 */
export default async function ReportsPage() {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const reports = await read((ctx) => analytics.listReports(ctx));
  const tz = c.venue.timezone;
  return (
    <div className="space-y-8">
      <PageHeader title="Reports" description="Every report asks the metric catalogue a question, so the number here is the number your assistant gives. Open one, pick the dates and what to compare with, and download the table." />
      <AnalyticsTabs current="/console/analytics/reports" manager={manager} />
      {!reports.ok ? (
        <ReadError message={reports.error} />
      ) : (
        <div className="space-y-8" data-testid="reports-catalogue">
          {analytics.REPORT_CATEGORIES.map((cat) => {
            const words = analytics.REPORT_CATEGORY_WORDS[cat];
            const entries = reports.data.filter((r) => r.category === cat);
            return (
              <section key={cat} aria-labelledby={`reports-${cat}`} data-testid={`reports-${cat}`}>
                <div className="mb-3">
                  <h2 id={`reports-${cat}`} className="text-lg font-semibold text-ink">
                    {words.title}
                  </h2>
                  <p className="text-sm text-ink-2">{words.blurb}</p>
                </div>
                {entries.length === 0 ? (
                  <EmptyState title={`No ${words.title.toLowerCase()} reports yet`}>The metric catalogue has no measures for this yet, so there is nothing to report on. When it does, the reports appear here.</EmptyState>
                ) : (
                  <Card padded={false}>
                    <ul className="divide-y divide-line">
                      {entries.map((r) => (
                        <li key={r.key} className="flex flex-wrap items-start justify-between gap-3 px-5 py-4" data-testid={`report-${r.key}`}>
                          <div className="min-w-0 flex-1 basis-72">
                            <Link href={`/console/analytics/reports/${encodeURIComponent(r.id ?? r.key)}`} className="font-medium text-accent hover:underline">
                              {r.name}
                            </Link>
                            <p className="mt-0.5 text-sm text-ink-2">{r.description}</p>
                            <p className="mt-1 text-xs text-ink-3">
                              Created by {r.createdBy}
                              {r.createdAt ? ` · ${dateTime(r.createdAt, tz, { date: true, time: false })}` : ''} · {r.query.metrics.length} {r.query.metrics.length === 1 ? 'measure' : 'measures'}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone={r.id ? 'accent' : 'neutral'}>{r.id ? 'Yours' : 'Pipedline'}</Badge>
                            <Badge>{CHART_WORDS[r.chart]}</Badge>
                            {r.id && manager ? (
                              <ConfirmAction trigger="Delete" title={`Delete “${r.name}”?`} action={deleteReportAction} hidden={{ id: r.id }} confirmLabel="Delete the report" testId={`delete-report-${r.id}`}>
                                The saved report is removed for everyone at the organisation. No numbers are deleted: it only asked a question.
                              </ConfirmAction>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
