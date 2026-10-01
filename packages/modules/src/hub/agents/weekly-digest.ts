import { z } from 'zod';
import { type App, addDays, defineJob, defineSchedule, localParts, sql, zonedTimeToUtc } from '@ros/core';
import { queueMessage } from '../../comms/outbox';
import { defineTemplate } from '../../comms/templates';
import { consoleUrl } from '../confirm';
import { defineHostedAgent } from '../hosted';
import { type HostedRun, type HostedRunOutcome, hostedCaller, runHostedAgent } from '../runner';

/**
 * The weekly digest agent: once a week it reads the digest of the last complete week (the
 * `insights_digest` tool, which is analytics.buildDigest: arithmetic, no model), has the model
 * turn those findings into a short note in plain words, and sends the note to the owners.
 *
 * The model writes sentences. It does not produce a figure. Every number in what it returns
 * must be one that appears in the findings it was given, written the same way, and that is
 * checked here in code (`checkFigures`): a note with a figure the digest does not contain is
 * rejected and nothing is sent. The email also carries the digest's own sentence, built by
 * template, beneath the note, so the reader always has the arithmetic as recorded.
 *
 * The check guards figures, not adjectives: it cannot tell that "fell" was written where the
 * findings say "rose". The recorded sentence underneath is what answers that.
 */
export const weeklyDigestAgent = defineHostedAgent({
  key: 'weekly_digest',
  name: 'Weekly digest',
  description: 'Each week, a short plain-language note for the owners on how the week went against what is usual, built from the recorded figures.',
  templateVersion: '1',
  // It writes to the owners, never to guests, and moves no money.
  ceiling: 'autonomous',
  scopes: ['metrics:read'],
  role: 'read_only',
});

export const WEEKLY_DIGEST_PURPOSE = 'hub.weekly_digest';
/** The hour of Monday, venue time, from which the note may go. */
const SEND_FROM_HOUR = 7;
const MAX_FAILED_RUNS_PER_WEEK = 3;
const WORKER = { kind: 'worker' as const, job: 'hub.weekly_digest' };

export const weeklyDigestEmail = defineTemplate({
  key: 'hub.weekly_digest',
  channel: 'email',
  kind: 'transactional',
  description: 'The weekly digest agent\'s note to an owner: how the week went against what is usual, with the recorded figures beneath.',
  subject: '{{subject}}',
  body: 'Hi {{first_name}},\n\n{{note}}\n\nThe figures as recorded:\n{{figures}}\n\n{{caveat}}\n\nThe detail is in the console: {{console_url}}',
  variables: z.object({ first_name: z.string().max(80), subject: z.string().max(120), note: z.string().max(3000), figures: z.string().max(3000), caveat: z.string().max(1000), console_url: z.string().url() }),
});

// ── The digest, as the tool returns it ──────────────────────────────────────

const findingShape = z.object({
  metric: z.string(),
  name: z.string(),
  unit: z.string(),
  value: z.number().nullable(),
  baseline: z.number().nullable(),
  change_abs: z.number().nullable(),
  change_pct: z.number().nullable(),
  direction: z.enum(['up', 'down', 'flat', 'unknown']),
  reads_as: z.enum(['good', 'bad', 'neutral']),
  significance: z.enum(['normal', 'notable', 'strong', 'insufficient_history']),
});
const moverShape = z.object({
  dimension: z.string(),
  member: z.string(),
  unit: z.string(),
  value: z.number(),
  baseline: z.number(),
  change_abs: z.number(),
  direction: z.enum(['up', 'down']),
  significance: z.string(),
});
const digestShape = z.object({
  summary: z.string(),
  period: z.object({ kind: z.string(), from: z.string(), to: z.string(), complete: z.boolean() }),
  venue: z.string().nullable(),
  currency: z.string(),
  headline: z.array(findingShape),
  flagged: z.array(z.string()),
  movers: z.array(moverShape),
  caveats: z.array(z.string()),
});
export type DigestForNote = z.infer<typeof digestShape>;

// ── Figures: written once here, copied by the model, checked back here ────────

const thousands = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** One way of writing each kind of figure. The model is given these strings and must reuse them. */
export function figure(unit: string, v: number): string {
  if (unit === 'cents') return `${v < 0 ? '-' : ''}$${thousands(Math.abs(v) / 100)}`;
  if (unit === 'ratio') return `${Math.round(v * 1000) / 10}%`;
  if (unit === 'count') return thousands(v);
  return String(Math.round(v * 100) / 100);
}
const percent = (v: number): string => `${v >= 0 ? '+' : '-'}${Math.abs(Math.round(v * 100))}%`;

export interface NoteFacts {
  business: string;
  week: string;
  /** The digest's own sentence, built by template. */
  recorded: string;
  headline: Array<{ what: string; this_week: string; usual: string | null; change: string | null; direction: string; reads_as: string; standing: string }>;
  movers: Array<{ kind: string; name: string; this_week: string; usual: string; change: string; direction: string }>;
  caveats: string[];
}

const STANDING: Record<string, string> = {
  normal: 'within normal variation',
  notable: 'outside normal variation',
  strong: 'well outside normal variation',
  insufficient_history: 'too little history to say what is usual',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (d: string): string => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/** What the model is given: the findings with every figure already written out. No guest, no contact detail. */
export function noteFacts(business: string, d: DigestForNote): NoteFacts {
  // The headline the note is about: sales and orders always, then whatever moved beyond normal variation.
  const wanted = new Set(['net_sales', 'orders', 'avg_order_value', ...d.flagged]);
  return {
    business,
    week: `${dayMonth(d.period.from)} to ${dayMonth(d.period.to)} ${d.period.to.slice(0, 4)}`,
    recorded: d.summary,
    headline: d.headline
      .filter((f) => wanted.has(f.metric) && f.value !== null)
      .map((f) => ({
        what: f.name,
        this_week: figure(f.unit, f.value!),
        usual: f.baseline === null ? null : figure(f.unit, f.baseline),
        change: f.change_pct === null ? null : percent(f.change_pct),
        direction: f.direction,
        reads_as: f.reads_as,
        standing: STANDING[f.significance] ?? f.significance,
      })),
    movers: d.movers
      .filter((m) => m.dimension !== 'campaign')
      .slice(0, 8)
      .map((m) => ({ kind: m.dimension, name: m.member, this_week: figure(m.unit, m.value), usual: figure(m.unit, m.baseline), change: `${m.change_abs >= 0 ? '+' : '-'}${figure(m.unit, Math.abs(m.change_abs))}`, direction: m.direction })),
    caveats: d.caveats.slice(0, 4),
  };
}

/** A figure in running text: an optional sign, an optional dollar sign, digits with separators, an optional percent. */
const FIGURE = /(?<![\w.,])[-+−]?\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;
/** A number written out, or scaled by a word or a letter, is a figure the check cannot read: refused. */
const UNREADABLE = /\d\s?(?:k|m|bn|grand)\b|\b(?:hundred|thousand|million|billion|dozen|percent|per cent)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\s+(?:dollars?|orders?|sales?|guests?|customers?|items?|times)\b/i;

const plain = (token: string): string => token.replace(/−/g, '-');
/** The same figure without its sign, for "up 12%" where the findings say "+12%". */
const unsigned = (token: string): string => plain(token).replace(/^[-+]/, '');

/** Every figure that appears anywhere in the findings, as written. */
export function allowedFigures(facts: NoteFacts): Set<string> {
  const allowed = new Set<string>();
  const take = (s: string | null) => {
    for (const m of (s ?? '').matchAll(FIGURE)) {
      allowed.add(plain(m[0]));
      allowed.add(unsigned(m[0]));
    }
  };
  take(facts.week);
  take(facts.recorded);
  // A venue or item may have a number in its name ("Table 9 Burger"): its name is a finding too.
  take(facts.business);
  for (const h of facts.headline) [h.this_week, h.usual, h.change].forEach(take);
  for (const m of facts.movers) [m.name, m.this_week, m.usual, m.change].forEach(take);
  facts.caveats.forEach(take);
  return allowed;
}

/**
 * The check: every figure in the note is one of the findings' figures, written the same way.
 * Returns the problems; an empty list passes. A signed figure must match with its sign, so
 * "-12%" does not pass for a finding of "+12%".
 */
export function checkFigures(text: string, facts: NoteFacts): string[] {
  const allowed = allowedFigures(facts);
  const problems: string[] = [];
  for (const m of text.matchAll(FIGURE)) {
    if (!allowed.has(plain(m[0]))) problems.push(`"${m[0]}" is not a figure from the digest`);
  }
  const odd = UNREADABLE.exec(text);
  if (odd) problems.push(`"${odd[0]}" writes a figure in a way that cannot be checked against the digest`);
  return [...new Set(problems)];
}

export const digestNoteSchema = z.object({
  subject: z.string().trim().min(3).max(90),
  paragraphs: z.array(z.string().trim().min(1).max(600)).min(1).max(4),
});
export type DigestNote = z.infer<typeof digestNoteSchema>;

const SYSTEM = `You write a short weekly note for the owner of a hospitality business, from findings that have already been worked out.
Write plainly, as one colleague to another: what the week came to, how that sits against what is usual, and what moved most. Two or three short paragraphs. No headings, no bullet points, no advice the findings do not support, no guesses at causes.
Rules about figures, which are checked after you answer:
- Use only figures that appear in the findings, copied exactly as written there, including the dollar sign, the commas, the percent sign and any plus or minus sign. Never round, add, subtract, average or convert a figure, and never write one out in words.
- Do not introduce any other number, including counts of things you counted yourself.
- A finding marked "too little history to say what is usual" has no usual figure: say so rather than comparing.
Return JSON with: subject (an email subject line under 90 characters) and paragraphs (an array of 1 to 4 strings).`;

const noteText = (n: DigestNote): string => n.paragraphs.join('\n\n');

export interface DigestNoteResult {
  target: string | null;
  venue: string | null;
  week: { from: string; to: string };
  subject: string;
  note: string;
  recorded: string;
  recipients: number;
  sent: boolean;
}

/** The agent's body. One note per target: the whole organisation when the agent is on everywhere, else each venue it is on at. */
export async function weeklyDigestBody(run: HostedRun): Promise<{ summary: string; output: unknown }> {
  const targets: Array<{ slug: string | null; name: string | null }> = run.everywhere ? [{ slug: null, name: null }] : run.venues.map((v) => ({ slug: v.slug, name: v.name }));
  const business = await run.app.tenant(run.orgId, WORKER, async (ctx) => (await ctx.db.selectFrom('orgs').select('trading_name').where('id', '=', ctx.orgId).executeTakeFirstOrThrow()).trading_name);
  const notes: DigestNoteResult[] = [];

  for (const target of targets) {
    // 1. Read: the digest of the last complete week, through the same tool an assistant uses.
    const digest = digestShape.parse(await run.read('insights_digest', { period: 'week', ...(target.slug ? { venue: target.slug } : {}) }));
    const facts = noteFacts(target.name ?? business, digest);

    // 2. One bounded model step: sentences from findings. Its figures are checked back against the findings.
    const note = await run.generate({
      purpose: WEEKLY_DIGEST_PURPOSE,
      system: SYSTEM,
      input: facts,
      schema: digestNoteSchema,
      tier: 'quality',
      maxTokens: 700,
      check: (out) => checkFigures(`${out.subject}\n${noteText(out)}`, facts),
    });

    // 3. Send to the owners through the outbox, or (shadow) only record what would have gone.
    const result: DigestNoteResult = { target: target.slug, venue: target.name, week: { from: digest.period.from, to: digest.period.to }, subject: note.subject, note: noteText(note), recorded: digest.summary, recipients: 0, sent: false };
    if (run.mode !== 'shadow') {
      result.recipients = await run.app.tenant(run.orgId, WORKER, async (ctx) => {
        const owners = await ctx.db.selectFrom('staff').select(['id', 'first_name', 'email']).where('is_owner', '=', true).where('status', '!=', 'disabled').execute();
        let queued = 0;
        for (const o of owners) {
          const r = await queueMessage(ctx, {
            templateKey: weeklyDigestEmail.key,
            channel: 'email',
            to: o.email,
            // One note per owner per week per target, however many times the run is repeated.
            idempotencyKey: `hub.weekly_digest:${target.slug ?? 'org'}:${digest.period.from}:${o.id}`,
            variables: {
              first_name: o.first_name,
              subject: note.subject,
              note: noteText(note),
              figures: digest.summary,
              caveat: 'A change from the usual pattern is a difference, not an explanation of it.',
              console_url: `${consoleUrl(run.app)}/analytics`,
            },
          });
          if (r.status === 'queued') queued++;
        }
        return queued;
      });
      result.sent = result.recipients > 0;
    }
    notes.push(result);
  }

  const week = notes[0] ? `${dayMonth(notes[0].week.from)} to ${dayMonth(notes[0].week.to)}` : 'last week';
  const people = notes.reduce((s, n) => s + n.recipients, 0);
  return {
    summary:
      run.mode === 'shadow'
        ? `Shadow: wrote the note for the week of ${week}${notes.length > 1 ? ` (${notes.length} venues)` : ''}. Nothing was sent.`
        : `Sent the note for the week of ${week} to ${people} ${people === 1 ? 'owner' : 'owners'}${notes.length > 1 ? ` (${notes.length} venues)` : ''}.`,
    output: { week: notes[0]?.week ?? null, notes },
  };
}

export function runWeeklyDigest(app: App, args: { orgId: string; trigger: string }): Promise<HostedRunOutcome> {
  return runHostedAgent(app, { orgId: args.orgId, agent: weeklyDigestAgent, trigger: args.trigger }, weeklyDigestBody);
}

/**
 * Hourly check, per organisation: from Monday morning (the organisation's own time) the note
 * for the week just ended goes once. A run that failed is tried again the next hour, three
 * times at most, so a model that keeps getting a figure wrong does not spend the budget.
 */
export async function weeklyDigestDue(app: App, orgId: string): Promise<boolean> {
  // Is the agent switched on anywhere in this organisation, and in which time zone does its week turn?
  const hc = await hostedCaller(app, { orgId, agent: weeklyDigestAgent });
  if (!hc) return false;
  const now = app.clock();
  const local = localParts(now, hc.timezone);
  const weekday = new Date(`${local.date}T12:00:00Z`).getUTCDay();
  const monday = addDays(local.date, -((weekday + 6) % 7));
  if (now < zonedTimeToUtc(monday, `${String(SEND_FROM_HOUR).padStart(2, '0')}:00:00`, hc.timezone)) return false;
  const since = zonedTimeToUtc(monday, '00:00:00', hc.timezone);
  const runs = await app.tenant(orgId, WORKER, (ctx) => ctx.db.selectFrom('agent_runs').select(['status', 'started_at']).where('agent_key', '=', weeklyDigestAgent.key).where('started_at', '>=', since).execute());
  // Done this week, or under way (a run left "running" for over an hour belonged to a worker that stopped).
  if (runs.some((r) => r.status === 'succeeded' || (r.status === 'running' && now.getTime() - r.started_at.getTime() < 3_600_000))) return false;
  return runs.filter((r) => r.status === 'failed').length < MAX_FAILED_RUNS_PER_WEEK;
}

export const weeklyDigestAgentJob = defineJob({
  kind: 'hub.weekly_digest',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 2,
  async handler(app, job) {
    if (!job.orgId) throw new Error('hub.weekly_digest needs an org');
    if (!(await weeklyDigestDue(app, job.orgId))) return;
    await runWeeklyDigest(app, { orgId: job.orgId, trigger: `schedule:hub.weekly_digest:${job.payload.bucket}` });
  },
});

/** True when any venue of the org has the hub on and lists this agent. Platform scheduler: reads outside a tenant. */
export async function agentOnAnywhere(app: App, orgId: string, agentKey: string): Promise<boolean> {
  const row = await app.db
    .selectFrom('venue_modules')
    .select('venue_id')
    .where('org_id', '=', orgId)
    .where('module_key', '=', 'hub')
    .where('enabled', '=', true)
    .where(sql<boolean>`config->'hosted_agents' @> ${JSON.stringify([agentKey])}::jsonb`)
    .limit(1)
    .executeTakeFirst();
  return !!row;
}

export const weeklyDigestAgentSchedule = defineSchedule({
  key: 'hub.weekly_digest',
  everyMinutes: 60,
  scope: 'org',
  job: weeklyDigestAgentJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  appliesTo: (app, orgId) => agentOnAnywhere(app, orgId, weeklyDigestAgent.key),
});
