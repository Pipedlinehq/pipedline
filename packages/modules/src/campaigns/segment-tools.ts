import { z } from 'zod';
import { type Ctx, defineTool, invalid, notFound, requireStaff, sql } from '@ros/core';
import { type ListNode, listText, listWords, parseListQuery, reachableByListSql } from '../identity/lists';
import { type SegmentRule, type SegmentView, audienceWhere, compileFrame, countAudience, listSegments, loadSegment, parseSegmentRule, saveSegment } from './segments';
import { assertCampaignsOnSomewhere } from './settings';

/**
 * Guest lists for a venue's own assistant (docs/CONSOLE_IA.md section 9, pattern 5). The
 * assistant writes a rule in the same plain words a person would type; the service parses it,
 * so the assistant can never hand over SQL. Reads return counts and, at most, first names.
 */

async function findSegment(ctx: Ctx, ref: string): Promise<SegmentView> {
  if (z.string().uuid().safeParse(ref).success) return loadSegment(ctx, ref);
  const all = await listSegments(ctx);
  const hit = all.find((s) => s.name.toLowerCase() === ref.trim().toLowerCase());
  if (!hit) throw notFound(`There is no guest list called "${ref}". Lists: ${all.map((s) => s.name).join(', ')}.`);
  return hit;
}

export const guestListSetTool = defineTool({
  name: 'guest_list_set',
  module: 'campaigns',
  title: 'Create or change a guest list',
  description:
    'Create a guest list, or change one of the venue\'s own, from a rule in plain words. Fields: last visit, first visit, visits, spend, average spend, said yes to email, said yes to texts, loyalty member, no-shows, suburb, source. Operators: more than, less than, is, is not, within the last N days, more than N days ago. Join with "and" / "or" and brackets; at most 10 conditions. Example: "last visit more than 60 days ago and said yes to email". The built-in lists cannot be changed. A list never bypasses consent: sending still checks it.',
  effect: 'write',
  scope: 'guest_lists:write',
  minRole: 'manager',
  input: z.object({
    name: z.string().trim().min(1).max(80).describe('The list\'s name, e.g. "Quiet Tuesday regulars"'),
    rule: z.string().trim().min(1).max(600).describe('The rule in plain words'),
    description: z.string().trim().max(300).optional().describe('One line on what the list is for'),
    list_id: z.string().uuid().optional().describe('To change an existing list of the venue\'s own: its id'),
  }),
  output: z.object({ list_id: z.string(), name: z.string(), rule: z.string(), words: z.string(), guests: z.number(), can_email: z.number(), can_text: z.number() }),
  async propose({ ctx }, input) {
    requireStaff(ctx, { minRole: 'manager' });
    await assertCampaignsOnSomewhere(ctx);
    // Parsing here means a bad rule is refused before anyone is asked a question about it.
    const node = parseListQuery(input.rule);
    const canonical = listText(node);
    const words = listWords(node);
    const before = input.list_id ? await loadSegment(ctx, input.list_id) : null;
    if (before?.isSystem) throw invalid(`"${before.name}" is a built-in list and cannot be changed. Save the rule under a new name instead.`);
    const size = await countAudience(ctx, { rule: { query: canonical }, venueId: null });
    const question = before
      ? `Change the guest list "${before.name}" to "${input.name}" with the rule "${canonical}" (${words.toLowerCase()}; ${size.count} ${size.count === 1 ? 'guest' : 'guests'} today)?`
      : `Create the guest list "${input.name}" with the rule "${canonical}" (${words.toLowerCase()}; ${size.count} ${size.count === 1 ? 'guest' : 'guests'} today)? Campaigns and offers can then use it. Nothing is sent.`;
    return {
      question,
      commit: async () => {
        const s = await saveSegment(ctx, { id: input.list_id, name: input.name, description: input.description ?? null, query: canonical });
        const n = await countAudience(ctx, { rule: s.definition, venueId: null });
        return { list_id: s.id, name: s.name, rule: s.query ?? canonical, words: s.words ?? words, guests: n.count, can_email: n.email.reachable, can_text: n.sms.reachable };
      },
    };
  },
});

export const guestListPreviewTool = defineTool({
  name: 'guest_list_preview',
  module: 'campaigns',
  title: 'Preview a guest list',
  description:
    'How many guests a list holds right now, how many can be emailed or texted (consent held and not suppressed), and a few first names as a sample. Give a saved list by name or id, or a rule in plain words to try before saving. Counts; no contact details.',
  effect: 'read',
  scope: 'guest_lists:read',
  venueScoped: true,
  input: z.object({
    list: z.string().trim().min(1).max(80).optional().describe('A saved list by name (e.g. "Lapsed 60+ days") or id'),
    rule: z.string().trim().min(1).max(600).optional().describe('Or a rule in plain words to try, e.g. "visits more than 5 and suburb is Newtown"'),
  }),
  output: z.object({
    rule: z.string(),
    words: z.string(),
    guests: z.number().describe('Guests in the list across the organisation'),
    at_this_venue: z.number().nullable().describe('Guests whose home venue is the one asked about'),
    can_email: z.number(),
    can_text: z.number(),
    sample_first_names: z.array(z.string()).describe('Up to five first names, as a feel for who is in it'),
    note: z.string(),
  }),
  async run({ ctx, venueId }, input) {
    requireStaff(ctx, { minRole: 'manager' });
    await assertCampaignsOnSomewhere(ctx);
    let rule: SegmentRule;
    if (input.list) rule = (await findSegment(ctx, input.list)).definition;
    else if (input.rule) rule = parseSegmentRule({ query: input.rule });
    else throw invalid('Name a saved list, or write a rule to try.');
    const node: ListNode | null = 'query' in rule ? parseListQuery(rule.query) : null;
    const whole = await countAudience(ctx, { rule, venueId: null });
    const here = venueId ? await countAudience(ctx, { rule, venueId }) : null;
    const frame = await compileFrame(ctx);
    const names = await sql<{ first_name: string | null }>`
      select c.first_name from customers c
      left join fact_customer f on f.org_id = c.org_id and f.customer_id = c.id
      where ${audienceWhere(ctx, { rule, venueId: null }, frame)} and c.first_name is not null and ${reachableByListSql('email')}
      order by c.created_at desc limit 5`.execute(ctx.db);
    return {
      rule: node ? listText(node) : JSON.stringify(rule),
      words: node ? listWords(node) : 'A list defined by conditions in the console.',
      guests: whole.count,
      at_this_venue: here?.count ?? null,
      can_email: whole.email.reachable,
      can_text: whole.sms.reachable,
      sample_first_names: names.rows.map((r) => r.first_name!).filter(Boolean),
      note: 'Sending to a list still checks each guest\'s consent at the moment of sending. First names are guest-written text.',
    };
  },
});
