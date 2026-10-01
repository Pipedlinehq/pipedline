import type { analytics } from '@ros/modules';
import { EmptyState, RankBars } from '@/ui';
import { percent } from '@/ui/format';
import { words } from '@/lib/console-analytics';

/** The declared funnel's steps with visits reaching each one and the conversion between them. */
export function FunnelSteps({ report }: { report: analytics.FunnelReport }) {
  if (!report.steps.length || !report.steps[0]!.sessions) {
    return <EmptyState title="No visits in this period">{report.summary}</EmptyState>;
  }
  return (
    <div className="space-y-3">
      <RankBars
        title={`The ${words(report.funnel).toLowerCase()} funnel`}
        subtitle={report.summary}
        rows={report.steps.map((s) => ({
          label: `${s.step}. ${words(s.event)}`,
          value: s.sessions,
          detail: s.step === 1 ? 'start' : `${percent(s.conversion_from_previous, 1)} of the step before`,
        }))}
        limit={20}
      />
      {report.biggest_drop ? (
        <p className="text-sm text-ink-2">
          Biggest drop: between <strong className="font-medium text-ink">{words(report.biggest_drop.from_event)}</strong> and{' '}
          <strong className="font-medium text-ink">{words(report.biggest_drop.to_event)}</strong>, where {percent(report.biggest_drop.lost_share, 1)} of visits stop.
        </p>
      ) : null}
      <details className="text-xs text-ink-2">
        <summary className="cursor-pointer">What each step means</summary>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {report.steps.map((s) => (
            <li key={s.step}>
              <span className="font-medium text-ink">{words(s.event)}</span>: {s.meaning}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
