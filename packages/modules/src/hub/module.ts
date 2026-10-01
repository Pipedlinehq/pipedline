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
  agent_access_enabled: z.boolean().default(true),
  /** Scopes a key may use here. '*' is everything; 'sales:*' and '*:read' match by part. */
  allowed_scopes: z.array(z.string().trim().min(1).max(80)).max(100).default(['*']),
  /** Guest-level reads (`guests:*` scopes) are off until the venue switches them on, whatever allowed_scopes says. */
  guest_level_reads_enabled: z.boolean().default(false),
  max_keys_per_staff: z.number().int().min(0).max(50).default(5),
  key_max_lifetime_days: z.number().int().min(1).max(365).default(90),
  /** How long a question stays answerable. What goes stale inside the window is caught anyway: the question is rebuilt. */
  write_confirmation_ttl_minutes: z.number().int().min(1).max(60).default(10),
  /** Plugs whose tools are offered to assistants here. Empty by default: the venue turns a plug on. */
  enabled_plugs: z.array(z.string().trim().min(1).max(60)).max(50).default([]),
  /** Whether this venue's campaign outcomes (totals only) may be released to Criota. Off by default. */
  criota_share_enabled: z.boolean().default(false),
  /** No figure is released for a cohort smaller than this. */
  criota_min_cohort: z.number().int().min(CRIOTA_MIN_COHORT_FLOOR).max(1000).default(10),
  /** Hosted agents switched on here, and how far each may go (hub/hosted.ts agentMode; unlisted = off, listed = shadow until raised). */
  hosted_agents: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  autonomy_level_per_agent: z.record(z.string(), z.enum(AUTONOMY_LEVELS)).default({}),
  /** A paid order nobody has accepted after this many minutes is reported as needing attention (hub/ops.ts). */
  ops_order_waiting_minutes: z.number().int().min(1).max(240).default(10),
  /** "No sales yet today" is reported only when the same weekday usually has at least this many sales by the same time. */
  ops_quiet_min_usual_sales: z.number().int().min(1).max(10000).default(3),
});
export type HubConfig = z.infer<typeof hubConfig>;

/** Org-level settings (orgs.settings.hub): limits that belong to the whole organisation, not one venue. */
export const hubOrgSettings = z.object({
  calls_per_key_per_minute: z.number().int().min(1).max(6000).default(120),
  calls_per_org_per_minute: z.number().int().min(1).max(60000).default(600),
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
  actions_per_day: z.number().int().min(0).max(1000).default(20),
  /** How long a hosted agent's proposal waits for a person before it lapses and nothing is done. */
  approval_ttl_hours: z.number().int().min(1).max(336).default(48),
});
export type HostedAgentSettings = z.infer<typeof hostedAgentSettings>;
export const HOSTED_SETTINGS_NAMESPACE = 'hosted_agents';

export const hubModule = defineModule({
  key: 'hub',
  name: 'Assistant access and plugs',
  description: 'The MCP server, assistant keys, confirmed writes, the plug gateway and hosted agents.',
  dependsOn: [],
  // What an assistant may see and do is decided here, so it is never an assistant that decides it.
  assistantConfigurable: false,
  tables: ['agent_keys', 'agent_calls', 'agent_confirmations', 'plug_reviews', 'agent_runs', 'agent_oauth_clients', 'agent_oauth_codes', 'agent_oauth_tokens', 'llm_usage'],
  configSchema: hubConfig,
  configVersion: 1,
  defaultConfig: hubConfig.parse({}),
});
