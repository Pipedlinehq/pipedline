import type { ordering } from '@ros/modules';
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

// ── The three status axes and "Came from" (docs/COMMERCE_ADMIN_PATTERNS.md pattern 2) ──────────
// Words and tones for each axis. Never colour alone: the word is always there.

export const KITCHEN: Record<ordering.KitchenAxis, { label: string; tone: Tone }> = {
  none: { label: 'Not with the kitchen yet', tone: 'neutral' },
  new: { label: 'New', tone: 'warn' },
  accepted: { label: 'Accepted', tone: 'accent' },
  cooking: { label: 'Cooking', tone: 'accent' },
  ready: { label: 'Ready', tone: 'good' },
  collected: { label: 'Collected', tone: 'neutral' },
  delivered: { label: 'Delivered', tone: 'neutral' },
  served: { label: 'Served', tone: 'neutral' },
  stopped: { label: 'Taken off', tone: 'bad' },
};

export const MONEY: Record<ordering.MoneyAxis, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'neutral' },
  due: { label: 'Due', tone: 'warn' },
  paid: { label: 'Paid', tone: 'good' },
  partly_refunded: { label: 'Partly refunded', tone: 'warn' },
  refunded: { label: 'Refunded', tone: 'bad' },
  voided: { label: 'Voided', tone: 'neutral' },
};

export const LEAVES: Record<ordering.LeavesAxis, string> = { pickup: 'Pickup', table: 'Table', delivery: 'Delivery' };

export const SOURCE: Record<ordering.OrderSource, string> = { website: 'Website', qr: 'QR', phone: 'Phone', assistant: 'Inside assistants', square: 'Square' };

export function KitchenBadge({ axis }: { axis: ordering.KitchenAxis }) {
  const k = KITCHEN[axis];
  return (
    <Badge tone={k.tone}>
      <span data-axis="kitchen">{k.label}</span>
    </Badge>
  );
}

export function MoneyBadge({ axis }: { axis: ordering.MoneyAxis }) {
  const m = MONEY[axis];
  return (
    <Badge tone={m.tone}>
      <span data-axis="money">{m.label}</span>
    </Badge>
  );
}

export function LeavesBadge({ axis, table }: { axis: ordering.LeavesAxis; table?: string | null }) {
  return (
    <Badge>
      <span data-axis="leaves">
        {LEAVES[axis]}
        {axis === 'table' && table ? ` ${table}` : ''}
      </span>
    </Badge>
  );
}

/** "Came from": where the order started. */
export function SourceBadge({ source }: { source: ordering.OrderSource }) {
  return (
    <Badge tone={source === 'assistant' ? 'accent' : 'neutral'}>
      <span data-axis="source">{SOURCE[source] ?? source}</span>
    </Badge>
  );
}

/** All four badges in a row, for a list row or a page header. */
export function OrderAxes({ order, withSource = true }: { order: Pick<ordering.OrderView, 'axes' | 'source' | 'tableLabel'>; withSource?: boolean }) {
  return (
    <>
      <KitchenBadge axis={order.axes.kitchen} />
      <MoneyBadge axis={order.axes.money} />
      <LeavesBadge axis={order.axes.leaves} table={order.tableLabel} />
      {withSource ? <SourceBadge source={order.source} /> : null}
    </>
  );
}

/** "Didn't finish" words for the Email status and Recovery status columns. */
export function nudgeWords(o: Pick<ordering.OrderView, 'nudgeSentAt' | 'nudgeStatus' | 'customerEmail' | 'customerPhone'>): string {
  if (!o.nudgeSentAt) return 'Not sent';
  if (o.nudgeStatus?.startsWith('suppressed')) return `Not sent: ${o.nudgeStatus.slice('suppressed:'.length).replace(/_/g, ' ') || 'the address is blocked'}`;
  return 'Sent';
}
