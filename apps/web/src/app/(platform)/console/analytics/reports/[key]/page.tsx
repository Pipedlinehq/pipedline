import Link from 'next/link';
import { notFound } from 'next/navigation';
import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { readFilter } from '@/lib/console-filters';
import { show } from '@/lib/console-analytics';
import { ActionForm, Badge, Card, Checkbox, Dialog, Field, Input, LinkButton, PageHeader, Select, SubmitButton, Textarea } from '@/ui';
import { AnalyticsFilterRow, Caveats, Provenance } from '@/components/console/provenance';
import { ResultTable } from '@/components/console/analytics/blocks';
import { ReportFigure, TargetMeter } from '@/components/console/analytics/reports';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ReadError } from '@/components/console/states';
import { addAnnotationAction, deleteAnnotationAction, deleteReportAction, deleteTargetAction, saveReportAction, setTargetAction } from '../actions';

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : sp[k]) as string | undefined;
const COMPARE_WORDS = { previous_period: 'Previous period', same_period_last_year: 'Same period last year' } as const;

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return { title: `${decodeURIComponent(key)} · Reports · Pipedline` };
}

/**
 * A report page (docs/CONSOLE_IA.md section 9, pattern 9): date range · compare to · chart · table
 * · download · save as. Every figure is queryMetrics for the report's question; the page draws and
 * never recomputes. Targets and annotations sit beside the chart for the venue being looked at.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<SP> }) {
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);
  const sp = await searchParams;
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  const f = readFilter(sp, c, { compare: null });
  const grainRaw = one(sp, 'grain');
  const grain = grainRaw === 'day' || grainRaw === 'week' || grainRaw === 'month' ? grainRaw : undefined;
  const tz = c.venue.timezone;
  const compareLabel = f.compare ? COMPARE_WORDS[f.compare] : 'Comparison';

  const run = await read((ctx) => analytics.runReport(ctx, { report: key, period: f.period, ...(f.compare ? { compareTo: f.compare } : {}), ...(f.venueId ? { venueId: f.venueId } : {}), ...(grain ? { grain } : {}), limit: 500 }));
  if (!run.ok) {
    if (run.code === 'not_found') notFound();
    return (
      <div className="space-y-6">
        <PageHeader title="Report" />
        <ReadError message={run.error} />
      </div>
    );
  }
  const { report, result, annotations } = run.data;
  const lead = result.metrics[0]!;
  const targetable = lead.adds_up || (lead.unit === 'ratio' && analytics.getMetric(lead.key)?.aggregation !== 'distinct');
  const month = result.period.to.slice(0, 7);
  const [target, targets] = await Promise.all([
    targetable ? read((ctx) => analytics.targetProgress(ctx, { metric: lead.key, month, ...(f.venueId ? { venueId: f.venueId } : {}) })) : null,
    manager ? read((ctx) => analytics.listTargets(ctx, { metric: lead.key, ...(f.venueId ? { venueId: f.venueId } : {}) })) : null,
  ]);
  const path = `/console/analytics/reports/${encodeURIComponent(rawKey)}`;
  const query = new URLSearchParams(f.query);
  if (grain) query.set('grain', grain);
  const exportHref = c.isOwner ? `${path}/export?${query.toString()}&format=csv` : null;
  const savedQuery = JSON.stringify(report.query);
  const unitWord = lead.unit === 'cents' ? 'dollars' : lead.unit === 'ratio' ? 'percent' : lead.unit === 'days' ? 'days' : 'a number';
  const targetValue = (p: analytics.TargetProgress) => (p.target === null ? '' : lead.unit === 'cents' ? (p.target / 100).toFixed(2) : lead.unit === 'ratio' ? String(Math.round(p.target * 1000) / 10) : String(p.target));

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={
          <Link href="/console/analytics/reports" className="text-accent">
            Reports · {analytics.REPORT_CATEGORY_WORDS[report.category].title}
          </Link>
        }
        title={report.name}
        description={`${report.description} Created by ${report.createdBy}.`}
        actions={
          <>
            {exportHref ? (
              <LinkButton href={exportHref} size="sm" variant="secondary">
                Download CSV
              </LinkButton>
            ) : null}
            {manager ? (
              <Dialog trigger="Save as…" title="Save this report as your own" triggerSize="sm" triggerVariant="primary">
                <ActionForm action={saveReportAction} className="space-y-4" resetOnSuccess>
                  <input type="hidden" name="query" value={savedQuery} />
                  <input type="hidden" name="chart" value={report.chart} />
                  <p className="text-sm text-ink-2">The report keeps its question; you give it a name and a place in the catalogue. The dates are chosen each time it is opened.</p>
                  <Field label="Name">
                    <Input name="name" required maxLength={80} defaultValue={report.id ? report.name : `${report.name} (ours)`} data-testid="save-report-name" />
                  </Field>
                  <Field label="Description" hint="Optional">
                    <Textarea name="description" maxLength={400} defaultValue={report.description} />
                  </Field>
                  <Field label="Category">
                    <Select name="category" defaultValue={report.category}>
                      {analytics.REPORT_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {analytics.REPORT_CATEGORY_WORDS[cat].title}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex justify-end">
                    <SubmitButton pendingLabel="Saving…">Save report</SubmitButton>
                  </div>
                </ActionForm>
              </Dialog>
            ) : null}
          </>
        }
      />
      <AnalyticsTabs current="/console/analytics/reports" query={f.query} manager={manager} />
      <div>
        <AnalyticsFilterRow filter={f} c={c} extra={grain ? { grain } : undefined} />
        {report.chart === 'line' ? (
          <nav aria-label="Split by" className="-mt-3 mb-4 flex flex-wrap items-center gap-2 text-xs text-ink-2">
            <span>Split by</span>
            {(['day', 'week', 'month'] as const).map((g) => {
              const q = new URLSearchParams(f.query);
              q.set('grain', g);
              const on = (result.grain ?? '') === g;
              return (
                <Link key={g} href={`${path}?${q.toString()}`} aria-current={on ? 'page' : undefined} className={`rounded-full px-2.5 py-0.5 ${on ? 'bg-ink text-surface' : 'bg-sunken text-ink-2 hover:text-ink'}`}>
                  {g}
                </Link>
              );
            })}
          </nav>
        ) : null}
        <div data-testid="report-figure">
          <ReportFigure report={report} result={result} annotations={annotations} compareLabel={compareLabel} />
        </div>
        <Provenance result={result} timeZone={tz} />
        <Caveats items={result.caveats} />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card title="The table" description={`${result.rows.length} ${result.rows.length === 1 ? 'row' : 'rows'}${result.truncated ? ' (the first 500)' : ''}; the total is the whole period, not a sum of the rows where a metric does not add up.`} padded={false}>
          <div data-testid="report-table">
            <ResultTable result={result} max={500} />
          </div>
        </Card>
        <div className="space-y-6">
          {targetable ? (
            <Card title="Target" description={`${lead.name}, per calendar month, for ${f.venueId ? c.venues.find((v) => v.id === f.venueId)?.name ?? c.venue.name : 'the whole organisation'}.`}>
              {target?.ok ? <TargetMeter p={target.data} currency={result.currency} /> : target && !target.ok ? <p className="text-sm text-ink-2">{target.error}</p> : null}
              {target?.ok && target.data.target === null ? <p className="text-sm text-ink-2" data-testid="target-none">No target for {month} yet{manager ? ': set one below.' : '.'}</p> : null}
              {manager ? (
                <ActionForm action={setTargetAction} className="mt-4 space-y-3" resetOnSuccess>
                  <input type="hidden" name="path" value={path} />
                  <input type="hidden" name="metric" value={lead.key} />
                  <input type="hidden" name="unit" value={lead.unit} />
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Month">
                      <Input name="month" type="month" defaultValue={month} required />
                    </Field>
                    <Field label={`Target (${unitWord})`}>
                      <Input name="target" inputMode="decimal" required defaultValue={target?.ok ? targetValue(target.data) : ''} data-testid="target-input" />
                    </Field>
                  </div>
                  {c.venues.length > 1 ? <Checkbox name="everyVenue" value="1" defaultChecked={!f.venueId} label="For the whole organisation" hint="Otherwise for the venue you are looking at." /> : <input type="hidden" name="everyVenue" value="1" />}
                  <div className="flex justify-end">
                    <SubmitButton size="sm" pendingLabel="Saving…">
                      Set target
                    </SubmitButton>
                  </div>
                </ActionForm>
              ) : null}
              {targets?.ok && targets.data.length ? (
                <ul className="mt-4 divide-y divide-line text-sm" data-testid="target-list">
                  {targets.data.slice(0, 6).map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="text-ink-2">
                        {t.month} · {show(t.target, lead.unit as 'cents', result.currency)}
                        {t.venueId ? '' : <span className="text-ink-3"> · whole organisation</span>}
                      </span>
                      <InlineAction action={deleteTargetAction} hidden={{ id: t.id, path, name: lead.name }} label="Remove" />
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}
          <Card title="Marked dates" description="A note on a date, drawn on every report chart whose dates cover it: a menu change, a public holiday, the night the review went round.">
            {annotations.length ? (
              <ul className="divide-y divide-line text-sm" data-testid="annotation-list">
                {annotations.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 py-2">
                    <span>
                      <span className="font-medium text-ink">{a.date}</span> <span className="text-ink-2">{a.label}</span>
                      <span className="block text-xs text-ink-3">
                        {a.venueId ? 'This venue' : 'Every venue'} · {a.createdBy}
                      </span>
                    </span>
                    {manager ? <InlineAction action={deleteAnnotationAction} hidden={{ id: a.id, path }} label="Remove" /> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-3">Nothing marked between {result.period.from} and {result.period.to}.</p>
            )}
            {manager ? (
              <ActionForm action={addAnnotationAction} className="mt-4 space-y-3" resetOnSuccess>
                <input type="hidden" name="path" value={path} />
                <div className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-3">
                  <Field label="Date">
                    <Input name="date" type="date" required defaultValue={result.period.to} min={result.period.from} max={result.period.to} data-testid="annotation-date" />
                  </Field>
                  <Field label="What happened">
                    <Input name="label" required maxLength={80} placeholder="Menu change" data-testid="annotation-label" />
                  </Field>
                </div>
                {c.venues.length > 1 ? <Checkbox name="everyVenue" value="1" label="Every venue" hint="Otherwise only the venue you are looking at." /> : <input type="hidden" name="everyVenue" value="1" />}
                <div className="flex justify-end">
                  <SubmitButton size="sm" pendingLabel="Marking…">
                    Mark this date
                  </SubmitButton>
                </div>
              </ActionForm>
            ) : null}
          </Card>
          <Card title="About this report">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Measures</dt>
                <dd className="mt-0.5 flex flex-wrap gap-1.5">
                  {result.metrics.map((m) => (
                    <Badge key={m.key}>{m.name}</Badge>
                  ))}
                </dd>
              </div>
              {result.dimensions.length ? (
                <div>
                  <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Split by</dt>
                  <dd className="mt-0.5 text-ink-2">{result.dimensions.join(', ')}</dd>
                </div>
              ) : null}
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">How the first measure is worked out</dt>
                <dd className="mt-0.5 text-ink-2">{analytics.getMetric(lead.key)?.computation}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-[0.08em] text-ink-3">Your assistant runs it as</dt>
                <dd className="mt-0.5 font-mono text-xs text-ink">report_run · {report.key}</dd>
              </div>
              {report.id && manager ? (
                <div className="pt-2">
                  <ConfirmAction trigger="Delete this report" title={`Delete “${report.name}”?`} action={deleteReportAction} hidden={{ id: report.id }} confirmLabel="Delete the report">
                    The saved report is removed for everyone at the organisation. No numbers are deleted.
                  </ConfirmAction>
                </div>
              ) : null}
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
