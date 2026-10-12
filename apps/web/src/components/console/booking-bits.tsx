import { Badge } from '@/ui';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

/** A booking's status as a word a host says. Never colour alone. */
export const BOOKING_STATUS: Record<string, { label: string; tone: Tone }> = {
  requested: { label: 'Waiting for a yes', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  seated: { label: 'Seated', tone: 'accent' },
  completed: { label: 'Finished', tone: 'neutral' },
  declined: { label: 'Declined', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'bad' },
};

/** "Came from": where the booking was made. */
export const BOOKING_SOURCE: Record<string, string> = { web: 'Website', assistant: 'Inside assistants', phone: 'Phone', staff: 'Staff' };

export function BookingStatusBadge({ status }: { status: string }) {
  const s = BOOKING_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function BookingSourceBadge({ source }: { source: string }) {
  return (
    <Badge tone={source === 'assistant' ? 'accent' : 'neutral'}>
      <span data-axis="source">{BOOKING_SOURCE[source] ?? source}</span>
    </Badge>
  );
}

/** "4" reads badly in a sentence; covers are guests. */
export const covers = (n: number) => `${n} ${n === 1 ? 'guest' : 'guests'}`;

/** "2 no-shows before" on a guest's booking row; nothing for a clean record. */
export function NoShowCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge tone="bad">
      <span data-no-shows={count}>
        {count} no-show{count === 1 ? '' : 's'} on record
      </span>
    </Badge>
  );
}

/** "Didn't finish" words for the Email status column on a booking. */
export function bookingNudgeWords(b: { nudgeSentAt: Date | null; nudgeStatus: string | null }): string {
  if (!b.nudgeSentAt) return 'Not sent';
  if (b.nudgeStatus?.startsWith('suppressed')) return `Not sent: ${b.nudgeStatus.slice('suppressed:'.length).replace(/_/g, ' ') || 'the address is blocked'}`;
  return 'Sent';
}
