import { z } from 'zod';
import { defineTool, getModule, listConnections, listModuleDefs, localParts } from '@ros/core';
import { getVenue } from './venues';
import { isOpenAt, openWindows, setHourException } from './hours';

export const venueStatusTool = defineTool({
  name: 'venue_status',
  module: 'tenancy',
  title: 'Venue status',
  description:
    'Whether the venue is open right now, today\'s trading periods, which features are switched on, and the health of its connected services. Start here.',
  effect: 'read',
  scope: 'venue:read',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    venue: z.object({ name: z.string(), timezone: z.string(), status: z.string() }),
    local_time: z.string(),
    open_now: z.boolean(),
    today: z.array(z.object({ opens: z.string(), closes: z.string() })),
    features_on: z.array(z.string()),
    connections: z.array(
      z.object({ service: z.string(), status: z.string(), last_ok: z.string().nullable(), problem: z.string().nullable() }),
    ),
  }),
  async run({ ctx, venueId }) {
    const venue = await getVenue(ctx, venueId!);
    const now = ctx.now();
    const local = localParts(now, venue.timezone);
    const windows = await openWindows(ctx, venue.id, local.date);
    const features: string[] = [];
    for (const def of listModuleDefs()) {
      if (def.spine) continue;
      if ((await getModule(ctx, venue.id, def)).enabled) features.push(def.key);
    }
    const connections = await listConnections(ctx, { venueId: venue.id });
    return {
      venue: { name: venue.name, timezone: venue.timezone, status: venue.status },
      local_time: `${local.date} ${local.time.slice(0, 5)}`,
      open_now: await isOpenAt(ctx, venue.id, now),
      today: windows.map((w) => ({
        opens: localParts(w.opensAt, venue.timezone).time.slice(0, 5),
        closes: localParts(w.closesAt, venue.timezone).time.slice(0, 5),
      })),
      features_on: features,
      connections: connections
        .filter((c) => c.status !== 'revoked')
        .map((c) => ({
          service: c.plug_key,
          status: c.status,
          last_ok: c.last_ok_at ? c.last_ok_at.toISOString() : null,
          problem: c.last_error,
        })),
    };
  },
});

export const hoursSetExceptionTool = defineTool({
  name: 'hours_set_exception',
  module: 'tenancy',
  title: 'Set a one-off change to opening hours',
  description:
    'Close the venue for a date, or give it different hours for that date only (a public holiday, a private event). The weekly hours are not changed.',
  effect: 'write',
  scope: 'venue:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('The venue-local date, YYYY-MM-DD'),
    closed: z.boolean().describe('True to close for the whole day'),
    opens: z.string().optional().describe('24-hour opening time, e.g. 17:00. Needed when closed is false'),
    closes: z.string().optional().describe('24-hour closing time, e.g. 22:30. Needed when closed is false'),
    reason: z.string().max(200).optional(),
  }),
  output: z.object({ date: z.string(), closed: z.boolean(), opens: z.string().nullable(), closes: z.string().nullable() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const what = input.closed ? `close ${venue.name} for the whole day` : `open ${venue.name} from ${input.opens} to ${input.closes}`;
    return {
      question: `On ${input.date}, ${what}${input.reason ? ` (${input.reason})` : ''}? This replaces any earlier change for that date. The weekly hours stay as they are.`,
      commit: async () => {
        const r = await setHourException(ctx, venue.id, {
          date: input.date,
          closed: input.closed,
          opensAt: input.opens,
          closesAt: input.closes,
          reason: input.reason,
        });
        return { date: r.date, closed: r.closed, opens: r.opensAt, closes: r.closesAt };
      },
    };
  },
});
