/**
 * The kitchen screen's pure logic: what a ticket looks like after the taps this screen has not
 * yet sent, how late it is, and the order tickets are laid out in. No React, no browser APIs,
 * so the rules are easy to read in one place.
 */

export type TicketStatus = 'new' | 'acknowledged' | 'ready' | 'bumped' | 'cancelled';
export type ScreenEvent = 'viewed' | 'acknowledged' | 'ready' | 'bumped' | 'recalled';

/** A ticket as the screen receives it (listLiveTickets, dates as ISO strings). */
export interface KTicket {
  id: string;
  orderId: string;
  reference: string;
  ticketNumber: number;
  status: TicketStatus;
  needsAlert: boolean;
  channel: 'pickup' | 'delivery' | 'dine-in-qr';
  tableLabel: string | null;
  guestName: string | null;
  notes: string | null;
  allergenFlags: string[];
  targetReadyAt: string | null;
  receivedAt: string;
  acknowledgedAt: string | null;
  readyAt: string | null;
  bumpedAt: string | null;
  items: Array<{ name: string; qty: number; modifiers: string[]; note: string | null; allergens: string[] }>;
}

export interface KBoard {
  venueId: string;
  serverTime: string;
  alertRepeatSeconds: number;
  tickets: KTicket[];
}

/** A tap waiting to reach the server. `key` is the idempotency key: replaying it changes nothing. */
export interface QueuedEvent {
  key: string;
  ticketId: string;
  event: ScreenEvent;
  occurredAt: string;
}

/**
 * Server state wins for a ticket's content; this screen's own unsent (or just-sent) taps are
 * folded over its status, with the same rules the server folds ticket_events by.
 */
export function foldStatus(status: TicketStatus, events: Array<Pick<QueuedEvent, 'event'>>): TicketStatus {
  let s = status;
  for (const e of events) {
    if (s === 'cancelled') break;
    switch (e.event) {
      case 'acknowledged':
        if (s === 'new') s = 'acknowledged';
        break;
      case 'ready':
        if (s === 'new' || s === 'acknowledged') s = 'ready';
        break;
      case 'bumped':
        s = 'bumped';
        break;
      case 'recalled':
        if (s === 'bumped') s = 'ready';
        break;
      default:
        break;
    }
  }
  return s;
}

/** Minutes a ticket has to be ready when the order carries no promised time. */
export const DEFAULT_TARGET_MINUTES = 20;

export type Level = 'ok' | 'soon' | 'due' | 'over' | 'ready' | 'done';

export interface Escalation {
  level: Level;
  /** The words on the ticket. Colour is never the only signal. */
  label: string;
  /** The time part, e.g. "12 min left", "4 min late". */
  timing: string;
  ageMinutes: number;
  /** Minutes past the promised time; 0 when not late. */
  minutesLate: number;
  /** Minutes until the promised time; 0 when due or late. */
  minutesLeft: number;
}

/**
 * Age against the promised time (docs/modules/kds.md section 5): under 60% of the time used is
 * on track, 60–90% due soon, 90–100% due now, beyond it overdue.
 */
export function escalation(t: Pick<KTicket, 'receivedAt' | 'targetReadyAt'>, status: TicketStatus, nowMs: number): Escalation {
  const received = Date.parse(t.receivedAt);
  const target = t.targetReadyAt ? Date.parse(t.targetReadyAt) : received + DEFAULT_TARGET_MINUTES * 60_000;
  const ageMinutes = Math.max(0, Math.floor((nowMs - received) / 60_000));
  const minutesLate = Math.max(0, Math.floor((nowMs - target) / 60_000));
  const minutesLeft = Math.max(0, Math.ceil((target - nowMs) / 60_000));
  const age = `${ageMinutes} min old`;
  if (status === 'ready') return { level: 'ready', label: 'READY', timing: age, ageMinutes, minutesLate: 0, minutesLeft: 0 };
  if (status === 'bumped' || status === 'cancelled') return { level: 'done', label: status === 'bumped' ? 'BUMPED' : 'CANCELLED', timing: age, ageMinutes, minutesLate: 0, minutesLeft: 0 };
  const span = Math.max(60_000, target - received);
  const used = (nowMs - received) / span;
  if (nowMs >= target) return { level: 'over', label: 'OVERDUE', timing: `${minutesLate} min late`, ageMinutes, minutesLate, minutesLeft: 0 };
  if (used >= 0.9) return { level: 'due', label: 'DUE NOW', timing: `${minutesLeft} min left`, ageMinutes, minutesLate: 0, minutesLeft };
  if (used >= 0.6) return { level: 'soon', label: 'DUE SOON', timing: `${minutesLeft} min left`, ageMinutes, minutesLate: 0, minutesLeft };
  return { level: 'ok', label: 'ON TRACK', timing: `${minutesLeft} min left`, ageMinutes, minutesLate: 0, minutesLeft };
}

export interface Shown {
  ticket: KTicket;
  status: TicketStatus;
  esc: Escalation;
}

const rank = (s: Shown) => (s.esc.level === 'over' ? 0 : s.status === 'new' || s.status === 'acknowledged' ? 1 : s.status === 'ready' ? 2 : 3);

/**
 * The order tickets are laid out in. Overdue tickets come first (most overdue first) so that an
 * overdue ticket is never on a later page than one that is not; then the rest oldest first; then
 * the ready ones waiting to go; the recently bumped last, kept only so a mis-tap can be recalled.
 */
export function layoutOrder(shown: Shown[]): Shown[] {
  return [...shown].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    if (rank(a) === 0) return b.esc.minutesLate - a.esc.minutesLate || a.ticket.receivedAt.localeCompare(b.ticket.receivedAt);
    if (rank(a) === 3) return (b.ticket.bumpedAt ?? '').localeCompare(a.ticket.bumpedAt ?? '');
    return a.ticket.receivedAt.localeCompare(b.ticket.receivedAt) || a.ticket.ticketNumber - b.ticket.ticketNumber;
  });
}

export const CHANNEL_LABEL: Record<KTicket['channel'], string> = { pickup: 'PICKUP', delivery: 'DELIVERY', 'dine-in-qr': 'TABLE' };
