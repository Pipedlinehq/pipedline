import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { ordering, qr } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { type Read, read } from '@/lib/console-read';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { CHANNEL_LABEL, NEXT_STEP, OrderStatusBadge, PaymentBadge } from '@/components/console/order-bits';
import { ModuleOff, ReadError, Tabs } from '@/components/console/states';
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th, money, timeOnly } from '@/ui';
import { advanceOrder, clearAttention, closeTable, stopOrder } from './actions';

export const metadata = { title: 'Orders · Pipedline' };

type View = 'live' | 'all' | 'tables' | 'attention';

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ view?: string; channel?: string }> }) {
  const sp = await searchParams;
  const c = await getConsole();
  if (!(await moduleOn('ordering'))) return <ModuleOff title="Orders" what="Online ordering" canManage={atLeast(c.role, 'manager')} />;
  const tablesOn = await moduleOn('qr');
  const view: View = sp.view === 'all' ? 'all' : sp.view === 'attention' ? 'attention' : sp.view === 'tables' && tablesOn ? 'tables' : 'live';
  // Orders flagged for a person to look at (a discount the venue absorbed, a delivery that failed).
  const flagged = await read((ctx) => ordering.listOrders(ctx, { venueId: c.venue.id, needsAttention: true, limit: 100 }));
  const flaggedCount = flagged.ok ? flagged.data.length : 0;
  const channel = sp.channel === 'pickup' || sp.channel === 'delivery' || sp.channel === 'dine-in-qr' ? sp.channel : undefined;
  // Kitchen and front-of-house staff move orders along; read-only staff look.
  const canMove = c.role !== 'read_only';
  const manager = atLeast(c.role, 'manager');
  const seesGuests = manager || GUEST_FACING_ROLES.includes(c.role);
  const tz = c.venue.timezone;

  const tabs = [
    { href: '/console/orders', label: 'Live' },
    { href: '/console/orders?view=all', label: 'All orders' },
    ...(tablesOn ? [{ href: '/console/orders?view=tables', label: 'Tables' }] : []),
    { href: '/console/orders?view=attention', label: flaggedCount ? `Needs attention (${flaggedCount})` : 'Needs attention' },
  ];
  const current = view === 'live' ? '/console/orders' : `/console/orders?view=${view}`;

  return (
    <>
      <PageHeader title="Orders" description={`Online and table orders at ${c.venue.name}. New orders need accepting before the kitchen starts.`} />
      <Tabs items={tabs} current={current} />
      {view !== 'attention' && flaggedCount ? (
        <p role="status" data-testid="attention-banner" className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          {flaggedCount === 1 ? 'One order needs' : `${flaggedCount} orders need`} a person to look at {flaggedCount === 1 ? 'it' : 'them'}.{' '}
          <Link href="/console/orders?view=attention" className="font-medium underline underline-offset-2">
            See what and why
          </Link>
        </p>
      ) : null}
      {view === 'tables' ? (
        <TablesView venueId={c.venue.id} tz={tz} canClose={canMove} />
      ) : view === 'attention' ? (
        <AttentionList orders={flagged} tz={tz} manager={manager} />
      ) : (
        <OrderList view={view} channel={channel} tz={tz} canMove={canMove} seesGuests={seesGuests} />
      )}
    </>
  );
}

function AttentionList({ orders, tz, manager }: { orders: Read<ordering.OrderView[]>; tz: string; manager: boolean }) {
  if (!orders.ok) return <ReadError message={orders.error} />;
  if (orders.data.length === 0) {
    return (
      <EmptyState title="Nothing needs attention">An order is put here when something happened to it that a person should know about, such as a delivery that could not be made or a discount the venue had to absorb.</EmptyState>
    );
  }
  return (
    <Card title="Orders a person should look at" description="Each stays here until a manager marks it as dealt with." padded={false}>
      <Table>
        <thead>
          <tr>
            <Th>Order</Th>
            <Th>What happened</Th>
            <Th>Flagged</Th>
            <Th>Status</Th>
            {manager ? (
              <Th>
                <span className="sr-only">Mark as dealt with</span>
              </Th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {orders.data.map((o) => (
            <tr key={o.id} data-testid={`attention-${o.reference}`}>
              <Td>
                <Link href={`/console/orders/${o.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                  {o.reference}
                </Link>
                <span className="block whitespace-nowrap text-xs text-ink-2">
                  {CHANNEL_LABEL[o.channel] ?? o.channel} · {money(o.totalCents, o.currency)}
                </span>
              </Td>
              <Td className="max-w-md">{o.attentionReason ?? 'No reason was recorded.'}</Td>
              <Td className="whitespace-nowrap">{o.attentionAt ? shortWhen(o.attentionAt, tz) : '–'}</Td>
              <Td>
                <OrderStatusBadge status={o.status} />
              </Td>
              {manager ? (
                <Td align="right">
                  <ConfirmAction
                    trigger={<>Dealt with<span className="sr-only"> ({o.reference})</span></>}
                    title={`Mark ${o.reference} as dealt with?`}
                    action={clearAttention}
                    hidden={{ orderId: o.id, reference: `Order ${o.reference}` }}
                    confirmLabel="Mark as dealt with"
                    variant="primary"
                    testId={`clear-attention-${o.reference}`}
                  >
                    <p>It leaves this list. The order itself is not changed, and what the flag said is kept on the record:</p>
                    <p className="mt-2 rounded-md bg-sunken px-3 py-2 text-ink">{o.attentionReason ?? 'No reason was recorded.'}</p>
                  </ConfirmAction>
                </Td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

async function OrderList({ view, channel, tz, canMove, seesGuests }: { view: 'live' | 'all'; channel?: 'pickup' | 'delivery' | 'dine-in-qr'; tz: string; canMove: boolean; seesGuests: boolean }) {
  const r = await read((ctx, c) => ordering.listOrders(ctx, { venueId: c.venue.id, live: view === 'live', channel, limit: 100 }));
  if (!r.ok) return <ReadError message={r.error} />;
  const orders = r.data;
  const channels = [
    { value: '', label: 'All channels' },
    { value: 'pickup', label: 'Pickup' },
    { value: 'dine-in-qr', label: 'Table (QR)' },
    { value: 'delivery', label: 'Delivery' },
  ];
  return (
    <Card padded={false}>
      <form method="get" className="flex flex-wrap items-end gap-3 border-b border-line px-5 py-3">
        {view === 'all' ? <input type="hidden" name="view" value="all" /> : null}
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Channel
          <select name="channel" defaultValue={channel ?? ''} className="h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink">
            {channels.map((ch) => (
              <option key={ch.value} value={ch.value}>
                {ch.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-9 rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-ink hover:bg-sunken">
          Show
        </button>
        <p className="ml-auto self-center text-xs text-ink-3">
          {orders.length} {orders.length === 1 ? 'order' : 'orders'}
          {view === 'all' && orders.length >= 100 ? ' (the latest 100)' : ''}
        </p>
      </form>
      {orders.length === 0 ? (
        <div className="p-5">
          <EmptyState title={view === 'live' ? 'No orders in progress' : 'No orders yet'}>
            {view === 'live' ? 'New paid orders appear here the moment they are placed. Nothing is waiting on the kitchen right now.' : 'Orders placed online or at a table will be listed here.'}
          </EmptyState>
        </div>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Order</Th>
              <Th className="hidden lg:table-cell">Placed</Th>
              {seesGuests ? <Th className="hidden lg:table-cell">Guest</Th> : null}
              <Th align="right">Total</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const next = NEXT_STEP[o.status];
              return (
                <tr key={o.id} data-testid={`order-${o.reference}`}>
                  <Td>
                    <Link href={`/console/orders/${o.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {o.reference}
                    </Link>
                    <span className="block whitespace-nowrap text-xs text-ink-3">
                      {CHANNEL_LABEL[o.channel] ?? o.channel}
                      {o.tableLabel ? `, table ${o.tableLabel}` : ''} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
                    </span>
                    {seesGuests && o.customerName ? <span className="block max-w-40 truncate text-xs text-ink-2 lg:hidden">{o.customerName}</span> : null}
                    <span className="block whitespace-nowrap text-xs text-ink-2 lg:hidden">{view === 'live' ? timeOnly(o.placedAt ?? o.createdAt, tz) : shortWhen(o.placedAt ?? o.createdAt, tz)}</span>
                  </Td>
                  <Td className="hidden whitespace-nowrap lg:table-cell">{view === 'live' ? timeOnly(o.placedAt ?? o.createdAt, tz) : shortWhen(o.placedAt ?? o.createdAt, tz)}</Td>
                  {seesGuests ? <Td className="hidden max-w-48 truncate lg:table-cell">{o.customerName ?? <span className="text-ink-3">Not given</span>}</Td> : null}
                  <Td numeric>
                    {money(o.totalCents, o.currency)}
                    {o.refundedCents > 0 ? <span className="block text-xs text-bad">−{money(o.refundedCents, o.currency)}</span> : null}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <OrderStatusBadge status={o.status} />
                      {o.attentionAt ? <Badge tone="warn">Needs attention</Badge> : null}
                      {o.paymentStatus !== 'paid' && o.status !== 'refunded' ? <PaymentBadge status={o.paymentStatus} /> : null}
                    </div>
                    {canMove && (next || o.status === 'placed') ? (
                      <div className="mt-2 flex flex-wrap items-start gap-2">
                        {next ? <InlineAction action={advanceOrder} hidden={{ orderId: o.id, status: next.to }} label={next.label} variant={o.status === 'placed' ? 'primary' : 'secondary'} testId={`advance-${o.reference}`} /> : null}
                        {o.status === 'placed' ? (
                          <ConfirmAction
                            trigger="Reject"
                            title={`Reject order ${o.reference}`}
                            action={stopOrder}
                            hidden={{ orderId: o.id, status: 'rejected' }}
                            reason={{ label: 'Why (the guest is told this)', placeholder: 'We have sold out of the main you ordered.' }}
                            confirmLabel="Reject and refund"
                          >
                            The order comes off the kitchen screen, the guest is emailed your reason, and{' '}
                            {o.paymentStatus === 'paid' ? <strong>their payment of {money(o.totalCents, o.currency)} is refunded in full</strong> : 'they are not charged'}.
                          </ConfirmAction>
                        ) : null}
                      </div>
                    ) : null}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

async function TablesView({ venueId, tz, canClose }: { venueId: string; tz: string; canClose: boolean }) {
  const [open, closed] = await Promise.all([
    read((ctx) => qr.listTableSessions(ctx, { venueId, open: true })),
    read((ctx) => qr.listTableSessions(ctx, { venueId, open: false, limit: 20 })),
  ]);
  if (!open.ok) return <ReadError message={open.error} />;
  return (
    <div className="space-y-6">
      <Card title="Tables ordering now" description="Each table's rounds and what they come to. Close a table when the guests leave." padded={false}>
        {open.data.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No tables are ordering right now">A session opens when a table places its first order from the QR code.</EmptyState>
          </div>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Table</Th>
                <Th>Opened</Th>
                <Th>Last order</Th>
                <Th align="right">Rounds</Th>
                <Th align="right">Total</Th>
                {canClose ? <Th>
                  <span className="sr-only">Close</span>
                </Th> : null}
              </tr>
            </thead>
            <tbody>
              {open.data.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">
                    {s.tableLabel}
                  </Td>
                  <Td>{timeOnly(s.openedAt, tz)}</Td>
                  <Td>{timeOnly(s.lastActivityAt, tz)}</Td>
                  <Td numeric>{s.orders}</Td>
                  <Td numeric>{money(s.totalCents)}</Td>
                  {canClose ? (
                    <Td>
                      <div className="flex justify-end">
                        <ConfirmAction
                          trigger="Close table"
                          title={`Close table ${s.tableLabel}`}
                          action={closeTable}
                          hidden={{ sessionId: s.id, label: `Table ${s.tableLabel}` }}
                          confirmLabel="Close table"
                          variant="primary"
                          fields={
                            <label className="block">
                              <span className="mb-1 block text-sm font-medium text-ink">Guests at the table (optional)</span>
                              <input name="covers" type="number" min={1} max={200} inputMode="numeric" className="block h-10 w-32 rounded-md border border-line-strong bg-surface px-3 text-sm" />
                            </label>
                          }
                        >
                          The table&apos;s session ends. Its {s.orders} {s.orders === 1 ? 'round stays' : 'rounds stay'} on record; the next scan at this table starts a new session. No money moves.
                        </ConfirmAction>
                      </div>
                    </Td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Card title="Recently closed" padded={false}>
        {!closed.ok ? (
          <div className="p-5">
            <ReadError message={closed.error} />
          </div>
        ) : closed.data.length === 0 ? (
          <p className="px-5 py-4 text-sm text-ink-3">No closed table sessions yet.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Table</Th>
                <Th>Opened</Th>
                <Th>Closed</Th>
                <Th align="right">Guests</Th>
                <Th align="right">Rounds</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {closed.data.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.tableLabel}</Td>
                  <Td className="whitespace-nowrap">{shortWhen(s.openedAt, tz)}</Td>
                  <Td className="whitespace-nowrap">{s.closedAt ? shortWhen(s.closedAt, tz) : '–'}</Td>
                  <Td numeric>{s.covers ?? '–'}</Td>
                  <Td numeric>{s.orders}</Td>
                  <Td numeric>{money(s.totalCents)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

/** "30 Sep, 1:19 pm" in the venue's zone: short enough for a list. */
function shortWhen(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(at);
}
