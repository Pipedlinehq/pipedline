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

export const BOOKING_SOURCE: Record<string, string> = { web: 'Website', assistant: "Guest's assistant", phone: 'Phone', staff: 'Staff' };

export function BookingStatusBadge({ status }: { status: string }) {
  const s = BOOKING_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** "4" reads badly in a sentence; covers are guests. */
export const covers = (n: number) => `${n} ${n === 1 ? 'guest' : 'guests'}`;
