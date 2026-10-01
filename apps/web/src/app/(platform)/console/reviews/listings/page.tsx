import Link from 'next/link';
import { addDays, getPlug, localDate } from '@ros/core';
import { reviews } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { dateRange } from '@/components/console/provenance';
import { ReadError } from '@/components/console/states';
import { ActionForm, Badge, Card, EmptyState, Field, Input, LineChart, Select, StatTile, SubmitButton, Table, Td, Th, dateTime, dayLabel } from '@/ui';
import { checkForReviews, connectListingAction } from '../actions';
import { ReviewsFrame } from '../shared';

export const metadata = { title: 'Listings · Reviews · Restaurant OS' };

type SP = Record<string, string | string[] | undefined>;
const RANGES = [14, 28, 90] as const;

/** The listings reviews are read from, how the reading is going, and what the listing itself reports. */
export default async function ListingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const c = await getConsole();
  if (!(await moduleOn('reviews'))) return <ReviewsFrame c={c} current="/console/reviews/listings">{null}</ReviewsFrame>;
  const sp = await searchParams;
  const manager = atLeast(c.role, 'manager');
  const tz = c.venue.timezone;
  const rawDays = Number(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const days = RANGES.find((d) => d === rawDays) ?? 28;

  const [listings, insights] = await Promise.all([
    read((ctx) => reviews.listListings(ctx, c.venue.id)),
    read(async (ctx) => {
      // Complete venue-local days, ending yesterday.
      const to = addDays(localDate(ctx.now(), tz), -1);
      const from = addDays(to, -(days - 1));
      return { from, to, days: await reviews.listingInsights(ctx, { venueId: c.venue.id, from, to }) };
    }),
  ]);
  const plugs = reviews.reviewsPlugKeys().map((k) => getPlug(k));
  const sum = (k: 'directions' | 'calls' | 'searches' | 'websiteClicks') => (insights.ok ? insights.data.days.reduce((s, d) => s + d[k], 0) : 0);

  return (
    <ReviewsFrame c={c} current="/console/reviews/listings" description={`Where ${c.venue.name}'s reviews come from. Each connected listing is read every hour.`}>
      <div className="space-y-6">
        <Card
          title="Connected listings"
          padded={false}
          actions={
            manager && listings.ok && listings.data.length ? (
              <ActionForm action={checkForReviews}>
                <SubmitButton size="sm" variant="secondary" pendingLabel="Asking…">
                  Check for new reviews now
                </SubmitButton>
              </ActionForm>
            ) : undefined
          }
        >
          {!listings.ok ? (
            <div className="p-5">
              <ReadError message={listings.error} />
            </div>
          ) : listings.data.length === 0 ? (
            <div className="p-5">
              <EmptyState title="No listing is connected">{manager ? 'Connect one below and its reviews are read in straight away.' : 'A manager can connect one.'}</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Listing</Th>
                  <Th>Status</Th>
                  <Th>Last checked</Th>
                  <Th>Read up to</Th>
                  <Th align="right">New last time</Th>
                </tr>
              </thead>
              <tbody>
                {listings.data.map((l) => (
                  <tr key={l.connectionId} data-testid="listing">
                    <Td>
                      {l.name}
                      {l.lastError ? (
                        <span role="alert" className="mt-1 block text-xs text-bad">
                          Last problem: {l.lastError}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{l.status === 'connected' ? <Badge tone="good">Connected</Badge> : l.status === 'unhealthy' ? <Badge tone="bad">Not working</Badge> : <Badge>{l.status}</Badge>}</Td>
                    <Td>{l.lastRunAt ? dateTime(l.lastRunAt, tz) : 'Not yet'}</Td>
                    <Td>{l.syncedThrough ? dateTime(l.syncedThrough, tz) : '–'}</Td>
                    <Td numeric>{l.lastCount ?? '–'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <section aria-label="Listing insights" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-ink">What the listing reports</h2>
              <p className="text-sm text-ink-2">
                {insights.ok ? `${dateRange(insights.data.from, insights.data.to)} (${tz}), complete days only.` : ''} Counted by the listing provider, not by us.
              </p>
            </div>
            <nav aria-label="Period" className="flex gap-3 text-sm">
              {RANGES.map((d) => (
                <Link key={d} href={`?days=${d}`} aria-current={d === days ? 'true' : undefined} className={d === days ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
                  Last {d} days
                </Link>
              ))}
            </nav>
          </div>
          {!insights.ok ? (
            <ReadError message={insights.error} />
          ) : insights.data.days.length === 0 ? (
            <EmptyState title="No insights for these dates">Either the listing provider does not report them, or collecting them is switched off in Reply settings. That is unmeasured, not zero interest.</EmptyState>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <StatTile label="Searches that showed the listing" value={sum('searches').toLocaleString('en-AU')} hint={`${insights.data.days.length} days reported`} />
                <StatTile label="Website clicks" value={sum('websiteClicks').toLocaleString('en-AU')} hint="From the listing to the site" />
                <StatTile label="Direction requests" value={sum('directions').toLocaleString('en-AU')} hint="From the listing" />
                <StatTile label="Calls" value={sum('calls').toLocaleString('en-AU')} hint="From the listing" />
              </div>
              <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                <LineChart
                  title="Actions from the listing"
                  subtitle="Per day"
                  x={insights.data.days.map((d) => dayLabel(d.day))}
                  series={[
                    { key: 'clicks', label: 'Website clicks', values: insights.data.days.map((d) => d.websiteClicks), slot: 1 },
                    { key: 'directions', label: 'Direction requests', values: insights.data.days.map((d) => d.directions), slot: 2 },
                    { key: 'calls', label: 'Calls', values: insights.data.days.map((d) => d.calls), slot: 3 },
                  ]}
                  note="Read from review_listing_insights, summed across this venue's listings. Days the provider did not report are left out, not counted as zero."
                />
                <LineChart
                  title="Searches that showed the listing"
                  subtitle="Per day"
                  x={insights.data.days.map((d) => dayLabel(d.day))}
                  series={[{ key: 'searches', label: 'Searches', values: insights.data.days.map((d) => d.searches), slot: 1 }]}
                  note="A different scale from the actions, so it has its own chart."
                />
              </div>
            </>
          )}
        </section>

        {manager ? (
          <Card title="Connect a listing" description="The listing's id and an access token from the provider. The token is sealed on arrival and never shown again.">
            {plugs.length === 0 ? (
              <p className="text-sm text-ink-3">No review listing provider is available yet.</p>
            ) : (
              <ActionForm action={connectListingAction} className="grid max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2" resetOnSuccess>
                <Field label="Provider">
                  <Select name="plugKey" defaultValue={plugs[0]!.key}>
                    {plugs.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Listing id" hint="The provider's id for this venue's listing.">
                  <Input name="externalAccountId" required maxLength={200} autoComplete="off" />
                </Field>
                <Field label="Access token" className="sm:col-span-2">
                  <Input name="accessToken" type="password" required autoComplete="off" />
                </Field>
                <div className="sm:col-span-2">
                  <SubmitButton pendingLabel="Connecting…">Connect listing</SubmitButton>
                </div>
              </ActionForm>
            )}
            {plugs.some((p) => p.simulated) ? <p className="mt-3 text-xs text-ink-3">Only a simulated listing is available here. A real Google Business Profile connection is not built yet.</p> : null}
          </Card>
        ) : null}
        <p className="text-xs text-ink-3">
          Disconnecting a listing is done in <Link href="/console/settings/connections" className="text-accent hover:underline">Settings → Connected services</Link>.
        </p>
      </div>
    </ReviewsFrame>
  );
}
