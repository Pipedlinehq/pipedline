import { z } from 'zod';
import { type App, type Principal, assertModule, audit, invalid, requireStaff } from '@ros/core';
import { getOffer } from '../offers/definitions';
import { getVenue } from '../tenancy/venues';
import { getToneOfVoice } from '../website/brand';
import { campaignsModule } from './module';
import { countAudience, loadSegment } from './segments';

/**
 * Drafting campaign copy with the model: one bounded, schema-validated generation. The prompt
 * carries the venue's tone of voice, the segment's name and size, the channel, the offer in
 * plain words and the brief the manager typed. Never a guest: no name, address, number or card
 * (docs/THREAT_MODEL.md section 7). What comes back is a suggestion for a draft; nothing is sent
 * without a manager's approval.
 */

export const campaignCopySchema = z.object({
  subject: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2000),
  smsBody: z.string().trim().min(1).max(300),
});
export type CampaignCopy = z.infer<typeof campaignCopySchema>;

export const draftCopyInput = z.object({
  venueId: z.string().uuid(),
  segmentId: z.string().uuid(),
  channel: z.enum(['email', 'sms']),
  /** What the message is about, in the manager's words. */
  brief: z.string().trim().min(3).max(600),
  offerId: z.string().uuid().nullish(),
});

const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+/g;
const PHONE_RE = /\+?\d[\d\s().-]{6,}\d/g;
/** Belt and braces: anything shaped like an address or a number is removed before it reaches the model. */
export const redactContacts = (s: string): string => s.replace(EMAIL_RE, '[removed]').replace(PHONE_RE, '[removed]');

const SYSTEM = `You write short marketing messages for an independent hospitality venue to send to its own guests who have agreed to hear from it.
Write in the venue's voice. Be specific and warm; no hype, no exclamation-mark pile-ups, no invented facts, prices or dates beyond what the brief gives.
Address the guest as {{first_name}} exactly once; it is filled in per guest. Do not include a discount code, a link or an unsubscribe line: those are added separately.
Return JSON with: subject (an email subject line, under 70 characters), body (the email, plain text, 2 to 4 short paragraphs), smsBody (the SMS version, under 300 characters, without the venue name at the start, which is added).`;

/**
 * Suggest copy for a campaign. Called by the console with the App (not inside a transaction):
 * it reads what it needs in one tenant transaction, calls the model outside it, and records the
 * call in a second.
 */
export async function draftCampaignCopy(app: App, args: { orgId: string; principal: Principal; input: z.input<typeof draftCopyInput> }): Promise<CampaignCopy> {
  const parsed = draftCopyInput.safeParse(args.input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? 'That request is not valid.', { issues: parsed.error.issues });
  const input = parsed.data;

  const facts = await app.tenant(args.orgId, args.principal, async (ctx) => {
    requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
    await assertModule(ctx, input.venueId, campaignsModule);
    const venue = await getVenue(ctx, input.venueId);
    const segment = await loadSegment(ctx, input.segmentId);
    const size = await countAudience(ctx, { rule: segment.definition, venueId: input.venueId });
    const offer = input.offerId ? await getOffer(ctx, input.offerId) : null;
    const tone = await getToneOfVoice(ctx);
    return {
      venue: venue.name,
      segment: segment.name,
      reachable: input.channel === 'email' ? size.email.reachable : size.sms.reachable,
      offer: offer?.summary ?? null,
      tone,
    };
  });

  const system = `${SYSTEM}\n\nThe venue's tone of voice, in its own words:\n${facts.tone ? redactContacts(facts.tone) : '(none given: write plainly and warmly)'}`;
  const prompt = JSON.stringify({
    venue: facts.venue,
    audience: { segment: facts.segment, guests: facts.reachable },
    channel: input.channel,
    offer: facts.offer,
    brief: redactContacts(input.brief),
  });
  const result = await app.adapters.llm.generate({ purpose: 'campaigns.draft_copy', orgId: args.orgId, system, input: prompt, schema: campaignCopySchema, tier: 'quality', maxTokens: 900 });

  await app.tenant(args.orgId, args.principal, (ctx) =>
    audit(ctx, { action: 'campaign.copy_drafted', entityType: 'venue', entityId: input.venueId, venueId: input.venueId, after: { segmentId: input.segmentId, channel: input.channel, model: result.model, tokensIn: result.usage.inputTokens, tokensOut: result.usage.outputTokens } }),
  );
  return result.output;
}
