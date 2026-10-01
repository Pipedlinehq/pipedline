import type { App, Ctx } from './app';
import { requireStaff } from './authz';
import { audit } from './audit';
import { AppError, invalid, notFound } from './errors';
import { json } from './json';
import { hookList, keyedRegistry, register } from './registry';
import type { AdapterKinds } from './ports/registry';
import type { ConnectionHandle } from './ports/connection';

/**
 * The plug catalogue and a venue's connections to it. One table holds every connected
 * service, so there is one health view, one re-auth flow and one place to revoke.
 * docs/modules/hub.md sections 4 and 6.
 */
export interface PlugDef {
  key: string;
  name: string;
  description: string;
  /** 'adapter' = we call its API through a port. 'mcp' = a remote MCP server behind the gateway. */
  kind: 'adapter' | 'mcp';
  tier: 'first_party' | 'curated' | 'community';
  /** The adapter this plug supplies for each port it implements. */
  adapters: Partial<Record<keyof AdapterKinds, string>>;
  auth: 'oauth' | 'api_key' | 'none';
  /** Scopes this plug may be granted. A connection holds a subset the owner approved. */
  scopes: string[];
  /** True when a connection belongs to one venue (a POS location) rather than the whole org. */
  venueScoped: boolean;
  /** For simulated providers used in development and tests. Never offered in production. */
  simulated?: boolean;
}

const plugs = keyedRegistry<PlugDef>('plugs');

export function definePlug(def: PlugDef): PlugDef {
  return register(plugs, def.key, def, 'Plug');
}

export function getPlug(key: string): PlugDef {
  const p = plugs.get(key);
  if (!p) throw new AppError('not_found', 'That service is not in the catalogue.');
  return p;
}

export function listPlugs(): PlugDef[] {
  return [...plugs.values()];
}

export interface ConnectionRow {
  id: string;
  org_id: string;
  venue_id: string | null;
  plug_key: string;
  status: 'pending' | 'connected' | 'unhealthy' | 'revoked';
  scopes: string[];
  secret_ref: string | null;
  external_account_id: string;
  config: unknown;
  connected_at: Date | null;
  last_ok_at: Date | null;
  last_error: string | null;
  expires_at: Date | null;
}

const COLUMNS = [
  'id',
  'org_id',
  'venue_id',
  'plug_key',
  'status',
  'scopes',
  'secret_ref',
  'external_account_id',
  'config',
  'connected_at',
  'last_ok_at',
  'last_error',
  'expires_at',
] as const;

export interface ConnectInput {
  plugKey: string;
  venueId?: string | null;
  externalAccountId: string;
  scopes?: string[];
  /** Provider tokens and keys. Sealed in the secret store; never written to the connection row. */
  credentials: Record<string, string>;
  config?: Record<string, unknown>;
  expiresAt?: Date | null;
}

/** Create or refresh a connection. Managers may connect a venue's services; org-level plugs need an owner. */
export async function connect(ctx: Ctx, input: ConnectInput): Promise<ConnectionRow> {
  const plug = getPlug(input.plugKey);
  if (plug.simulated && ctx.app.config.env === 'production') throw notFound('That service is not in the catalogue.');
  if (plug.venueScoped && !input.venueId) throw invalid(`${plug.name} connects to one venue. Choose the venue.`);
  const staff = requireStaff(ctx, { venueId: input.venueId ?? undefined, minRole: 'manager' });
  const scopes = input.scopes ?? plug.scopes;
  const unknown = scopes.filter((s) => !plug.scopes.includes(s));
  if (unknown.length) throw invalid(`${plug.name} cannot be granted: ${unknown.join(', ')}`);

  const existing = await ctx.db
    .selectFrom('connections')
    .select(COLUMNS)
    .where('plug_key', '=', plug.key)
    .where('external_account_id', '=', input.externalAccountId)
    .where((eb) => (input.venueId ? eb('venue_id', '=', input.venueId) : eb('venue_id', 'is', null)))
    .executeTakeFirst();

  const sealed = JSON.stringify(input.credentials);
  let secretRef = existing?.secret_ref ?? null;
  if (secretRef) await ctx.app.secrets.replace(ctx.orgId, secretRef, sealed);
  else secretRef = await ctx.app.secrets.put(ctx.orgId, `conn:${plug.key}`, sealed);

  const values = {
    status: 'connected' as const,
    scopes,
    secret_ref: secretRef,
    config: json(input.config ?? {}),
    connected_by_staff_id: staff?.staffId ?? null,
    connected_at: ctx.now(),
    last_ok_at: ctx.now(),
    last_error: null,
    expires_at: input.expiresAt ?? null,
  };

  const row = existing
    ? await ctx.db.updateTable('connections').set(values).where('id', '=', existing.id).returning(COLUMNS).executeTakeFirstOrThrow()
    : await ctx.db
        .insertInto('connections')
        .values({
          org_id: ctx.orgId,
          venue_id: input.venueId ?? null,
          plug_key: plug.key,
          external_account_id: input.externalAccountId,
          ...values,
        })
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();

  await audit(ctx, {
    action: existing ? 'connection.refreshed' : 'connection.created',
    entityType: 'connection',
    entityId: row.id,
    venueId: row.venue_id,
    after: { plug: plug.key, scopes, externalAccountId: input.externalAccountId },
  });
  return row;
}

export async function listConnections(ctx: Ctx, filter: { venueId?: string; plugKey?: string } = {}): Promise<ConnectionRow[]> {
  requireStaff(ctx, { venueId: filter.venueId });
  let q = ctx.db.selectFrom('connections').select(COLUMNS).orderBy('plug_key');
  if (filter.plugKey) q = q.where('plug_key', '=', filter.plugKey);
  if (filter.venueId) q = q.where((eb) => eb.or([eb('venue_id', '=', filter.venueId!), eb('venue_id', 'is', null)]));
  return q.execute();
}

/**
 * The live connection that supplies `kind` for a venue, or null. A venue-level connection wins
 * over an org-level one. No role check: modules call this while serving guests.
 */
export async function findConnectionFor(ctx: Ctx, kind: keyof AdapterKinds, venueId: string | null): Promise<ConnectionRow | null> {
  const keys = listPlugs()
    .filter((p) => p.adapters[kind])
    .map((p) => p.key);
  if (!keys.length) return null;
  const rows = await ctx.db
    .selectFrom('connections')
    .select(COLUMNS)
    .where('plug_key', 'in', keys)
    .where('status', '=', 'connected')
    .where((eb) => (venueId ? eb.or([eb('venue_id', '=', venueId), eb('venue_id', 'is', null)]) : eb('venue_id', 'is', null)))
    .execute();
  return rows.find((r) => r.venue_id === venueId) ?? rows[0] ?? null;
}

/** Runs inside the transaction that revokes a connection, so whatever depended on it ends with it. */
export type ConnectionRevokedHook = (ctx: Ctx, connection: ConnectionRow) => Promise<void>;
const revokedHooks = hookList<ConnectionRevokedHook>('connections.revoked');
export function onConnectionRevoked(fn: ConnectionRevokedHook): void {
  revokedHooks.add(fn);
}

export async function revokeConnection(ctx: Ctx, connectionId: string): Promise<void> {
  const row = await ctx.db.selectFrom('connections').select(COLUMNS).where('id', '=', connectionId).executeTakeFirst();
  if (!row) throw notFound('Connection not found');
  requireStaff(ctx, { venueId: row.venue_id ?? undefined, minRole: 'manager' });
  await ctx.db.updateTable('connections').set({ status: 'revoked', secret_ref: null }).where('id', '=', connectionId).execute();
  for (const hook of revokedHooks.all()) await hook(ctx, row);
  if (row.secret_ref) {
    // The secret store writes on its own database connection. Until this transaction commits,
    // the stored row still points at the secret and the delete is refused by the foreign key,
    // so the secret is removed once the revocation is committed.
    const ref = row.secret_ref;
    const { app, orgId } = ctx;
    ctx.afterCommit(() => app.secrets.remove(orgId, ref));
  }
  await audit(ctx, { action: 'connection.revoked', entityType: 'connection', entityId: connectionId, venueId: row.venue_id });
}

/** Resolve a connection row to something an adapter can use. Call outside a tenant transaction. */
export async function resolveConnection(app: App, row: ConnectionRow): Promise<ConnectionHandle> {
  if (row.status === 'revoked' || !row.secret_ref) {
    throw new AppError('unavailable', 'That service is not connected.');
  }
  const credentials = JSON.parse(await app.secrets.get(row.org_id, row.secret_ref)) as Record<string, string>;
  return {
    id: row.id,
    orgId: row.org_id,
    venueId: row.venue_id,
    plugKey: row.plug_key,
    externalAccountId: row.external_account_id,
    scopes: row.scopes,
    config: (row.config ?? {}) as Record<string, unknown>,
    credentials,
  };
}

/** The adapter a connection's plug supplies for a port. */
export function adapterFor<K extends keyof AdapterKinds>(app: App, kind: K, row: Pick<ConnectionRow, 'plug_key'>): AdapterKinds[K] {
  const key = getPlug(row.plug_key).adapters[kind];
  if (!key) throw new AppError('unavailable', `That service does not provide ${String(kind)}.`);
  return app.adapters.get(kind, key);
}

/** Webhooks arrive before we know the org: find the connection by the provider's account id. */
export async function findConnectionByAccount(app: App, plugKey: string, externalAccountId: string): Promise<ConnectionRow | null> {
  const row = await app.db
    .selectFrom('connections')
    .select(COLUMNS)
    .where('plug_key', '=', plugKey)
    .where('external_account_id', '=', externalAccountId)
    .where('status', 'in', ['connected', 'unhealthy'])
    .executeTakeFirst();
  return row ?? null;
}

export async function markConnectionHealth(app: App, connectionId: string, outcome: { ok: true } | { ok: false; error: string }): Promise<void> {
  await app.db
    .updateTable('connections')
    .set(
      outcome.ok
        ? { status: 'connected', last_ok_at: app.clock(), last_error: null }
        : { status: 'unhealthy', last_error: outcome.error.slice(0, 500) },
    )
    .where('id', '=', connectionId)
    .where('status', '!=', 'revoked')
    .execute();
}

/**
 * Replace a live connection's sealed credentials, e.g. with a renewed OAuth token, and mark it
 * healthy. Platform-level like markConnectionHealth: a worker calls it between transactions,
 * for a connection it loaded inside the owning org. A revoked connection is left alone.
 */
export async function updateConnectionCredentials(
  app: App,
  row: Pick<ConnectionRow, 'id' | 'org_id' | 'secret_ref' | 'status'>,
  args: { credentials: Record<string, string>; expiresAt: Date | null },
): Promise<void> {
  if (row.status === 'revoked' || !row.secret_ref) throw new AppError('unavailable', 'That service is not connected.');
  await app.secrets.replace(row.org_id, row.secret_ref, JSON.stringify(args.credentials));
  await app.db
    .updateTable('connections')
    .set({ status: 'connected', expires_at: args.expiresAt, last_ok_at: app.clock(), last_error: null })
    .where('id', '=', row.id)
    .where('status', '!=', 'revoked')
    .execute();
}
