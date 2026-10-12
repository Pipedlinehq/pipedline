import { z } from 'zod';
import { type ConnectionRow, type Ctx, getModule, getPlug, listConnections, notFound, requireStaff, sql } from '@ros/core';
import { pluginCatalogueForVenue, type VenueCatalogueEntry } from '../tenancy/plugin-catalogue';
import { hubModule } from './module';
import { plugNamespace } from './plugs';

/**
 * One plugin's page (docs/CONSOLE_IA.md section 9, pattern 14): the catalogue entry (what it reads
 * and writes, the tools it adds, its settings), its connections and their health, when each tool
 * was last used (from `agent_calls`, which holds which tool and how it went and never the
 * arguments), a note when a connected service has done nothing for 30 days, and for a service
 * somebody else runs, what leaves the venue in plain words.
 */
export const IDLE_AFTER_DAYS = 30;

export interface ToolUsage {
  name: string;
  effect: 'read' | 'write';
  description: string;
  lastUsedAt: Date | null;
  lastOutcome: string | null;
  /** Calls in the last 30 days. */
  calls30d: number;
}

export interface PlugConnectionView {
  id: string;
  venueId: string | null;
  status: ConnectionRow['status'];
  account: string;
  connectedAt: Date | null;
  lastOkAt: Date | null;
  lastError: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export interface PlugDetail {
  entry: VenueCatalogueEntry;
  tools: ToolUsage[];
  connections: PlugConnectionView[];
  /** The newest use of any kind: a tool call, or for a service that posts into the venue, its last successful read or write. */
  lastUsedAt: Date | null;
  /** Set when the plug is connected and has neither read nor written anything for IDLE_AFTER_DAYS. */
  idleNote: string | null;
  /** For a connected service: what leaves the venue, in plain words. Empty for the venue's own modules. */
  dataLeaves: string[];
  /** For a remote assistant plug: whether this venue offers its tools to assistants. */
  offeredToAssistantsHere: boolean | null;
}

/** What crosses to each connected service, for its page. Written for an owner; the plug's scopes say the rest. */
const DATA_LEAVES: Record<string, string[]> = {
  criota: [
    'Per-venue campaign outcomes only: visits, new guests, orders and spend as a band, for each campaign, and only for a venue that has switched sharing on.',
    'Never a figure for fewer guests than the venue\'s minimum, so a number can never point at one person.',
    'Never a guest record, a name, a contact detail or a card identifier. Outcomes are never joined across venues.',
  ],
  'criota-sim': ['The same as Criota: per-venue campaign totals above the minimum group size, never anything about one guest. This is the simulated service for development.'],
  square: ['Nothing of the venue\'s own records goes to Square: Square posts sales into the ledger, and when online ordering sends orders to the till, those orders and their payments.'],
  'square-sim': ['The same as Square: sales come in; orders and payments go out when online ordering uses the till. This is the simulated point of sale for development.'],
  klaviyo: ['Guest profiles and their consents, for guests who said yes to marketing email, so the venue\'s own email platform can send to them.', 'Opt-outs in both directions. Never a card identifier.'],
  'sim-esp': ['The same as a connected email platform: marketing-consented guest profiles and consents. Simulated, for development.'],
  'meta-capi': ['For guests who ticked the ad-platform box: a hashed email or phone and the purchase total, so an ad platform can count a sale it was aligned with. Nothing readable, nothing for guests who did not tick it.'],
  'sim-ads': ['The same as an ad platform: hashed contact details and purchase totals for consenting guests only. Simulated, for development.'],
};

const GENERIC_LEAVES = {
  mcp: ['Only what the assistant sends it when it uses one of the service\'s tools, after you say yes. It cannot read the venue\'s records on its own.'],
  other: ['What the connection was granted (see its access below), and nothing per guest unless the guest agreed to it.'],
};

/** A plugin's page. Manager and above at the venue; a key that is not in the catalogue, or another org's venue, is not found. */
export async function plugDetail(ctx: Ctx, raw: { venueId: string; key: string }): Promise<PlugDetail> {
  const { venueId, key } = z.object({ venueId: z.string().uuid(), key: z.string().trim().min(1).max(80) }).parse(raw);
  requireStaff(ctx, { venueId, minRole: 'manager' });
  const catalogue = await pluginCatalogueForVenue(ctx, venueId);
  const entry = catalogue.plugins.find((p) => p.key === key);
  if (!entry) throw notFound('Plugin not found');
  const now = ctx.now();
  const since = new Date(now.getTime() - IDLE_AFTER_DAYS * 86_400_000);
  const isPlug = entry.kind === 'plug';

  // Tool usage from the call log: the venue's own tools are recorded under 'os' by name; a service's under its key as `<namespace>__<tool>`.
  const toolNames = isPlug ? [] : entry.tools.map((t) => t.name);
  const usageRows = isPlug
    ? await ctx.db
        .selectFrom('agent_calls')
        .select((eb) => ['tool', eb.fn.max('occurred_at').as('last_at'), eb.fn.countAll<number>().filterWhere('occurred_at', '>=', since).as('n30')])
        .where('plug_key', '=', key)
        .groupBy('tool')
        .execute()
    : toolNames.length
      ? await ctx.db
          .selectFrom('agent_calls')
          .select((eb) => ['tool', eb.fn.max('occurred_at').as('last_at'), eb.fn.countAll<number>().filterWhere('occurred_at', '>=', since).as('n30')])
          .where('plug_key', '=', 'os')
          .where('tool', 'in', toolNames)
          .groupBy('tool')
          .execute()
      : [];
  const lastOutcomes = usageRows.length
    ? await sql<{ tool: string; outcome: string }>`
        select distinct on (tool) tool, outcome from agent_calls
        where org_id = ${ctx.orgId} and plug_key = ${isPlug ? key : 'os'} and tool = any(${usageRows.map((r) => r.tool)}::text[])
        order by tool, occurred_at desc`.execute(ctx.db)
    : { rows: [] as Array<{ tool: string; outcome: string }> };
  const outcomeOf = new Map(lastOutcomes.rows.map((r) => [r.tool, r.outcome]));
  const usage = new Map(usageRows.map((r) => [r.tool, { lastAt: r.last_at ? new Date(r.last_at as unknown as string) : null, n30: Number(r.n30) }]));
  const ns = isPlug ? plugNamespace(key) : null;
  const tools: ToolUsage[] = isPlug
    ? [...usage.keys()].sort().map((name) => ({ name, effect: 'read' as const, description: `A tool of ${entry.name}, named ${name.replace(`${ns}__`, '')} there.`, lastUsedAt: usage.get(name)!.lastAt, lastOutcome: outcomeOf.get(name) ?? null, calls30d: usage.get(name)!.n30 }))
    : entry.tools.map((t) => ({ name: t.name, effect: t.effect, description: t.description, lastUsedAt: usage.get(t.name)?.lastAt ?? null, lastOutcome: outcomeOf.get(t.name) ?? null, calls30d: usage.get(t.name)?.n30 ?? 0 }));

  // Connections, for a service somebody else runs.
  const rows = isPlug ? (await listConnections(ctx, { venueId })).filter((c) => c.plug_key === key) : [];
  const connections: PlugConnectionView[] = rows.map((c) => ({ id: c.id, venueId: c.venue_id, status: c.status, account: c.external_account_id, connectedAt: c.connected_at, lastOkAt: c.last_ok_at, lastError: c.last_error, expiresAt: c.expires_at, scopes: c.scopes }));
  const live = connections.filter((c) => c.status === 'connected' || c.status === 'unhealthy');

  let plugKind: 'mcp' | 'other' | null = null;
  if (isPlug) {
    try {
      plugKind = getPlug(key).kind === 'mcp' ? 'mcp' : 'other';
    } catch {
      plugKind = 'other';
    }
  }
  // A health check is not a use. For a service that posts into the venue (a till, an email platform), its last successful run is.
  const lastCall = tools.reduce<Date | null>((m, t) => (t.lastUsedAt && (!m || t.lastUsedAt > m) ? t.lastUsedAt : m), null);
  const lastPost = plugKind === 'other' ? live.reduce<Date | null>((m, c) => (c.lastOkAt && (!m || c.lastOkAt > m) ? c.lastOkAt : m), null) : null;
  const lastUsedAt = [lastCall, lastPost].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  let idleNote: string | null = null;
  if (isPlug && live.length) {
    const connectedAt = live.reduce<Date | null>((m, c) => (c.connectedAt && (!m || c.connectedAt < m) ? c.connectedAt : m), null);
    const idleSince = lastUsedAt ?? connectedAt;
    if (idleSince && idleSince <= since) {
      idleNote = `${entry.name} has not read or written anything in ${IDLE_AFTER_DAYS} days. If the venue no longer uses it, disconnect it: its access ends and nothing else changes.`;
    }
  }

  let offeredToAssistantsHere: boolean | null = null;
  if (plugKind === 'mcp') {
    const hub = await getModule(ctx, venueId, hubModule);
    offeredToAssistantsHere = hub.enabled && hub.config.enabled_plugs.includes(key);
  }

  return {
    entry,
    tools,
    connections,
    lastUsedAt,
    idleNote,
    dataLeaves: isPlug ? (DATA_LEAVES[key] ?? GENERIC_LEAVES[plugKind ?? 'other']) : [],
    offeredToAssistantsHere,
  };
}
