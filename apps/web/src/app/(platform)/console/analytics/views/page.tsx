import Link from 'next/link';
import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { readFilter, venueFilter } from '@/lib/console-filters';
import { words } from '@/lib/console-analytics';
import { ActionForm, Badge, Card, Checkbox, EmptyState, Field, Input, PageHeader, SubmitButton, Table, Td, Th } from '@/ui';
import { AnalyticsFilterRow, Caveats, Provenance } from '@/components/console/provenance';
import { ResultTable } from '@/components/console/analytics/blocks';
import { ResultChart } from '@/components/console/analytics/views';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { ReadError } from '@/components/console/states';
import { deleteViewAction, pinViewAction, saveViewAction } from '../actions';

export const metadata = { title: 'Explore and saved views · Analytics · Restaurant OS' };

type SP = Record<string, string | string[] | undefined>;
const many = (sp: SP, k: string): string[] => (Array.isArray(sp[k]) ? (sp[k] as string[]) : sp[k] ? [sp[k] as string] : []);

/**
 * Ask any question the metric catalogue can answer, then keep the good ones as saved views so a
 * recurring question is asked the same way every time. A view stores the question, never the
 * answer: opening it asks again, as whoever opens it.
 */
export default async function ViewsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = readFilter(sp, c);
  const tz = c.venue.timezone;
  const manager = atLeast(c.role, 'manager');
  const catalogue = analytics.metricCatalogue();
  const viewId = many(sp, 'view')[0];
  const metrics = many(sp, 'm').filter((m) => catalogue.metrics.some((x) => x.key === m)).slice(0, 6);
  const dims = many(sp, 'd').filter((d) => catalogue.dimensions.some((x) => x.key === d)).slice(0, 2);
  const grainRaw = many(sp, 'g')[0];
  const grain = grainRaw === 'day' || grainRaw === 'week' || grainRaw === 'month' ? grainRaw : undefined;

  const asked: analytics.MetricQuery | null = metrics.length
    ? { metrics, dimensions: dims, period: f.period, ...(grain ? { grain } : {}), ...(f.compare ? { compareTo: f.compare } : {}), filters: venueFilter(f), limit: 200 }
    : null;

  const [views, answer, saved] = await Promise.all([
    read((ctx) => analytics.listViews(ctx)),
    asked ? read((ctx) => analytics.queryMetrics(ctx, asked)) : Promise.resolve(null),
    viewId ? read((ctx) => analytics.runView(ctx, { id: viewId })) : Promise.resolve(null),
  ]);
  const groups = [...new Set(catalogue.metrics.map((m) => m.group))];
  // Exports are for owners (exportMetrics refuses anyone else).
  const exportHref = asked && c.isOwner ? `/console/analytics/export?format=csv&q=${encodeURIComponent(JSON.stringify(asked))}` : null;

  return (
    <div className="space-y-8">
      <PageHeader title="Explore and saved views" description="Ask the numbers a question in the catalogue's own terms. Every answer carries its dates, sources and caveats." />
      <AnalyticsTabs current="/console/analytics/views" query={f.query} manager={manager} />

      {saved ? (
        saved.ok ? (
          <section aria-label="Saved view" className="space-y-2">
            <h2 className="text-lg font-semibold text-ink">{saved.data.view.name}</h2>
            {saved.data.view.description ? <p className="text-sm text-ink-2">{saved.data.view.description}</p> : null}
            <ResultChart result={saved.data.result} title={saved.data.view.name} />
            <div className="rounded-lg border border-line bg-surface">
              <ResultTable result={saved.data.result} max={200} />
            </div>
            <Provenance result={saved.data.result} timeZone={tz} />
            <Caveats items={saved.data.result.caveats} />
            <p className="text-xs text-ink-3">The saved question: {describe(saved.data.view.query)}</p>
          </section>
        ) : (
          <ReadError message={saved.error} />
        )
      ) : null}

      <Card title="Saved views" description="Shared with everyone at the organisation. Pinned views appear on the overview." padded={false}>
        {!views.ok ? (
          <div className="p-5">
            <ReadError message={views.error} />
          </div>
        ) : views.data.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No saved views yet">Ask a question below, then save it{manager ? '' : ' (a manager can save views)'}.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Asks for</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {views.data.map((v) => (
                <tr key={v.id} data-testid="saved-view">
                  <Td>
                    <Link href={`?view=${v.id}`} className="font-medium text-accent hover:underline">
                      {v.name}
                    </Link>
                    {v.description ? <p className="mt-0.5 text-xs text-ink-3">{v.description}</p> : null}
                  </Td>
                  <Td className="text-ink-2">{describe(v.query)}</Td>
                  <Td>{v.pinned ? <Badge tone="accent">Pinned</Badge> : <Badge>Saved</Badge>}</Td>
                  <Td>
                    {manager ? (
                      <div className="flex flex-wrap justify-end gap-2">
                        <InlineAction action={pinViewAction} hidden={{ id: v.id, pinned: String(!v.pinned) }} label={v.pinned ? 'Unpin' : 'Pin'} />
                        <ConfirmAction trigger="Delete" title={`Delete “${v.name}”?`} action={deleteViewAction} hidden={{ id: v.id }} confirmLabel="Delete the view">
                          The saved question is removed for everyone at the organisation{v.pinned ? ' and it leaves the overview' : ''}. No data is deleted: the numbers it asked about stay in the ledger.
                        </ConfirmAction>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <section aria-label="Ask a question" className="space-y-4">
        <h2 className="text-lg font-semibold text-ink">Ask a question</h2>
        <AnalyticsFilterRow filter={f} c={c} extra={[...metrics.map((m) => ['m', m] as [string, string]), ...dims.map((d) => ['d', d] as [string, string]), ...(grain ? [['g', grain] as [string, string]] : [])]} />
        <form method="get" className="space-y-4 rounded-lg border border-line bg-surface p-5">
          {Object.entries(Object.fromEntries(new URLSearchParams(f.query))).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          <fieldset>
            <legend className="text-sm font-medium text-ink">Measure (up to six)</legend>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {groups.map((g) => {
                const inGroup = catalogue.metrics.filter((m) => m.group === g);
                return (
                  <details key={g} open={inGroup.some((m) => metrics.includes(m.key)) || g === 'Sales'} className="rounded-md border border-line px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium text-ink-2">{g}</summary>
                    <div className="mt-2 space-y-1.5">
                      {inGroup.map((m) => (
                        <Checkbox key={m.key} name="m" value={m.key} defaultChecked={metrics.includes(m.key)} label={m.name} />
                      ))}
                    </div>
                  </details>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            {[0, 1].map((i) => (
              <label key={i} className="flex flex-col gap-1 text-xs font-medium text-ink-2">
                {i === 0 ? 'Split by' : 'Then by'}
                <select name="d" defaultValue={dims[i] ?? ''} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink">
                  <option value="">Nothing</option>
                  {catalogue.dimensions.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              Over time
              <select name="g" defaultValue={grain ?? ''} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink">
                <option value="">No, one total</option>
                <option value="day">By day</option>
                <option value="week">By week</option>
                <option value="month">By month</option>
              </select>
            </label>
            <SubmitButton size="sm">Ask</SubmitButton>
          </div>
        </form>

        {answer ? (
          answer.ok ? (
            <div className="space-y-3" data-testid="explore-answer">
              <ResultChart result={answer.data} title={answer.data.metrics.map((m) => m.name).join(', ')} />
              <div className="rounded-lg border border-line bg-surface">
                <ResultTable result={answer.data} max={200} />
              </div>
              <Provenance result={answer.data} timeZone={tz} />
              <Caveats items={answer.data.caveats} />
              <div className="flex flex-wrap items-start gap-4">
                {exportHref ? (
                  <a href={exportHref} className="inline-flex h-8 items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken" download>
                    Download as CSV
                  </a>
                ) : null}
                {manager ? (
                  <ActionForm action={saveViewAction} className="flex flex-1 flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4" resetOnSuccess>
                    <input type="hidden" name="query" value={JSON.stringify({ ...asked, limit: undefined })} />
                    <Field label="Save as" className="min-w-48 flex-1">
                      <Input name="name" required maxLength={80} placeholder="e.g. Friday dinner by channel" />
                    </Field>
                    <Field label="What it is for (optional)" className="min-w-48 flex-[2]">
                      <Input name="description" maxLength={400} />
                    </Field>
                    <Checkbox name="pinned" label="Pin to the overview" />
                    <SubmitButton size="sm" variant="secondary">
                      Save view
                    </SubmitButton>
                  </ActionForm>
                ) : null}
              </div>
            </div>
          ) : (
            <ReadError message={answer.error} />
          )
        ) : (
          <p className="text-sm text-ink-3">Tick at least one measure and press Ask.</p>
        )}
      </section>
    </div>
  );
}

function describe(q: analytics.MetricQuery): string {
  const period = typeof q.period === 'string' ? words(q.period).toLowerCase() : q.period ? `${q.period.from} to ${q.period.to}` : 'the last 28 days';
  const by = q.dimensions?.length ? ` by ${q.dimensions.map((d) => words(d).toLowerCase()).join(' and ')}` : '';
  const grain = q.grain ? `, per ${q.grain}` : '';
  const cmp = q.compareTo ? `, against the ${q.compareTo === 'previous_period' ? 'previous period' : 'same period last year'}` : '';
  return `${q.metrics.map((m) => words(m).toLowerCase()).join(', ')}${by}${grain}, ${period}${cmp}`;
}
