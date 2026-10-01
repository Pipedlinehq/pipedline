import { approvals } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { read } from '@/lib/console-read';
import { NotHere } from '@/components/console/not-here';
import { ApprovalStatus, DecideButtons, REQUESTER } from '@/components/console/approval-bits';
import { CampaignApprovalDetails } from '@/components/console/approval-campaigns';
import { Facts, ReadError } from '@/components/console/states';
import { ReviewReplyApproval } from '@/components/console/approval-review-reply';
import { Card, LinkButton, PageHeader, dateTime } from '@/ui';
import { decide } from '../actions';

export const metadata = { title: 'Approval · Pipedline' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ApprovalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return <NotHere back="/console/approvals" label="Back to approvals" />;
  const c = await getConsole();
  const r = await read((ctx) => approvals.getApproval(ctx, id));
  if (!r.ok) {
    if (r.code === 'not_found') return <NotHere back="/console/approvals" label="Back to approvals" />;
    return (
      <>
        <PageHeader title="Approval" />
        <ReadError message={r.error} />
      </>
    );
  }
  const a = r.data;
  const tz = c.venue.timezone;
  const canDecide = a.status === 'pending' && (a.venueId ? atLeast(c.session.principal.venueRoles[a.venueId] ?? 'read_only', 'manager') : true);
  return (
    <>
      <PageHeader title="Approval" description={<ApprovalStatus status={a.status} />} actions={<LinkButton href="/console/approvals">All approvals</LinkButton>} />
      <div className="space-y-6">
        <Card title="What will happen if approved">
          <p className="text-base text-ink">{a.summary}</p>
          {canDecide ? (
            <div className="mt-4">
              <DecideButtons id={a.id} summary={a.summary} action={decide} />
            </div>
          ) : null}
        </Card>
        {a.kind === 'reviews.reply' ? <ReviewReplyApproval approval={a} /> : null}
        <CampaignApprovalDetails approval={a} />
        <Card title="Record">
          <Facts
            items={[
              ['Kind', a.kind],
              ['Asked by', REQUESTER[a.requestedByKind] ?? a.requestedByKind],
              ['Asked', dateTime(a.createdAt, tz)],
              ['Where', a.venueId ? (c.venues.find((v) => v.id === a.venueId)?.name ?? 'Another venue') : 'Whole organisation'],
              ['Expires', a.expiresAt ? dateTime(a.expiresAt, tz) : 'Never'],
              ['Decided', a.decidedAt ? dateTime(a.decidedAt, tz) : '–'],
              ['Note', a.decisionNote ?? '–'],
              ['Subject', `${a.subjectType} ${a.subjectId}`],
            ]}
          />
        </Card>
        <Card title="Details as submitted" description="Exactly what was asked for, as data. Text in it may have been written by a guest or an assistant.">
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-sunken p-3 text-xs text-ink-2">{JSON.stringify(a.payload, null, 2)}</pre>
        </Card>
      </div>
    </>
  );
}
