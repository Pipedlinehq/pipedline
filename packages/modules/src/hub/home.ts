import { z } from 'zod';
import { type Ctx, type ToolDef, addDays, audit, conflict, defineTool, formatMoney, getTool, invalid, isAppError, localDate, notFound, requireStaff, staffOf } from '@ros/core';
import { listDigests } from '../analytics/digest';
import { listApprovals } from '../approvals/index';
import { listBookings } from '../bookings/bookings';
import { getMenuEditor } from '../menu/edit';
import { listOrders } from '../ordering/orders';
import { listReviews } from '../reviews/read';
import { getVenue, listVenues } from '../tenancy/venues';
import { opsStatus } from './ops';

/**
 * Home (docs/CONSOLE_IA.md section 9, pattern 8). Three things the console's first page needs
 * that no module owned:
 *
 *   - needs-attention counts, each read through the owning module's own list function with the
 *     same filters its page uses, so the count and the page behind the link agree;
 *   - guidance cards a person can put away, remembered per staff member;
 *   - suggestions, at most five, worked out from what is already recorded (the operations
 *     status and the latest weekly digest; no model is asked) and approved by running an
 *     assistant tool's own propose and commit exactly once, or dismissed with a reason.
 */

// ── Needs attention ───────────────────────────────────────────────────────────

export interface AttentionItem {
  key: 'orders_to_accept' | 'orders_flagged' | 'bookings_to_confirm' | 'approvals_waiting' | 'reviews_to_reply' | 'items_sold_out';
  count: number;
  /** "4 orders to accept", with the count already in the words. */
  label: string;
  /** The console page, filtered to exactly these rows. */
  href: string;
}

export interface NeedsAttention {
  venue: { id: string; name: string };
  items: AttentionItem[];
  /** Items with a count above zero, most urgent first. */
  open: AttentionItem[];
  summary: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** A module that is off, a role that may not look, or a venue that is not found means: nothing to count here. */
const skippable = (e: unknown) => isAppError(e) && (e.code === 'module_disabled' || e.code === 'forbidden' || e.code === 'not_found');

async function count(fn: () => Promise<number>): Promise<number | null> {
  try {
    return await fn();
  } catch (e) {
    if (skippable(e)) return null;
    throw e;
  }
}

/**
 * What needs someone at the venue right now, by type, each count from the owning module and each
 * link opening the page filtered to the same rows. Any staff role at the venue; a kind of item the
 * role may not open (bookings for the kitchen, approvals below manager) is left out, not shown as zero.
 */
export async function needsAttention(ctx: Ctx, raw: { venueId: string }): Promise<NeedsAttention> {
  const { venueId } = z.object({ venueId: z.string().uuid() }).parse(raw);
  requireStaff(ctx, { venueId });
  const venue = await getVenue(ctx, venueId);
  const today = localDate(ctx.now(), venue.timezone);
  const items: AttentionItem[] = [];
  const add = (key: AttentionItem['key'], n: number | null, words: (n: number) => string, href: string) => {
    if (n !== null) items.push({ key, count: n, label: words(n), href });
  };
  add('orders_to_accept', await count(async () => (await listOrders(ctx, { venueId, statuses: ['placed'], limit: 200 })).length), (n) => plural(n, 'order to accept', 'orders to accept'), '/console/orders?view=accepting');
  add('orders_flagged', await count(async () => (await listOrders(ctx, { venueId, needsAttention: true, limit: 200 })).length), (n) => plural(n, 'order flagged for a look', 'orders flagged for a look'), '/console/orders?view=attention');
  // The same window the book's "Needs confirming" view uses: today and the next 59 days.
  add('bookings_to_confirm', await count(async () => (await listBookings(ctx, { venueId, date: today, to: addDays(today, 59), status: ['requested'] })).bookings.length), (n) => plural(n, 'booking to confirm', 'bookings to confirm'), '/console/bookings?view=confirming');
  add('approvals_waiting', await count(async () => (await listApprovals(ctx, { status: 'pending' })).filter((a) => a.venueId === null || a.venueId === venueId).length), (n) => plural(n, 'thing waiting for your yes', 'things waiting for your yes'), '/console/approvals');
  add('reviews_to_reply', await count(async () => (await listReviews(ctx, { venueId, onlyUnanswered: true, limit: 200 })).length), (n) => plural(n, 'review to reply to', 'reviews to reply to'), '/console/reviews?show=unanswered');
  add(
    'items_sold_out',
    await count(async () => {
      const editor = await getMenuEditor(ctx, venueId, { availability: 'off' });
      return editor.menus.reduce((s, m) => s + m.sections.reduce((t, sec) => t + sec.items.length, 0), 0);
    }),
    (n) => plural(n, 'item sold out', 'items sold out'),
    '/console/menu?view=soldout',
  );
  const open = items.filter((i) => i.count > 0);
  return {
    venue: { id: venue.id, name: venue.name },
    items,
    open,
    summary: open.length ? open.map((i) => i.label).join(' · ') : 'Nothing needs attention.',
  };
}

export const needsAttentionTool = defineTool({
  name: 'needs_attention',
  module: 'hub',
  title: 'What needs attention, by type',
  description:
    'Counts of what is waiting for someone at the venue, by type: orders to accept, orders flagged for a look, bookings to confirm, things waiting for a manager\'s yes, reviews without a reply, and items sold out (86\'d). Each count comes from the same list the console page shows and carries the link to that page filtered to those rows. A type the person\'s role may not open is left out rather than shown as zero. For live findings in words (a service that stopped, a quiet service) use ops_status.',
  effect: 'read',
  scope: 'ops:read',
  venueScoped: true,
  input: z.object({}),
  output: z.object({
    venue: z.string(),
    summary: z.string(),
    items: z.array(z.object({ key: z.string(), count: z.number().int(), label: z.string(), console_path: z.string() })),
  }),
  async run({ ctx, venueId }) {
    const n = await needsAttention(ctx, { venueId: venueId! });
    return { venue: n.venue.name, summary: n.summary, items: n.items.map((i) => ({ key: i.key, count: i.count, label: i.label, console_path: i.href })) };
  },
});

// ── Guidance cards, dismissible per person ────────────────────────────────────

export interface HomeCard {
  key: string;
  title: string;
  body: string;
  href: string;
  cta: string;
  /** The lowest role the card is for. */
  minRole: 'read_only' | 'manager' | 'owner';
}

export const HOME_CARDS: HomeCard[] = [
  { key: 'guide.assistant', title: 'Connect your assistant', body: 'Your own Claude or ChatGPT can read the numbers and, after your yes, make changes. One address, one key.', href: '/console/assistant', cta: 'Open Assistant', minRole: 'manager' },
  { key: 'guide.alerts', title: 'Tell the team when something happens', body: 'A new order to the kitchen, a booking to the host, a review to you: by email or text, with quiet hours.', href: '/console/settings/notifications', cta: 'Set up alerts', minRole: 'manager' },
  { key: 'guide.reports', title: 'Reports, each number defined once', body: 'Sales, guests, menu and marketing reports with a comparison, a chart, a table and a download. Save your own.', href: '/console/analytics/reports', cta: 'Open Reports', minRole: 'read_only' },
  { key: 'guide.plugins', title: 'See what each plugin reads and writes', body: 'Every plugin and connected service has a page: what it touches, the tools it adds, when it was last used.', href: '/console/plugins', cta: 'Open Plugins', minRole: 'manager' },
];

const cardKey = z.string().regex(/^[a-z][a-z0-9_.-]{0,59}$/);

/** The cards this person has not put away. Signed-in staff only. */
export async function homeCards(ctx: Ctx): Promise<HomeCard[]> {
  const staff = staffOf(ctx);
  if (!staff || ctx.principal.kind !== 'staff') return [];
  const rows = await ctx.db.selectFrom('home_dismissals').select('card_key').where('staff_id', '=', staff.staffId).execute();
  const gone = new Set(rows.map((r) => r.card_key));
  return HOME_CARDS.filter((c) => !gone.has(c.key));
}

/** Put a card away, for this person only. Idempotent. */
export async function dismissCard(ctx: Ctx, raw: { card: string }): Promise<{ card: string }> {
  const { card } = z.object({ card: cardKey }).parse(raw);
  const staff = staffOf(ctx);
  if (!staff || ctx.principal.kind !== 'staff') throw invalid('Cards are put away by a person in the console.');
  if (!HOME_CARDS.some((c) => c.key === card)) throw notFound('That card does not exist.');
  await ctx.db
    .insertInto('home_dismissals')
    .values({ org_id: ctx.orgId, staff_id: staff.staffId, card_key: card, dismissed_at: ctx.now() })
    .onConflict((oc) => oc.columns(['org_id', 'staff_id', 'card_key']).doNothing())
    .execute();
  return { card };
}

// ── Suggestions ───────────────────────────────────────────────────────────────

export interface Suggestion {
  /** What it is about: `ops.accept_order:A7K2`, `digest.2026-09-21.refund_rate`. */
  key: string;
  title: string;
  body: string;
  /** Where the facts behind it are. */
  href: string;
  /** The tool and arguments Approve runs through propose and commit, when a tool exists for it. */
  action: { tool: string; input: Record<string, unknown>; verb: string } | null;
  source: 'ops' | 'digest';
}

export const SUGGESTION_CAP = 5;

const money = (cents: number, currency: string) => formatMoney(cents, currency);
const showUnit = (unit: string, v: number, currency: string): string =>
  unit === 'cents' ? money(Math.round(v), currency) : unit === 'ratio' ? `${Math.round(v * 1000) / 10}%` : unit === 'count' ? String(Math.round(v)) : String(Math.round(v * 100) / 100);

const REPORT_FOR: Record<string, string> = {
  net_sales: 'sales.over_time',
  orders: 'sales.over_time',
  avg_order_value: 'sales.avg_order_value',
  items_per_order: 'menu.items_per_order',
  identified_share: 'guests.new_and_returning',
  new_customer_orders: 'guests.new_and_returning',
  returning_customer_orders: 'guests.new_and_returning',
  discounts: 'sales.refunds_and_discounts',
  refund_rate: 'sales.refunds_and_discounts',
  web_sessions: 'marketing.visits',
};

/** Every suggestion the records support right now, before the venue's decisions and the cap are applied. */
async function deriveSuggestions(ctx: Ctx, venueId: string): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  // Operations: a paid order left waiting has a tool behind it (the same one ops_watch proposes); a stopped service has a page.
  try {
    const ops = await opsStatus(ctx, { venueId });
    for (const o of ops.waitingOrders.slice(0, SUGGESTION_CAP)) {
      out.push({
        key: `ops.accept_order:${o.reference}`,
        title: `Accept order ${o.reference}`,
        body: `Paid ${o.waitingMinutes} ${o.waitingMinutes === 1 ? 'minute' : 'minutes'} ago (${o.total}, ${o.kind}) and nobody has accepted it.`,
        href: '/console/orders?view=accepting',
        action: { tool: 'order_decide', input: { order: o.reference, decision: 'accept' }, verb: 'Accept it' },
        source: 'ops',
      });
    }
    for (const c of ops.connections.filter((x) => x.status === 'unhealthy')) {
      out.push({ key: `ops.reconnect:${c.service}`, title: `Reconnect ${c.service}`, body: `${c.service} has stopped working${c.problem ? `: ${c.problem.slice(0, 160)}` : ''}. Until it is reconnected its tools are withdrawn and nothing new arrives from it.`, href: '/console/settings/connections', action: null, source: 'ops' });
    }
  } catch (e) {
    if (!skippable(e)) throw e;
  }
  // The latest weekly digest: what moved beyond normal variation and reads badly, and the items that fell most.
  try {
    const venues = await listVenues(ctx);
    let digests = await listDigests(ctx, { venueId, period: 'week', limit: 1 });
    if (!digests.length && venues.length === 1) digests = await listDigests(ctx, { period: 'week', limit: 1 });
    const d = digests[0];
    if (d) {
      for (const f of d.headline.filter((x) => d.flagged.includes(x.metric) && x.reads_as === 'bad' && x.value !== null && x.baseline !== null)) {
        out.push({
          key: `digest.${d.period.from}.${f.metric}`,
          title: `${f.name} ${f.direction === 'up' ? 'rose' : 'fell'} last week`,
          body: `${showUnit(f.unit, f.value!, d.currency)} against the usual ${showUnit(f.unit, f.baseline!, d.currency)} for those weekdays${f.change_pct !== null ? ` (${f.change_pct >= 0 ? '+' : ''}${Math.round(f.change_pct * 100)}%)` : ''}: outside normal variation. A difference from the usual pattern, not an explanation of it.`,
          href: `/console/analytics/reports/${REPORT_FOR[f.metric] ?? 'sales.over_time'}?period=last_week&compare=previous_period`,
          action: null,
          source: 'digest',
        });
      }
      for (const m of d.movers.filter((x) => x.dimension === 'item' && x.direction === 'down' && x.significance === 'strong').slice(0, 2)) {
        out.push({
          key: `digest.${d.period.from}.item.${m.member.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60)}`,
          title: `${m.member} sold much less last week`,
          body: `${showUnit(m.unit, m.value, d.currency)} against the usual ${showUnit(m.unit, m.baseline, d.currency)}. Check it is on the menu and priced as you expect.`,
          href: '/console/analytics/reports/menu.top_items?period=last_week&compare=previous_period',
          action: null,
          source: 'digest',
        });
      }
    }
  } catch (e) {
    if (!skippable(e)) throw e;
  }
  return out;
}

/** The suggestions to show: derived now, less the ones already approved or dismissed, capped at five. Manager and above at the venue. */
export async function suggestions(ctx: Ctx, raw: { venueId: string }): Promise<Suggestion[]> {
  const { venueId } = z.object({ venueId: z.string().uuid() }).parse(raw);
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const all = await deriveSuggestions(ctx, venueId);
  if (!all.length) return [];
  const decided = new Set((await ctx.db.selectFrom('home_suggestion_decisions').select('suggestion_key').where('venue_id', '=', venueId).where('suggestion_key', 'in', all.map((s) => s.key)).execute()).map((r) => r.suggestion_key));
  return all.filter((s) => !decided.has(s.key)).slice(0, SUGGESTION_CAP);
}

export const suggestionDecisionInput = z.object({ venueId: z.string().uuid(), key: z.string().min(1).max(160), reason: z.string().trim().max(500).nullish() }).strict();

/** Put a suggestion away for the venue, with the reason in the person's words. Manager and above. */
export async function dismissSuggestion(ctx: Ctx, raw: z.input<typeof suggestionDecisionInput>): Promise<{ key: string }> {
  const input = suggestionDecisionInput.parse(raw);
  const staff = requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const s = (await deriveSuggestions(ctx, input.venueId)).find((x) => x.key === input.key);
  if (!s) throw notFound('That suggestion is no longer there.');
  await ctx.db
    .insertInto('home_suggestion_decisions')
    .values({ org_id: ctx.orgId, venue_id: input.venueId, suggestion_key: input.key, decision: 'dismissed', reason: input.reason ?? null, decided_by_id: staff?.staffId ?? null, decided_at: ctx.now() })
    .onConflict((oc) => oc.columns(['org_id', 'venue_id', 'suggestion_key']).doNothing())
    .execute();
  await audit(ctx, { action: 'home.suggestion_dismissed', entityType: 'suggestion', entityId: null, venueId: input.venueId, after: { key: input.key, title: s.title, reason: input.reason ?? null } });
  return { key: input.key };
}

/**
 * Approve a suggestion: run its tool's own propose, then commit, in this transaction, as the
 * person approving. The decision row is written first under a unique key, so a second approval
 * of the same suggestion is refused before anything runs: the commit happens exactly once.
 */
export async function approveSuggestion(ctx: Ctx, raw: z.input<typeof suggestionDecisionInput>): Promise<{ key: string; question: string; result: unknown }> {
  const input = suggestionDecisionInput.parse(raw);
  const staff = requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const s = (await deriveSuggestions(ctx, input.venueId)).find((x) => x.key === input.key);
  if (!s) throw notFound('That suggestion is no longer there.');
  if (!s.action) throw invalid('That suggestion has nothing to run: it points at a page.');
  const tool: ToolDef | undefined = getTool(s.action.tool);
  if (!tool || tool.effect !== 'write') throw invalid('The tool behind that suggestion is not available.');
  const taken = await ctx.db
    .insertInto('home_suggestion_decisions')
    .values({ org_id: ctx.orgId, venue_id: input.venueId, suggestion_key: input.key, decision: 'approved', reason: null, decided_by_id: staff?.staffId ?? null, decided_at: ctx.now() })
    .onConflict((oc) => oc.columns(['org_id', 'venue_id', 'suggestion_key']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!taken) throw conflict('That suggestion has already been decided.');
  const parsed = tool.input.parse(s.action.input);
  const proposal = await tool.propose({ ctx, venueId: input.venueId }, parsed);
  const result = await proposal.commit();
  await ctx.db.updateTable('home_suggestion_decisions').set({ reason: proposal.question.slice(0, 500) }).where('id', '=', taken.id).execute();
  await audit(ctx, { action: 'home.suggestion_approved', entityType: 'suggestion', entityId: null, venueId: input.venueId, after: { key: input.key, tool: tool.name, question: proposal.question } });
  return { key: input.key, question: proposal.question, result };
}

export const suggestionDismissTool = defineTool({
  name: 'suggestion_dismiss',
  module: 'hub',
  title: 'Dismiss a Home suggestion',
  description:
    'Puts away one of the suggestions shown on the console\'s Home page for this venue, with the reason, so it is not shown again. Suggestions are worked out from what is recorded (orders left waiting, services that stopped, what moved in the weekly digest); dismissing one changes nothing about the venue. The person is asked to confirm first. To act on a suggestion, use the tool it names (for example order_decide) rather than this one.',
  effect: 'write',
  scope: 'ops:write',
  minRole: 'manager',
  venueScoped: true,
  input: z.object({
    key: z.string().min(1).max(160).describe('The suggestion\'s key, as the console shows it (e.g. "ops.accept_order:A7K2").'),
    reason: z.string().trim().min(1).max(500).optional().describe('Why, in the person\'s words. Optional.'),
  }),
  output: z.object({ key: z.string(), dismissed: z.boolean(), venue: z.string() }),
  async propose({ ctx, venueId }, input) {
    const venue = await getVenue(ctx, venueId!);
    const s = (await suggestions(ctx, { venueId: venue.id })).find((x) => x.key === input.key);
    if (!s) throw notFound('That suggestion is not on Home for this venue (it may already have been decided).');
    return {
      question: `Put away the suggestion "${s.title}" at ${venue.name}${input.reason ? ` (reason: ${input.reason})` : ''}? It will not be shown again. Nothing else changes.`,
      commit: async () => {
        await dismissSuggestion(ctx, { venueId: venue.id, key: input.key, reason: input.reason ?? null });
        return { key: input.key, dismissed: true, venue: venue.name };
      },
    };
  },
});

export const homeTools = [needsAttentionTool, suggestionDismissTool];
