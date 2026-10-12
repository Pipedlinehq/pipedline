import Link from 'next/link';
import { events, offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { ModuleOff, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { Badge, Card, EmptyState, LinkButton, PageHeader, RankBars, StatTile, Table, Td, Th, compactMoney, money, percent } from '@/ui';
import { APPLIES_TO, AUDIENCES, METHODS, STATUS_WORDS } from './offer-form';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Offers · Pipedline' };

const DAYS = [30, 90, 365] as const;

/**
 * Offers (docs/CONSOLE_IA.md section 9, pattern 6): the list with its lifecycle views, Active ·
 * Scheduled · Expired · Switched off · All, worked out from each offer's dates at this moment;
 * method, what it comes off and who it is for as filters; uses and the sales they sat on.
 */
const SPEC: ViewSpec = {
  page: 'offers',
  path: '/console/offers',
  landing: 'active',
  defaults: [
    { key: 'active', label: 'Active', filters: { status: 'active' } },
    { key: 'scheduled', label: 'Scheduled', filters: { status: 'scheduled' } },
    { key: 'expired', label: 'Expired', filters: { status: 'expired' } },
    { key: 'off', label: 'Switched off', filters: { status: 'off' } },
    { key: 'all', label: 'All', filters: {} },
  ],
  fields: [
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'active', label: 'Active' },
        { value: 'scheduled', label: 'Scheduled' },
        { value: 'expired', label: 'Expired' },
        { value: 'off', label: 'Switched off' },
        // Wave 1's tokens still mean what they meant.
        { value: 'on', label: 'On' },
      ],
    },
    { key: 'method', label: 'How it is used', kind: 'select', options: Object.entries(METHODS).map(([value, label]) => ({ value, label })) },
    { key: 'applies', label: 'Comes off', kind: 'select', options: Object.entries(APPLIES_TO).map(([value, label]) => ({ value, label })) },
    { key: 'who', label: 'For', kind: 'select', options: Object.entries(AUDIENCES).map(([value, label]) => ({ value, label })) },
    {
      key: 'days',
      label: 'Used in',
      kind: 'select',
      options: DAYS.map((d) => ({ value: String(d), label: `Last ${d} days` })),
    },
  ],
};

export default async function OffersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="Offers" what="Offers" canManage={manager} />;
  const raw = await searchParams;
  // The old period links (?days=90) still mean what they meant.
  const sp = raw.days && raw.f !== '1' ? { ...raw, f: '1', view: 'all' } : raw;
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'offers' }));
  const resolved = resolveView(SPEC, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const days = DAYS.find((d) => String(d) === f.days) ?? 90;
  const status = f.status === 'on' ? undefined : (f.status as offers.OfferStatus | undefined);
  const [list, summary] = await Promise.all([
    read((ctx) => offers.listOffers(ctx, { includeInactive: true, active: f.status === 'on' ? true : undefined, status, method: (f.method as offers.OfferMethod) || undefined })),
    read((ctx) => offers.getOffersSummary(ctx, { days })),
  ]);
  const stats = new Map(summary.ok ? summary.data.offers.map((s) => [s.offerId, s]) : []);
  const rows = list.ok ? list.data.filter((o) => (!f.applies || o.appliesTo === f.applies) && (!f.who || o.audience === f.who)) : [];
  const cur = c.org.currency;
  return (
    <>
      <PageHeader
        title="Offers"
        description="Offers by code or applied automatically: what they give, who they are for, when they run, and how often they were used."
        actions={
          manager ? (
            <>
              <LinkButton href="/console/offers/surcharges" size="sm">
                Surcharges
              </LinkButton>
              <LinkButton href="/console/offers/new" variant="primary">
                New offer
              </LinkButton>
            </>
          ) : undefined
        }
      />
      <IndexViews page="offers" path="/console/offers" resolved={resolved} fields={SPEC.fields} canSave={c.role !== 'read_only'} saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={`Uses in the last ${days} days`} />
      {!summary.ok ? (
        <ReadError message={summary.error} />
      ) : (
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Codes issued" value={summary.data.totals.issued.toLocaleString('en-AU')} hint={`${summary.data.totals.live.toLocaleString('en-AU')} still usable`} />
            <StatTile label="Uses" value={summary.data.totals.uses.toLocaleString('en-AU')} hint={`Codes used and automatic offers applied; ${percent(summary.data.totals.redemptionRate, 1)} of codes used`} />
            <StatTile label="Given away" value={compactMoney(summary.data.totals.discountCents, cur)} hint="What the uses took off" />
            <StatTile label="Sales they sat on" value={compactMoney(summary.data.totals.revenueCents, cur)} hint="Net of refunds; not caused by the offer" />
          </div>
          {summary.data.offers.some((o) => o.uses > 0) ? (
            <RankBars
              title="Uses, by offer"
              rows={summary.data.offers.filter((o) => o.uses > 0).map((o) => ({ label: o.name, value: o.uses, detail: o.method === 'code' ? `${percent(o.redemptionRate, 0)} of ${o.issued} codes` : 'automatic' }))}
              note="A use shows the offer was taken up. It does not show the sale would not have happened anyway."
            />
          ) : null}
        </div>
      )}
      {!list.ok ? (
        <ReadError message={list.error} />
      ) : rows.length === 0 ? (
        <EmptyState title={Object.keys(f).length ? 'No offers match this view' : 'No offers yet'} action={manager && !Object.keys(f).length ? <LinkButton href="/console/offers/new">Create one</LinkButton> : undefined}>
          {Object.keys(f).length ? 'Try another view, or clear a filter.' : manager ? 'Create an offer: a code guests hold, or a special applied by itself.' : 'A manager can create offers.'}
        </EmptyState>
      ) : (
        <Card padded={false}>
          <Table label="Offers">
            <thead>
              <tr>
                <Th>Offer</Th>
                <Th>How</Th>
                <Th>For</Th>
                <Th align="right">Uses</Th>
                <Th align="right">Given away</Th>
                <Th align="right">Sales</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const s = stats.get(o.id);
                const st = STATUS_WORDS[o.status];
                return (
                  <tr key={o.id} data-testid={`offer-${o.id}`} data-status={o.status}>
                    <Td>
                      <Link href={`/console/offers/${o.id}`} className="font-medium text-accent hover:underline">
                        {o.name}
                      </Link>
                      <span className="block max-w-md text-xs text-ink-3" data-testid="offer-summary">
                        {o.summary}
                      </span>
                    </Td>
                    <Td className="whitespace-nowrap">{METHODS[o.method]}</Td>
                    <Td className="whitespace-nowrap">{o.audience === 'list' ? (o.segmentName ?? 'A guest list') : AUDIENCES[o.audience]}</Td>
                    <Td numeric>{s?.uses.toLocaleString('en-AU') ?? 0}</Td>
                    <Td numeric>{money(s?.discountCents ?? 0, cur)}</Td>
                    <Td numeric>{money(s?.revenueCents ?? 0, cur)}</Td>
                    <Td>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
