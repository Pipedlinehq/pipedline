import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { delivery, ordering } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { idempotencyKey } from '@/lib/console-actions';
import { moduleOn } from '@/lib/console-modules';
import { read } from '@/lib/console-read';
import { NotHere } from '@/components/console/not-here';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { CHANNEL_LABEL, NEXT_STEP, OrderStatusBadge, PaymentBadge } from '@/components/console/order-bits';
import { Facts, ModuleOff, ReadError } from '@/components/console/states';
import { Badge, Card, GuestText, LinkButton, PageHeader, Table, Td, Th, dateTime, money, timeOnly } from '@/ui';
import { advanceOrder, clearAttention, refund, stopOrder } from '../actions';

export const metadata = { title: 'Order · Restaurant OS' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) return <NotHere back="/console/orders" label="Back to orders" />;
  const c = await getConsole();
  if (!(await moduleOn('ordering'))) return <ModuleOff title="Order" what="Online ordering" canManage={atLeast(c.role, 'manager')} />;
  const r = await read((ctx) => ordering.getOrder(ctx, id));
  if (!r.ok) {
    if (r.code === 'not_found' || r.code === 'module_disabled') return <NotHere back="/console/orders" label="Back to orders" />;
    return (
      <>
        <PageHeader title="Order" />
        <ReadError message={r.error} />
      </>
    );
  }
  const o = r.data;
  // The money that went back, and (for a delivery) what the courier did. Either may be refused to this role; the order still shows.
  const [refunds, courier] = await Promise.all([
    o.refundedCents > 0 || o.paymentStatus !== 'unpaid' ? read((ctx) => ordering.listOrderRefunds(ctx, o.id)) : null,
    o.channel === 'delivery' ? read((ctx) => delivery.getDeliveryForOrder(ctx, o.id)) : null,
  ]);
  // An order at another of the person's venues is shown in that venue's zone; the service has already checked access.
  const venue = c.venues.find((v) => v.id === o.venueId) ?? c.venue;
  const tz = venue.timezone;
  const role = c.session.principal.venueRoles[o.venueId] ?? c.role;
  const manager = atLeast(role, 'manager');
  const canMove = role !== 'read_only';
  const seesGuests = manager || GUEST_FACING_ROLES.includes(role);
  const next = NEXT_STEP[o.status];
  const paid = o.paymentStatus === 'paid' || o.paymentStatus === 'partially_refunded';
  const refundable = paid ? o.totalCents - o.refundedCents : 0;
  const stopped = ['rejected', 'cancelled', 'refunded'].includes(o.status);
  // A paid order is cancelled only by a manager, because it sends the money back.
  const canCancel = ['accepted', 'preparing', 'ready'].includes(o.status) && (manager || !paid);

  return (
    <>
      <PageHeader
        title={`Order ${o.reference}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <OrderStatusBadge status={o.status} />
            {o.status !== 'refunded' ? <PaymentBadge status={o.paymentStatus} /> : null}
            <span>
              {CHANNEL_LABEL[o.channel] ?? o.channel}
              {o.tableLabel ? `, table ${o.tableLabel}` : ''} at {venue.name}
            </span>
          </span>
        }
        actions={<LinkButton href="/console/orders">All orders</LinkButton>}
      />

      {o.attentionAt ? (
        <div role="status" data-testid="order-attention" className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm text-warn">
          <p className="min-w-0 flex-1 basis-72">
            <strong className="font-semibold">This order needs a person to look at it.</strong> {o.attentionReason ?? 'No reason was recorded.'}
            <span className="block text-xs">Flagged {dateTime(o.attentionAt, tz)}.</span>
          </p>
          {manager ? (
            <ConfirmAction trigger="Mark as dealt with" title={`Mark ${o.reference} as dealt with?`} action={clearAttention} hidden={{ orderId: o.id, reference: `Order ${o.reference}` }} confirmLabel="Mark as dealt with" variant="primary" testId="clear-attention">
              The flag is taken off this order and it leaves the “Needs attention” list. The order itself is not changed, and what the flag said is kept on the record.
            </ConfirmAction>
          ) : null}
        </div>
      ) : null}
      {canMove && !stopped && (next || o.status === 'placed' || canCancel) ? (
        <div className="mb-6 flex flex-wrap items-start gap-2" aria-label="Order actions">
          {next ? <InlineAction action={advanceOrder} hidden={{ orderId: o.id, status: next.to }} label={next.label} variant="primary" testId="advance" /> : null}
          {o.status === 'placed' ? (
            <ConfirmAction
              trigger="Reject"
              title={`Reject order ${o.reference}`}
              action={stopOrder}
              hidden={{ orderId: o.id, status: 'rejected' }}
              reason={{ label: 'Why (the guest is told this)', placeholder: 'We have sold out of the main you ordered.' }}
              confirmLabel={paid ? 'Reject and refund' : 'Reject'}
            >
              The order comes off the kitchen screen and the guest is emailed your reason.{' '}
              {paid ? <strong>Their payment of {money(o.totalCents, o.currency)} is refunded in full to their card.</strong> : 'They have not been charged.'}
            </ConfirmAction>
          ) : null}
          {canCancel ? (
            <ConfirmAction
              trigger="Cancel order"
              title={`Cancel order ${o.reference}`}
              action={stopOrder}
              hidden={{ orderId: o.id, status: 'cancelled' }}
              reason={{ label: 'Why (the guest is told this)', placeholder: 'The kitchen had to close early tonight.' }}
              confirmLabel={paid ? 'Cancel and refund' : 'Cancel order'}
            >
              The order is cancelled and comes off the kitchen screen, and the guest is emailed your reason.{' '}
              {paid ? <strong>Everything not yet refunded ({money(refundable, o.currency)}) goes back to their card.</strong> : 'They have not been charged.'}
            </ConfirmAction>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card title="Items" padded={false}>
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Price</Th>
                  <Th align="right">Line</Th>
                </tr>
              </thead>
              <tbody>
                {o.items.map((i, n) => (
                  <tr key={n}>
                    <Td>
                      <span className="font-medium">{i.name}</span>
                      {i.isAlcohol ? (
                        <span className="ml-2">
                          <Badge>Alcohol</Badge>
                        </span>
                      ) : null}
                      {i.modifiers.length ? <span className="block text-xs text-ink-2">{i.modifiers.map((m) => `${m.name}${m.priceDeltaCents ? ` (+${money(m.priceDeltaCents, o.currency)})` : ''}`).join(', ')}</span> : null}
                      {i.allergens.length ? <span className="block text-xs text-warn">Allergens: {i.allergens.join(', ')}</span> : null}
                      {i.note ? (
                        <span className="mt-1 block text-xs">
                          Note: <GuestText>{i.note}</GuestText>
                        </span>
                      ) : null}
                    </Td>
                    <Td numeric>{i.qty}</Td>
                    <Td numeric>{money(i.unitPriceCents, o.currency)}</Td>
                    <Td numeric>{money(i.lineTotalCents, o.currency)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <dl className="space-y-1 border-t border-line px-5 py-4 text-sm">
              <Row label="Subtotal" value={money(o.subtotalCents, o.currency)} />
              {o.adjustments.map((a, n) => (
                <Row key={n} label={a.label} value={money(a.amountCents, o.currency)} />
              ))}
              {o.discountCents ? <Row label="Discounts" value={`−${money(o.discountCents, o.currency)}`} /> : null}
              {o.deliveryFeeCents ? <Row label="Delivery" value={money(o.deliveryFeeCents, o.currency)} /> : null}
              {o.tipCents ? <Row label="Tip" value={money(o.tipCents, o.currency)} /> : null}
              <Row label="Total" value={money(o.totalCents, o.currency)} strong />
              <Row label="Of which GST" value={money(o.taxCents, o.currency)} muted />
              {o.refundedCents ? <Row label="Refunded" value={`−${money(o.refundedCents, o.currency)}`} /> : null}
            </dl>
          </Card>

          {o.customerNote ? (
            <Card title="Note from the guest">
              <p className="text-sm">
                <GuestText>{o.customerNote}</GuestText>
              </p>
            </Card>
          ) : null}

          {manager && paid && refundable > 0 ? (
            <Card title="Refund" description={`Up to ${money(refundable, o.currency)} can go back to the card this order was paid with.`}>
              <ConfirmAction
                trigger="Refund…"
                triggerVariant="danger"
                triggerSize="md"
                title={`Refund order ${o.reference}`}
                action={refund}
                hidden={{ orderId: o.id, idempotencyKey: idempotencyKey() }}
                reason={{ label: 'Reason (kept on the record)', placeholder: 'One item was missing.', hint: 'Audited with your name. The guest is not sent this text.' }}
                confirmLabel="Send refund"
                testId="refund"
                fields={
                  <label className="block">
                    <span className="mb-1 block text-sm font-medium text-ink">Amount in dollars</span>
                    <input name="amount" inputMode="decimal" placeholder={(refundable / 100).toFixed(2)} className="block h-10 w-40 rounded-md border border-line-strong bg-surface px-3 text-sm" />
                    <span className="mt-1 block text-xs text-ink-3">Leave empty to refund everything left ({money(refundable, o.currency)}).</span>
                  </label>
                }
              >
                The amount goes back to the guest&apos;s card through the card processor. It cannot be undone. The ledger records the refund against this sale, and a full refund also gives back any offer code or points used on the order.
              </ConfirmAction>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card title="Guest">
            {seesGuests ? (
              <dl className="space-y-3 text-sm">
                {(
                  [
                    ['Name', o.customerName ?? 'Not given'],
                    ['Email', o.customerEmail ?? '–'],
                    ['Phone', o.customerPhone ?? '–'],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k}>
                    <dt className="text-xs text-ink-3">{k}</dt>
                    <dd className="break-words text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-ink-2">Guest details are shown to front-of-house staff and managers.</p>
            )}
            {seesGuests && o.customerId ? (
              <p className="mt-3 text-sm">
                <Link href={`/console/customers/${o.customerId}`} className="text-accent underline-offset-2 hover:underline">
                  Open customer record
                </Link>
              </p>
            ) : null}
          </Card>
          <Card title="Timeline">
            <ol className="space-y-2 text-sm" data-testid="order-timeline">
              {timeline(o, refunds?.ok ? refunds.data : [], courier?.ok && courier.data ? courier.data : null).map((e, n) => (
                <li key={n} className="flex justify-between gap-4" data-kind={e.kind}>
                  <span className={e.at ? (e.tone === 'bad' ? 'text-bad' : 'text-ink') : 'text-ink-2'}>
                    {e.label}
                    {e.detail ? <span className="block text-xs text-ink-2">{e.detail}</span> : null}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-2">{e.at ? timeOnly(e.at, tz) : '–'}</span>
                </li>
              ))}
            </ol>
            {refunds && !refunds.ok ? <p className="mt-2 text-xs text-ink-2">Refunds could not be listed: {refunds.error}</p> : null}
            {o.promisedAt ? <p className="mt-3 text-xs text-ink-3">Promised for {timeOnly(o.promisedAt, tz)}.</p> : null}
            {o.pickupSlotStart ? (
              <p className="mt-1 text-xs text-ink-3">
                Pickup slot {timeOnly(o.pickupSlotStart, tz)}
                {o.pickupSlotEnd ? `–${timeOnly(o.pickupSlotEnd, tz)}` : ''}
              </p>
            ) : o.requestedAsap ? (
              <p className="mt-1 text-xs text-ink-3">Asked for as soon as possible.</p>
            ) : null}
            {o.rejectedReason ? (
              <p className="mt-3 text-sm">
                Reason given: <span className="text-ink-2">{o.rejectedReason}</span>
              </p>
            ) : null}
          </Card>
          {courier?.ok && courier.data ? (
            <Card title="Delivery">
              <Facts
                items={[
                  ['Courier', `${courier.data.provider}${courier.data.courierName && seesGuests ? `, ${courier.data.courierName}` : ''}`],
                  ['Status', courier.data.status.replace(/_/g, ' ')],
                  ['To', courier.data.dropoffArea || '–'],
                  ['Guest paid for delivery', money(courier.data.customerFeeCents, o.currency)],
                  ['Courier charged', money(courier.data.courierFeeCents, o.currency)],
                  ['Due at the door', courier.data.dropoffEta ? timeOnly(courier.data.dropoffEta, tz) : '–'],
                ]}
              />
              {courier.data.failureReason ? <p className="mt-3 text-sm text-bad">{courier.data.failureReason}</p> : null}
              {courier.data.dropoffNotes && seesGuests ? (
                <p className="mt-3 text-sm">
                  For the courier: <GuestText>{courier.data.dropoffNotes}</GuestText>
                </p>
              ) : null}
            </Card>
          ) : null}
          <Card title="Record">
            <Facts
              items={[
                ['Placed', o.placedAt ? dateTime(o.placedAt, tz) : '–'],
                ['Sent to the till', o.posOrderRef ?? 'Not sent'],
                ['Flags', o.flags.length ? o.flags.join(', ') : 'None'],
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold text-ink' : muted ? 'text-ink-3' : 'text-ink-2'}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

interface TimelineEntry {
  kind: 'step' | 'refund' | 'delivery';
  label: string;
  detail?: string;
  at: Date | null;
  tone?: 'bad';
}

const DELIVERY_STEP: Record<string, string> = {
  requested: 'Courier asked for',
  courier_assigned: 'Courier assigned',
  picked_up: 'Picked up by the courier',
  delivered: 'Delivered',
  failed: 'Delivery failed',
  returned: 'Returned to the venue',
  cancelled: 'Delivery cancelled',
};

/**
 * What happened to the order, in the order it happened: the kitchen's steps, each refund (with
 * who sent it and why, and whether the processor has confirmed it), and the courier's steps.
 * Steps that have not happened yet are listed last, without a time.
 */
function timeline(o: ordering.OrderView, refunds: ordering.OrderRefundView[], courier: delivery.DeliveryView | null): TimelineEntry[] {
  const steps: TimelineEntry[] = [
    { kind: 'step', label: 'Created', at: o.createdAt },
    { kind: 'step', label: 'Placed and paid', at: o.placedAt },
    { kind: 'step', label: 'Accepted', at: o.acceptedAt },
    { kind: 'step', label: 'Ready', at: o.readyAt },
    { kind: 'step', label: 'Completed', at: o.completedAt },
  ];
  const money$ = (cents: number) => money(cents, o.currency);
  const refunded: TimelineEntry[] = refunds.map((r) => ({
    kind: 'refund',
    label: r.status === 'completed' ? `Refunded ${money$(r.amountCents)}` : r.status === 'pending' ? `Refund of ${money$(r.amountCents)} with the card processor` : `Refund of ${money$(r.amountCents)} was refused`,
    detail: [r.automatic ? 'Sent automatically' : r.byStaffName ? `Sent by ${r.byStaffName}` : 'Sent by staff', r.reason, r.status === 'failed' ? (r.failureReason ?? 'Nothing was taken back.') : null].filter(Boolean).join(' · '),
    at: r.requestedAt,
    tone: r.status === 'failed' ? 'bad' : undefined,
  }));
  const carried: TimelineEntry[] = (courier?.timeline ?? [])
    .filter((t) => DELIVERY_STEP[t.to])
    .map((t) => ({ kind: 'delivery', label: DELIVERY_STEP[t.to]!, at: t.at, tone: t.to === 'failed' || t.to === 'returned' ? 'bad' : undefined }));
  const happened = [...steps.filter((e) => e.at), ...refunded, ...carried].sort((a, b) => a.at!.getTime() - b.at!.getTime());
  // A step that will not happen any more (the order was stopped) is left out rather than shown as pending.
  const stopped = ['rejected', 'cancelled', 'refunded'].includes(o.status);
  return [...happened, ...(stopped ? [] : steps.filter((e) => !e.at))];
}
