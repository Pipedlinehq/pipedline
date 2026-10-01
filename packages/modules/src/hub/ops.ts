import { z } from 'zod';
import { type Ctx, addDays, defineTool, formatMoney, getModule, isAppError, listConnections, localParts, requireStaff, sql, zonedTimeToUtc } from '@ros/core';
import { listOrders } from '../ordering/orders';
import { openWindows } from '../tenancy/hours';
import { getVenue } from '../tenancy/venues';
import { hubModule } from './module';

/**
 * What needs someone's attention at one venue right now: connected services that have stopped
 * working, orders the system flagged for staff, paid orders nobody has accepted, and a venue
 * that is open and past the middle of a service with no sale recorded when the same weekday
 * usually has some by now. Arithmetic over the venue's own records; nothing here is a model's
 * opinion. Read by the `ops_status` tool and by the `ops_watch` hosted agent.
 */
const WEEKS_COMPARED = 4;
const SALE = sql.raw(`('completed', 'refunded', 'partially_refunded')`);

export interface OpsStatus {
  venue: { id: string; name: string; timezone: string };
  localTime: string;
  connections: Array<{ service: string; status: string; lastOk: Date | null; problem: string | null }>;
  flaggedOrders: Array<{ reference: string; status: string; flaggedAt: Date; reason: string; total: string }>;
  waitingOrders: Array<{ reference: string; waitingMinutes: number; total: string; kind: string }>;
  trading: {
    openNow: boolean;
    /** True when now is past the middle of a trading period that has not ended. */
    midService: boolean;
    salesToday: number;
    /** Sales by this time of day on each of the last same weekdays, most recent first. */
    usualByNow: number[];
    /** No sale today, mid-service, when there usually are some by now. */
    quiet: boolean;
  };
  /** Each finding in plain words, most urgent first. Empty when nothing needs attention. */
  findings: string[];
}

async function salesBetween(ctx: Ctx, venueId: string, from: Date, to: Date): Promise<number> {
  const r = await sql<{ n: number }>`
    select count(*)::int as n from transactions
    where org_id = ${ctx.orgId} and venue_id = ${venueId} and occurred_at >= ${from} and occurred_at <= ${to} and status in ${SALE}`.execute(ctx.db);
  return r.rows[0]!.n;
}

/** Manager and above at the venue. A venue of another organisation, or one the caller has no role at, is not found. */
export async function opsStatus(ctx: Ctx, raw: { venueId: string }): Promise<OpsStatus> {
  const input = z.object({ venueId: z.string().uuid() }).parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const venue = await getVenue(ctx, input.venueId);
  const config = (await getModule(ctx, venue.id, hubModule)).config;
  const now = ctx.now();
  const local = localParts(now, venue.timezone);
  const findings: string[] = [];

  // Connected services.
  const connections = (await listConnections(ctx, { venueId: venue.id }))
    .filter((c) => c.status !== 'revoked')
    .map((c) => ({ service: c.plug_key, status: c.status as string, lastOk: c.last_ok_at, problem: c.last_error }));
  for (const c of connections.filter((x) => x.status === 'unhealthy')) {
    findings.push(`${c.service} has stopped working${c.problem ? `: ${c.problem.slice(0, 200).replace(/[.\s]+$/, '')}` : ''}. Reconnect it in the console.`);
  }

  // Orders. A venue without online ordering simply has none.
  let flaggedOrders: OpsStatus['flaggedOrders'] = [];
  let waitingOrders: OpsStatus['waitingOrders'] = [];
  try {
    const flagged = await listOrders(ctx, { venueId: venue.id, needsAttention: true, limit: 50 });
    flaggedOrders = flagged.map((o) => ({ reference: o.reference, status: o.status, flaggedAt: o.attentionAt!, reason: (o.attentionReason ?? '').slice(0, 300), total: formatMoney(o.totalCents, o.currency) }));
    const cutoff = now.getTime() - config.ops_order_waiting_minutes * 60_000;
    const placed = await listOrders(ctx, { venueId: venue.id, statuses: ['placed'], limit: 200 });
    waitingOrders = placed
      .filter((o) => (o.placedAt ?? o.createdAt).getTime() <= cutoff)
      .map((o) => ({ reference: o.reference, waitingMinutes: Math.floor((now.getTime() - (o.placedAt ?? o.createdAt).getTime()) / 60_000), total: formatMoney(o.totalCents, o.currency), kind: o.channel }))
      .sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  } catch (e) {
    if (!isAppError(e) || e.code !== 'module_disabled') throw e;
  }
  for (const o of waitingOrders) findings.push(`Order ${o.reference} (${o.total}) was paid ${o.waitingMinutes} minutes ago and nobody has accepted it.`);
  for (const o of flaggedOrders) findings.push(`Order ${o.reference} is flagged for staff: ${o.reason}`);

  // Trading: open, past the middle of a period, and nothing sold, against the same weekday before.
  const windows = [...(await openWindows(ctx, venue.id, addDays(local.date, -1))), ...(await openWindows(ctx, venue.id, local.date))];
  const openNow = windows.some((w) => now >= w.opensAt && now < w.closesAt);
  const midService = windows.some((w) => now.getTime() >= (w.opensAt.getTime() + w.closesAt.getTime()) / 2 && now < w.closesAt);
  const dayStart = zonedTimeToUtc(local.date, '00:00:00', venue.timezone);
  const salesToday = await salesBetween(ctx, venue.id, dayStart, now);
  const usualByNow: number[] = [];
  let quiet = false;
  if (midService && salesToday === 0) {
    for (let k = 1; k <= WEEKS_COMPARED; k++) {
      const date = addDays(local.date, -7 * k);
      usualByNow.push(await salesBetween(ctx, venue.id, zonedTimeToUtc(date, '00:00:00', venue.timezone), zonedTimeToUtc(date, local.time, venue.timezone)));
    }
    const weeksWithSales = usualByNow.filter((n) => n > 0).length;
    const mean = usualByNow.reduce((s, n) => s + n, 0) / WEEKS_COMPARED;
    quiet = weeksWithSales >= WEEKS_COMPARED - 1 && mean >= config.ops_quiet_min_usual_sales;
    if (quiet) {
      findings.push(
        `No sale has been recorded today by ${local.time.slice(0, 5)}, mid-service. On the last ${WEEKS_COMPARED} of this weekday there were ${usualByNow.join(', ')} by this time. Either the venue is not trading or sales are not reaching the ledger: check the till connection.`,
      );
    }
  }

  return {
    venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
    localTime: `${local.date} ${local.time.slice(0, 5)}`,
    connections,
    flaggedOrders,
    waitingOrders,
    trading: { openNow, midService, salesToday, usualByNow, quiet },
    findings,
  };
}

export const opsStatusTool = defineTool({
  name: 'ops_status',
  module: 'hub',
  title: 'What needs attention',
  description:
    'What needs someone to look at this venue right now: connected services that stopped working, orders flagged for staff, paid orders nobody has accepted, and whether the venue is mid-service with no sale recorded when it usually has some by now. An empty list of findings means nothing was found, not that nothing is wrong.',
  effect: 'read',
  scope: 'ops:read',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    venue: z.string(),
    local_time: z.string(),
    findings: z.array(z.string()),
    connections: z.array(z.object({ service: z.string(), status: z.string(), last_ok: z.string().nullable(), problem: z.string().nullable() })),
    flagged_orders: z.array(z.object({ reference: z.string(), status: z.string(), flagged_at: z.string(), reason: z.string(), total: z.string() })),
    waiting_orders: z.array(z.object({ reference: z.string(), waiting_minutes: z.number().int(), total: z.string(), kind: z.string() })),
    trading: z.object({ open_now: z.boolean(), mid_service: z.boolean(), sales_today: z.number().int(), usual_by_now: z.array(z.number().int()), quiet: z.boolean() }),
    note: z.string(),
  }),
  async run({ ctx, venueId }) {
    const s = await opsStatus(ctx, { venueId: venueId! });
    return {
      venue: s.venue.name,
      local_time: s.localTime,
      findings: s.findings,
      connections: s.connections.map((c) => ({ service: c.service, status: c.status, last_ok: c.lastOk ? c.lastOk.toISOString() : null, problem: c.problem })),
      flagged_orders: s.flaggedOrders.map((o) => ({ reference: o.reference, status: o.status, flagged_at: o.flaggedAt.toISOString(), reason: o.reason, total: o.total })),
      waiting_orders: s.waitingOrders.map((o) => ({ reference: o.reference, waiting_minutes: o.waitingMinutes, total: o.total, kind: o.kind })),
      trading: { open_now: s.trading.openNow, mid_service: s.trading.midService, sales_today: s.trading.salesToday, usual_by_now: s.trading.usualByNow, quiet: s.trading.quiet },
      note: 'Counts and times come from the venue\'s own records. "quiet" compares today with the same weekday over the last four weeks; it is a difference from the usual pattern, not an explanation of it.',
    };
  },
});
