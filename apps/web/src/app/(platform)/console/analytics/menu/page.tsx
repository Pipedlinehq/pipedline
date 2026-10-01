import Link from 'next/link';
import { analytics } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { readFilter } from '@/lib/console-filters';
import { BarChart, Card, EmptyState, PageHeader, RankBars, Table, Td, Th } from '@/ui';
import { money, percent } from '@/ui/format';
import { AnalyticsFilterRow, Caveats, Provenance } from '@/components/console/provenance';
import { AnalyticsTabs } from '@/components/console/analytics/tabs';
import { ReadError } from '@/components/console/states';

export const metadata = { title: 'Menu performance · Analytics · Pipedline' };

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => (Array.isArray(sp[k]) ? sp[k]![0] : (sp[k] as string | undefined));

/** What sells: quantity, revenue, mix and attach rate per item or category, and what moved. */
export default async function MenuAnalytics({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const f = readFilter(sp, c);
  const by = one(sp, 'by') === 'category' ? 'category' : 'item';
  const sortBy = (['revenue', 'quantity', 'attach_rate'] as const).find((s) => s === one(sp, 'sort')) ?? 'revenue';
  const tz = c.venue.timezone;
  const r = await read((ctx) => analytics.menuPerformance(ctx, { venueId: f.venueId, period: f.period, by, sortBy, limit: 40 }));
  const link = (patch: Record<string, string>) => `?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(f.query)), by, sort: sortBy, ...patch }).toString()}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Menu performance" description={`${f.venueLabel}. From the lines on each sale, named as they were sold.`} />
      <AnalyticsTabs current="/console/analytics/menu" query={f.query} manager={atLeast(c.role, 'manager')} />
      <AnalyticsFilterRow filter={f} c={c} showCompare={false} extra={{ by, sort: sortBy }} />
      <div className="flex flex-wrap gap-4 text-sm">
        <span className="text-ink-2">Group by:</span>
        {(['item', 'category'] as const).map((b) => (
          <Link key={b} href={link({ by: b })} aria-current={b === by ? 'true' : undefined} className={b === by ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
            {b === 'item' ? 'Item' : 'Category'}
          </Link>
        ))}
        <span className="ml-4 text-ink-2">Rank by:</span>
        {(['revenue', 'quantity', 'attach_rate'] as const).map((s) => (
          <Link key={s} href={link({ sort: s })} aria-current={s === sortBy ? 'true' : undefined} className={s === sortBy ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
            {s === 'attach_rate' ? 'Attach rate' : s === 'quantity' ? 'Quantity' : 'Revenue'}
          </Link>
        ))}
      </div>
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : !r.data.rows.length ? (
        <EmptyState title="No item sales in this period">{r.data.summary}</EmptyState>
      ) : (
        <>
          <p className="text-sm text-ink">{r.data.summary}</p>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <RankBars
              title={`Top ${by === 'item' ? 'items' : 'categories'} by ${sortBy.replace('_', ' ')}`}
              rows={r.data.rows.map((x) => ({
                label: x.name,
                value: sortBy === 'revenue' ? x.revenue_cents : sortBy === 'quantity' ? x.quantity : (x.attach_rate ?? 0),
                detail: sortBy === 'revenue' ? `${x.quantity} sold` : money(x.revenue_cents, r.data.currency),
              }))}
              format={sortBy === 'revenue' ? 'money' : sortBy === 'quantity' ? 'number' : 'percent'}
              currency={r.data.currency}
              limit={12}
            />
            <BarChart
              title="Biggest movers against the period before"
              subtitle="Change in revenue"
              x={[...r.data.rising, ...r.data.falling].map((m) => m.name)}
              xLabel={by === 'item' ? 'Item' : 'Category'}
              series={[
                { key: 'up', label: 'Up', values: [...r.data.rising.map((m) => m.revenue_change_cents), ...r.data.falling.map(() => null)], slot: 3 },
                { key: 'down', label: 'Down (size of fall)', values: [...r.data.rising.map(() => null), ...r.data.falling.map((m) => -m.revenue_change_cents)], slot: 2 },
              ]}
              format="money"
              currency={r.data.currency}
            />
          </div>
          <Card title="Every line" description={`${r.data.total_lines} ${by === 'item' ? 'items' : 'categories'} sold; ${r.data.rows.length} shown.`} padded={false}>
            <Table>
              <thead>
                <tr>
                  <Th>{by === 'item' ? 'Item' : 'Category'}</Th>
                  <Th align="right">Quantity</Th>
                  <Th align="right">Revenue</Th>
                  <Th align="right">Mix</Th>
                  <Th align="right">On orders</Th>
                  <Th align="right">Attach rate</Th>
                  <Th align="right">Period before</Th>
                  <Th align="right">Change</Th>
                </tr>
              </thead>
              <tbody>
                {r.data.rows.map((x) => (
                  <tr key={x.name}>
                    <Td>{x.name}</Td>
                    <Td numeric>{x.quantity}</Td>
                    <Td numeric>{money(x.revenue_cents, r.data.currency)}</Td>
                    <Td numeric>{percent(x.revenue_share, 1)}</Td>
                    <Td numeric>{x.orders_containing}</Td>
                    <Td numeric>{percent(x.attach_rate, 1)}</Td>
                    <Td numeric>{money(x.previous_revenue_cents, r.data.currency)}</Td>
                    <Td numeric>{x.revenue_change_pct === null ? '–' : `${x.revenue_change_pct > 0 ? '+' : ''}${(x.revenue_change_pct * 100).toFixed(1)}%`}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          <Provenance result={{ period: r.data.period, compare: r.data.compared_with, as_of: r.data.as_of }} timeZone={tz} />
          <Caveats items={r.data.caveats} />
        </>
      )}
    </div>
  );
}
