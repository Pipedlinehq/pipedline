import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { events, ordering, qr } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { type Read, read } from '@/lib/console-read';
import { WHEN_OPTIONS, resolveView, whenRange, type ViewSpec } from '@/lib/console-views';
import { app } from '@/lib/runtime';
import { BulkSelection, RowBox, SelectAllBox, type BulkActionDef } from '@/components/console/bulk';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { CHANNEL_LABEL, NEXT_STEP, OrderStatusBadge, PaymentBadge } from '@/components/console/order-bits';
import { ModuleOff, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { Badge, Card, EmptyState, PageHeader, Table, Td, Th, money, timeOnly } from '@/ui';
import { advanceOrder, bulkOrders, clearAttention, closeTable, stopOrder } from './actions';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Orders · Pipedline' };

/**
 * Orders (docs/CONSOLE_IA.md section 9, wave 1): one list with saved views. The default views
 * are the kitchen's own questions (what needs accepting, what is in the kitchen, what is ready,
 * today, everything), plus the orders a person should look at and the tables ordering now. The
 * filters live in the URL and are applied by the ordering service, never in the page.
 */
const STATUS_OPTIONS = [
  { value: 'live', label: 'In progress (new to ready)' },
  { value: 'placed', label: 'New (needs accepting)' },
  { value: 'kitchen', label: 'Accepted or preparing' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'preparing', label: 'Preparing' },
  { value: 'ready', label: 'Ready' },
  { value: 'completed', label: 'Completed' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'refunded', label: 'Refunded' },
];

function spec(tablesOn: boolean): ViewSpec {
  return {
    page: 'orders',
    path: '/console/orders',
    landing: 'live',
    defaults: [
      { key: 'live', label: 'Live', filters: { status: 'live' } },
      { key: 'accepting', label: 'Needs accepting', filters: { status: 'placed' } },
      { key: 'kitchen', label: 'In the kitchen', filters: { status: 'kitchen' } },
      { key: 'ready', label: 'Ready', filters: { status: 'ready' } },
      { key: 'today', label: 'Today', filters: { when: 'today' } },
      { key: 'all', label: 'All', filters: {} },
      { key: 'attention', label: 'Needs attention', filters: { attention: 'yes' } },
      ...(tablesOn ? [{ key: 'tables', label: 'Tables', filters: {} }] : []),
    ],
    fields: [
      { key: 'status', label: 'Kitchen', kind: 'select', options: STATUS_OPTIONS },
      { key: 'channel', label: 'How it leaves', kind: 'select', options: [{ value: 'pickup', label: 'Pickup' }, { value: 'dine-in-qr', label: 'Table (QR)' }, { value: 'delivery', label: 'Delivery' }] },
      { key: 'when', label: 'Placed', kind: 'select', options: WHEN_OPTIONS },
      { key: 'q', label: 'Order reference', kind: 'text', placeholder: 'A7K2' },
      { key: 'attention', label: 'Flagged', kind: 'select', options: [{ value: 'yes', label: 'Needs attention' }] },
    ],
  };
}

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const c = await getConsole();
  if (!(await moduleOn('ordering'))) return <ModuleOff title="Orders" what="Online ordering" canManage={atLeast(c.role, 'manager')} />;
  const tablesOn = await moduleOn('qr');
  const vs = spec(tablesOn);
  const saved = await read((ctx) => events.listConsoleViews(ctx, { venueId: c.venue.id, page: 'orders' }));
  const resolved = resolveView(vs, sp, saved.ok ? saved.data : []);
  const f = resolved.filters;
  const tz = c.venue.timezone;
  // Orders flagged for a person to look at (a discount the venue absorbed, a delivery that failed).
  const flagged = await read((ctx) => ordering.listOrders(ctx, { venueId: c.venue.id, needsAttention: true, limit: 100 }));
  const flaggedCount = flagged.ok ? flagged.data.length : 0;
  // Kitchen and front-of-house staff move orders along; read-only staff look.
  const canMove = c.role !== 'read_only';
  const manager = atLeast(c.role, 'manager');
  const seesGuests = manager || GUEST_FACING_ROLES.includes(c.role);
  const isTables = resolved.current.key === 'tables' && tablesOn;
  const isAttention = !isTables && f.attention === 'yes';

  return (
    <>
      <PageHeader title="Orders" description={`Online and table orders at ${c.venue.name}. New orders need accepting before the kitchen starts.`} />
      <IndexViews
        page="orders"
        path="/console/orders"
        resolved={resolved}
        fields={vs.fields}
        canSave={canMove}
        saveAction={saveView}
        renameAction={renameView}
        deleteAction={deleteView}
      />
      {!isAttention && flaggedCount ? (
        <p role="status" data-testid="attention-banner" className="mb-4 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">
          {flaggedCount === 1 ? 'One order needs' : `${flaggedCount} orders need`} a person to look at {flaggedCount === 1 ? 'it' : 'them'}.{' '}
          <Link href="/console/orders?view=attention" className="font-medium underline underline-offset-2">
            See what and why
          </Link>
        </p>
      ) : null}
      {isTables ? <TablesView venueId={c.venue.id} tz={tz} canClose={canMove} /> : isAttention ? <AttentionList orders={flagged} tz={tz} manager={manager} filters={f} /> : <OrderList filters={f} tz={tz} canMove={canMove} manager={manager} seesGuests={seesGuests} />}
    </>
  );
}

/** The filters in force, as the ordering service takes them. */
function toListInput(filters: Record<string, string>, venueId: string, tz: string): Parameters<typeof ordering.listOrders>[1] {
  const input: Parameters<typeof ordering.listOrders>[1] = { venueId, limit: 100 };
  const s = filters.status;
  if (s === 'live') input.live = true;
  else if (s === 'kitchen') input.statuses = ['accepted', 'preparing'];
  else if (s) input.statuses = [s as 'placed'];
  if (filters.channel) input.channel = filters.channel as 'pickup';
  const range = whenRange(filters.when, app().clock(), tz);
  if (range) {
    input.from = range.from;
    input.to = range.to;
  }
  if (filters.q) input.reference = filters.q;
  if (filters.attention === 'yes') input.needsAttention = true;
  return input;
}

function AttentionList({ orders, tz, manager, filters }: { orders: Read<ordering.OrderView[]>; tz: string; manager: boolean; filters: Record<string, string> }) {
  if (!orders.ok) return <ReadError message={orders.error} />;
  // The other tokens still apply to the flagged list.
  const rows = orders.data.filter((o) => (!filters.channel || o.channel === filters.channel) && (!filters.q || o.reference.toLowerCase().includes(filters.q.toLowerCase())));
  if (rows.length === 0) {
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
          {rows.map((o) => (
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

const BULK: BulkActionDef[] = [
  { key: 'accepted', verb: 'Accept', body: 'The {nouns} go to the kitchen and {their} guests are told the order is accepted. Only new orders can be accepted; any other is left as it is and named.' },
  { key: 'preparing', verb: 'Start preparing', title: 'Start preparing {n} {nouns}?', confirmLabel: 'Start preparing {nouns}' },
  { key: 'ready', verb: 'Mark ready', title: 'Mark {n} {nouns} ready?', confirmLabel: 'Mark {nouns} ready', body: 'The guests are told {their} order is ready to collect.' },
  { key: 'completed', verb: 'Complete', body: 'The {nouns} {is} marked as handed over and leave the live list.' },
  {
    key: 'cancelled',
    verb: 'Cancel',
    destructive: true,
    reason: { label: 'Why (the guests are told this)', placeholder: 'The kitchen had to close early tonight.' },
    body: 'The {nouns} come off the kitchen screen and each guest is emailed your reason. Any paid order is refunded in full to the card it was paid with. A new order is rejected rather than cancelled; a manager is needed to cancel a paid one.',
  },
];

async function OrderList({ filters, tz, canMove, manager, seesGuests }: { filters: Record<string, string>; tz: string; canMove: boolean; manager: boolean; seesGuests: boolean }) {
  const live = filters.status === 'live';
  const r = await read((ctx, c) => ordering.listOrders(ctx, toListInput(filters, c.venue.id, tz)));
  if (!r.ok) return <ReadError message={r.error} />;
  const orders = r.data;
  const actions = manager ? BULK : BULK.filter((a) => a.key !== 'cancelled');
  const table = (
    <Card padded={false}>
      <p className="border-b border-line px-5 py-2 text-xs text-ink-3">
        {orders.length} {orders.length === 1 ? 'order' : 'orders'}
        {orders.length >= 100 ? ' (the latest 100; narrow the filters to see others)' : ''}
      </p>
      {orders.length === 0 ? (
        <div className="p-5">
          <EmptyState title={live ? 'No orders in progress' : 'No orders match this view'}>
            {live ? 'New paid orders appear here the moment they are placed. Nothing is waiting on the kitchen right now.' : 'Try another view, or clear a filter.'}
          </EmptyState>
        </div>
      ) : (
        <Table label="Orders">
          <thead>
            <tr>
              {canMove ? (
                <Th className="w-8">
                  <SelectAllBox label="Select every order on this page" />
                </Th>
              ) : null}
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
                  {canMove ? (
                    <Td>
                      <RowBox id={o.id} label={`Select order ${o.reference}`} name={o.reference} />
                    </Td>
                  ) : null}
                  <Td>
                    <Link href={`/console/orders/${o.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {o.reference}
                    </Link>
                    <span className="block whitespace-nowrap text-xs text-ink-3">
                      {CHANNEL_LABEL[o.channel] ?? o.channel}
                      {o.tableLabel ? `, table ${o.tableLabel}` : ''} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
                    </span>
                    {seesGuests && o.customerName ? <span className="block max-w-40 truncate text-xs text-ink-2 lg:hidden">{o.customerName}</span> : null}
                    <span className="block whitespace-nowrap text-xs text-ink-2 lg:hidden">{live ? timeOnly(o.placedAt ?? o.createdAt, tz) : shortWhen(o.placedAt ?? o.createdAt, tz)}</span>
                  </Td>
                  <Td className="hidden whitespace-nowrap lg:table-cell">{live ? timeOnly(o.placedAt ?? o.createdAt, tz) : shortWhen(o.placedAt ?? o.createdAt, tz)}</Td>
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
  return canMove ? (
    <BulkSelection noun={{ one: 'order', many: 'orders' }} actions={actions} action={bulkOrders} testId="bulk-orders">
      {table}
    </BulkSelection>
  ) : (
    table
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
                {canClose ? (
                  <Th>
                    <span className="sr-only">Close</span>
                  </Th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {open.data.map((s) => (
                <tr key={s.id}>
                  <Td className="font-medium">{s.tableLabel}</Td>
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
