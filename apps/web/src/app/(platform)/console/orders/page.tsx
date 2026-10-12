import Link from 'next/link';
import { GUEST_FACING_ROLES } from '@ros/core';
import { events, menu, ordering, qr } from '@ros/modules';
import { atLeast, getConsole } from '@/lib/console';
import { moduleOn } from '@/lib/console-modules';
import { type Read, read } from '@/lib/console-read';
import { WHEN_OPTIONS, resolveView, whenRange, type ViewSpec } from '@/lib/console-views';
import { app } from '@/lib/runtime';
import { BulkSelection, RowBox, SelectAllBox, type BulkActionDef } from '@/components/console/bulk';
import { ConfirmAction, InlineAction } from '@/components/console/confirm';
import { CHANNEL_LABEL, KITCHEN, MONEY, NEXT_STEP, OrderAxes, SOURCE, nudgeWords } from '@/components/console/order-bits';
import { ModuleOff, ReadError } from '@/components/console/states';
import { IndexViews } from '@/components/console/views';
import { ActionForm, Badge, Card, Dialog, EmptyState, Field, GuestText, Input, PageHeader, Select, SubmitButton, Table, Td, Textarea, Th, dateTime, money, timeOnly } from '@/ui';
import { advanceOrder, bulkOrders, cancelDraft, clearAttention, closeTable, createDraft, markPaid, nudgeOrder, sendPayLink, stopOrder } from './actions';
import { deleteView, renameView, saveView } from '../views-actions';

export const metadata = { title: 'Orders · Pipedline' };

/**
 * Orders (docs/CONSOLE_IA.md section 9, waves 1 and 2): one list with saved views. Every order
 * carries three independent status axes (what the kitchen is doing, what the money is doing, how
 * it leaves) and where it came from; each is a badge on the row and a filter token. The default
 * views are the kitchen's own questions, "Unpaid" (a grouping of unpaid and due), "Didn't finish"
 * (orders a guest started and did not pay, with the one nudge) and "Phone and function orders"
 * (drafts staff build, paid by a link or marked paid). Filters live in the URL and are applied
 * by the ordering service, never in the page.
 */
const KITCHEN_OPTIONS = [
  { value: 'new', label: 'New (needs accepting)' },
  { value: 'in_kitchen', label: 'Accepted or cooking' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'cooking', label: 'Cooking' },
  { value: 'ready', label: 'Ready' },
  { value: 'done', label: 'Collected, delivered or served' },
  { value: 'collected', label: 'Collected' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'served', label: 'Served' },
  { value: 'none', label: 'Not with the kitchen yet' },
  { value: 'stopped', label: 'Taken off (rejected, cancelled, refunded)' },
];

const MONEY_OPTIONS = [
  { value: 'owing', label: 'Unpaid or due' },
  { value: 'unpaid', label: 'Unpaid' },
  { value: 'due', label: 'Due (phone and function orders)' },
  { value: 'paid', label: 'Paid' },
  { value: 'partly_refunded', label: 'Partly refunded' },
  { value: 'refunded', label: 'Refunded' },
  { value: 'voided', label: 'Voided' },
];

const SOURCE_OPTIONS = (Object.keys(SOURCE) as ordering.OrderSource[]).map((value) => ({ value, label: SOURCE[value] }));

function spec(tablesOn: boolean): ViewSpec {
  return {
    page: 'orders',
    path: '/console/orders',
    landing: 'live',
    defaults: [
      { key: 'live', label: 'Live', filters: { status: 'live' } },
      { key: 'accepting', label: 'Needs accepting', filters: { kitchen: 'new' } },
      { key: 'kitchen', label: 'In the kitchen', filters: { kitchen: 'in_kitchen' } },
      { key: 'ready', label: 'Ready', filters: { kitchen: 'ready' } },
      { key: 'today', label: 'Today', filters: { when: 'today' } },
      { key: 'all', label: 'All', filters: {} },
      { key: 'unpaid', label: 'Unpaid', filters: { money: 'owing' } },
      { key: 'unfinished', label: "Didn't finish", filters: { unfinished: 'yes' } },
      { key: 'drafts', label: 'Phone and function orders', filters: { drafts: 'yes' } },
      { key: 'attention', label: 'Needs attention', filters: { attention: 'yes' } },
      ...(tablesOn ? [{ key: 'tables', label: 'Tables', filters: {} }] : []),
    ],
    fields: [
      { key: 'kitchen', label: 'Kitchen', kind: 'select', options: KITCHEN_OPTIONS },
      { key: 'money', label: 'Money', kind: 'select', options: MONEY_OPTIONS },
      { key: 'channel', label: 'How it leaves', kind: 'select', options: [{ value: 'pickup', label: 'Pickup' }, { value: 'dine-in-qr', label: 'Table' }, { value: 'delivery', label: 'Delivery' }] },
      { key: 'source', label: 'Came from', kind: 'select', options: SOURCE_OPTIONS },
      { key: 'when', label: 'Placed', kind: 'select', options: WHEN_OPTIONS },
      { key: 'q', label: 'Order reference', kind: 'text', placeholder: 'A7K2' },
      { key: 'status', label: 'Live', kind: 'select', options: [{ value: 'live', label: 'In progress (new to ready)' }] },
      { key: 'attention', label: 'Flagged', kind: 'select', options: [{ value: 'yes', label: 'Needs attention' }] },
      { key: 'unfinished', label: "Didn't finish", kind: 'select', options: [{ value: 'yes', label: 'Started by a guest, not paid' }] },
      { key: 'drafts', label: 'Phone and function', kind: 'select', options: [{ value: 'yes', label: 'Built by staff, not yet paid' }] },
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
  const isUnfinished = !isTables && !isAttention && f.unfinished === 'yes';
  const isDrafts = !isTables && !isAttention && !isUnfinished && f.drafts === 'yes';

  return (
    <>
      <PageHeader title="Orders" description={`Online, table, phone and function orders at ${c.venue.name}. New orders need accepting before the kitchen starts.`} />
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
      {isTables ? (
        <TablesView venueId={c.venue.id} tz={tz} canClose={canMove} />
      ) : isAttention ? (
        <AttentionList orders={flagged} tz={tz} manager={manager} filters={f} />
      ) : isUnfinished ? (
        <UnfinishedList venueId={c.venue.id} tz={tz} seesGuests={seesGuests} filters={f} />
      ) : isDrafts ? (
        <DraftsList venueId={c.venue.id} tz={tz} seesGuests={seesGuests} manager={manager} filters={f} />
      ) : (
        <OrderList filters={f} tz={tz} canMove={canMove} manager={manager} seesGuests={seesGuests} />
      )}
    </>
  );
}

const KITCHEN_GROUPS: Record<string, ordering.KitchenAxis[]> = { in_kitchen: ['accepted', 'cooking'], done: ['collected', 'delivered', 'served'] };
const MONEY_GROUPS: Record<string, ordering.MoneyAxis[]> = { owing: ['unpaid', 'due'] };

/** The filters in force, as the ordering service takes them. */
function toListInput(filters: Record<string, string>, venueId: string, tz: string): Parameters<typeof ordering.listOrders>[1] {
  const input: Parameters<typeof ordering.listOrders>[1] = { venueId, limit: 100 };
  if (filters.status === 'live') input.live = true;
  if (filters.kitchen) input.kitchen = KITCHEN_GROUPS[filters.kitchen] ?? (filters.kitchen in KITCHEN ? [filters.kitchen as ordering.KitchenAxis] : undefined);
  if (filters.money) input.money = MONEY_GROUPS[filters.money] ?? (filters.money in MONEY ? [filters.money as ordering.MoneyAxis] : undefined);
  if (filters.channel) input.channel = filters.channel as 'pickup';
  if (filters.source && filters.source in SOURCE) input.source = [filters.source as ordering.OrderSource];
  const range = whenRange(filters.when, app().clock(), tz);
  if (range) {
    input.from = range.from;
    input.to = range.to;
  }
  if (filters.q) input.reference = filters.q;
  if (filters.attention === 'yes') input.needsAttention = true;
  if (filters.unfinished === 'yes') input.unfinished = true;
  if (filters.drafts === 'yes') input.drafts = true;
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
                <div className="flex flex-wrap gap-1">
                  <OrderAxes order={o} withSource={false} />
                </div>
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
              <Th>Kitchen · Money · How it leaves · Came from</Th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const next = NEXT_STEP[o.status];
              return (
                <tr key={o.id} data-testid={`order-${o.reference}`} data-kitchen={o.axes.kitchen} data-money={o.axes.money} data-source={o.source}>
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
                      <OrderAxes order={o} />
                      {o.attentionAt ? <Badge tone="warn">Needs attention</Badge> : null}
                      {o.recoveredAt ? <Badge tone="good">Recovered</Badge> : o.abandonedAt && !o.purgedAt ? <Badge tone="warn">Didn&apos;t finish</Badge> : null}
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

/**
 * "Didn't finish" (pattern 7): orders a guest started, gave a contact for, and did not pay for.
 * Email status says whether the one nudge went; Recovery status whether the guest came back
 * (paid this order, or placed and paid a new one). Hosts, front of house and managers: it holds
 * guests' names and contact details.
 */
async function UnfinishedList({ venueId, tz, seesGuests, filters }: { venueId: string; tz: string; seesGuests: boolean; filters: Record<string, string> }) {
  const r = await read((ctx) => ordering.listUnfinishedOrders(ctx, { venueId, limit: 200 }));
  if (!r.ok) return <ReadError message={r.error} />;
  const rows = r.data.filter((o) => (!filters.channel || o.channel === filters.channel) && (!filters.q || o.reference.toLowerCase().includes(filters.q.toLowerCase())) && (!filters.source || o.source === filters.source));
  return (
    <Card
      title="Orders a guest did not finish"
      description="A guest put items in, gave an email or phone, and did not pay. One nudge may be sent: a message about their own order, nothing more. Details are removed after three months."
      padded={false}
    >
      {rows.length === 0 ? (
        <div className="p-5">
          <EmptyState title="Nothing left unfinished">An order appears here once it has waited unpaid for the venue&apos;s threshold (set under Plugins, Online ordering) and the guest gave a way to reach them.</EmptyState>
        </div>
      ) : (
        <Table label="Unfinished orders">
          <thead>
            <tr>
              <Th>Order</Th>
              {seesGuests ? <Th>Guest</Th> : null}
              <Th>Started</Th>
              <Th align="right">Would have come to</Th>
              <Th>Email status</Th>
              <Th>Recovery status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const canNudge = !o.nudgeSentAt && !o.recoveredAt && (o.customerEmail || o.customerPhone);
              return (
                <tr key={o.id} data-testid={`unfinished-${o.reference}`} data-recovered={o.recoveredAt ? 'true' : 'false'}>
                  <Td>
                    <Link href={`/console/orders/${o.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {o.reference}
                    </Link>
                    <span className="block whitespace-nowrap text-xs text-ink-3">
                      {CHANNEL_LABEL[o.channel] ?? o.channel} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'} · from {SOURCE[o.source]}
                    </span>
                  </Td>
                  {seesGuests ? (
                    <Td className="text-xs">
                      <GuestText>{o.customerName}</GuestText>
                      {o.customerEmail ? <span className="block break-all text-ink-2">{o.customerEmail}</span> : null}
                      {o.customerPhone ? <span className="block text-ink-2">{o.customerPhone}</span> : null}
                    </Td>
                  ) : null}
                  <Td className="whitespace-nowrap">
                    {shortWhen(o.createdAt, tz)}
                    <span className="block text-xs text-ink-3">{o.status === 'pending_payment' ? 'Can still be paid' : 'Lapsed'}</span>
                  </Td>
                  <Td numeric>{money(o.totalCents, o.currency)}</Td>
                  <Td>
                    <span className="block" data-testid={`email-status-${o.reference}`}>
                      {nudgeWords(o)}
                      {o.nudgeSentAt ? <span className="block text-xs text-ink-3">{shortWhen(o.nudgeSentAt, tz)}</span> : null}
                    </span>
                  </Td>
                  <Td>
                    <span className="block" data-testid={`recovery-status-${o.reference}`}>
                      {o.recoveredAt ? (
                        <>
                          <Badge tone="good">Recovered</Badge>
                          <span className="block text-xs text-ink-3">{shortWhen(o.recoveredAt, tz)}</span>
                        </>
                      ) : (
                        'Not recovered'
                      )}
                    </span>
                  </Td>
                  <Td align="right">
                    {canNudge ? (
                      <ConfirmAction
                        trigger="Send a nudge"
                        title={`Nudge the guest about order ${o.reference}?`}
                        action={nudgeOrder}
                        hidden={{ orderId: o.id }}
                        confirmLabel="Send the nudge"
                        variant="primary"
                        testId={`nudge-${o.reference}`}
                      >
                        <p>
                          One message goes to the guest by {o.customerEmail ? 'email' : 'text message'}: what was in their order ({money(o.totalCents, o.currency)}) and where to {o.status === 'pending_payment' ? 'finish paying' : 'order again'}. It is about their own order, not an offer, and it is the only nudge they will get.
                        </p>
                      </ConfirmAction>
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

/**
 * Phone and function orders (pattern 10): drafts staff build by hand, waiting to be paid by the
 * guest's pay link or marked paid by a manager. Hosts, front of house and managers build them; a
 * custom item (its own name and price) needs a manager.
 */
async function DraftsList({ venueId, tz, seesGuests, manager, filters }: { venueId: string; tz: string; seesGuests: boolean; manager: boolean; filters: Record<string, string> }) {
  const [r, m] = await Promise.all([
    read((ctx) => ordering.listOrders(ctx, { venueId, drafts: true, limit: 200 })),
    read((ctx) => menu.getPublicMenu(ctx, venueId, { surface: 'online' })),
  ]);
  if (!r.ok) return <ReadError message={r.error} />;
  const rows = r.data.filter((o) => (!filters.channel || o.channel === filters.channel) && (!filters.q || o.reference.toLowerCase().includes(filters.q.toLowerCase())));
  // Items with no required choice can be picked from a plain list; the rest are added by the assistant or as a custom item.
  const items = m.ok ? m.data.menus.flatMap((x) => x.sections.flatMap((s) => s.items)).filter((i) => i.isAvailable && i.modifierGroups.every((g) => g.minSelections === 0)) : [];
  return (
    <div className="space-y-4">
      {seesGuests ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-2">An order built by hand for a guest who phoned, asked at the counter or is booking a function. Nothing is charged until they pay the link, or a manager marks it paid.</p>
          <Dialog trigger="New phone or function order" title="Build an order by hand" triggerVariant="primary">
            <ActionForm action={createDraft} className="space-y-4" resetOnSuccess>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name the order is under" className="col-span-2">
                  <Input name="name" required maxLength={100} data-testid="draft-name" />
                </Field>
                <Field label="Email" hint="For the pay link">
                  <Input name="email" type="email" maxLength={254} data-testid="draft-email" />
                </Field>
                <Field label="Phone" hint="Optional">
                  <Input name="phone" type="tel" maxLength={30} />
                </Field>
                <Field label="How it leaves">
                  <Select name="channel" defaultValue="pickup">
                    <option value="pickup">Pickup (or a function collected)</option>
                    <option value="dine-in-qr">At a table</option>
                  </Select>
                </Field>
                <Field label="Table" hint="For a table order">
                  <Input name="tableLabel" maxLength={40} />
                </Field>
                <Field label="Wanted for" hint="The pickup time, or the function's date and time">
                  <Input name="wantedAt" type="datetime-local" data-testid="draft-wanted" />
                </Field>
                <Field label="Hold until" hint="The pay link works to the end of this day. Empty: 30 days.">
                  <Input name="holdUntil" type="date" />
                </Field>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-ink">Items from the menu</legend>
                {items.length === 0 ? <p className="text-xs text-ink-3">No items can be picked here right now (every item needs a choice, or the menu is empty). Add a custom item, or build the order with your assistant.</p> : null}
                {[0, 1, 2, 3].map((n) => (
                  <div key={n} className="grid grid-cols-[minmax(0,1fr)_5rem] gap-2">
                    <Select name="itemId" defaultValue="" aria-label={`Item ${n + 1}`} data-testid={`draft-item-${n}`}>
                      <option value="">—</option>
                      {items.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} · {money(i.priceCents)}
                        </option>
                      ))}
                    </Select>
                    <Input name="qty" type="number" min={1} max={99} defaultValue={1} aria-label={`Quantity ${n + 1}`} data-testid={`draft-qty-${n}`} />
                  </div>
                ))}
                <p className="text-xs text-ink-3">An item that needs a choice (a size, a side) is added by your assistant, or as a custom item.</p>
              </fieldset>
              {manager ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-ink">A custom item (managers)</legend>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_4rem] gap-2">
                    <Input name="customName" maxLength={100} placeholder="Function set menu for 20" aria-label="Custom item name" data-testid="draft-custom-name" />
                    <Input name="customPrice" inputMode="decimal" placeholder="Price $" aria-label="Custom item price in dollars" data-testid="draft-custom-price" />
                    <Input name="customQty" type="number" min={1} max={99} defaultValue={1} aria-label="Custom item quantity" />
                  </div>
                </fieldset>
              ) : null}
              <Field label="Note for the kitchen and the record" hint="Shown on the docket.">
                <Textarea name="note" maxLength={500} className="min-h-16" />
              </Field>
              <SubmitButton pendingLabel="Building…">Build the order</SubmitButton>
            </ActionForm>
          </Dialog>
        </div>
      ) : null}
      <Card title="Phone and function orders waiting to be paid" padded={false}>
        {rows.length === 0 ? (
          <div className="p-5">
            <EmptyState title="No phone or function orders waiting">An order you build by hand sits here until the guest pays the link or a manager marks it paid. Untouched drafts are cleared after a year.</EmptyState>
          </div>
        ) : (
          <Table label="Phone and function orders">
            <thead>
              <tr>
                <Th>Order</Th>
                {seesGuests ? <Th>Guest</Th> : null}
                <Th>Wanted</Th>
                <Th>Hold until</Th>
                <Th align="right">Total</Th>
                <Th>Money</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} data-testid={`draft-${o.reference}`} data-status={o.status}>
                  <Td>
                    <Link href={`/console/orders/${o.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                      {o.reference}
                    </Link>
                    <span className="block whitespace-nowrap text-xs text-ink-3">
                      {CHANNEL_LABEL[o.channel] ?? o.channel}
                      {o.tableLabel ? `, table ${o.tableLabel}` : ''} · {o.itemCount} {o.itemCount === 1 ? 'item' : 'items'}
                    </span>
                  </Td>
                  {seesGuests ? (
                    <Td className="text-xs">
                      <GuestText>{o.customerName}</GuestText>
                      {o.customerEmail ? <span className="block break-all text-ink-2">{o.customerEmail}</span> : null}
                      {o.customerPhone ? <span className="block text-ink-2">{o.customerPhone}</span> : null}
                    </Td>
                  ) : null}
                  <Td className="whitespace-nowrap">{o.promisedAt ? dateTime(o.promisedAt, tz) : <span className="text-ink-3">Not set</span>}</Td>
                  <Td className="whitespace-nowrap">{o.holdUntil ? dateTime(o.holdUntil, tz, { date: true, time: false }) : <span className="text-ink-3">–</span>}</Td>
                  <Td numeric>{money(o.totalCents, o.currency)}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <OrderAxes order={o} withSource={false} />
                    </div>
                    {o.payLinkSentAt ? <span className="block text-xs text-ink-3">Pay link sent {shortWhen(o.payLinkSentAt, tz)}</span> : null}
                  </Td>
                  <Td align="right">
                    {seesGuests ? (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {o.customerEmail || o.customerPhone ? (
                          <ConfirmAction trigger={o.payLinkSentAt ? 'Send the pay link again' : 'Send a pay link'} title={`Send a pay link for order ${o.reference}?`} action={sendPayLink} hidden={{ orderId: o.id }} confirmLabel="Send the pay link" variant="primary" testId={`paylink-${o.reference}`}>
                            <p>
                              The guest gets a link by {o.customerEmail ? 'email' : 'text message'} to the venue&apos;s own order page and pays the full {money(o.totalCents, o.currency)} there. Nothing goes to the kitchen until it is paid.
                              {o.holdUntil ? ` The link works until ${dateTime(o.holdUntil, tz)}.` : ''}
                            </p>
                          </ConfirmAction>
                        ) : null}
                        {manager ? (
                          <ConfirmAction
                            trigger="Mark paid"
                            title={`Mark order ${o.reference} as paid?`}
                            action={markPaid}
                            hidden={{ orderId: o.id }}
                            confirmLabel="Mark as paid"
                            variant="primary"
                            reason={{ label: 'Why it is marked paid here (kept on the record)', placeholder: 'Paid cash at the counter.' }}
                            testId={`markpaid-${o.reference}`}
                            fields={
                              <Field label="How it was paid">
                                <Select name="method" defaultValue="cash">
                                  <option value="cash">Cash</option>
                                  <option value="bank">Bank transfer</option>
                                  <option value="other">Other</option>
                                </Select>
                              </Field>
                            }
                          >
                            <p>The order goes into the sales record and to the kitchen as paid ({money(o.totalCents, o.currency)}). A refund later has to be given the same way: no card is behind it.</p>
                          </ConfirmAction>
                        ) : null}
                        <ConfirmAction trigger="Cancel" title={`Cancel order ${o.reference}?`} action={cancelDraft} hidden={{ orderId: o.id }} confirmLabel="Cancel the order" reason={{ label: 'Why (kept on the record)', placeholder: 'The guest changed their mind.' }} testId={`cancel-draft-${o.reference}`}>
                          <p>Nothing was charged, so nothing is refunded and the guest is not written to.</p>
                        </ConfirmAction>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
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
