import { z } from 'zod';
import { defineTool } from '@ros/core';
import { ALERT_CHANNELS, ALERT_EVENTS, ALERT_EVENT_DEFS, ROLE_WORDS, alertsSummary, listAlertRules, setAlertRule } from './alerts';

/**
 * Alerts to the team, for an assistant: read who is told what, and set a rule after the person
 * says yes. Both pinned to the console's own functions; a recipient is always a staff member or
 * a role at the venue, never a guest.
 */
const ruleShape = z.object({ channel: z.enum(ALERT_CHANNELS), to: z.string(), enabled: z.boolean() });

export const alertsSummaryTool = defineTool({
  name: 'alerts_summary',
  module: 'comms',
  title: 'Alerts to the team',
  description:
    'Who at the venue is told, and how, when something happens: a new order, a new or cancelled booking, a review posted, the assistant waiting for a yes, a delivery problem, and the daily and weekly digests. Each event lists its rules (email or text, to one team member or to everyone holding a role) and whether each is on, plus the quiet hours during which alerts that are not urgent wait. Alerts only ever go to team members, never to guests.',
  effect: 'read',
  scope: 'alerts:read',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    summary: z.string(),
    venue: z.string(),
    events: z.array(z.object({ event: z.string(), label: z.string(), description: z.string(), rules: z.array(ruleShape) })),
    quiet_hours: z.object({ start: z.string(), end: z.string() }).nullable(),
  }),
  async run({ ctx, venueId }) {
    const s = await alertsSummary(ctx, { venueId: venueId! });
    return { summary: s.summary, venue: s.venue, events: s.events, quiet_hours: s.quietHours };
  },
});

const recipientArg = z.union([
  z.object({ kind: z.literal('role'), role: z.enum(['owner', 'manager', 'host', 'front_of_house', 'kitchen']).describe('Everyone holding this role at the venue.') }).strict(),
  z.object({ kind: z.literal('staff'), name: z.string().min(1).max(120).describe('A team member, by their name as the team page shows it.') }).strict(),
]);

export const alertSetTool = defineTool({
  name: 'alert_set',
  module: 'comms',
  title: 'Set an alert to the team',
  description:
    'Switch an alert on or off: for one event (order.new, booking.new, booking.cancelled, review.posted, assistant.needs_yes, delivery.problem, digest.daily, digest.weekly), tell a team member or everyone holding a role, by email or text. The person is asked to confirm first; nothing changes until they say yes. A text needs the team member to have a phone number on the team page. Recipients are team members only: an alert can never be sent to a guest.',
  effect: 'write',
  scope: 'alerts:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    event: z.enum(ALERT_EVENTS).describe('Which event the alert is for.'),
    channel: z.enum(ALERT_CHANNELS).describe('email or sms.'),
    recipient: recipientArg,
    enabled: z.boolean().optional().describe('Default true. False switches the rule off without removing it.'),
  }),
  output: z.object({ event: z.string(), channel: z.string(), to: z.string(), enabled: z.boolean(), venue: z.string() }),
  async propose({ ctx, venueId }, input) {
    const cat = await listAlertRules(ctx, { venueId: venueId! });
    const enabled = input.enabled ?? true;
    let recipient: Parameters<typeof setAlertRule>[1]['recipient'];
    let to: string;
    if (input.recipient.kind === 'role') {
      const role = input.recipient.role;
      recipient = { kind: 'role', role };
      const n = cat.roles.find((r) => r.role === role)?.count ?? 0;
      to = `every ${ROLE_WORDS[role].toLowerCase()} at the venue (${n} ${n === 1 ? 'person' : 'people'} today)`;
    } else {
      const wanted = input.recipient.name.trim().toLowerCase();
      const matches = cat.people.filter((p) => p.name.toLowerCase() === wanted || p.name.toLowerCase().startsWith(wanted));
      if (matches.length !== 1) throw new Error(matches.length ? `"${input.recipient.name}" matches more than one team member: ${matches.map((m) => m.name).join(', ')}.` : `No team member at this venue is called "${input.recipient.name}".`);
      recipient = { kind: 'staff', staffId: matches[0]!.staffId };
      to = matches[0]!.name;
    }
    const venueName = (await alertsSummary(ctx, { venueId: venueId! })).venue;
    const def = ALERT_EVENT_DEFS[input.event];
    const how = input.channel === 'sms' ? 'a text' : 'an email';
    const question = enabled
      ? `Send ${how} to ${to} whenever this happens at ${venueName}: ${def.label.toLowerCase()} (${def.description.replace(/\.$/, '').toLowerCase()})?`
      : `Stop sending ${how} to ${to} for "${def.label.toLowerCase()}" at ${venueName}?`;
    return {
      question,
      commit: async () => {
        const rule = await setAlertRule(ctx, { venueId: venueId!, event: input.event, channel: input.channel, recipient, enabled });
        return { event: rule.event, channel: rule.channel, to, enabled: rule.enabled, venue: venueName };
      },
    };
  },
});

export const alertTools = [alertsSummaryTool, alertSetTool];
