import Link from 'next/link';
import { campaigns } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ReadError } from '@/components/console/states';
import { Card, EmptyState, LinkButton, Table, Td, Th, dateTime } from '@/ui';
import { CampaignStatusBadge, CampaignsFrame, channelWord } from './shared';

export const metadata = { title: 'Campaigns · Pipedline' };

const STATUSES = ['draft', 'pending_approval', 'sending', 'sent', 'cancelled'] as const;
const STATUS_LABEL: Record<string, string> = { draft: 'Drafts', pending_approval: 'Waiting for approval', sending: 'Sending', sent: 'Sent', cancelled: 'Cancelled' };

/** One-off emails and texts to a segment. Each goes only after a manager approves it, then in waves. */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const c = await getConsole();
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === sp.status);
  const manager = atLeast(c.role, 'manager');
  return (
    <CampaignsFrame
      c={c}
      current="/console/campaigns"
      title="Campaigns"
      description={`One-off messages from ${c.venue.name} to a segment of its guests. Nothing is sent until a manager approves it; then it goes in waves, only to guests who have agreed to hear from you.`}
      actions={manager ? <LinkButton href="/console/campaigns/new" variant="primary">New campaign</LinkButton> : undefined}
    >
      <List venueId={c.venue.id} status={status} tz={c.venue.timezone} manager={manager} />
    </CampaignsFrame>
  );
}

async function List({ venueId, status, tz, manager }: { venueId: string; status: (typeof STATUSES)[number] | undefined; tz: string; manager: boolean }) {
  const r = await read((ctx) => campaigns.listCampaigns(ctx, { venueId, status, limit: 100 }));
  return (
    <div className="space-y-4">
      <nav aria-label="Status" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link href="/console/campaigns" aria-current={!status ? 'true' : undefined} className={!status ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
          All
        </Link>
        {STATUSES.map((s) => (
          <Link key={s} href={`/console/campaigns?status=${s}`} aria-current={s === status ? 'true' : undefined} className={s === status ? 'font-medium text-ink underline' : 'text-accent hover:underline'}>
            {STATUS_LABEL[s]}
          </Link>
        ))}
      </nav>
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.length === 0 ? (
        <EmptyState title={status ? `No campaigns are ${STATUS_LABEL[status]!.toLowerCase()}` : 'No campaigns yet'} action={manager && !status ? <LinkButton href="/console/campaigns/new">Draft the first one</LinkButton> : undefined}>
          {manager ? 'Draft a message to a segment. You see how many guests can receive it before anything is sent.' : 'A manager drafts campaigns. They appear here with their results.'}
        </EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>To</Th>
                <Th align="right">Guests</Th>
                <Th>Status</Th>
                <Th>Last change</Th>
              </tr>
            </thead>
            <tbody>
              {r.data.map((x) => (
                <tr key={x.id} data-testid="campaign-row">
                  <Td>
                    <Link href={`/console/campaigns/${x.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {x.name}
                    </Link>
                    <span className="block text-xs text-ink-3">
                      By {channelWord(x.channel)} · drafted by {x.createdByKind === 'agent' ? 'an assistant' : 'staff'}
                    </span>
                  </Td>
                  <Td>{x.segmentName ?? '–'}</Td>
                  <Td numeric>{x.audienceCount ?? '–'}</Td>
                  <Td>
                    <CampaignStatusBadge status={x.status} />
                  </Td>
                  <Td className="whitespace-nowrap">{dateTime(x.sentAt ?? x.updatedAt, tz)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
