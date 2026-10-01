import { z } from 'zod';
import { defineTool, formatMoney, invalid } from '@ros/core';
import { checkSpecial, endSpecial, listSpecials, postSpecial } from './specials';

/**
 * The assistant tools. Each is pinned to the service function the console would call, so the
 * role check, the module guard and row-level security are the same ones. `output` is an
 * allowlist: a field not named there does not leave. A write is `propose` (changes nothing,
 * returns the question) and `commit` (runs only after the person's yes).
 */

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date such as 2026-10-02.');

const specialShape = z.object({
  special_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  price: z.string(),
  price_cents: z.number().int(),
  first_day: z.string(),
  last_day: z.string(),
  status: z.enum(['upcoming', 'running', 'over', 'ended']),
});

type Shown = z.infer<typeof specialShape>;
const shown = (s: Awaited<ReturnType<typeof listSpecials>>[number]): Shown => ({
  special_id: s.id,
  name: s.name,
  description: s.description,
  price: formatMoney(s.priceCents),
  price_cents: s.priceCents,
  first_day: s.startsOn,
  last_day: s.endsOn,
  status: s.status,
});

export const specialsListTool = defineTool({
  name: 'specials_list',
  module: 'specials',
  title: 'The specials board',
  description:
    'The venue\'s specials: each one\'s name, description, price, the days it runs and whether it is running today, still to come, over, or was taken down. Use it to answer "what are today\'s specials?" or to find a special before ending it.',
  effect: 'read',
  scope: 'specials:read',
  venueScoped: true,
  input: z.object({ include_past: z.boolean().optional().describe('True to also list specials that are over or were taken down') }),
  output: z.object({ specials: z.array(specialShape), running_today: z.number().int() }),
  async run({ ctx, venueId }, input) {
    const rows = await listSpecials(ctx, { venueId: venueId!, show: input.include_past ? 'all' : 'open' });
    return { specials: rows.map(shown), running_today: rows.filter((r) => r.status === 'running').length };
  },
});

export const specialPostTool = defineTool({
  name: 'special_post',
  module: 'specials',
  title: 'Post a special',
  description:
    'Put a special on the venue\'s board: a name, an optional description, a price in cents and the days it runs. Guests see it on those days. Ask the person for the price; never guess one. A special is a notice, not a menu item: it cannot be ordered online.',
  effect: 'write',
  scope: 'specials:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    name: z.string().trim().min(1).max(80).describe('What it is called on the board, e.g. "Lamb shoulder for two"'),
    description: z.string().trim().max(500).optional().describe('One or two sentences guests read under the name'),
    price_cents: z.number().int().min(0).max(1_000_000).describe('The price in cents: 1850 is $18.50'),
    starts_on: DAY.optional().describe('First day, YYYY-MM-DD, in the venue\'s time zone. Left out: today'),
    ends_on: DAY.optional().describe('Last day, inclusive. Left out: the same day as starts_on'),
  }),
  output: specialShape,
  async propose({ ctx, venueId }, input) {
    // The same checks the change itself makes: a refusal comes now, before anyone is asked.
    const plan = await checkSpecial(ctx, {
      venueId: venueId!,
      name: input.name,
      description: input.description,
      priceCents: input.price_cents,
      startsOn: input.starts_on,
      endsOn: input.ends_on,
    });
    const when = plan.days === 1 ? `on ${plan.startsOn}` : `from ${plan.startsOn} to ${plan.endsOn} (${plan.days} days)`;
    return {
      question: `Post "${plan.name}" at ${formatMoney(plan.priceCents)} on the specials board at ${plan.venue.name}, ${when}? Guests see it on ${plan.days === 1 ? 'that day' : 'those days'}.`,
      commit: async () =>
        shown(
          await postSpecial(ctx, {
            venueId: plan.venue.id,
            name: plan.name,
            description: plan.description,
            priceCents: plan.priceCents,
            // The days the person was shown, not "today" worked out a second time.
            startsOn: plan.startsOn,
            endsOn: plan.endsOn,
          }),
        ),
    };
  },
});

export const specialEndTool = defineTool({
  name: 'special_end',
  module: 'specials',
  title: 'Take a special down',
  description: 'Take a special off the board now, before its last day. Guests stop seeing it straight away. It stays in the history and cannot be put back; post it again instead.',
  effect: 'write',
  scope: 'specials:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({ special: z.string().trim().min(1).max(100).describe('The special_id from specials_list, or its exact name') }),
  output: specialShape,
  async propose({ ctx, venueId }, input) {
    const open = await listSpecials(ctx, { venueId: venueId!, show: 'open', limit: 100 });
    const wanted = input.special.toLowerCase();
    const matches = open.filter((s) => s.id === wanted || s.name.toLowerCase() === wanted);
    if (!matches.length) throw invalid('No special running or scheduled here has that id or exact name. Use specials_list to find it.');
    if (matches.length > 1) throw invalid('More than one special has that name. Use the special_id from specials_list.');
    const special = matches[0]!;
    return {
      question: `Take "${special.name}" (${formatMoney(special.priceCents)}, ${special.startsOn} to ${special.endsOn}) off the specials board now? Guests stop seeing it straight away.`,
      commit: async () => shown(await endSpecial(ctx, { specialId: special.id })),
    };
  },
});

export const specialsTools = [specialsListTool, specialPostTool, specialEndTool];
