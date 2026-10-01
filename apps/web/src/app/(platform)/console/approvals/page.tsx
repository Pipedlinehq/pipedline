import Link from 'next/link';
import { approvals } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { ApprovalStatus, DecideButtons, REQUESTER } from '@/components/console/approval-bits';
import { NotForYourRole, ReadError, Tabs } from '@/components/console/states';
import { Card, EmptyState, PageHeader, Table, Td, Th, dateTime } from '@/ui';
import { decide } from './actions';

export const metadata = { title: 'Approvals · Pipedline' };

type Status = 'pending' | 'approved' | 'rejected' | 'expired';

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const sp = await searchParams;
  const c = await getConsole();
  // Approvals are decided by managers; the service refuses anyone else.
  if (!Object.values(c.session.principal.venueRoles).some((r) => atLeast(r, 'manager'))) {
    return <NotForYourRole title="Approvals">Campaign sends, batches of messages and actions an assistant proposes wait here for a manager&apos;s yes.</NotForYourRole>;
  }
  const status: Status = sp.status === 'approved' || sp.status === 'rejected' || sp.status === 'expired' ? sp.status : 'pending';
  const r = await read((ctx) => approvals.listApprovals(ctx, { status }));
  const venueName = (id: string | null) => (id ? (c.venues.find((v) => v.id === id)?.name ?? 'Another venue') : 'Whole organisation');
  const tz = c.venue.timezone;

  return (
    <>
      <PageHeader title="Approvals" description="Things that wait for a person before they happen: campaign sends, batches of messages, and actions an assistant has proposed." />
      <Tabs
        current={status === 'pending' ? '/console/approvals' : `/console/approvals?status=${status}`}
        items={[
          { href: '/console/approvals', label: 'Waiting' },
          { href: '/console/approvals?status=approved', label: 'Approved' },
          { href: '/console/approvals?status=rejected', label: 'Rejected' },
          { href: '/console/approvals?status=expired', label: 'Expired' },
        ]}
      />
      {!r.ok ? (
        <ReadError message={r.error} />
      ) : r.data.length === 0 ? (
        <EmptyState title={status === 'pending' ? 'Nothing is waiting for you' : `Nothing ${status} yet`}>
          {status === 'pending' ? 'When a campaign, a batch of messages or an assistant needs a yes, it appears here with exactly what will happen.' : 'Decided items are kept here for the record.'}
        </EmptyState>
      ) : (
        <Card padded={false}>
          <Table>
            <thead>
              <tr>
                <Th>What will happen</Th>
                <Th>Where</Th>
                <Th>Asked</Th>
                <Th>Status</Th>
                {status === 'pending' ? <Th>
                  <span className="sr-only">Decide</span>
                </Th> : null}
              </tr>
            </thead>
            <tbody>
              {r.data.map((a) => (
                <tr key={a.id}>
                  <Td className="max-w-md">
                    <Link href={`/console/approvals/${a.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {a.summary}
                    </Link>
                    <span className="block text-xs text-ink-3">
                      {a.kind.replace(/[._]/g, ' ')} · {REQUESTER[a.requestedByKind] ?? a.requestedByKind}
                    </span>
                  </Td>
                  <Td>{venueName(a.venueId)}</Td>
                  <Td className="whitespace-nowrap">
                    {dateTime(a.createdAt, tz)}
                    {a.expiresAt && a.status === 'pending' ? <span className="block text-xs text-ink-3">Expires {dateTime(a.expiresAt, tz)}</span> : null}
                  </Td>
                  <Td>
                    <ApprovalStatus status={a.status} />
                  </Td>
                  {status === 'pending' ? (
                    <Td>
                      {!a.venueId || atLeast(c.session.principal.venueRoles[a.venueId] ?? 'read_only', 'manager') ? <DecideButtons id={a.id} summary={a.summary} action={decide} /> : null}
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}
