import { z } from 'zod';
import { type App, type Ctx, type StaffRole, ROLE_RANK, addDays, audit, defineJob, defineSchedule, invalid, localParts, notFound, requireStaff, sql, zonedTimeToUtc } from '@ros/core';
import { computeDigest } from '../analytics/digest';
import { getOrgSettings, setOrgSettings } from '../tenancy/orgs';
import { getVenue } from '../tenancy/venues';
import { type QueueResult, queueMessage } from './outbox';
import { defineTemplate } from './templates';

/**
 * Alerts to the team (docs/CONSOLE_IA.md section 9, pattern 13). A venue chooses, per event, who
 * is told and how: a staff member or everyone holding a role, by email or text, each rule on or
 * off, with quiet hours for the whole organisation. Every alert is a transactional message to a
 * staff member through the outbox: never to a guest, never marketing, never a message the outbox
 * would not send.
 *
 * Alerts are raised from the activity stream, not from inside the modules that record the
 * events: a dispatcher reads `events` from a watermark every few minutes and words each one. The
 * alert's idempotency key names the event row and the rule, so a re-read never sends twice. The
 * daily and weekly digests are alerts too; the weekly one is the hosted `weekly_digest` agent,
 * which reads its recipients from here.
 */
export const ALERT_EVENTS = ['order.new', 'booking.new', 'booking.cancelled', 'review.posted', 'assistant.needs_yes', 'delivery.problem', 'digest.daily', 'digest.weekly'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
export const ALERT_CHANNELS = ['email', 'sms'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export interface AlertEventDef {
  key: AlertEvent;
  label: string;
  description: string;
  /** The activity-stream event it is raised from; null for the digests, which have their own clock. */
  from: string | null;
  /** Goes at once whatever the quiet hours say: the kitchen needs to know about an order now. */
  urgent: boolean;
  /** The module whose switch decides whether this event can happen; null when it always can. */
  module: string | null;
}

export const ALERT_EVENT_DEFS: Record<AlertEvent, AlertEventDef> = {
  'order.new': { key: 'order.new', label: 'A new order', description: 'A paid order has arrived and is waiting to be accepted.', from: 'order.paid', urgent: true, module: 'ordering' },
  'booking.new': { key: 'booking.new', label: 'A new booking', description: 'A guest booked a table, or asked for one.', from: 'booking.requested', urgent: false, module: 'bookings' },
  'booking.cancelled': { key: 'booking.cancelled', label: 'A booking cancelled', description: 'A guest or a team member cancelled a booking.', from: 'booking.cancelled', urgent: false, module: 'bookings' },
  'review.posted': { key: 'review.posted', label: 'A review posted', description: 'A new review arrived from a connected listing.', from: 'review.received', urgent: false, module: 'reviews' },
  'assistant.needs_yes': { key: 'assistant.needs_yes', label: 'The assistant needs a yes', description: 'An assistant or an agent proposed a change that waits for your approval.', from: 'approval.requested', urgent: false, module: null },
  'delivery.problem': { key: 'delivery.problem', label: 'A delivery problem', description: 'A delivery could not be made: no courier, failed, returned or cancelled.', from: 'delivery.failed', urgent: true, module: 'delivery' },
  'digest.daily': { key: 'digest.daily', label: 'The daily digest', description: 'Each morning: yesterday against what is usual for that weekday.', from: null, urgent: false, module: null },
  'digest.weekly': { key: 'digest.weekly', label: 'The weekly digest', description: 'Monday morning: the week against what is usual, in plain words.', from: null, urgent: false, module: null },
};

export const ALERT_ROLES: StaffRole[] = ['owner', 'manager', 'host', 'front_of_house', 'kitchen'];
export const ROLE_WORDS: Record<StaffRole, string> = { owner: 'Owners', manager: 'Managers', host: 'Hosts', front_of_house: 'Front of house', kitchen: 'Kitchen', read_only: 'Read-only' };

// ── Settings: quiet hours ─────────────────────────────────────────────────────

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00.');

export const alertSettings = z.object({
  /** Alerts that are not urgent wait until the end of this venue-local window. Null: no quiet hours. */
  quietHours: z.object({ start: HHMM, end: HHMM }).nullable().default({ start: '22:00', end: '07:00' }),
  /** The hour (0-23, venue time) the daily digest goes. */
  dailyDigestHour: z.number().int().min(0).max(23).default(7),
});
export type AlertSettings = z.infer<typeof alertSettings>;
export const defaultAlertSettings: AlertSettings = alertSettings.parse({});
export const ALERTS_SETTINGS_NAMESPACE = 'alerts';

/** Quiet hours and the digest hour. Manager and above. */
export async function getAlertSettings(ctx: Ctx): Promise<AlertSettings> {
  requireStaff(ctx, { minRole: 'manager' });
  return getOrgSettings(ctx, ALERTS_SETTINGS_NAMESPACE, alertSettings, defaultAlertSettings);
}

export async function setAlertSettings(ctx: Ctx, patch: Partial<z.input<typeof alertSettings>>): Promise<AlertSettings> {
  const current = await getAlertSettings(ctx);
  const next = alertSettings.parse({ ...current, ...patch });
  return setOrgSettings(ctx, ALERTS_SETTINGS_NAMESPACE, alertSettings, next);
}

/** Whether a venue-local time (HH:MM) falls inside the window, which may cross midnight. */
export function inQuietHours(hhmm: string, q: { start: string; end: string } | null): boolean {
  if (!q || q.start === q.end) return false;
  return q.start > q.end ? hhmm >= q.start || hhmm < q.end : hhmm >= q.start && hhmm < q.end;
}

/** When the quiet hours end, as an instant, for a moment inside them. */
export function quietHoursEnd(now: Date, tz: string, q: { start: string; end: string }): Date {
  const local = localParts(now, tz);
  const hhmm = local.time.slice(0, 5);
  const day = q.start > q.end && hhmm >= q.start ? addDays(local.date, 1) : local.date;
  return zonedTimeToUtc(day, `${q.end}:00`, tz);
}

// ── Templates ─────────────────────────────────────────────────────────────────

const teamVars = z.object({ title: z.string().max(200), body: z.string().max(3000), link: z.string().max(400) });

export const alertEmail = defineTemplate({
  key: 'alerts.team',
  channel: 'email',
  kind: 'transactional',
  description: 'An alert to a team member: a new order or booking, a review, a delivery problem, an assistant waiting for a yes, or a digest.',
  subject: '{{title}}',
  body: '{{body}}\n\n{{link}}',
  variables: teamVars,
});

export const alertSms = defineTemplate({
  key: 'alerts.team',
  channel: 'sms',
  kind: 'transactional',
  description: 'The same alert as a text: one line and a link.',
  body: '{{org_name}}: {{title}}. {{body}} {{link}}',
  variables: teamVars,
});

// ── Rules ─────────────────────────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  venueId: string;
  event: AlertEvent;
  channel: AlertChannel;
  recipient: { kind: 'staff'; staffId: string; name: string; hasPhone: boolean } | { kind: 'role'; role: StaffRole };
  enabled: boolean;
}

const recipientInput = z.union([z.object({ kind: z.literal('staff'), staffId: z.string().uuid() }).strict(), z.object({ kind: z.literal('role'), role: z.enum(['owner', 'manager', 'host', 'front_of_house', 'kitchen']) }).strict()]);

export const setAlertRuleInput = z
  .object({
    venueId: z.string().uuid(),
    event: z.enum(ALERT_EVENTS),
    channel: z.enum(ALERT_CHANNELS),
    recipient: recipientInput,
    enabled: z.boolean().default(true),
  })
  .strict();
export type SetAlertRuleInput = z.input<typeof setAlertRuleInput>;

const COLS = ['id', 'venue_id', 'event', 'channel', 'recipient_kind', 'recipient', 'enabled'] as const;
type Row = { id: string; venue_id: string; event: string; channel: 'email' | 'sms'; recipient_kind: string; recipient: string; enabled: boolean };

async function staffAt(ctx: Ctx, venueId: string): Promise<Array<{ id: string; firstName: string; lastName: string | null; email: string; phone: string | null; role: StaffRole }>> {
  const rows = await ctx.db
    .selectFrom('staff_venues as sv')
    .innerJoin('staff as s', 's.id', 'sv.staff_id')
    .select(['s.id', 's.first_name', 's.last_name', 's.email', 's.phone', 'sv.role'])
    .where('sv.venue_id', '=', venueId)
    .where('s.status', '!=', 'disabled')
    .orderBy('s.first_name')
    .execute();
  return rows.map((r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone, role: r.role }));
}

const fullName = (s: { firstName: string; lastName: string | null }) => [s.firstName, s.lastName].filter(Boolean).join(' ');

function ruleOf(r: Row, people: Map<string, { name: string; hasPhone: boolean }>): AlertRule {
  const recipient: AlertRule['recipient'] =
    r.recipient_kind === 'staff'
      ? { kind: 'staff', staffId: r.recipient, name: people.get(r.recipient)?.name ?? 'A former team member', hasPhone: people.get(r.recipient)?.hasPhone ?? false }
      : { kind: 'role', role: r.recipient as StaffRole };
  return { id: r.id, venueId: r.venue_id, event: r.event as AlertEvent, channel: r.channel, recipient, enabled: r.enabled };
}

export interface AlertCatalogue {
  venueId: string;
  events: AlertEventDef[];
  rules: AlertRule[];
  /** Who can be chosen at this venue. */
  people: Array<{ staffId: string; name: string; role: StaffRole; hasPhone: boolean }>;
  roles: Array<{ role: StaffRole; label: string; count: number }>;
  settings: AlertSettings;
}

/** The rules at a venue with the events and people they can name. Manager and above at the venue. */
export async function listAlertRules(ctx: Ctx, raw: { venueId: string }): Promise<AlertCatalogue> {
  const { venueId } = z.object({ venueId: z.string().uuid() }).parse(raw);
  requireStaff(ctx, { venueId, minRole: 'manager' });
  await getVenue(ctx, venueId);
  const people = await staffAt(ctx, venueId);
  const byId = new Map(people.map((p) => [p.id, { name: fullName(p), hasPhone: !!p.phone }]));
  const rows = await ctx.db.selectFrom('alert_rules').select(COLS).where('venue_id', '=', venueId).orderBy('event').orderBy('channel').orderBy('created_at').execute();
  return {
    venueId,
    events: ALERT_EVENTS.map((e) => ALERT_EVENT_DEFS[e]),
    rules: rows.map((r) => ruleOf(r, byId)),
    people: people.map((p) => ({ staffId: p.id, name: fullName(p), role: p.role, hasPhone: !!p.phone })),
    roles: ALERT_ROLES.map((role) => ({ role, label: ROLE_WORDS[role], count: people.filter((p) => p.role === role).length })),
    settings: await getOrgSettings(ctx, ALERTS_SETTINGS_NAMESPACE, alertSettings, defaultAlertSettings),
  };
}

/** Add or switch a rule: who is told, how, for one event at one venue. Manager and above at the venue. */
export async function setAlertRule(ctx: Ctx, raw: SetAlertRuleInput): Promise<AlertRule> {
  const parsed = setAlertRuleInput.safeParse(raw);
  if (!parsed.success) throw invalid('That alert rule is not valid.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const input = parsed.data;
  const staff = requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  await getVenue(ctx, input.venueId);
  const people = await staffAt(ctx, input.venueId);
  const byId = new Map(people.map((p) => [p.id, { name: fullName(p), hasPhone: !!p.phone }]));
  const wanted = input.recipient;
  if (wanted.kind === 'staff') {
    const person = people.find((p) => p.id === wanted.staffId);
    if (!person) throw notFound('That team member is not at this venue.');
    if (input.channel === 'sms' && !person.phone) throw invalid(`${fullName(person)} has no phone number on the team page, so a text cannot reach them.`);
  }
  const recipient = wanted.kind === 'staff' ? wanted.staffId : wanted.role;
  const before = await ctx.db
    .selectFrom('alert_rules')
    .select(COLS)
    .where('venue_id', '=', input.venueId)
    .where('event', '=', input.event)
    .where('channel', '=', input.channel)
    .where('recipient_kind', '=', input.recipient.kind)
    .where('recipient', '=', recipient)
    .executeTakeFirst();
  const row = before
    ? await ctx.db.updateTable('alert_rules').set({ enabled: input.enabled, updated_at: ctx.now() }).where('id', '=', before.id).returning(COLS).executeTakeFirstOrThrow()
    : await ctx.db
        .insertInto('alert_rules')
        .values({ org_id: ctx.orgId, venue_id: input.venueId, event: input.event, channel: input.channel, recipient_kind: input.recipient.kind, recipient, enabled: input.enabled, created_by_id: staff?.staffId ?? null, created_at: ctx.now(), updated_at: ctx.now() })
        .returning(COLS)
        .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'alerts.rule_set',
    entityType: 'alert_rule',
    entityId: row.id,
    venueId: input.venueId,
    before: before ? { enabled: before.enabled } : undefined,
    after: { event: input.event, channel: input.channel, recipient: input.recipient, enabled: input.enabled },
  });
  return ruleOf(row, byId);
}

/** Take a rule away. Manager and above at its venue; another org's is not found. */
export async function removeAlertRule(ctx: Ctx, id: string): Promise<void> {
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success) throw notFound('Alert rule not found');
  const row = await ctx.db.selectFrom('alert_rules').select(COLS).where('id', '=', parsed.data).executeTakeFirst();
  if (!row) throw notFound('Alert rule not found');
  requireStaff(ctx, { venueId: row.venue_id, minRole: 'manager' });
  await ctx.db.deleteFrom('alert_rules').where('id', '=', row.id).execute();
  await audit(ctx, { action: 'alerts.rule_removed', entityType: 'alert_rule', entityId: row.id, venueId: row.venue_id, before: { event: row.event, channel: row.channel, recipient_kind: row.recipient_kind, recipient: row.recipient } });
}

// ── Delivery ──────────────────────────────────────────────────────────────────

export interface Alert {
  venueId: string;
  event: AlertEvent;
  /** One line, e.g. "New order A7K2". */
  title: string;
  /** A sentence or two. Never guest-written text. */
  body: string;
  /** Where to act on it in the console. */
  link: string;
  /** Names what the alert is about; the rule and recipient are added to it. */
  idempotencyKey: string;
}

export interface Notified {
  /** Messages queued or deferred, one per recipient and channel. */
  queued: number;
  /** Recipients a rule named who could not be reached (no phone, disabled). */
  skipped: number;
  /** When the messages wait until, if quiet hours applied. */
  heldUntil: Date | null;
  messageIds: string[];
}

type Person = { id: string; firstName: string; lastName: string | null; email: string; phone: string | null; role: StaffRole };

/** The people a rule names at a venue, right now. A role names everyone holding it there; owners always count as owners. */
function resolveRecipients(rule: Row, people: Person[]): Person[] {
  if (rule.recipient_kind === 'staff') return people.filter((p) => p.id === rule.recipient);
  const role = rule.recipient as StaffRole;
  return people.filter((p) => p.role === role || (role === 'owner' && ROLE_RANK[p.role] >= ROLE_RANK.owner));
}

/**
 * Tell the team about something, through every enabled rule for the event at the venue. Each
 * recipient gets one message per channel, keyed by the alert, the rule and the person, so the same
 * alert raised twice is sent once. Quiet hours hold a message that is not urgent until they end.
 * No role check: callers are the dispatcher and this module's own test send.
 */
export async function notifyTeam(ctx: Ctx, alert: Alert, opts: { onlyRuleId?: string } = {}): Promise<Notified> {
  const def = ALERT_EVENT_DEFS[alert.event];
  let q = ctx.db.selectFrom('alert_rules').select(COLS).where('venue_id', '=', alert.venueId).where('event', '=', alert.event).where('enabled', '=', true);
  if (opts.onlyRuleId) q = q.where('id', '=', opts.onlyRuleId);
  const rules = await q.execute();
  const out: Notified = { queued: 0, skipped: 0, heldUntil: null, messageIds: [] };
  if (!rules.length) return out;
  const venue = await getVenue(ctx, alert.venueId);
  const settings = await getOrgSettings(ctx, ALERTS_SETTINGS_NAMESPACE, alertSettings, defaultAlertSettings);
  const now = ctx.now();
  const local = localParts(now, venue.timezone);
  const held = !def.urgent && settings.quietHours && inQuietHours(local.time.slice(0, 5), settings.quietHours) ? quietHoursEnd(now, venue.timezone, settings.quietHours) : null;
  const people = await staffAt(ctx, alert.venueId);
  // One message per person and channel, however many rules name them.
  const seen = new Set<string>();
  const wanted: Array<{ rule: Row; person: Person; to: string; key: string }> = [];
  for (const rule of rules) {
    for (const person of resolveRecipients(rule, people)) {
      const to = rule.channel === 'email' ? person.email : person.phone;
      if (!to) {
        out.skipped++;
        continue;
      }
      const dedupe = `${person.id}:${rule.channel}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      wanted.push({ rule, person, to, key: `${alert.idempotencyKey}:${rule.id}:${person.id}` });
    }
  }
  if (!wanted.length) return out;
  // The outbox keeps one message per key; what was queued by an earlier raise of the same alert is not counted again.
  const already = new Set((await ctx.db.selectFrom('messages').select('idempotency_key').where('idempotency_key', 'in', wanted.map((w) => w.key)).execute()).map((m) => m.idempotency_key));
  for (const w of wanted) {
    if (already.has(w.key)) continue;
    const r: QueueResult = await queueMessage(ctx, {
      templateKey: alertEmail.key,
      channel: w.rule.channel,
      to: w.to,
      venueId: alert.venueId,
      idempotencyKey: w.key,
      variables: { title: alert.title, body: alert.body, link: alert.link },
      ...(held ? { sendAt: held } : {}),
    });
    if (r.status === 'queued') {
      out.queued++;
      out.messageIds.push(r.messageId);
    } else out.skipped++;
  }
  if (held && out.queued) out.heldUntil = held;
  return out;
}

/** The staff members every enabled rule for an event names, across these venues. For the digests. */
export async function alertRecipients(ctx: Ctx, event: AlertEvent, venueIds: string[]): Promise<Array<{ id: string; firstName: string; email: string; phone: string | null; channel: AlertChannel }>> {
  if (!venueIds.length) return [];
  const rules = await ctx.db.selectFrom('alert_rules').select(COLS).where('venue_id', 'in', venueIds).where('event', '=', event).where('enabled', '=', true).execute();
  const out = new Map<string, { id: string; firstName: string; email: string; phone: string | null; channel: AlertChannel }>();
  for (const venueId of [...new Set(rules.map((r) => r.venue_id))]) {
    const people = await staffAt(ctx, venueId);
    for (const rule of rules.filter((r) => r.venue_id === venueId)) {
      for (const p of resolveRecipients(rule, people)) out.set(`${p.id}:${rule.channel}`, { id: p.id, firstName: p.firstName, email: p.email, phone: p.phone, channel: rule.channel });
    }
  }
  return [...out.values()];
}

/** "Send a test": one message through one rule, to its recipients, now. Manager and above at the venue. */
export async function sendTestAlert(ctx: Ctx, raw: { ruleId: string }): Promise<Notified> {
  const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(raw);
  const row = await ctx.db.selectFrom('alert_rules').select(COLS).where('id', '=', ruleId).executeTakeFirst();
  if (!row) throw notFound('Alert rule not found');
  const staff = requireStaff(ctx, { venueId: row.venue_id, minRole: 'manager' });
  const venue = await getVenue(ctx, row.venue_id);
  const def = ALERT_EVENT_DEFS[row.event as AlertEvent];
  const result = await notifyTeam(
    ctx,
    {
      venueId: row.venue_id,
      // A test is urgent: it should arrive while the person is looking.
      event: row.event as AlertEvent,
      title: `Test alert from ${venue.name}: ${def.label.toLowerCase()}`,
      body: `This is a test of the "${def.label}" alert for ${venue.name}. When it happens for real, the message reads like this one and links to where to act.`,
      link: `${ctx.app.config.scheme}://${ctx.app.config.platformHost}/console/settings/notifications`,
      idempotencyKey: `alert:test:${row.id}:${ctx.now().toISOString()}`,
    },
    { onlyRuleId: row.id },
  );
  await audit(ctx, { action: 'alerts.test_sent', entityType: 'alert_rule', entityId: row.id, venueId: row.venue_id, after: { event: row.event, channel: row.channel, queued: result.queued, skipped: result.skipped, by: staff?.staffId ?? null } });
  return result;
}

// ── The dispatcher: alerts from the activity stream ──────────────────────────

const WORKER = { kind: 'worker' as const, job: 'alerts.dispatch' };
/** How far back the first run looks, so switching alerts on does not replay the venue's history. */
const FIRST_RUN_LOOKBACK_MS = 15 * 60_000;
const BATCH = 500;
const CHANNEL_WORDS: Record<string, string> = { pickup: 'pickup', delivery: 'delivery', 'dine-in-qr': 'at the table' };

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The alert an activity-stream event raises, in plain words. Guest-written text never appears: only references, counts and amounts. */
export function alertFor(event: { id: string; name: string; venue_id: string | null; properties: unknown }, consoleBase: string): Alert | null {
  if (!event.venue_id) return null;
  const p = (event.properties && typeof event.properties === 'object' ? event.properties : {}) as Record<string, unknown>;
  const key = `alert:${event.id}`;
  switch (event.name) {
    case 'order.paid': {
      const total = num(p.total_cents);
      const channel = CHANNEL_WORDS[str(p.channel) ?? ''] ?? str(p.channel) ?? 'online';
      return { venueId: event.venue_id, event: 'order.new', title: 'New order to accept', body: `A ${channel} order${total !== null ? ` for ${money(total)}` : ''} has been paid and is waiting for the kitchen to accept it.`, link: `${consoleBase}/orders?view=accepting`, idempotencyKey: key };
    }
    case 'booking.requested': {
      const party = num(p.party_size);
      const status = str(p.status);
      return {
        venueId: event.venue_id,
        event: 'booking.new',
        title: status === 'requested' ? 'Booking request to confirm' : 'New booking',
        body: `${party ? `A table for ${party}` : 'A booking'} ${status === 'requested' ? 'was requested and waits for your yes' : 'was booked'}.`,
        link: `${consoleBase}/bookings${status === 'requested' ? '?view=confirming' : ''}`,
        idempotencyKey: key,
      };
    }
    case 'booking.cancelled': {
      const party = num(p.party_size);
      const mins = num(p.minutes_before);
      return { venueId: event.venue_id, event: 'booking.cancelled', title: 'Booking cancelled', body: `${party ? `A table for ${party}` : 'A booking'} was cancelled${str(p.by) === 'guest' ? ' by the guest' : ''}${mins !== null && mins >= 0 ? `, ${Math.round(mins / 60)} ${Math.round(mins / 60) === 1 ? 'hour' : 'hours'} before the sitting` : ''}.`, link: `${consoleBase}/bookings`, idempotencyKey: key };
    }
    case 'review.received': {
      const rating = num(p.rating);
      return { venueId: event.venue_id, event: 'review.posted', title: rating !== null ? `New ${rating}-star review` : 'New review', body: `A review arrived${str(p.source) ? ` from ${str(p.source)}` : ''}${rating !== null ? `, rated ${rating} out of 5` : ''}. It is waiting for a reply.`, link: `${consoleBase}/reviews?show=unanswered`, idempotencyKey: key };
    }
    case 'approval.requested':
      return { venueId: event.venue_id, event: 'assistant.needs_yes', title: 'Something is waiting for your yes', body: 'A change has been proposed and nothing happens until a manager approves it. The approval says exactly what will change.', link: `${consoleBase}/approvals`, idempotencyKey: key };
    case 'delivery.failed':
      return { venueId: event.venue_id, event: 'delivery.problem', title: 'A delivery could not be made', body: `A delivery did not happen${str(p.reason) ? ` (${str(p.reason)!.replace(/_/g, ' ')})` : ''}. The order needs a look.`, link: `${consoleBase}/orders?view=attention`, idempotencyKey: key };
    default:
      return null;
  }
}

const SOURCE_EVENTS = Object.values(ALERT_EVENT_DEFS).map((d) => d.from).filter((x): x is string => !!x);

/**
 * Read the activity stream from the organisation's watermark and raise an alert for each event
 * that has a rule. Safe to run twice: the watermark moves only after the batch, and every message
 * is keyed by its event row. Returns how many events were considered and how many messages queued.
 */
export async function dispatchAlerts(app: App, orgId: string): Promise<{ considered: number; queued: number; readThrough: Date }> {
  const consoleBase = `${app.config.scheme}://${app.config.platformHost}/console`;
  return app.tenant(orgId, WORKER, async (ctx) => {
    const now = ctx.now();
    const cursor = await ctx.db.selectFrom('alert_cursors').select('read_through').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const since = cursor?.read_through ?? new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS);
    const venuesWithRules = (await ctx.db.selectFrom('alert_rules').select('venue_id').where('enabled', '=', true).distinct().execute()).map((r) => r.venue_id);
    let considered = 0;
    let queued = 0;
    let readThrough = since;
    if (venuesWithRules.length) {
      const events = await ctx.db
        .selectFrom('events')
        .select(['id', 'name', 'venue_id', 'properties', 'occurred_at'])
        .where('name', 'in', SOURCE_EVENTS)
        .where('venue_id', 'in', venuesWithRules)
        .where('occurred_at', '>', since)
        .where('occurred_at', '<=', now)
        .orderBy('occurred_at')
        .orderBy('id')
        .limit(BATCH)
        .execute();
      for (const e of events) {
        considered++;
        const alert = alertFor(e, consoleBase);
        if (alert) queued += (await notifyTeam(ctx, alert)).queued;
        readThrough = e.occurred_at;
      }
      // A full batch leaves the rest for the next run; an empty one moves the watermark to now.
      if (events.length < BATCH) readThrough = now;
    } else {
      readThrough = now;
    }
    await sql`insert into alert_cursors (org_id, read_through, updated_at) values (${ctx.orgId}, ${readThrough}, ${now})
      on conflict (org_id) do update set read_through = excluded.read_through, updated_at = excluded.updated_at`.execute(ctx.db);
    return { considered, queued, readThrough };
  });
}

export const dispatchAlertsJob = defineJob({
  kind: 'alerts.dispatch',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    if (job.orgId) await dispatchAlerts(app, job.orgId);
  },
});

/** True when the org has any alert rule switched on. Platform scheduler: reads outside a tenant. */
async function alertsOnAnywhere(app: App, orgId: string): Promise<boolean> {
  const row = await app.db.selectFrom('alert_rules').select('id').where('org_id', '=', orgId).where('enabled', '=', true).limit(1).executeTakeFirst();
  return !!row;
}

export const dispatchAlertsSchedule = defineSchedule({
  key: 'alerts.dispatch',
  everyMinutes: 5,
  scope: 'org',
  job: dispatchAlertsJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: alertsOnAnywhere,
});

// ── The daily digest ──────────────────────────────────────────────────────────

/**
 * Yesterday's digest (analytics.computeDigest: arithmetic, no model) to everyone a `digest.daily`
 * rule names, once per venue per day, from the digest hour in venue time. Safe to run twice.
 */
export async function sendDailyDigests(app: App, orgId: string): Promise<{ venues: number; queued: number }> {
  const consoleBase = `${app.config.scheme}://${app.config.platformHost}/console`;
  return app.tenant(orgId, { kind: 'worker', job: 'alerts.daily_digest' }, async (ctx) => {
    const settings = await getOrgSettings(ctx, ALERTS_SETTINGS_NAMESPACE, alertSettings, defaultAlertSettings);
    const venueIds = (await ctx.db.selectFrom('alert_rules').select('venue_id').where('event', '=', 'digest.daily').where('enabled', '=', true).distinct().execute()).map((r) => r.venue_id);
    let venues = 0;
    let queued = 0;
    for (const venueId of venueIds) {
      const venue = await getVenue(ctx, venueId);
      const local = localParts(ctx.now(), venue.timezone);
      if (Number(local.time.slice(0, 2)) < settings.dailyDigestHour) continue;
      const yesterday = addDays(local.date, -1);
      const key = `alert:digest.daily:${venueId}:${yesterday}`;
      const already = await ctx.db.selectFrom('messages').select('id').where('idempotency_key', 'like', `${key}:%`).limit(1).executeTakeFirst();
      if (already) continue;
      const digest = await computeDigest(ctx, { period: 'day', date: yesterday, venueId });
      venues++;
      queued += (
        await notifyTeam(ctx, {
          venueId,
          event: 'digest.daily',
          title: `${venue.name}: yesterday in numbers`,
          body: `${digest.summary}\n\nA change from the usual pattern is a difference, not an explanation of it.`,
          link: `${consoleBase}/analytics/reports`,
          idempotencyKey: key,
        })
      ).queued;
    }
    return { venues, queued };
  });
}

export const dailyDigestJob = defineJob({
  kind: 'alerts.daily_digest',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 2,
  async handler(app, job) {
    if (job.orgId) await sendDailyDigests(app, job.orgId);
  },
});

export const dailyDigestSchedule = defineSchedule({
  key: 'alerts.daily_digest',
  everyMinutes: 60,
  scope: 'org',
  job: dailyDigestJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: async (app, orgId) => !!(await app.db.selectFrom('alert_rules').select('id').where('org_id', '=', orgId).where('event', '=', 'digest.daily').where('enabled', '=', true).limit(1).executeTakeFirst()),
});

// ── Summary for the assistant and the console ─────────────────────────────────

export interface AlertsSummary {
  venue: string;
  events: Array<{ event: AlertEvent; label: string; description: string; rules: Array<{ channel: AlertChannel; to: string; enabled: boolean }> }>;
  quietHours: { start: string; end: string } | null;
  summary: string;
}

/** Who is told what at a venue, in words. Manager and above. */
export async function alertsSummary(ctx: Ctx, raw: { venueId: string }): Promise<AlertsSummary> {
  const cat = await listAlertRules(ctx, raw);
  const venue = await getVenue(ctx, cat.venueId);
  const to = (r: AlertRule) => (r.recipient.kind === 'staff' ? r.recipient.name : `every ${ROLE_WORDS[r.recipient.role].toLowerCase()} at the venue`);
  const events = cat.events.map((e) => ({ event: e.key, label: e.label, description: e.description, rules: cat.rules.filter((r) => r.event === e.key).map((r) => ({ channel: r.channel, to: to(r), enabled: r.enabled })) }));
  const on = cat.rules.filter((r) => r.enabled).length;
  const quiet = cat.settings.quietHours;
  return {
    venue: venue.name,
    events,
    quietHours: quiet,
    summary: `${on} alert ${on === 1 ? 'rule is' : 'rules are'} on at ${venue.name}${quiet ? `; alerts that are not urgent wait out the quiet hours ${quiet.start} to ${quiet.end}` : ''}. Alerts go to team members only, never to guests.`,
  };
}
