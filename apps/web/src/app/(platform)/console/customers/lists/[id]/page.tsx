import Link from 'next/link';
import { campaigns, identity, offers } from '@ros/modules';
import { atLeast, getConsole, type ConsoleContext } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ConfirmAction } from '@/components/console/confirm';
import { ListBuilder } from '@/components/console/list-builder';
import { NotHere } from '@/components/console/not-here';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, FormMessage, LinkButton, PageHeader, StatTile, Table, Td, Th, dateTime, percent } from '@/ui';
import { deleteListAction, parseListTextAction, previewListAction, saveListAction } from '../actions';
import { BUILDER_FIELDS, describeQuery } from '../rows';

export const metadata = { title: 'Guest list · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GuestListPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  const { id } = await params;
  const { created } = await searchParams;
  const c = await getConsole();
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Guest list">A manager defines guest lists.</NotForYourRole>;
  if (!(await moduleOn('campaigns'))) return <ModuleOff title="Guest list" what="Campaigns" canManage />;
  if (!UUID.test(id)) return <NotHere back="/console/customers/lists" label="Back to guest lists" />;
  return (
    <>
      <PageHeader title="Guest list" actions={<LinkButton href="/console/customers/lists">All lists</LinkButton>} />
      <Detail id={id} c={c} created={!!created} />
    </>
  );
}

async function Detail({ id, c, created }: { id: string; c: ConsoleContext; created: boolean }) {
  const r = await read((ctx) => campaigns.getSegment(ctx, id));
  if (!r.ok) return r.code === 'not_found' || r.code === 'module_disabled' ? <NotHere back="/console/customers/lists" label="Back to guest lists" /> : <ReadError message={r.error} />;
  const s = r.data;
  const offersOn = await moduleOn('offers');
  const [count, usage, usedByOffers, sample] = await Promise.all([
    read((ctx) => campaigns.previewSegment(ctx, { segmentId: s.id, venueId: c.venue.id })),
    read((ctx) => campaigns.segmentUsage(ctx, s.id)),
    offersOn ? read((ctx) => offers.offersUsingList(ctx, s.id)) : Promise.resolve(null),
    s.query ? read((ctx) => identity.listCustomers(ctx, { venueId: c.venue.id, query: s.query!, limit: 8 })) : Promise.resolve(null),
  ]);
  const described = s.query ? describeQuery(s.query) : null;
  const tz = c.venue.timezone;

  return (
    <div className="space-y-6">
      {created ? <FormMessage tone="success">List created. Campaigns and offers can use it now.</FormMessage> : null}
      <Card
        title={s.name}
        description={s.description ?? undefined}
        actions={
          <>
            {s.isSystem ? <Badge>Built in</Badge> : null}
            {!s.isSystem ? (
              <ConfirmAction trigger="Delete" title={`Delete “${s.name}”?`} action={deleteListAction} hidden={{ id: s.id }} confirmLabel="Delete the list" testId="delete-list">
                The rule is removed for everyone at the organisation. No guest record is changed and no message is affected. A list a campaign or an offer uses is kept.
              </ConfirmAction>
            ) : null}
          </>
        }
      >
        <p className="text-sm text-ink" data-testid="list-rule">
          {s.query ? (
            <>
              <span className="font-mono text-xs">{s.query}</span>
              <span className="block mt-1">{described?.words}.</span>
            </>
          ) : (
            'A list defined by conditions in the campaigns segment editor.'
          )}
        </p>
        {count.ok ? (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="list-counts">
            <StatTile label={`At ${c.venue.name}`} value={count.data.count.toLocaleString('en-AU')} hint="Guests whose home venue this is" />
            <StatTile label="Can be emailed" value={count.data.email.reachable.toLocaleString('en-AU')} hint={`${percent(count.data.email.share)} of them`} />
            <StatTile label="Can be sent a text" value={count.data.sms.reachable.toLocaleString('en-AU')} hint={`${percent(count.data.sms.share)} of them`} />
          </div>
        ) : (
          <div className="mt-4">
            <ReadError message={count.error} />
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">Visits and spend come from sales tied to a known guest. A list never bypasses consent: a send still checks each guest at the moment it goes.</p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="A few of them" description={`The most recent guests in this list at ${c.venue.name}.`} padded={false}>
          {!sample ? (
            <p className="px-5 py-4 text-sm text-ink-3">This list is defined by conditions, so it is counted here rather than listed.</p>
          ) : !sample.ok ? (
            <div className="p-5">
              <ReadError message={sample.error} />
            </div>
          ) : sample.data.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink-3">Nobody at this venue is in the list right now.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Guest</Th>
                  <Th align="right">Visits</Th>
                  <Th>Last visit</Th>
                </tr>
              </thead>
              <tbody data-testid="list-preview-rows">
                {sample.data.map((g) => (
                  <tr key={g.id}>
                    <Td>
                      <Link href={`/console/customers/${g.id}`} className="font-medium text-accent hover:underline">
                        {g.name}
                      </Link>
                    </Td>
                    <Td numeric>{g.visits}</Td>
                    <Td className="whitespace-nowrap">{g.lastVisitAt ? dateTime(g.lastVisitAt, tz, { date: true, time: false }) : <span className="text-ink-3">None recorded</span>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card title="Where it is used">
          {!usage.ok ? (
            <ReadError message={usage.error} />
          ) : (
            <ul className="space-y-2 text-sm" data-testid="list-usage">
              {usage.data.campaigns.map((k) => (
                <li key={k.id}>
                  Campaign{' '}
                  <Link href={`/console/campaigns/${k.id}`} className="text-accent hover:underline">
                    {k.name}
                  </Link>{' '}
                  <span className="text-ink-3">({k.status.replace(/_/g, ' ')})</span>
                </li>
              ))}
              {usedByOffers?.ok
                ? usedByOffers.data.map((o) => (
                    <li key={o.id}>
                      Offer{' '}
                      <Link href={`/console/offers/${o.id}`} className="text-accent hover:underline">
                        {o.name}
                      </Link>{' '}
                      <span className="text-ink-3">({o.status === 'off' ? 'switched off' : o.status})</span>
                    </li>
                  ))
                : null}
              {!usage.data.campaigns.length && !(usedByOffers?.ok && usedByOffers.data.length) ? <li className="text-ink-3">Nothing uses this list yet. Choose it in a campaign, or as who an offer is for.</li> : null}
            </ul>
          )}
        </Card>
      </div>

      {s.isSystem ? (
        <Card title="Save a copy to change it" description="A built-in list cannot be changed. Start from its rule and save it under a new name.">
          <ListBuilder save={saveListAction} preview={previewListAction} parse={parseListTextAction} fields={BUILDER_FIELDS} initial={{ name: `${s.name} (copy)`, description: s.description, text: s.query ?? '', rows: described?.rows ?? null }} submitLabel="Create the copy" />
        </Card>
      ) : s.query ? (
        <Card title="Change the rule">
          <ListBuilder save={saveListAction} preview={previewListAction} parse={parseListTextAction} fields={BUILDER_FIELDS} initial={{ id: s.id, name: s.name, description: s.description, text: s.query, rows: described?.rows ?? null }} />
        </Card>
      ) : (
        <Card title="Change the rule">
          <p className="text-sm text-ink-2">
            This list was made in the campaigns segment editor. Change it{' '}
            <Link href={`/console/campaigns/segments/${s.id}`} className="text-accent hover:underline">
              there
            </Link>
            , or make a new list here in plain words.
          </p>
        </Card>
      )}
    </div>
  );
}
