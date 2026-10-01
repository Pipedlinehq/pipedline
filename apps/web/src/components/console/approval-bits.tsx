import type { FormState } from '@/ui/client';
import { Badge } from '@/ui';
import { ConfirmAction } from './confirm';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';
const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warn' },
  approved: { label: 'Approved', tone: 'good' },
  rejected: { label: 'Rejected', tone: 'bad' },
  expired: { label: 'Expired', tone: 'neutral' },
};

export function ApprovalStatus({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const REQUESTER: Record<string, string> = { staff: 'A staff member', agent: 'An assistant', worker: 'Scheduled work', platform: 'The platform' };

/** The two decisions for a waiting item, each confirming the exact summary of what will happen. */
export function DecideButtons({ id, summary, action }: { id: string; summary: string; action: (prev: FormState, fd: FormData) => Promise<FormState> }) {
  return (
    <div className="flex flex-wrap gap-2">
      <ConfirmAction
        trigger="Approve"
        triggerVariant="primary"
        title="Approve this?"
        action={action}
        hidden={{ approvalId: id, decision: 'approved' }}
        reason={{ label: 'Note (optional)', required: false, minLength: 0 }}
        confirmLabel="Approve"
        variant="primary"
        testId={`approve-${id}`}
      >
        <p>If you approve, this happens straight away:</p>
        <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-ink">{summary}</p>
      </ConfirmAction>
      <ConfirmAction
        trigger="Reject"
        title="Reject this?"
        action={action}
        hidden={{ approvalId: id, decision: 'rejected' }}
        reason={{ label: 'Why (optional, kept on the record)', required: false, minLength: 0 }}
        confirmLabel="Reject"
        testId={`reject-${id}`}
      >
        <p>Nothing below will happen, and whoever asked is told it was rejected:</p>
        <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-ink">{summary}</p>
      </ConfirmAction>
    </div>
  );
}
