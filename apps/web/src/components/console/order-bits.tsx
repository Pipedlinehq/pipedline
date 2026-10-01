import { Badge } from '@/ui';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_payment: { label: 'Awaiting payment', tone: 'neutral' },
  placed: { label: 'New', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'accent' },
  preparing: { label: 'Preparing', tone: 'accent' },
  ready: { label: 'Ready', tone: 'good' },
  completed: { label: 'Completed', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'bad' },
  refunded: { label: 'Refunded', tone: 'bad' },
};

export function OrderStatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const PAYMENT: Record<string, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'neutral' },
  pending: { label: 'Payment pending', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'good' },
  failed: { label: 'Payment failed', tone: 'bad' },
  partially_refunded: { label: 'Part refunded', tone: 'warn' },
  refunded: { label: 'Refunded', tone: 'bad' },
};

export function PaymentBadge({ status }: { status: string }) {
  const s = PAYMENT[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const CHANNEL_LABEL: Record<string, string> = { pickup: 'Pickup', delivery: 'Delivery', 'dine-in-qr': 'Table (QR)' };

/** The next step a person moves an order to, and the words on the button. */
export const NEXT_STEP: Partial<Record<string, { to: 'accepted' | 'preparing' | 'ready' | 'completed'; label: string }>> = {
  placed: { to: 'accepted', label: 'Accept' },
  accepted: { to: 'preparing', label: 'Start preparing' },
  preparing: { to: 'ready', label: 'Mark ready' },
  ready: { to: 'completed', label: 'Complete' },
};
