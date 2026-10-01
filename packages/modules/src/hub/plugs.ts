import {
  type App,
  type ConnectionRow,
  type Ctx,
  type PlugDef,
  type RemoteMcpTool,
  adapterFor,
  definePlug,
  digestOf,
  getModule,
  getPlug,
  invalid,
  json,
  listPlugs,
  notFound,
  resolveConnection,
} from '@ros/core';
import { CRIOTA_MIN_COHORT_FLOOR, hubModule } from './module';

/**
 * Remote MCP plugs: services a venue connects, whose tools the gateway offers through OUR
 * server (docs/modules/hub.md sections 6 and 7). The catalogue is `definePlug` in core; a plug
 * of kind `mcp` names the `remote_mcp` adapter that speaks to it. The remote server's address
 * belongs to that adapter, registered at the composition root: a connection holds only the
 * access key the venue was given by the service.
 */
export const criotaPlug = definePlug({
  key: 'criota',
  name: 'Criota',
  description: 'Creator campaigns for the venue: campaigns, applications, drafts to review and results, from the venue\'s own Criota account.',
  kind: 'mcp',
  tier: 'first_party',
  adapters: { remote_mcp: 'criota' },
  auth: 'api_key',
  scopes: ['read', 'write'],
  // One Criota account for the organisation; a venue switches its tools on in `enabled_plugs`.
  venueScoped: false,
});

export const criotaSimPlug = definePlug({
  key: 'criota-sim',
  name: 'Criota (simulated)',
  description: 'A simulated Criota account, for development and tests. Never offered in production.',
  kind: 'mcp',
  tier: 'first_party',
  adapters: { remote_mcp: 'criota-sim' },
  auth: 'api_key',
  scopes: ['read', 'write'],
  venueScoped: false,
  simulated: true,
});

/** Plugs that are Criota, real or simulated: the ones the outcomes boundary is about. */
const CRIOTA_PLUGS = [criotaPlug.key, criotaSimPlug.key];

/** Whether a plug key is Criota's (the only service outcomes are ever released to). */
export function isCriotaPlug(plugKey: string): boolean {
  return CRIOTA_PLUGS.includes(plugKey);
}

export function mcpPlugs(app: App): PlugDef[] {
  return listPlugs().filter((p) => p.kind === 'mcp' && !!p.adapters.remote_mcp && !(p.simulated && app.config.env === 'production'));
}

/** How a plug's tools are named on our server: `<namespace>__<tool>`. */
export function plugNamespace(plugKey: string): string {
  return plugKey.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

// ── Pinning the tool list ────────────────────────────────────────────────────

export interface PinnedTool extends RemoteMcpTool {
  digest: string;
}

export interface PlugReview {
  plugKey: string;
  toolsDigest: string;
  tools: PinnedTool[];
  reviewedBy: string;
  reviewedAt: Date;
}

/**
 * The digest of everything about a tool that an assistant reads or that decides how the gateway
 * treats it: its name, title, description (the words an assistant obeys), its argument and
 * answer shapes, and its hints (read-only decides whether we ask first).
 */
export function toolDigest(t: RemoteMcpTool): string {
  return digestOf({
    name: t.name,
    title: t.title ?? null,
    description: t.description ?? null,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null,
  });
}

export function toolListDigest(tools: RemoteMcpTool[]): string {
  return digestOf(
    [...tools]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((t) => [t.name, toolDigest(t)]),
  );
}

function reviewFrom(row: { plug_key: string; tools_digest: string; tool_list: unknown; reviewed_by: string; reviewed_at: Date }): PlugReview {
  const list = (Array.isArray(row.tool_list) ? row.tool_list : []) as PinnedTool[];
  return { plugKey: row.plug_key, toolsDigest: row.tools_digest, tools: list, reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at };
}

/** The reviewed tool list of each of these plugs. Every org may read it; only the platform writes it. */
export async function plugReviews(ctx: Ctx, plugKeys: string[]): Promise<Map<string, PlugReview>> {
  const out = new Map<string, PlugReview>();
  if (!plugKeys.length) return out;
  const rows = await ctx.db.selectFrom('plug_reviews').selectAll().where('plug_key', 'in', plugKeys).execute();
  for (const r of rows) out.set(r.plug_key, reviewFrom(r));
  return out;
}

/**
 * How a live tool list stands against the reviewed one. It is `pinned` only when every tool the
 * service offers now is one that was reviewed, word for word. A tool that is new, or whose
 * description, shape or hints differ, makes it `changed`, and the gateway withdraws ALL of the
 * plug's tools until someone reviews it again. A connection that is offered fewer tools than
 * were reviewed (its key was given less at the service) is still pinned: nothing unreviewed is
 * on offer.
 */
export function checkPinned(review: PlugReview | undefined, live: RemoteMcpTool[]): { state: 'pinned' } | { state: 'not_reviewed' } | { state: 'changed'; tools: string[] } {
  if (!review) return { state: 'not_reviewed' };
  const reviewed = new Map(review.tools.map((t) => [t.name, t.digest]));
  const differing = live.filter((t) => reviewed.get(t.name) !== toolDigest(t)).map((t) => t.name);
  return differing.length ? { state: 'changed', tools: differing } : { state: 'pinned' };
}

export interface ReviewPlugInput {
  plugKey: string;
  /** Who read the list and stands behind it. */
  reviewedBy: string;
  /** The list that was read. Omit to read it now through a connection. */
  tools?: RemoteMcpTool[];
  /** The connection to read the live list through, when `tools` is not given. */
  from?: { orgId: string; connectionId: string };
}

/** The live tool list of a plug, read through one connection. A provider call: never inside a transaction. */
export async function fetchLiveTools(app: App, orgId: string, connectionId: string): Promise<RemoteMcpTool[]> {
  // Platform code acting on a named connection (a review, a health check): read outside a tenant.
  const row = await app.db
    .selectFrom('connections')
    .select(['id', 'org_id', 'venue_id', 'plug_key', 'status', 'scopes', 'secret_ref', 'external_account_id', 'config', 'connected_at', 'last_ok_at', 'last_error', 'expires_at'])
    .where('id', '=', connectionId)
    .where('org_id', '=', orgId)
    .executeTakeFirst();
  if (!row) throw notFound('Connection not found');
  const handle = await resolveConnection(app, row);
  return adapterFor(app, 'remote_mcp', row).listTools(handle);
}

/**
 * PLATFORM: record that a person read a plug's tool list and accepts it. Until this is called a
 * plug's tools are not offered to anyone, and after the service changes any of them they are
 * withdrawn until it is called again. Not a venue's decision: it is ours, for every venue.
 */
export async function reviewPlug(app: App, input: ReviewPlugInput): Promise<PlugReview> {
  const plug = getPlug(input.plugKey);
  if (plug.kind !== 'mcp') throw invalid(`${plug.name} has no remote tool list to review.`);
  if (!input.reviewedBy.trim()) throw invalid('Say who reviewed it.');
  const live = input.tools ?? (input.from ? await fetchLiveTools(app, input.from.orgId, input.from.connectionId) : null);
  if (!live) throw invalid('Give the tool list that was reviewed, or a connection to read it through.');
  const tools: PinnedTool[] = live.map((t) => ({ ...t, digest: toolDigest(t) }));
  const toolsDigest = toolListDigest(live);
  return app.platform('hub: plug tool list reviewed', async (pctx) => {
    const row = await pctx.db
      .insertInto('plug_reviews')
      .values({ plug_key: plug.key, tools_digest: toolsDigest, tool_list: json(tools), reviewed_by: input.reviewedBy.trim(), reviewed_at: pctx.now() })
      .onConflict((oc) => oc.column('plug_key').doUpdateSet({ tools_digest: toolsDigest, tool_list: json(tools), reviewed_by: input.reviewedBy.trim(), reviewed_at: pctx.now() }))
      .returningAll()
      .executeTakeFirstOrThrow();
    return reviewFrom(row);
  });
}

// ── The Criota boundary (docs/modules/hub.md section 7) ─────────────────────

export interface CriotaSharing {
  /** Whether this venue's campaign outcomes may be released to Criota at all. */
  enabled: boolean;
  /** No figure is released for fewer guests than this. */
  minCohort: number;
  /** Outcomes are released per venue and never joined across venues. */
  scope: 'venue';
}

/**
 * What may cross to Criota for one venue. Whoever builds the outcomes (analytics) asks this
 * first and releases nothing when `enabled` is false, and nothing below `minCohort`.
 *
 * It is on only when the venue switched sharing on AND the organisation has a live Criota
 * connection: a venue that came in through the channel is not sharing by default. Nothing
 * guest-level ever crosses, whatever this says: totals and bands per campaign, for this venue.
 */
export async function criotaSharing(ctx: Ctx, venueId: string): Promise<CriotaSharing> {
  const state = await getModule(ctx, venueId, hubModule);
  const minCohort = Math.max(CRIOTA_MIN_COHORT_FLOOR, state.config.criota_min_cohort);
  const off: CriotaSharing = { enabled: false, minCohort, scope: 'venue' };
  if (!state.enabled || !state.config.criota_share_enabled) return off;
  const keys = CRIOTA_PLUGS.filter((k) => !(getPlug(k).simulated && ctx.app.config.env === 'production'));
  const live = await ctx.db
    .selectFrom('connections')
    .select('id')
    .where('plug_key', 'in', keys)
    .where('status', '=', 'connected')
    .where((eb) => eb.or([eb('venue_id', 'is', null), eb('venue_id', '=', venueId)]))
    .executeTakeFirst();
  return live ? { enabled: true, minCohort, scope: 'venue' } : off;
}
