import Link from 'next/link';
import { campaigns } from '@ros/modules';
import { atLeast, getConsole, type ConsoleContext } from '@/lib/console';
import { read } from '@/lib/console-read';
import { type Rule, ruleWords } from '@/components/console/segment-words';
import { ReadError } from '@/components/console/states';
import { Badge, Card, EmptyState, FormMessage, LinkButton, Table, Td, Th } from '@/ui';
import { CampaignsFrame } from '../shared';

export const metadata = { title: 'Segments · Campaigns · Restaurant OS' };

/** Groups of guests by rule. A segment is a question about the guest list, answered as a count. */
export default async function SegmentsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const c = await getConsole();
  const { deleted } = await searchParams;
  const manager = atLeast(c.role, 'manager');
  return (
    <CampaignsFrame
      c={c}
      current="/console/campaigns/segments"
      title="Segments"
      description="Groups of guests, defined by rules over what they have ordered and agreed to. Shared across the organisation. A segment is only ever counted here, never listed."
      actions={manager ? <LinkButton href="/console/campaigns/segments/new" variant="primary">New segment</LinkButton> : undefined}
    >
      {deleted ? (
        <div className="mb-4">
          <FormMessage tone="success">Segment deleted. No guest record was changed.</FormMessage>
        </div>
      ) : null}
      <List c={c} manager={manager} />
    </CampaignsFrame>
  );
}

async function List({ c, manager }: { c: ConsoleContext; manager: boolean }) {
  const r = await read(async (ctx) => {
    const list = await campaigns.listSegments(ctx);
    // Counts need a manager at the venue; other roles see the rules without numbers.
    const counts = new Map<string, campaigns.SegmentPreview>();
    if (manager) for (const s of list) counts.set(s.id, await campaigns.previewSegment(ctx, { segmentId: s.id, venueId: c.venue.id }));
    return { list, counts };
  });
  if (!r.ok) return <ReadError message={r.error} />;
  if (!r.data.list.length) return <EmptyState title="No segments yet">The built-in segments appear once campaigns have been set up for the organisation.</EmptyState>;
  const venueName = (id: string) => c.venues.find((v) => v.id === id)?.name ?? 'another venue';
  return (
    <Card padded={false}>
      <Table>
        <thead>
          <tr>
            <Th>Segment</Th>
            <Th>Rule</Th>
            {manager ? <Th align="right">At {c.venue.name}</Th> : null}
            {manager ? <Th align="right">Can email</Th> : null}
            {manager ? <Th align="right">Can SMS</Th> : null}
          </tr>
        </thead>
        <tbody>
          {r.data.list.map((s) => {
            const n = r.data.counts.get(s.id);
            return (
              <tr key={s.id} data-testid="segment-row">
                <Td>
                  <Link href={`/console/campaigns/segments/${s.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                    {s.name}
                  </Link>{' '}
                  {s.isSystem ? <Badge>Built in</Badge> : null}
                  {s.description ? <span className="block text-xs text-ink-3">{s.description}</span> : null}
                </Td>
                <Td className="max-w-sm text-ink-2">{ruleWords(s.definition as Rule, venueName)}</Td>
                {manager ? <Td numeric>{n ? n.count.toLocaleString('en-AU') : '–'}</Td> : null}
                {manager ? <Td numeric>{n ? n.email.reachable.toLocaleString('en-AU') : '–'}</Td> : null}
                {manager ? <Td numeric>{n ? n.sms.reachable.toLocaleString('en-AU') : '–'}</Td> : null}
              </tr>
            );
          })}
        </tbody>
      </Table>
    </Card>
  );
}
