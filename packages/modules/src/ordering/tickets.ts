import type { Selectable } from 'kysely';
import { z } from 'zod';
import { type Ctx, type DB, AppError, assertModule, isAppError, json, localParts, notFound, requireDevice, sql, staffOf, track } from '@ros/core';
import { queueMessage } from '../comms/outbox';
import { getVenue } from '../tenancy/venues';
import type { OrderStatus } from './contract';
import { type OrderingConfig, orderingModule, ticketAcknowledged } from './module';
import { TERMINAL, transition } from './orders';
import { type OrderItemRow, type OrderRow, CHANNEL_LABEL, firstName, frozenModifiers, itemSummary, loadOrder, whenLine } from './rows';

/**
 * The kitchen order screen's data (docs/ROADMAP.md Stage 2, docs/modules/ordering.md section 5).
 * One ticket per paid order. `ticket_events` is the sync unit (docs/modules/kds.md section 9): a
 * screen that was offline replays its taps, each with its own key, and the ticket's state is the
 * fold of its events in the order they happened. Events are idempotent; state is derived.
 */

export type TicketRow = Selectable<DB['kitchen_tickets']>;
type TicketStatus = TicketRow['status'];
type TicketEvent = 'received' | 'viewed' | 'acknowledged' | 'ready' | 'bumped' | 'recalled' | 'cancelled';

/** What a screen may send. 'received' and 'cancelled' are the platform's own. */
export const SCREEN_EVENTS = ['viewed', 'acknowledged', 'ready', 'bumped', 'recalled'] as const;

interface Folded {
  status: TicketStatus;
  firstViewedAt: Date | null;
  acknowledgedAt: Date | null;
  readyAt: Date | null;
  bumpedAt: Date | null;
}

export function foldTicketEvents(events: Array<{ event: string; occurred_at: Date }>): Folded {
  const s: Folded = { status: 'new', firstViewedAt: null, acknowledgedAt: null, readyAt: null, bumpedAt: null };
  for (const e of events) {
    const at = e.occurred_at;
    if (s.status === 'cancelled') break;
    switch (e.event as TicketEvent) {
      case 'viewed':
        s.firstViewedAt ??= at;
        break;
      case 'acknowledged':
        s.firstViewedAt ??= at;
        s.acknowledgedAt ??= at;
        if (s.status === 'new') s.status = 'acknowledged';
        break;
      case 'ready':
        if (s.status === 'new' || s.status === 'acknowledged') {
          s.firstViewedAt ??= at;
          s.acknowledgedAt ??= at;
          s.readyAt = at;
          s.status = 'ready';
        }
        break;
      case 'bumped':
        if (s.status !== 'bumped') {
          s.firstViewedAt ??= at;
          s.acknowledgedAt ??= at;
          s.readyAt ??= at;
          s.bumpedAt = at;
          s.status = 'bumped';
        }
        break;
      case 'recalled':
        // Recall undoes a bump, and only a bump.
        if (s.status === 'bumped') {
          s.bumpedAt = null;
          s.status = 'ready';
        }
        break;
      case 'cancelled':
        s.status = 'cancelled';
        break;
      default:
        break;
    }
  }
  return s;
}

interface AppendResult {
  /** False when this key had already been recorded: a replay, which changes nothing. */
  inserted: boolean;
  ticket: TicketRow;
}

async function appendEvent(ctx: Ctx, ticket: TicketRow, event: TicketEvent, key: string, occurredAt: Date, metadata: Record<string, unknown> = {}): Promise<AppendResult> {
  const p = ctx.principal;
  const inserted = await ctx.db
    .insertInto('ticket_events')
    .values({
      org_id: ctx.orgId,
      ticket_id: ticket.id,
      event,
      device_id: p.kind === 'device' ? p.deviceId : null,
      staff_id: staffOf(ctx)?.staffId ?? null,
      idempotency_key: key,
      occurred_at: occurredAt,
      metadata: json(metadata),
    })
    .onConflict((oc) => oc.columns(['org_id', 'idempotency_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return { inserted: false, ticket };

  const events = await ctx.db.selectFrom('ticket_events').select(['event', 'occurred_at']).where('ticket_id', '=', ticket.id).orderBy('occurred_at').orderBy('seq').execute();
  const f = foldTicketEvents(events);
  const updated = await ctx.db
    .updateTable('kitchen_tickets')
    .set({ status: f.status, first_viewed_at: f.firstViewedAt, acknowledged_at: f.acknowledgedAt, ready_at: f.readyAt, bumped_at: f.bumpedAt })
    .where('id', '=', ticket.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return { inserted: true, ticket: updated };
}

/**
 * Put a paid order in front of the kitchen. Called once payment is confirmed and never before,
 * so a prank cannot print tickets. Safe to call again: an order has one ticket.
 */
export async function createTicket(ctx: Ctx, order: OrderRow, items: OrderItemRow[], cfg: OrderingConfig): Promise<TicketRow> {
  const existing = await ctx.db.selectFrom('kitchen_tickets').selectAll().where('order_id', '=', order.id).executeTakeFirst();
  if (existing) return existing;
  const venue = await getVenue(ctx, order.venue_id);
  const now = ctx.now();
  const serviceDate = localParts(now, venue.timezone).date;
  // Ticket numbers are per venue per day; one ticket at a time takes the next.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`ticket-number:${order.venue_id}:${serviceDate}`}, 0))`.execute(ctx.db);
  const last = await ctx.db
    .selectFrom('kitchen_tickets')
    .select((eb) => eb.fn.max('ticket_number').as('n'))
    .where('venue_id', '=', order.venue_id)
    .where('service_date', '=', serviceDate)
    .executeTakeFirst();
  const allergens = [...new Set(items.flatMap((i) => i.allergens))].sort();

  const ticket = await ctx.db
    .insertInto('kitchen_tickets')
    .values({
      org_id: ctx.orgId,
      venue_id: order.venue_id,
      order_id: order.id,
      ticket_number: Number(last?.n ?? 0) + 1,
      service_date: serviceDate,
      status: 'new',
      channel: order.channel,
      table_label: order.table_label,
      guest_name: order.customer_name ? firstName(order) : null,
      notes: order.customer_note,
      allergen_flags: allergens,
      target_ready_at: order.promised_at,
      received_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await appendEvent(ctx, ticket, 'received', `received:${ticket.id}`, now);

  // The other ways a venue hears about an order, when it has asked for them.
  const variables = {
    venue_name: venue.name,
    reference: order.reference,
    channel_label: CHANNEL_LABEL[order.channel],
    summary: itemSummary(items, order.currency, { prices: false }),
    when_line: whenLine(order, venue.timezone),
    allergen_line: allergens.length ? allergens.join(', ') : 'none listed',
    note_line: order.customer_note ? `Guest note (their words): "${order.customer_note}"` : '',
  };
  if (cfg.kitchen_routing.includes('email') && cfg.kitchen_email) {
    await queueMessage(ctx, { templateKey: 'order.kitchen_new', channel: 'email', to: cfg.kitchen_email, idempotencyKey: `order:${order.id}:kitchen:email`, variables, venueId: order.venue_id });
  }
  if (cfg.kitchen_routing.includes('sms') && cfg.manager_sms) {
    await queueMessage(ctx, { templateKey: 'order.kitchen_new', channel: 'sms', to: cfg.manager_sms, idempotencyKey: `order:${order.id}:kitchen:sms`, variables, venueId: order.venue_id });
  }
  return ticket;
}

const STATUS_EVENT: Partial<Record<OrderStatus, TicketEvent>> = {
  accepted: 'acknowledged',
  preparing: 'acknowledged',
  ready: 'ready',
  completed: 'bumped',
  rejected: 'cancelled',
  cancelled: 'cancelled',
  refunded: 'cancelled',
};

/**
 * Keep the ticket in step when an order's status is changed somewhere other than the kitchen
 * screen (the console, an assistant, a refund). `changeId` is the status-history row, so each
 * change lands on the ticket once.
 */
export async function noteOrderStatus(ctx: Ctx, order: OrderRow, change: { from: OrderStatus; to: OrderStatus; changeId: string }): Promise<void> {
  const ticket = await ctx.db.selectFrom('kitchen_tickets').selectAll().where('order_id', '=', order.id).executeTakeFirst();
  if (!ticket) return;
  const event: TicketEvent | undefined = change.to === 'ready' && change.from === 'completed' ? 'recalled' : STATUS_EVENT[change.to];
  if (!event) return;
  await appendEvent(ctx, ticket, event, `order-status:${change.changeId}`, ctx.now());
}

const CHAIN: OrderStatus[] = ['placed', 'accepted', 'preparing', 'ready', 'completed'];

/** The kitchen moved the ticket: bring the order along, one step at a time so every step is recorded. */
async function followTicket(ctx: Ctx, ticket: TicketRow): Promise<void> {
  const target: OrderStatus | null = ticket.status === 'acknowledged' ? 'preparing' : ticket.status === 'ready' ? 'ready' : ticket.status === 'bumped' ? 'completed' : null;
  if (!target) return;
  let order = await loadOrder(ctx, ticket.order_id, { lock: true });
  if (TERMINAL.includes(order.status) || !CHAIN.includes(order.status)) return;
  if (order.status === 'completed' && target === 'ready') {
    await transition(ctx, order, 'ready');
    return;
  }
  while (CHAIN.indexOf(order.status) < CHAIN.indexOf(target)) {
    order = (await transition(ctx, order, CHAIN[CHAIN.indexOf(order.status) + 1]!)).order;
  }
}

export interface TicketView {
  id: string;
  orderId: string;
  reference: string;
  ticketNumber: number;
  serviceDate: string;
  status: TicketStatus;
  /** True until someone acknowledges the ticket: the screen repeats its alert while this holds. */
  needsAlert: boolean;
  channel: TicketRow['channel'];
  tableLabel: string | null;
  guestName: string | null;
  /** Guest-written. Text, never markup. */
  notes: string | null;
  /** Every allergen on the ticket. A safety field: shown without a tap. */
  allergenFlags: string[];
  targetReadyAt: Date | null;
  receivedAt: Date;
  firstViewedAt: Date | null;
  acknowledgedAt: Date | null;
  readyAt: Date | null;
  bumpedAt: Date | null;
  items: Array<{ name: string; qty: number; modifiers: string[]; note: string | null; allergens: string[] }>;
}

async function ticketViews(ctx: Ctx, tickets: TicketRow[]): Promise<TicketView[]> {
  if (!tickets.length) return [];
  const orderIds = tickets.map((t) => t.order_id);
  const orders = await ctx.db.selectFrom('orders').select(['id', 'reference']).where('id', 'in', orderIds).execute();
  const items = await ctx.db.selectFrom('order_items').selectAll().where('order_id', 'in', orderIds).orderBy('line_no').execute();
  return tickets.map((t) => ({
    id: t.id,
    orderId: t.order_id,
    reference: orders.find((o) => o.id === t.order_id)?.reference ?? '',
    ticketNumber: t.ticket_number,
    serviceDate: t.service_date,
    status: t.status,
    needsAlert: t.status === 'new',
    channel: t.channel,
    tableLabel: t.table_label,
    guestName: t.guest_name,
    notes: t.notes,
    allergenFlags: t.allergen_flags,
    targetReadyAt: t.target_ready_at,
    receivedAt: t.received_at,
    firstViewedAt: t.first_viewed_at,
    acknowledgedAt: t.acknowledged_at,
    readyAt: t.ready_at,
    bumpedAt: t.bumped_at,
    items: items
      .filter((i) => i.order_id === t.order_id)
      .map((i) => ({ name: i.name_snapshot, qty: i.qty, modifiers: frozenModifiers(i).map((m) => m.name), note: i.note, allergens: i.allergens })),
  }));
}

export const liveTicketsInput = z.object({
  /** A paired screen may leave this out: it has one venue. */
  venueId: z.string().uuid().optional(),
  /** Bumped tickets stay listed this long, so a mis-tap can be recalled. */
  keepBumpedMinutes: z.number().int().min(0).max(240).default(15),
});

export interface TicketBoard {
  venueId: string;
  serverTime: Date;
  alertRepeatSeconds: number;
  tickets: TicketView[];
}

/** What a kitchen screen shows: tickets not yet handed over, oldest first, and the recently bumped. */
export async function listLiveTickets(ctx: Ctx, raw: z.input<typeof liveTicketsInput> = {}): Promise<TicketBoard> {
  const input = liveTicketsInput.parse(raw);
  const venueId = input.venueId ?? (ctx.principal.kind === 'device' ? ctx.principal.venueId : undefined);
  if (!venueId) throw new AppError('invalid', 'Choose a venue.');
  requireDevice(ctx, venueId, 'kitchen');
  const cfg = await assertModule(ctx, venueId, orderingModule);
  const now = ctx.now();
  const bumpedSince = new Date(now.getTime() - input.keepBumpedMinutes * 60_000);
  const tickets = await ctx.db
    .selectFrom('kitchen_tickets')
    .selectAll()
    .where('venue_id', '=', venueId)
    .where((eb) => eb.or([eb('status', 'in', ['new', 'acknowledged', 'ready']), eb.and([eb('status', '=', 'bumped'), eb('bumped_at', '>', bumpedSince)])]))
    .orderBy('received_at')
    .orderBy('ticket_number')
    .limit(200)
    .execute();
  return { venueId, serverTime: now, alertRepeatSeconds: cfg.alert_repeat_seconds, tickets: await ticketViews(ctx, tickets) };
}

export const ticketEventInput = z.object({
  ticketId: z.string().uuid(),
  event: z.enum(SCREEN_EVENTS),
  /** Made by the screen when the button was tapped. Sending it again changes nothing. */
  key: z.string().min(8).max(100),
  /** When it was tapped, if the screen was offline and is catching up. */
  occurredAt: z.string().datetime().optional(),
});

/**
 * A tap on the kitchen screen: viewed, acknowledged, ready, bumped or recalled. A paired kitchen
 * screen or kitchen staff, for their own venue only. Idempotent per key, so an offline screen can
 * replay everything it queued. The order follows the ticket: acknowledged = being prepared,
 * ready = ready (the guest is told), bumped = handed over, recalled = back to ready.
 */
export async function recordTicketEvent(ctx: Ctx, raw: z.input<typeof ticketEventInput>): Promise<TicketView> {
  const input = ticketEventInput.parse(raw);
  const ticket = await ctx.db.selectFrom('kitchen_tickets').selectAll().where('id', '=', input.ticketId).forUpdate().executeTakeFirst();
  if (!ticket) throw notFound('Ticket not found');
  requireDevice(ctx, ticket.venue_id, 'kitchen');
  await assertModule(ctx, ticket.venue_id, orderingModule);

  // A screen's clock is not trusted far: the time it reports must sit between the ticket arriving and now.
  const now = ctx.now();
  let at = now;
  if (input.occurredAt) {
    const t = new Date(input.occurredAt);
    if (t <= now && t >= ticket.received_at) at = t;
  }

  const result = await appendEvent(ctx, ticket, input.event, `screen:${input.key}`, at);
  if (result.inserted) {
    if (ticket.status === 'new' && result.ticket.status !== 'new' && result.ticket.acknowledged_at) {
      await track(
        ctx,
        ticketAcknowledged,
        { ticket_id: ticket.id, order_id: ticket.order_id, seconds_to_acknowledge: Math.max(0, Math.round((result.ticket.acknowledged_at.getTime() - ticket.received_at.getTime()) / 1000)) },
        { venueId: ticket.venue_id },
      );
    }
    await followTicket(ctx, result.ticket);
  }
  return (await ticketViews(ctx, [result.ticket]))[0]!;
}

export const ticketEventsInput = z.object({ events: z.array(ticketEventInput).min(1).max(200) });

/** A screen coming back online sends everything it queued. Each event stands alone: one that cannot apply does not stop the rest. */
export async function recordTicketEvents(ctx: Ctx, raw: z.input<typeof ticketEventsInput>): Promise<Array<{ key: string; ok: boolean; error?: string }>> {
  const input = ticketEventsInput.parse(raw);
  const out: Array<{ key: string; ok: boolean; error?: string }> = [];
  for (const e of input.events) {
    try {
      await recordTicketEvent(ctx, e);
      out.push({ key: e.key, ok: true });
    } catch (err) {
      if (!isAppError(err)) throw err;
      out.push({ key: e.key, ok: false, error: err.message });
    }
  }
  return out;
}

/** Change an order's status from outside the kitchen screen, and keep its ticket in step. */
export async function moveOrder(ctx: Ctx, order: OrderRow, to: OrderStatus, opts: { reason?: string | null } = {}): Promise<OrderRow> {
  const from = order.status;
  const moved = await transition(ctx, order, to, opts);
  if (moved.historyId) await noteOrderStatus(ctx, moved.order, { from, to, changeId: moved.historyId });
  return moved.order;
}
