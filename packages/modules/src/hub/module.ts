import { z } from 'zod';
import { defineModule } from '@ros/core';

/** How far a hosted agent may go on its own (docs/modules/hub.md section 8). */
export const AUTONOMY_LEVELS = ['shadow', 'supervised', 'autonomous'] as const;

/** Below this many guests a figure could point at a person. A venue may ask for more, never fewer. */
export const CRIOTA_MIN_COHORT_FLOOR = 5;

/**
 * Config surface: docs/modules/hub.md section 10. One row per venue. A key that sees several
 * venues is held to each venue's own settings when it acts there, and to the strictest of them
 * where a limit is about the key itself (how many, how long).
 */
export const hubConfig = z.object({
  /** Whether assistants may connect to this venue at all. Off: the venue is invisible to every key. */
  agent_access_enabled: z
    .boolean()
    .default(true)
    .describe('Whether an AI assistant may connect to this venue at all. Off: no assistant or access key can see this venue, whoever it belongs to. Default on.'),
  /** Scopes a key may use here. '*' is everything; 'sales:*' and '*:read' match by part. */
  allowed_scopes: z
    .array(z.string().trim().min(1).max(80).describe('One permission (scope), e.g. "sales:read", or a pattern such as "sales:*", "*:read" or "*".'))
    .max(100)
    .default(['*'])
    .describe('The permissions (shown as scopes on the access-key screen) an assistant may use at this venue, e.g. "sales:read" or "menu:write". "*" allows everything the person behind the key may do; "sales:*" allows every sales permission and "*:read" every read-only one. Default: everything.'),
  /** Guest-level reads (`guests:*` scopes) are off until the venue switches them on, whatever allowed_scopes says. */
  guest_level_reads_enabled: z
    .boolean()
    .default(false)
    .describe('Whether an assistant may read about individual guests (the "guests:" permissions). Off: it sees totals only, whatever allowed_scopes says. Default off.'),
  max_keys_per_staff: z
    .number()
    .int()
    .min(0)
    .max(50)
    .default(5)
    .describe('The most access keys one staff member may hold for this venue at once. 0: nobody can make a new key here. Default 5.'),
  key_max_lifetime_days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(90)
    .describe('The longest an access key or assistant sign-in may last before it has to be made again, in days. Default 90.'),
  /** How long a question stays answerable. What goes stale inside the window is caught anyway: the question is rebuilt. */
  write_confirmation_ttl_minutes: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(10)
    .describe('When an assistant proposes a change, the person has this many minutes to say yes before the question lapses and nothing is done. Default 10.'),
  /** Plugs whose tools are offered to assistants here. Empty by default: the venue turns a plug on. */
  enabled_plugs: z
    .array(z.string().trim().min(1).max(60).describe('The key of one connected service, as shown on the Connections page.'))
    .max(50)
    .default([])
    .describe('Connected services (plugs) whose tools the assistant may use at this venue, by the key shown on the Connections page, e.g. "criota". Default: none; the venue switches each one on.'),
  /** Whether this venue's campaign outcomes (totals only) may be released to Criota. Off by default. */
  criota_share_enabled: z
    .boolean()
    .default(false)
    .describe('Whether the results of this venue\'s creator campaigns may be released to Criota. Totals only, never anything about one guest. Default off.'),
  /** No figure is released for a cohort smaller than this. */
  criota_min_cohort: z
    .number()
    .int()
    .min(CRIOTA_MIN_COHORT_FLOOR)
    .max(1000)
    .default(10)
    .describe('No figure is released to Criota that covers fewer guests than this, so a number can never point at one person. At least 5. Default 10.'),
  /** Hosted agents switched on here, and how far each may go (hub/hosted.ts agentMode; unlisted = off, listed = shadow until raised). */
  hosted_agents: z
    .array(z.string().trim().min(1).max(60).describe('The key of one agent Pipedline runs, e.g. "weekly_digest".'))
    .max(20)
    .default([])
    .describe('The agents Pipedline runs for the venue that are switched on here, by key, e.g. "weekly_digest", "ops_watch", "review_replier". One not listed is off. One listed starts in shadow mode (it reports what it would do and changes nothing) until autonomy_level_per_agent raises it. Default: none.'),
  autonomy_level_per_agent: z
    .record(z.string().describe('An agent\'s key, as listed in hosted_agents.'), z.enum(AUTONOMY_LEVELS).describe('"shadow", "supervised" or "autonomous".'))
    .default({})
    .describe('How far each switched-on agent may go, by its key: "shadow" (works things out and reports, changes nothing), "supervised" (asks a person before each change) or "autonomous" (makes the changes it is allowed to without asking). An agent never goes further than its own ceiling. Default: shadow for every listed agent.'),
  /** A paid order nobody has accepted after this many minutes is reported as needing attention (hub/ops.ts). */
  ops_order_waiting_minutes: z
    .number()
    .int()
    .min(1)
    .max(240)
    .default(10)
    .describe('A paid order nobody has accepted after this many minutes is reported as needing attention. Default 10.'),
  /** "No sales yet today" is reported only when the same weekday usually has at least this many sales by the same time. */
  ops_quiet_min_usual_sales: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(3)
    .describe('"No sales yet today" is reported mid-service only when this weekday has usually had at least this many sales by the same time. Default 3.'),
});
export type HubConfig = z.infer<typeof hubConfig>;

/** Org-level settings (orgs.settings.hub): limits that belong to the whole organisation, not one venue. */
export const hubOrgSettings = z.object({
  calls_per_key_per_minute: z
    .number()
    .int()
    .min(1)
    .max(6000)
    .default(120)
    .describe('The most requests one access key or assistant sign-in may make in a minute, across all venues. Beyond it the assistant is asked to wait. Default 120.'),
  calls_per_org_per_minute: z
    .number()
    .int()
    .min(1)
    .max(60000)
    .default(600)
    .describe('The most requests all of the organisation\'s assistants together may make in a minute. Default 600.'),
});
export type HubOrgSettings = z.infer<typeof hubOrgSettings>;
export const HUB_SETTINGS_NAMESPACE = 'hub';

/** Org-level limits on the hosted agents (orgs.settings.hosted_agents). */
export const hostedAgentSettings = z.object({
  /**
   * How many changes the hosted agents may propose or make for this organisation in one of its
   * own calendar days, all agents and venues together. At the cap an agent still reads and
   * reports; it proposes nothing more until tomorrow. 0 stops every hosted action.
   */
  actions_per_day: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(20)
    .describe('How many changes the agents Pipedline runs may propose or make for the whole organisation in one of its calendar days, all agents and venues together. At the cap an agent still reads and reports but proposes nothing more until tomorrow. 0 stops every agent action. Default 20.'),
  /** How long a hosted agent's proposal waits for a person before it lapses and nothing is done. */
  approval_ttl_hours: z
    .number()
    .int()
    .min(1)
    .max(336)
    .default(48)
    .describe('How long a change proposed by an agent waits for a person to approve it before it lapses and nothing is done, in hours. Default 48.'),
});
export type HostedAgentSettings = z.infer<typeof hostedAgentSettings>;
export const HOSTED_SETTINGS_NAMESPACE = 'hosted_agents';

export const hubModule = defineModule({
  key: 'hub',
  name: 'Assistant access and plugs',
  description: 'The MCP server, assistant keys, confirmed writes, the plug gateway and hosted agents.',
  dependsOn: [],
  manifest: {
    name: 'Assistant access and plugs',
    purpose: 'Lets the venue\'s own AI assistant connect, with an access key or a sign-in, and act with the role of the person behind it: every change asks that person first and is logged. Also where a connected service\'s tools are offered to the assistant, and where hosted agents run.',
    category: 'setup',
    kind: 'module',
    needs: ['Nothing to connect. The owner creates an access key, or signs the assistant in, from the console.'],
    reads: ['whatever the person behind the key may read, with their role and nothing more'],
    writes: ['a log of every call and every change', 'confirmations', 'hosted agents\' runs'],
    consent: 'Guest-level reads are off until the venue switches them on. Nothing leaves the venue to a connected service except campaign totals the venue chose to share, never anything per guest.',
  },
  // What an assistant may see and do is decided here, so it is never an assistant that decides it.
  assistantConfigurable: false,
  tables: ['agent_keys', 'agent_calls', 'agent_confirmations', 'plug_reviews', 'agent_runs', 'agent_oauth_clients', 'agent_oauth_codes', 'agent_oauth_tokens', 'llm_usage', 'home_dismissals', 'home_suggestion_decisions'],
  configSchema: hubConfig,
  configVersion: 1,
  defaultConfig: hubConfig.parse({}),
});
