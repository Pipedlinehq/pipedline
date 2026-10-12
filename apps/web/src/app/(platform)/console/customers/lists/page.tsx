import Link from 'next/link';
import { campaigns, offers } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { ModuleOff, NotForYourRole, ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, FormMessage, LinkButton, PageHeader, Table, Td, Th } from '@/ui';

export const metadata = { title: 'Guest lists · Pipedline' };

/**
 * Guest lists (docs/CONSOLE_IA.md section 9, pattern 5): groups of guests described by a rule in
 * plain words. The built-in ones are code and cannot be deleted; the venue's own are saved for
 * the organisation. Each shows how many guests it holds at this venue and where it is used.
 */
export default async function GuestListsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const c = await getConsole();
  const { deleted } = await searchParams;
  if (!atLeast(c.role, 'manager')) return <NotForYourRole title="Guest lists">A manager defines guest lists. The guests themselves are under Customers.</NotForYourRole>;
  if (!(await moduleOn('campaigns'))) return <ModuleOff title="Guest lists" what="Campaigns" canManage />;
  const offersOn = await moduleOn('offers');
  const r = await read(async (ctx) => {
    const list = await campaigns.listSegments(ctx);
    const counts = new Map<string, campaigns.SegmentPreview>();
    const used = new Map<string, { campaigns: number; offers: number }>();
    for (const s of list) {
      counts.set(s.id, await campaigns.previewSegment(ctx, { segmentId: s.id, venueId: c.venue.id }));
      const u = await campaigns.segmentUsage(ctx, s.id);
      const o = offersOn ? await offers.offersUsingList(ctx, s.id) : [];
      used.set(s.id, { campaigns: u.campaigns.length, offers: o.length });
    }
    return { list, counts, used };
  });
  return (
    <>
      <PageHeader
        title="Guest lists"
        description="Groups of guests described in plain words: who has not been in for a while, who said yes to email, who spends the most. Campaigns and offers use them. A list never bypasses consent."
        actions={
          <>
            <LinkButton href="/console/customers">All guests</LinkButton>
            <LinkButton href="/console/customers/lists/new" variant="primary">
              New list
            </LinkButton>
          </>
        }
      />
      {deleted ? (
        <div className="mb-4">
          <FormMessage tone="success">List deleted. No guest record was changed.</FormMessage>
        </div>
      ) : null}
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.list.length === 0 ? (
        <EmptyState title="No lists yet" />
      ) : (
        <Card padded={false}>
          <Table label="Guest lists">
            <thead>
              <tr>
                <Th>List</Th>
                <Th>Rule</Th>
                <Th align="right">At {c.venue.name}</Th>
                <Th align="right">Can email</Th>
                <Th>Used by</Th>
              </tr>
            </thead>
            <tbody>
              {r.data.list.map((s) => {
                const n = r.data.counts.get(s.id);
                const u = r.data.used.get(s.id)!;
                const uses = [u.campaigns ? `${u.campaigns} ${u.campaigns === 1 ? 'campaign' : 'campaigns'}` : null, u.offers ? `${u.offers} ${u.offers === 1 ? 'offer' : 'offers'}` : null].filter(Boolean);
                return (
                  <tr key={s.id} data-testid="guest-list-row">
                    <Td>
                      <Link href={`/console/customers/lists/${s.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        {s.name}
                      </Link>{' '}
                      {s.isSystem ? <Badge>Built in</Badge> : null}
                      {s.description ? <span className="block text-xs text-ink-3">{s.description}</span> : null}
                    </Td>
                    <Td className="max-w-md text-ink-2">{s.query ?? 'Conditions set in the campaigns segment editor'}</Td>
                    <Td numeric>{n ? n.count.toLocaleString('en-AU') : '–'}</Td>
                    <Td numeric>{n ? n.email.reachable.toLocaleString('en-AU') : '–'}</Td>
                    <Td className="text-ink-2">{uses.length ? uses.join(', ') : 'Nothing yet'}</Td>
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
