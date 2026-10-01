import { z } from 'zod';
import { type Ctx, defineTool, invalid, notFound, requireStaff } from '@ros/core';
import { getAnalyticsSettings } from '../analytics/settings';
import { getVenue } from '../tenancy/venues';
import { draftCampaign, getCampaignResults, listCampaigns } from './campaigns';
import { FLOW_KEYS, effectiveMode, flowsByKey } from './flows';
import { countAudience, loadSegment } from './segments';

/**
 * Assistant tools. An assistant may draft a campaign (a write: it creates a draft and nothing
 * else) and read how campaigns and flows are doing (totals, never guests). It can never send or
 * approve: sending needs a manager's yes in the console's approvals queue.
 */

async function findSegment(ctx: Ctx, ref: string): Promise<{ id: string; name: string }> {
  const byId = z.string().uuid().safeParse(ref);
  if (byId.success) {
    const s = await loadSegment(ctx, byId.data);
    return { id: s.id, name: s.name };
  }
  const rows = await ctx.db.selectFrom('segments').select(['id', 'name']).execute();
  const hit = rows.find((r) => r.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw notFound(`There is no segment called "${ref}". Segments: ${rows.map((r) => r.name).join(', ')}.`);
  return hit;
}

const quote = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 600)}"`;

export const messageDraftTool = defineTool({
  name: 'message_draft',
  module: 'campaigns',
  title: 'Draft a campaign message',
  description:
    'Create a DRAFT email or SMS campaign to one segment of this venue\'s guests. Nothing is sent: a manager reviews the draft and approves the send in the console. Write the copy yourself in the venue\'s voice; use {{first_name}} once to greet the guest. Do not put a discount code, link or unsubscribe line in the copy; a code is added per guest when an offer is chosen, and the unsubscribe line is added automatically.',
  effect: 'write',
  scope: 'campaigns:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    name: z.string().trim().min(1).max(120).describe('An internal name for the campaign, e.g. "Spring menu launch"'),
    segment: z.string().trim().min(1).max(80).describe('The segment by name (e.g. "Lapsed 60+", "Regulars") or id'),
    channel: z.enum(['email', 'sms']),
    subject: z.string().trim().min(1).max(200).optional().describe('Email subject line. Required for email'),
    body: z.string().trim().min(1).max(5000).describe('The message text. Plain text. SMS: under 480 characters'),
    offer_id: z.string().uuid().optional().describe('An offer each guest gets their own code for. Leave out for none'),
  }),
  output: z.object({ campaign_id: z.string(), status: z.string(), audience_count: z.number().nullable(), next_step: z.string() }),
  async propose({ ctx, venueId }, input) {
    if (!venueId) throw invalid('Say which venue this campaign is from.');
    requireStaff(ctx, { venueId, minRole: 'manager' });
    const venue = await getVenue(ctx, venueId);
    const seg = await findSegment(ctx, input.segment);
    const rule = (await loadSegment(ctx, seg.id)).definition;
    const size = await countAudience(ctx, { rule, venueId });
    const reachable = input.channel === 'email' ? size.email.reachable : size.sms.reachable;
    const args = { venueId, name: input.name, channel: input.channel, segmentId: seg.id, subject: input.subject ?? null, body: input.body, offerId: input.offer_id ?? null };
    const what = input.channel === 'email' ? `email with the subject ${quote(input.subject ?? '')} and the message ${quote(input.body)}` : `SMS saying ${quote(input.body)}`;
    return {
      question: `Save a draft ${input.channel === 'email' ? 'email' : 'SMS'} campaign "${input.name}" from ${venue.name} to the "${seg.name}" segment (${reachable} ${reachable === 1 ? 'guest' : 'guests'} can receive it): an ${what}${input.offer_id ? ', with a personal code for each guest' : ''}? Nothing is sent; a manager approves the send in the console.`,
      commit: async () => {
        const c = await draftCampaign(ctx, args);
        return { campaign_id: c.id, status: c.status, audience_count: c.audienceCount, next_step: 'A manager reviews the draft in the console and sends it for approval.' };
      },
    };
  },
});

const results = z.object({
  queued: z.number(),
  suppressed: z.number(),
  delivered: z.number(),
  opened: z.number(),
  clicked: z.number(),
  unsubscribed: z.number(),
  codes_issued: z.number(),
  codes_redeemed: z.number(),
  attributed_orders: z.number().nullable().describe('Sales by guests who ordered within the attribution window after the message. Null when fewer guests than the privacy floor stand behind it: unmeasured, not low'),
  attributed_revenue_cents: z.number().nullable(),
});

export const campaignsSummaryTool = defineTool({
  name: 'campaigns_summary',
  module: 'campaigns',
  title: 'Campaigns and flows summary',
  description:
    'The venue\'s recent one-off campaigns (status, audience size, what was delivered, opened and clicked, codes used, sales that followed) and its lifecycle flows (welcome, post-purchase, win-back, VIP, birthday) with their mode and how many guests are in each. Totals only; no guest is named. Sales that followed a message are aligned with it, not proof it caused them.',
  effect: 'read',
  scope: 'campaigns:read',
  venueScoped: true,
  input: z.object({ limit: z.number().int().min(1).max(20).optional().describe('How many recent campaigns. Default 10') }),
  output: z.object({
    campaigns: z.array(z.object({ name: z.string(), status: z.string(), channel: z.string(), segment: z.string().nullable(), audience_count: z.number().nullable(), sent_at: z.string().nullable(), results })),
    flows: z.array(z.object({ key: z.string(), name: z.string(), mode: z.string(), active_guests: z.number(), completed: z.number() })),
  }),
  async run({ ctx, venueId }, input) {
    if (!venueId) throw invalid('Say which venue.');
    const floor = (await getAnalyticsSettings(ctx)).minCohort;
    const list = await listCampaigns(ctx, { venueId, limit: input.limit ?? 10 });
    const campaigns = [];
    for (const c of list) {
      const r = await getCampaignResults(ctx, { campaignId: c.id });
      const shown = r.attributed.guests >= floor;
      campaigns.push({
        name: c.name,
        status: c.status,
        channel: c.channel,
        segment: c.segmentName,
        audience_count: c.audienceCount,
        sent_at: c.sentAt?.toISOString() ?? null,
        results: {
          queued: r.messages.queued,
          suppressed: r.messages.suppressed,
          delivered: r.messages.delivered,
          opened: r.messages.opened,
          clicked: r.messages.clicked,
          unsubscribed: r.messages.unsubscribed,
          codes_issued: r.codes.issued,
          codes_redeemed: r.codes.redeemed,
          attributed_orders: shown ? r.attributed.orders : null,
          attributed_revenue_cents: shown ? r.attributed.revenueCents : null,
        },
      });
    }
    const flows = [...(await flowsByKey(ctx)).values()].sort((a, b) => FLOW_KEYS.indexOf(a.key) - FLOW_KEYS.indexOf(b.key));
    const counts = await ctx.db
      .selectFrom('flow_enrollments')
      .select((eb) => ['flow_id', eb.fn.countAll<number>().filterWhere('status', '=', 'active').as('active'), eb.fn.countAll<number>().filterWhere('status', '=', 'completed').as('completed')])
      .where('venue_id', '=', venueId)
      .groupBy('flow_id')
      .execute();
    return {
      campaigns,
      flows: flows.map((f) => {
        const c = counts.find((x) => x.flow_id === f.id);
        return { key: f.key, name: f.name, mode: effectiveMode(f), active_guests: Number(c?.active ?? 0), completed: Number(c?.completed ?? 0) };
      }),
    };
  },
});
