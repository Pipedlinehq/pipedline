import Link from 'next/link';
import { offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ModuleOff, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, LinkButton, PageHeader, RankBars, StatTile, Table, Td, Th, compactMoney, money, percent } from '@/ui';
import { OFFER_KINDS } from './offer-form';

export const metadata = { title: 'Offers · Pipedline' };

const DAYS = [30, 90, 365] as const;

export default async function OffersPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const c = await getConsole();
  const manager = atLeast(c.role, 'manager');
  if (!(await moduleOn('offers'))) return <ModuleOff title="Offers" what="Offers" canManage={manager} />;
  const sp = await searchParams;
  const days = DAYS.find((d) => String(d) === sp.days) ?? 90;
  const [list, summary] = await Promise.all([read((ctx) => offers.listOffers(ctx, { includeInactive: true })), read((ctx) => offers.getOffersSummary(ctx, { days }))]);
  const stats = new Map(summary.ok ? summary.data.offers.map((s) => [s.offerId, s]) : []);
  const cur = c.org.currency;
  return (
    <>
      <PageHeader
        title="Offers"
        description="Unique codes for welcome, come-back, voucher and creator offers. Every code is single use."
        actions={manager ? <LinkButton href="/console/offers/new" variant="primary">New offer</LinkButton> : undefined}
      />
      <nav aria-label="Period" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">Codes issued in:</span>
        {DAYS.map((d) => (
          <Link key={d} href={`/console/offers?days=${d}`} aria-current={d === days ? 'page' : undefined} className={`rounded-md px-2.5 py-1 ${d === days ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'}`}>
            Last {d} days
          </Link>
        ))}
      </nav>
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
        <EmptyState title="No offers yet" action={manager ? <LinkButton href="/console/offers/new">Create one</LinkButton> : undefined}>
          {manager ? 'Create an offer, then issue codes for it or let a flow issue them.' : 'A manager can create offers.'}
        </EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
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
                  <tr key={o.id}>
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
