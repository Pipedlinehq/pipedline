import Link from 'next/link';
import { loyalty } from '@ros/modules';
import { getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ReadError } from '@/components/console/states';
import { BarChart, Card, EmptyState, RankBars, StatTile, compactMoney, percent } from '@/ui';
import { LoyaltyFrame, loyaltyRoles, points } from './shared';

export const metadata = { title: 'Loyalty · Restaurant OS' };

const DAYS = [7, 30, 90, 365] as const;

/** The programme in numbers: members, points issued and redeemed, what is owed, and how much trade is earning. */
export default async function LoyaltySummaryPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const days = DAYS.find((d) => String(d) === sp.days) ?? 30;
  const roles = loyaltyRoles(c);
  const r = await read((ctx) => loyalty.getLoyaltySummary(ctx, { days }));

  return (
    <LoyaltyFrame c={c} current="/console/loyalty" title="Loyalty" description="Points are a promise the venue owes. This is how many are out there, what they are worth, and whether the trade you can identify is earning.">
      <nav aria-label="Period" className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-2">Period:</span>
        {DAYS.map((d) => (
          <Link key={d} href={`/console/loyalty?days=${d}`} aria-current={d === days ? 'page' : undefined} className={`rounded-md px-2.5 py-1 ${d === days ? 'bg-ink text-white' : 'text-ink-2 hover:bg-sunken'}`}>
            Last {d} days
          </Link>
        ))}
      </nav>
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : !r.data.program ? (
        <EmptyState title="There is no loyalty programme yet">{roles.manager ? <Link className="text-accent underline" href="/console/loyalty/program">Set one up</Link> : 'A manager can set one up.'}</EmptyState>
      ) : (
        <Summary s={r.data} currency={c.org.currency} />
      )}
    </LoyaltyFrame>
  );
}

function Summary({ s, currency }: { s: loyalty.LoyaltySummary; currency: string }) {
  return (
    <div className="space-y-6">
      {!s.program!.active ? <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">The programme “{s.program!.name}” is paused: nobody earns or redeems until it is switched back on. Balances are kept.</p> : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Members" value={s.members.total.toLocaleString('en-AU')} hint={`${s.members.joinedInPeriod.toLocaleString('en-AU')} joined in the last ${s.periodDays} days`} />
        <StatTile label="Points outstanding" value={s.points.outstanding.toLocaleString('en-AU')} hint="Earned and not yet spent or expired" />
        <StatTile label="What they are worth" value={compactMoney(s.liabilityCents, currency)} hint="The liability, at the programme's point value" />
        <StatTile label="Redemption rate" value={percent(s.redemptionRate, 1)} hint="Points redeemed ÷ points issued, all time" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <BarChart
          title="Points in the period"
          subtitle={`The last ${s.periodDays} days`}
          x={['Issued', 'Redeemed']}
          xLabel="Points"
          series={[{ key: 'p', label: 'Points', values: [s.points.issuedInPeriod, s.points.redeemedInPeriod] }]}
          note="Issued counts earning, bonuses and additions by staff, net of refunds. Redeemed counts rewards spent, net of returns."
        />
        <RankBars
          title="Members by tier"
          rows={s.tiers.map((t) => ({ label: t.name, value: t.members }))}
          note={s.members.neverEarned ? `${s.members.neverEarned.toLocaleString('en-AU')} members have never earned a point.` : null}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Counter codes" description={`Issued in the last ${s.periodDays} days`}>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {(
              [
                ['Issued', s.redemptions.issued],
                ['Used', s.redemptions.redeemed],
                ['Lapsed', s.redemptions.expired],
                ['Confirmed by hand', s.redemptions.forced],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-ink-3">{k}</dt>
                <dd className="text-lg font-semibold tabular-nums">{v.toLocaleString('en-AU')}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Is identified trade earning?" description={`Completed sales tied to a known guest, last ${s.periodDays} days`}>
          <p className="text-sm text-ink">
            {s.earnCoverage.identifiedSales ? (
              <>
                <strong>{percent(s.earnCoverage.share, 1)}</strong> of {s.earnCoverage.identifiedSales.toLocaleString('en-AU')} identified sales earned points. Of the {s.earnCoverage.memberSales.toLocaleString('en-AU')} made by members, {percent(s.earnCoverage.memberShare, 1)} earned (this should sit at or near 100%).
              </>
            ) : (
              'No completed sales were tied to a known guest in this period. That is unmeasured, not a failing programme.'
            )}
          </p>
          <p className="mt-2 text-xs text-ink-3">
            All time: {points(s.points.issued)} issued, {points(s.points.redeemed)} redeemed, {points(s.points.expired)} expired. Only sales at venues you can see are counted in the coverage figure.
          </p>
        </Card>
      </div>
    </div>
  );
}
