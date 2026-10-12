import Link from 'next/link';
import { events, offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { resolveView, type ViewSpec } from '@/lib/console-views';
import { ModuleOff, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { Badge, Card, EmptyState, LinkButton, PageHeader, RankBars, StatTile, Table, Td, Th, compactMoney, money, percent } from '@/ui';
import { OFFER_KINDS } from './offer-form';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Offers · Pipedline' };

const DAYS = [30, 90, 365] as const;

/**
 * Offers (docs/CONSOLE_IA.md section 9, wave 1): the list with saved views. Today an offer is on
 * or off; "Scheduled" and "Expired" arrive with the offer dates in wave 2 (pattern 6), as two more
 * default views in this spec and nothing else.
 */
const SPEC: ViewSpec = {
  page: 'offers',
  path: '/console/offers',
  landing: 'active',
  defaults: [
    { key: 'active', label: 'Active', filters: { status: 'on' } },
    { key: 'off', label: 'Switched off', filters: { status: 'off' } },
    { key: 'all', label: 'All', filters: {} },
  ],
  fields: [
    {
      key: 'status',
      label: 'Status',
      kind: 'select',
      options: [
        { value: 'on', label: 'On' },
        { value: 'off', label: 'Off' },
      ],
    },
    { key: 'kind', label: 'Kind', kind: 'select', options: Object.entries(OFFER_KINDS).map(([value, label]) => ({ value, label })) },
    {
      key: 'days',
      label: 'Codes issued in',
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
  const [list, summary] = await Promise.all([
    read((ctx) => offers.listOffers(ctx, { includeInactive: true, active: f.status === 'on' ? true : f.status === 'off' ? false : undefined, kind: (f.kind as offers.OfferKind) || undefined })),
    read((ctx) => offers.getOffersSummary(ctx, { days })),
  ]);
  const stats = new Map(summary.ok ? summary.data.offers.map((s) => [s.offerId, s]) : []);
  const cur = c.org.currency;
  return (
    <>
      <PageHeader
        title="Offers"
        description="Unique codes for welcome, come-back, voucher and creator offers. Every code is single use."
        actions={manager ? <LinkButton href="/console/offers/new" variant="primary">New offer</LinkButton> : undefined}
      />
      <IndexViews page="offers" path="/console/offers" resolved={resolved} fields={SPEC.fields} canSave={c.role !== 'read_only'} saveAction={saveView} renameAction={renameView} deleteAction={deleteView} aside={`Codes issued in the last ${days} days`} />
      {!summary.ok ? (
        <ReadError message={summary.error} />
      ) : (
        <div className="mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Codes issued" value={summary.data.totals.issued.toLocaleString('en-AU')} hint={`${summary.data.totals.live.toLocaleString('en-AU')} still usable`} />
            <StatTile label="Used" value={summary.data.totals.redeemed.toLocaleString('en-AU')} hint={`${percent(summary.data.totals.redemptionRate, 1)} of issued`} />
            <StatTile label="Given away" value={compactMoney(summary.data.totals.discountCents, cur)} hint="What used codes took off" />
            <StatTile label="Sales they were used on" value={compactMoney(summary.data.totals.revenueCents, cur)} hint="Net of refunds; not caused by the offer" />
          </div>
          {summary.data.offers.some((o) => o.redeemed > 0) ? (
            <RankBars
              title="Codes used, by offer"
              rows={summary.data.offers.filter((o) => o.redeemed > 0).map((o) => ({ label: o.name, value: o.redeemed, detail: `${percent(o.redemptionRate, 0)} of ${o.issued}` }))}
              note="A used code shows the offer was taken up. It does not show the sale would not have happened anyway."
            />
          ) : null}
        </div>
      )}
      {!list.ok ? (
        <ReadError message={list.error} />
      ) : list.data.length === 0 ? (
        <EmptyState title={Object.keys(f).length ? 'No offers match this view' : 'No offers yet'} action={manager && !Object.keys(f).length ? <LinkButton href="/console/offers/new">Create one</LinkButton> : undefined}>
          {Object.keys(f).length ? 'Try another view, or clear a filter.' : manager ? 'Create an offer, then issue codes for it or let a flow issue them.' : 'A manager can create offers.'}
        </EmptyState>
      ) : (
        <Card padded={false}>
          <Table label="Offers">
            <thead>
              <tr>
                <Th>Offer</Th>
                <Th>Kind</Th>
                <Th align="right">Issued</Th>
                <Th align="right">Used</Th>
                <Th align="right">Given away</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((o) => {
                const s = stats.get(o.id);
                return (
                  <tr key={o.id} data-testid={`offer-${o.id}`}>
                    <Td>
                      <Link href={`/console/offers/${o.id}`} className="font-medium text-accent hover:underline">
                        {o.name}
                      </Link>
                      <span className="block text-xs text-ink-3">{o.summary}</span>
                    </Td>
                    <Td>{OFFER_KINDS[o.kind] ?? o.kind}</Td>
                    <Td numeric>{s?.issued.toLocaleString('en-AU') ?? 0}</Td>
                    <Td numeric>{s?.redeemed.toLocaleString('en-AU') ?? 0}</Td>
                    <Td numeric>{money(s?.discountCents ?? 0, cur)}</Td>
                    <Td>{o.isActive ? <Badge tone="good">On</Badge> : <Badge>Off</Badge>}</Td>
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
