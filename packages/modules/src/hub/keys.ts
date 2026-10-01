import { z } from 'zod';
import {
  type AgentPrincipal,
  type App,
  AppError,
  type Ctx,
  type StaffPrincipal,
  type StaffRole,
  audit,
  conflict,
  forbidden,
  getModuleDef,
  getPlug,
  hashToken,
  onConnectionRevoked,
  invalid,
  newToken,
  notFound,
  requireStaff,
} from '@ros/core';
import { onStaffDisabled } from '../auth/staff';
import { staffPrincipal } from '../auth/sessions';
import { HUB_SETTINGS_NAMESPACE, type HubConfig, type HubOrgSettings, hubConfig, hubModule, hubOrgSettings } from './module';
import { knownScopes, scopeAllowed } from './scopes';
import { mcpResourceUrl } from './address';

/**
 * Assistant access keys (docs/modules/hub.md section 2.7). A key belongs to one staff member,
 * is shown once, stored only as a hash, expires, can be revoked, carries scopes and an optional
 * subset of venues, and reads unless an owner allowed it to make changes. It can never do more
 * than its staff member: every request rebuilds that person's roles from the database.
 *
 * NEVER select `key_hash` into a response or a log, and never log a key.
 */
export const AGENT_KEY_PREFIX = 'ros_agent';

export const createAgentKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
  /** A subset of the venues the staff member has a role at. Omit for every venue they can see, now and later. */
  venueIds: z.array(z.string().uuid()).min(1).max(200).nullish(),
  /** "Can make changes". Only an owner may tick it. Every change still waits for a yes. */
  canWrite: z.boolean().default(false),
  expiresInDays: z.number().int().min(1).max(365),
});
export type CreateAgentKeyInput = z.input<typeof createAgentKeyInput>;

export interface AgentKeyView {
  id: string;
  staffId: string;
  name: string;
  /** The start of the key, so it can be recognised in a list. Never enough to use it. */
  prefix: string;
  scopes: string[];
  venueIds: string[] | null;
  canWrite: boolean;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  status: 'active' | 'expired' | 'revoked';
  /** 'assistant', or 'service:<plug>' for a key made for a connected service. */
  audience: string;
  /** For a service key: the connection it was made for, and dies with. */
  connectionId: string | null;
  /** 'key' when pasted; 'oauth' when an assistant was signed in. */
  kind: 'key' | 'oauth';
  /** How the console labels it: "Assistant key", "Signed-in assistant", "Service key for Criota". */
  label: string;
}

const VIEW_COLS = ['id', 'staff_id', 'name', 'key_prefix', 'scopes', 'venue_ids', 'can_write', 'expires_at', 'last_used_at', 'revoked_at', 'created_at', 'audience', 'connection_id', 'kind'] as const;

interface KeyRow {
  id: string;
  staff_id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  venue_ids: string[] | null;
  can_write: boolean;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  audience: string;
  connection_id: string | null;
  kind: string;
}

/** The plug a service audience names, or null for a staff member's assistant. */
export function serviceOf(audience: string | null | undefined): string | null {
  return audience && audience.startsWith('service:') ? audience.slice('service:'.length) : null;
}

function labelFor(r: { audience: string; kind: string }): string {
  const plug = serviceOf(r.audience);
  if (plug) {
    let name = plug;
    try {
      name = getPlug(plug).name;
    } catch {
      // A plug no longer in the catalogue is named by its key.
    }
    return `Service key for ${name}`;
  }
  return r.kind === 'oauth' ? 'Signed-in assistant' : 'Assistant key';
}

const view = (r: KeyRow, now: Date): AgentKeyView => ({
  id: r.id,
  staffId: r.staff_id,
  name: r.name,
  prefix: r.key_prefix,
  scopes: r.scopes,
  venueIds: r.venue_ids,
  canWrite: r.can_write,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
  createdAt: r.created_at,
  status: r.revoked_at ? 'revoked' : r.expires_at <= now ? 'expired' : 'active',
  audience: r.audience,
  connectionId: r.connection_id,
  kind: r.kind === 'oauth' ? 'oauth' : 'key',
  label: labelFor(r),
});

/** Keys are managed by a person signed in to the console: never by an assistant, a screen or a job. */
function signedInStaff(ctx: Ctx): StaffPrincipal {
  if (ctx.principal.kind !== 'staff') throw forbidden('Access keys are managed from the console, by the person they belong to.');
  return ctx.principal;
}

/** The hub's state at each venue, in one query. A venue with no row reads as off. */
export async function hubStates(ctx: Ctx, venueIds: string[]): Promise<Map<string, { enabled: boolean; config: HubConfig }>> {
  const out = new Map<string, { enabled: boolean; config: HubConfig }>();
  for (const id of venueIds) out.set(id, { enabled: false, config: hubModule.defaultConfig });
  if (!venueIds.length) return out;
  const rows = await ctx.db.selectFrom('venue_modules').select(['venue_id', 'enabled', 'config']).where('module_key', '=', hubModule.key).where('venue_id', 'in', venueIds).execute();
  for (const r of rows) {
    const parsed = hubConfig.safeParse(r.config);
    // A stored config that no longer parses falls back to defaults, as getModule does.
    out.set(r.venue_id, { enabled: r.enabled, config: parsed.success ? parsed.data : hubModule.defaultConfig });
  }
  return out;
}

/**
 * Create a key for the person signed in. An owner or a manager may create one for themself;
 * only an owner may let it make changes. The key itself is in the return value and nowhere else.
 */
export async function createAgentKey(ctx: Ctx, raw: CreateAgentKeyInput): Promise<{ key: string; view: AgentKeyView }> {
  const input = createAgentKeyInput.parse(raw);
  const staff = signedInStaff(ctx);
  requireStaff(ctx, { minRole: 'manager' });

  const requested = input.venueIds ? [...new Set(input.venueIds)] : null;
  // A venue the person has no role at does not exist, as far as they are concerned.
  for (const id of requested ?? []) if (!staff.venueRoles[id]) throw notFound('Venue not found');
  const covered = requested ?? Object.keys(staff.venueRoles);

  const states = await hubStates(ctx, covered);
  const open = covered.filter((id) => states.get(id)!.enabled && states.get(id)!.config.agent_access_enabled);
  // Naming a venue where assistants are switched off is refused outright; "every venue" needs one that is on.
  if (!open.length || (requested && open.length !== requested.length)) {
    throw new AppError('module_disabled', 'Assistant access is not switched on at that venue.');
  }
  const configs = open.map((id) => states.get(id)!.config);

  if (input.canWrite && !staff.isOwner) throw forbidden('Only an owner can allow a key to make changes.');

  const scopes = [...new Set(input.scopes)].sort();
  const known = new Set(knownScopes(ctx.app));
  const unknown = scopes.filter((s) => !known.has(s));
  if (unknown.length) throw invalid(`Not a permission a key can hold: ${unknown.join(', ')}`);
  const blocked = scopes.filter((s) => !configs.some((c) => scopeAllowed(s, c)));
  if (blocked.length) throw invalid(`Not switched on for assistants at this venue: ${blocked.join(', ')}`);

  const maxDays = Math.min(...configs.map((c) => c.key_max_lifetime_days));
  if (input.expiresInDays > maxDays) throw invalid(`A key can last at most ${maxDays} days here.`);
  const now = ctx.now();
  const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);

  const maxKeys = Math.min(...configs.map((c) => c.max_keys_per_staff));
  const live = await ctx.db
    .selectFrom('agent_keys')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('staff_id', '=', staff.staffId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirstOrThrow();
  if (Number(live.n) >= maxKeys) throw conflict(`You already hold ${live.n} access keys, which is the most allowed here. Revoke one first.`);

  const token = newToken(AGENT_KEY_PREFIX);
  const row = await ctx.db
    .insertInto('agent_keys')
    .values({
      org_id: ctx.orgId,
      staff_id: staff.staffId,
      name: input.name,
      key_prefix: token.display,
      key_hash: token.hash,
      scopes,
      venue_ids: requested,
      can_write: input.canWrite,
      expires_at: expiresAt,
      created_at: now,
    })
    .returning(VIEW_COLS)
    .executeTakeFirstOrThrow();

  await audit(ctx, {
    action: 'agent_key.created',
    entityType: 'agent_key',
    entityId: row.id,
    after: { name: input.name, audience: 'assistant', scopes, venueIds: requested, canWrite: input.canWrite, expiresAt: expiresAt.toISOString() },
  });
  return { key: token.token, view: view(row, now) };
}

export const createServiceKeyInput = z.object({
  /** The live connection to the service the key is for. The key dies with it. */
  connectionId: z.string().uuid(),
  name: z.string().trim().min(1).max(80).default('Service access'),
  /** Venues whose outcomes the service may ask for. Omit for every venue. Each venue still decides for itself whether to share. */
  venueIds: z.array(z.string().uuid()).min(1).max(200).nullish(),
  expiresInDays: z.number().int().min(1).max(365),
});
export type CreateServiceKeyInput = z.input<typeof createServiceKeyInput>;

/** The one permission a connected service's key may hold. */
export const SERVICE_KEY_SCOPES = ['outcomes:read'] as const;

/**
 * An owner makes a key for a connected service (Criota) to pull campaign outcomes with. It holds
 * `outcomes:read` and nothing else, can never make changes, is labelled as the service's in
 * every list and on the audit log, and ends when the connection is revoked. What the service
 * then receives is decided per venue by the venue's own sharing switch (hub.criotaSharing).
 */
export async function createServiceKey(ctx: Ctx, raw: CreateServiceKeyInput): Promise<{ key: string; view: AgentKeyView }> {
  const input = createServiceKeyInput.parse(raw);
  const staff = signedInStaff(ctx);
  if (!staff.isOwner) throw forbidden('Only an owner can give a connected service access.');
  const conn = await ctx.db.selectFrom('connections').select(['id', 'plug_key', 'venue_id', 'status']).where('id', '=', input.connectionId).executeTakeFirst();
  if (!conn) throw notFound('Connection not found');
  if (conn.status !== 'connected') throw conflict('That service is not connected. Reconnect it first.');

  const requested = input.venueIds ? [...new Set(input.venueIds)] : null;
  for (const id of requested ?? []) if (!staff.venueRoles[id]) throw notFound('Venue not found');
  const covered = requested ?? Object.keys(staff.venueRoles);
  const states = await hubStates(ctx, covered);
  const open = covered.filter((id) => states.get(id)!.enabled && states.get(id)!.config.agent_access_enabled);
  if (!open.length || (requested && open.length !== requested.length)) throw new AppError('module_disabled', 'Assistant access is not switched on at that venue.');
  const configs = open.map((id) => states.get(id)!.config);
  const maxDays = Math.min(...configs.map((c) => c.key_max_lifetime_days));
  if (input.expiresInDays > maxDays) throw invalid(`A key can last at most ${maxDays} days here.`);

  const now = ctx.now();
  const token = newToken(AGENT_KEY_PREFIX);
  const audience = `service:${conn.plug_key}`;
  const row = await ctx.db
    .insertInto('agent_keys')
    .values({
      org_id: ctx.orgId,
      staff_id: staff.staffId,
      name: input.name,
      key_prefix: token.display,
      key_hash: token.hash,
      scopes: [...SERVICE_KEY_SCOPES],
      venue_ids: requested,
      can_write: false,
      expires_at: new Date(now.getTime() + input.expiresInDays * 86_400_000),
      created_at: now,
      audience,
      connection_id: conn.id,
    })
    .returning(VIEW_COLS)
    .executeTakeFirstOrThrow();
  await audit(ctx, {
    action: 'agent_key.created',
    entityType: 'agent_key',
    entityId: row.id,
    venueId: conn.venue_id,
    after: { name: input.name, audience, connectionId: conn.id, scopes: [...SERVICE_KEY_SCOPES], venueIds: requested, canWrite: false, expiresAt: row.expires_at.toISOString() },
  });
  return { key: token.token, view: view(row, now) };
}

/** End every live key, sign-in and service key of the organisation this transaction acts for. Internal (offboarding). */
export async function revokeAllAgentKeys(ctx: Ctx, reason: string): Promise<number> {
  const ended = await ctx.db.updateTable('agent_keys').set({ revoked_at: ctx.now() }).where('revoked_at', 'is', null).returning('id').execute();
  for (const k of ended) await audit(ctx, { action: 'agent_key.revoked', entityType: 'agent_key', entityId: k.id, after: { reason } });
  return ended.length;
}

// A service's keys end with its connection, in the same transaction (core revokeConnection).
onConnectionRevoked(async (ctx, connection) => {
  const ended = await ctx.db.updateTable('agent_keys').set({ revoked_at: ctx.now() }).where('connection_id', '=', connection.id).where('revoked_at', 'is', null).returning('id').execute();
  for (const k of ended) await audit(ctx, { action: 'agent_key.revoked', entityType: 'agent_key', entityId: k.id, venueId: connection.venue_id, after: { reason: 'connection_revoked', connectionId: connection.id } });
});

/** A person's own keys. An owner sees everyone's, or one person's with `staffId`. */
export async function listAgentKeys(ctx: Ctx, filter: { staffId?: string } = {}): Promise<AgentKeyView[]> {
  const staff = signedInStaff(ctx);
  let q = ctx.db.selectFrom('agent_keys').select(VIEW_COLS).orderBy('created_at', 'desc');
  if (!staff.isOwner) q = q.where('staff_id', '=', staff.staffId);
  else if (filter.staffId) q = q.where('staff_id', '=', filter.staffId);
  const now = ctx.now();
  return (await q.execute()).map((r) => view(r, now));
}

async function ownKey(ctx: Ctx, keyId: string): Promise<KeyRow> {
  const staff = signedInStaff(ctx);
  if (!z.string().uuid().safeParse(keyId).success) throw notFound('Access key not found');
  const row = await ctx.db.selectFrom('agent_keys').select(VIEW_COLS).where('id', '=', keyId).executeTakeFirst();
  // Someone else's key is not found, not forbidden, unless you are an owner.
  if (!row || (row.staff_id !== staff.staffId && !staff.isOwner)) throw notFound('Access key not found');
  return row;
}

/** End a key now. The person it belongs to, or an owner. Safe to repeat. */
export async function revokeAgentKey(ctx: Ctx, keyId: string): Promise<void> {
  const row = await ownKey(ctx, keyId);
  if (row.revoked_at) return;
  await ctx.db.updateTable('agent_keys').set({ revoked_at: ctx.now() }).where('id', '=', keyId).where('revoked_at', 'is', null).execute();
  await audit(ctx, { action: 'agent_key.revoked', entityType: 'agent_key', entityId: keyId });
}

/** The owner's tick: whether a key may make changes. Each change still waits for the person's yes. */
export async function setAgentKeyCanWrite(ctx: Ctx, keyId: string, canWrite: boolean): Promise<AgentKeyView> {
  const staff = signedInStaff(ctx);
  if (!staff.isOwner) throw forbidden('Only an owner can allow a key to make changes.');
  const before = await ownKey(ctx, keyId);
  // A connected service's key reads outcomes and nothing else, whoever asks.
  if (canWrite && serviceOf(before.audience)) throw forbidden('A service key can never make changes.');
  const row = await ctx.db.updateTable('agent_keys').set({ can_write: canWrite }).where('id', '=', keyId).returning(VIEW_COLS).executeTakeFirstOrThrow();
  await audit(ctx, { action: 'agent_key.can_write_set', entityType: 'agent_key', entityId: keyId, before: { canWrite: before.can_write }, after: { canWrite } });
  return view(row, ctx.now());
}

// A person whose access is removed loses their keys in the same transaction (auth.disableStaff).
onStaffDisabled(async (ctx, staffId) => {
  const ended = await ctx.db.updateTable('agent_keys').set({ revoked_at: ctx.now() }).where('staff_id', '=', staffId).where('revoked_at', 'is', null).returning('id').execute();
  for (const k of ended) await audit(ctx, { action: 'agent_key.revoked', entityType: 'agent_key', entityId: k.id, after: { reason: 'staff_disabled' } });
});

/** One venue as a key sees it. */
export interface KeyVenue {
  id: string;
  slug: string;
  name: string;
  suburb: string | null;
  timezone: string;
  /** The staff member's role here. The key acts with it and nothing more. */
  role: StaffRole;
  config: HubConfig;
  /** Toggleable modules switched on here (with everything they depend on). */
  modulesOn: string[];
}

/** Who a presented key is, right now. Built fresh for every request and never cached. */
export interface ResolvedAgentKey {
  orgId: string;
  orgName: string;
  keyId: string;
  keyName: string;
  principal: AgentPrincipal;
  /** The venues the key can see: the staff member's, narrowed to the key's, where assistants are switched on. */
  venues: KeyVenue[];
  limits: HubOrgSettings;
  /** 'assistant', or 'service:<plug>' for a connected service's key. */
  audience: string;
  /** 'key' when pasted, 'oauth' when the assistant was signed in. */
  kind: 'key' | 'oauth';
  /** Set when a hosted agent (not a person's assistant) is making the calls. Recorded on agent_calls. */
  hosted?: { agentKey: string; runId: string | null };
  /** The request's client address, when the host that mounted the endpoint knows it. Recorded on audit rows. */
  ip?: string;
}
/** A tenant transaction for the key's organisation, acting as the key. Everything a call does to tenant data goes through here. */
export function asCaller<T>(app: App, caller: ResolvedAgentKey, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  return app.tenant(caller.orgId, caller.principal, fn, caller.ip ? { ip: caller.ip } : {});
}

/** `Authorization: Bearer <key>` → the key, or null. */
export function bearerKey(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m ? m[1]! : null;
}

const RESOLVER = { kind: 'worker' as const, job: 'hub.resolve_key' };
const TOUCH_EVERY_MS = 60_000;

/** What a signed-in assistant presents (hub/oauth.ts issues them). */
export const OAUTH_ACCESS_PREFIX = 'ros_oat';

const KEY_COLS = ['id', 'org_id', 'staff_id', 'name', 'scopes', 'venue_ids', 'can_write', 'expires_at', 'revoked_at', 'last_used_at', 'audience', 'connection_id', 'kind'] as const;

/**
 * A presented key or signed-in assistant's access token → who it acts as, or null. Every refusal
 * is the same null, so nothing is learned from which: malformed, unknown, revoked, expired, its
 * person disabled or gone, its organisation paused or closed, a service key whose connection is
 * no longer live, or assistants switched off at every venue it could see.
 *
 * A database that cannot be asked THROWS. "Could not check" is never "yes".
 */
export async function resolveAgentKey(app: App, presented: unknown): Promise<ResolvedAgentKey | null> {
  if (typeof presented !== 'string' || presented.length > 200) return null;
  const now = app.clock();
  let keyId: string | null = null;

  // Sign-in: the key or token arrives before the org is known, so it is looked up by its hash
  // outside any tenant (app.db). Everything after this runs for the org the key row names.
  if (presented.startsWith(`${OAUTH_ACCESS_PREFIX}_`)) {
    const token = await app.db
      .selectFrom('agent_oauth_tokens')
      .select(['key_id', 'expires_at', 'resource'])
      .where('token_hash', '=', hashToken(presented))
      .where('kind', '=', 'access')
      .executeTakeFirst();
    // Issued for this server and no other, and inside its hour.
    if (!token || token.expires_at <= now || token.resource !== mcpResourceUrl(app)) return null;
    keyId = token.key_id;
  } else if (!presented.startsWith(`${AGENT_KEY_PREFIX}_`)) {
    return null;
  }

  const row = keyId
    ? await app.db.selectFrom('agent_keys').select(KEY_COLS).where('id', '=', keyId).where('kind', '=', 'oauth').executeTakeFirst()
    : await app.db.selectFrom('agent_keys').select(KEY_COLS).where('key_hash', '=', hashToken(presented)).where('kind', '=', 'key').executeTakeFirst();
  if (!row || row.revoked_at || row.expires_at <= now) return null;

  const service = serviceOf(row.audience);
  if (service) {
    // A service key lives only as long as its connection does, whatever its own expiry says.
    const conn = row.connection_id ? await app.db.selectFrom('connections').select(['status', 'plug_key']).where('id', '=', row.connection_id).where('org_id', '=', row.org_id).executeTakeFirst() : null;
    if (!conn || conn.status !== 'connected' || conn.plug_key !== service) return null;
  }

  const person = await app.db.selectFrom('staff').select(['user_id', 'status']).where('id', '=', row.staff_id).where('org_id', '=', row.org_id).executeTakeFirst();
  if (!person || person.status === 'disabled') return null;
  // The same function a console session is built with: roles come from the database, now.
  const staff = await staffPrincipal(app, person.user_id, row.org_id);
  if (!staff) return null;

  const candidates = Object.keys(staff.venueRoles).filter((id) => !row.venue_ids || row.venue_ids.includes(id));
  if (!candidates.length) return null;

  const seen = await app.tenant(row.org_id, RESOLVER, async (ctx) => {
    const org = await ctx.db.selectFrom('orgs').select(['trading_name', 'status', 'settings']).where('id', '=', ctx.orgId).executeTakeFirst();
    if (!org || (org.status !== 'live' && org.status !== 'onboarding')) return null;
    const states = await hubStates(ctx, candidates);
    const open = candidates.filter((id) => states.get(id)!.enabled && states.get(id)!.config.agent_access_enabled);
    if (!open.length) return null;
    const venues = await ctx.db.selectFrom('venues').select(['id', 'slug', 'name', 'suburb', 'timezone', 'status']).where('id', 'in', open).orderBy('name').execute();
    const modules = await ctx.db.selectFrom('venue_modules').select(['venue_id', 'module_key']).where('venue_id', 'in', open).where('enabled', '=', true).execute();
    const stored = ((org.settings ?? {}) as Record<string, unknown>)[HUB_SETTINGS_NAMESPACE];
    const limits = hubOrgSettings.safeParse(stored ?? {});
    return { org, states, venues: venues.filter((v) => v.status !== 'closed'), modules, limits: limits.success ? limits.data : hubOrgSettings.parse({}) };
  });
  if (!seen || !seen.venues.length) return null;

  const venues: KeyVenue[] = seen.venues.map((v) => {
    const rowsOn = new Set(seen.modules.filter((m) => m.venue_id === v.id).map((m) => m.module_key));
    // A module counts as on only when everything it depends on is on too (as assertModule has it).
    const on = [...rowsOn].filter((key) => {
      try {
        return getModuleDef(key).dependsOn.every((dep) => getModuleDef(dep).spine || rowsOn.has(dep));
      } catch {
        return false;
      }
    });
    return { id: v.id, slug: v.slug, name: v.name, suburb: v.suburb, timezone: v.timezone, role: staff.venueRoles[v.id]!, config: seen.states.get(v.id)!.config, modulesOn: on };
  });

  const venueRoles: Record<string, StaffRole> = {};
  for (const v of venues) venueRoles[v.id] = v.role;
  // An owner's key that is held to some venues is not an owner of the whole organisation.
  const wholeOrg = row.venue_ids === null && venues.length === Object.keys(staff.venueRoles).length;
  const known = new Set(knownScopes(app));
  // A service key holds outcomes:read and nothing else, whatever its row says.
  const held = service ? row.scopes.filter((s) => (SERVICE_KEY_SCOPES as readonly string[]).includes(s)) : row.scopes;
  const scopes = held.filter((s) => known.has(s) && venues.some((v) => scopeAllowed(s, v.config)));

  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > TOUCH_EVERY_MS) {
    await app.db.updateTable('agent_keys').set({ last_used_at: now }).where('id', '=', row.id).execute();
  }

  return {
    orgId: row.org_id,
    orgName: seen.org.trading_name,
    keyId: row.id,
    keyName: row.name,
    principal: {
      kind: 'agent',
      keyId: row.id,
      // A service is never an owner of anything.
      staff: { kind: 'staff', staffId: staff.staffId, userId: staff.userId, isOwner: staff.isOwner && wholeOrg && !service, venueRoles },
      scopes,
      venueIds: row.venue_ids,
      canWrite: row.can_write && !service,
      audience: row.audience,
    },
    venues,
    limits: seen.limits,
    audience: row.audience,
    kind: row.kind === 'oauth' ? 'oauth' : 'key',
  };
}
