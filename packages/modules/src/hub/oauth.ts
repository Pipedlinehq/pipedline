import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { type OAuthMetadata, oauthMetadataResponse } from '@modelcontextprotocol/server';
import { type App, AppError, type Ctx, type StaffPrincipal, audit, forbidden, hashToken, invalid, rateLimit } from '@ros/core';
import { MCP_PATH, OAUTH_PATH, mcpResourceUrl, oauthEndpoints, oauthIssuer } from './address';
import { OAUTH_ACCESS_PREFIX, hubStates } from './keys';
import { describeScopes, isGuestLevelScope, isReadScope, scopeAllowed } from './scopes';

/**
 * An assistant connects by its person signing in and saying yes, with nothing to paste
 * (docs/THREAT_MODEL.md section 3: "agent key or OAuth sign-in"). Ported from Criota's
 * `services/mcpOauth.ts`, `mcpOauthCore.ts`, `routes/mcpAuth.ts` and `routes/wellKnown.ts`,
 * narrowed where OAuth 2.1 and the MCP authorization rules leave a choice:
 *
 *   - public clients only: an assistant proves itself with PKCE (S256); no client secret exists;
 *   - dynamic client registration (RFC 7591) only; a registration grants nothing, it names where
 *     a person may be sent back to (https, or http on the person's own computer);
 *   - the consent step is a console page, for a signed-in member of staff. It names every scope,
 *     and the "allow changes" box starts UNTICKED; only an owner may tick it;
 *   - a yes becomes a one-use code (2 minutes); the code becomes an access token (1 hour, never
 *     past the connection's end) and a renewal token that renews once. A code presented twice
 *     ends what the first exchange made; a renewal token presented twice ends the connection;
 *   - a connection is an `agent_keys` row of kind 'oauth'. Its tokens resolve through
 *     `resolveAgentKey` to the same `ResolvedAgentKey` a pasted key does, so every rule a key
 *     obeys (never more than its person, hub on at the venue, scopes allowed there, revocable,
 *     expiring, ended when the person is disabled or the org closes) applies unchanged;
 *   - tokens are issued for this MCP server (the `resource`) and no other.
 *
 * Not ported: client-id metadata documents (a client id that is an https address to fetch).
 * Fetching a stranger's document is a server-side request this surface does not need yet.
 * Criota's 30-second grace for a renewal asked twice is not ported either: here the second
 * presentation ends the connection.
 *
 * Codes, tokens and client ids leave this file exactly once, in the value that hands them to
 * the assistant. Only their SHA-256 is stored; neither is ever logged.
 */

// ── What is issued ──────────────────────────────────────────────────────────

const TAG = { access: `${OAUTH_ACCESS_PREFIX}_`, refresh: 'ros_ort_', code: 'ros_oac_' } as const;
type SecretKind = keyof typeof TAG;
const SECRET_RE: Record<SecretKind, RegExp> = {
  access: new RegExp(`^${TAG.access}[A-Za-z0-9_-]{43}$`),
  refresh: /^ros_ort_[A-Za-z0-9_-]{43}$/,
  code: /^ros_oac_[A-Za-z0-9_-]{43}$/,
};
const CLIENT_RE = /^ros_oc_[A-Za-z0-9_-]{22}$/;

function generateSecret(kind: SecretKind): string {
  return `${TAG[kind]}${randomBytes(32).toString('base64url')}`;
}
function isSecret(kind: SecretKind, v: unknown): v is string {
  return typeof v === 'string' && SECRET_RE[kind].test(v);
}

/** A yes is exchanged by a machine, at once. */
export const CODE_TTL_SECONDS = 120;
/** What an assistant presents with each request. Short: a copy that strays is soon worthless. */
export const ACCESS_TTL_SECONDS = 3600;
/** What an assistant renews with. Each renewal starts it again, so it measures time unused. */
export const REFRESH_TTL_SECONDS = 30 * 86_400;

// ── PKCE ────────────────────────────────────────────────────────────────────

const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether the verifier now presented is the one whose S256 hash came with the request. */
export function verifyPkce(verifier: unknown, challenge: string): boolean {
  if (typeof verifier !== 'string' || !VERIFIER_RE.test(verifier) || !CHALLENGE_RE.test(challenge)) return false;
  const made = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const kept = Buffer.from(challenge);
  return made.length === kept.length && timingSafeEqual(made, kept);
}

// ── Where a person may be sent back to ──────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
type RedirectCheck = { ok: true; loopback: boolean; host: string } | { ok: false; why: string };

/** https anywhere, or http on the person's own computer. No fragment, no credentials, no other scheme. */
export function checkRedirect(uri: unknown): RedirectCheck {
  if (typeof uri !== 'string' || !uri.length || uri.length > 2048) return { ok: false, why: 'not an address' };
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return { ok: false, why: 'not an address' };
  }
  if (u.hash || uri.includes('#')) return { ok: false, why: 'it carries a fragment' };
  if (u.username || u.password) return { ok: false, why: 'it carries credentials' };
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol === 'https:') return { ok: true, loopback, host: u.hostname };
  if (u.protocol === 'http:' && loopback) return { ok: true, loopback: true, host: u.hostname };
  return { ok: false, why: 'it is neither https nor this computer' };
}

const loopbackShape = (u: URL) => `${u.protocol}//loopback${u.pathname}${u.search}`;

/** Exactly one the assistant named beforehand; on the person's own computer the port may differ. */
export function redirectAllowed(registered: readonly string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  const c = checkRedirect(presented);
  if (!c.ok || !c.loopback) return false;
  const shape = loopbackShape(new URL(presented));
  return registered.some((r) => {
    const rc = checkRedirect(r);
    return rc.ok && rc.loopback && loopbackShape(new URL(r)) === shape;
  });
}

function redirectWith(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** A resource address with the differences that mean nothing set aside: case of scheme and host, a closing slash. */
function sameResource(a: string, b: string): boolean {
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      if (u.hash || u.search) return null;
      return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/** A name as it is shown to a person: one line, no control or invisible characters, bounded. */
function cleanName(value: unknown, max = 100): string | null {
  if (typeof value !== 'string') return null;
  const unseen = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069]', 'g');
  const name = value.replace(unseen, ' ').replace(/\s+/g, ' ').trim();
  return name ? name.slice(0, max) : null;
}

// ── Errors in OAuth's own form ──────────────────────────────────────────────

/** An OAuth error (RFC 6749 section 5.2). Thrown by the token, revoke and register paths. */
export class OAuthFlowError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
  }
}

const INVALID_GRANT = 'That code or token is not valid, has expired, or has been used. Connect again from your assistant.';

// ── Registration (RFC 7591) ─────────────────────────────────────────────────

const registrationSchema = z
  .object({
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    client_name: z.string().max(200).optional(),
    client_uri: z.string().max(2048).optional(),
    token_endpoint_auth_method: z.string().max(40).optional(),
    grant_types: z.array(z.string().max(60)).max(10).optional(),
    response_types: z.array(z.string().max(40)).max(10).optional(),
  })
  .passthrough();

/** An assistant registers where a person may be sent back to. Grants nothing. */
export async function registerOAuthClient(app: App, body: unknown): Promise<Record<string, unknown>> {
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? '');
    throw field === 'redirect_uris'
      ? new OAuthFlowError('invalid_redirect_uri', 'redirect_uris must be a list of one to ten addresses.')
      : new OAuthFlowError('invalid_client_metadata', `${field || 'the registration'} is not in the form expected.`);
  }
  const r = parsed.data;
  for (const uri of r.redirect_uris) {
    const c = checkRedirect(uri);
    if (!c.ok) throw new OAuthFlowError('invalid_redirect_uri', `${uri.slice(0, 120)} cannot be used: ${c.why}. Use https, or http on localhost.`);
  }
  if (r.token_endpoint_auth_method && r.token_endpoint_auth_method !== 'none') {
    throw new OAuthFlowError('invalid_client_metadata', 'token_endpoint_auth_method must be "none": no client secret is issued, and PKCE is required.');
  }
  if (r.grant_types && !r.grant_types.includes('authorization_code')) throw new OAuthFlowError('invalid_client_metadata', 'grant_types must include "authorization_code".');
  if (r.response_types && !r.response_types.includes('code')) throw new OAuthFlowError('invalid_client_metadata', 'response_types must include "code".');

  const clientId = `ros_oc_${randomBytes(16).toString('base64url')}`;
  const name = cleanName(r.client_name) ?? 'An assistant';
  const redirectUris = [...new Set(r.redirect_uris)];
  const uri = r.client_uri?.startsWith('https://') ? r.client_uri : null;
  const now = app.clock();
  // A registration belongs to no org: a platform table.
  await app.platform('hub: oauth client registered', (p) =>
    p.db.insertInto('agent_oauth_clients').values({ client_id: clientId, client_name: name, redirect_uris: redirectUris, client_uri: uri, created_at: now }).execute(),
  );
  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    client_name: name,
    redirect_uris: redirectUris,
    ...(uri ? { client_uri: uri } : {}),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

// ── The request a person is asked about ─────────────────────────────────────

const authorizationRequest = z.object({
  response_type: z.string().max(40).optional(),
  client_id: z.string().min(1).max(2048),
  redirect_uri: z.string().min(1).max(2048),
  code_challenge: z.string().max(256).optional(),
  code_challenge_method: z.string().max(20).optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(2048).optional(),
  resource: z.string().max(2048).optional(),
});

interface Understood {
  client: { clientId: string; name: string; uri: string | null };
  redirectUri: string;
  returnsTo: { host: string; thisComputer: boolean };
  /** Whether the assistant asked for changes (the "write" word), or for nothing in particular. */
  asksWrite: boolean;
  state: string | undefined;
  codeChallenge: string;
}

type Validated = { kind: 'ok'; request: Understood } | { kind: 'return'; redirectTo: string };

function toRecord(raw: unknown): Record<string, unknown> {
  if (raw instanceof URLSearchParams) return Object.fromEntries(raw.entries());
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/**
 * Read an authorization request (the query string the assistant sent the person to). Throws, for
 * the PERSON to read, when the assistant is unknown or the address is not one it named: nobody is
 * sent anywhere on the say-so of such a request. Other faults go back to the assistant.
 */
async function understand(app: App, raw: unknown): Promise<Validated> {
  const parsed = authorizationRequest.safeParse(toRecord(raw));
  if (!parsed.success) throw invalid('This link is incomplete, so it cannot be told which assistant it is for. Start again from your assistant.');
  const r = parsed.data;
  // A registration belongs to no org, so it is read outside any tenant.
  const client = CLIENT_RE.test(r.client_id)
    ? await app.db.selectFrom('agent_oauth_clients').select(['client_id', 'client_name', 'redirect_uris', 'client_uri']).where('client_id', '=', r.client_id).executeTakeFirst()
    : undefined;
  if (!client) throw invalid('The assistant asking could not be confirmed. Nothing was connected; start again from your assistant.');
  const where = checkRedirect(r.redirect_uri);
  if (!where.ok || !redirectAllowed(client.redirect_uris, r.redirect_uri)) {
    throw invalid(`${client.client_name} asked to send you somewhere it did not name beforehand, so this was stopped. Nothing was connected.`);
  }
  const back = (error: string, description: string): Validated => ({
    kind: 'return',
    redirectTo: redirectWith(r.redirect_uri, { error, error_description: description, state: r.state, iss: oauthIssuer(app) }),
  });
  if (r.response_type !== 'code') return back('unsupported_response_type', 'response_type must be "code".');
  if (r.code_challenge_method !== 'S256' || !r.code_challenge || !CHALLENGE_RE.test(r.code_challenge)) {
    return back('invalid_request', 'PKCE is required: send code_challenge with code_challenge_method=S256.');
  }
  if (r.resource !== undefined && !sameResource(r.resource, mcpResourceUrl(app))) return back('invalid_target', 'resource must be the address of this MCP server.');
  const words = (r.scope ?? '').split(/\s+/).filter(Boolean);
  const known = words.filter((w) => w === 'read' || w === 'write');
  return {
    kind: 'ok',
    request: {
      client: { clientId: client.client_id, name: client.client_name, uri: client.client_uri },
      redirectUri: r.redirect_uri,
      returnsTo: { host: where.host, thisComputer: where.loopback },
      asksWrite: known.length === 0 || known.includes('write'),
      state: r.state,
      codeChallenge: r.code_challenge,
    },
  };
}

/** Consent is given by a person signed in to the console, never by an assistant, a screen or a job. */
function signedInStaff(ctx: Ctx): StaffPrincipal {
  if (ctx.principal.kind !== 'staff') throw forbidden('An assistant is connected by a person signed in to the console.');
  return ctx.principal;
}

interface ConsentScope {
  scope: string;
  effect: 'read' | 'write';
  /** What it unlocks, in the tools' own titles. */
  tools: string[];
  plug?: string;
}

/** The venues this person could connect an assistant to, with each one's settings. */
async function connectableVenues(ctx: Ctx, staff: StaffPrincipal) {
  const ids = Object.keys(staff.venueRoles);
  const states = await hubStates(ctx, ids);
  const open = ids.filter((id) => states.get(id)!.enabled && states.get(id)!.config.agent_access_enabled);
  const rows = open.length ? await ctx.db.selectFrom('venues').select(['id', 'name', 'slug']).where('id', 'in', open).orderBy('name').execute() : [];
  return rows.map((v) => ({ id: v.id, name: v.name, slug: v.slug, role: staff.venueRoles[v.id]!, config: states.get(v.id)!.config }));
}

/** Scopes a sign-in may carry at these venues: reads, and changes only when allowed. Guest-level reads are for pasted keys only. */
function grantable(app: App, venues: Awaited<ReturnType<typeof connectableVenues>>): ConsentScope[] {
  return describeScopes(app)
    .filter((s) => !isGuestLevelScope(s.scope) && venues.some((v) => scopeAllowed(s.scope, v.config)))
    .map((s) => ({ scope: s.scope, effect: isReadScope(s.scope) ? ('read' as const) : ('write' as const), tools: s.tools.map((t) => t.title), ...(s.plug ? { plug: s.plug } : {}) }));
}

/** What the consent page shows. Nothing is changed by reading it. */
export type OAuthConsent =
  | {
      outcome: 'ask';
      assistant: { name: string; website: string | null; clientId: string };
      /** Where the person is sent once they have answered. */
      returnsTo: { host: string; thisComputer: boolean };
      account: { org: string; person: string; isOwner: boolean };
      /** The venues it could act at; the person may narrow them. */
      venues: Array<{ id: string; name: string; role: string }>;
      /** Every permission, named. Reads are granted with a yes; changes only with the box ticked. */
      scopes: { read: ConsentScope[]; changes: ConsentScope[] };
      /**
       * The "allow changes" box. It starts UNTICKED. `canTick` is false for anyone but an owner,
       * and `offered` is false when the assistant asked for reads only. Even ticked, every change
       * still waits for the person's own yes at the moment it is made.
       */
      allowChanges: { offered: boolean; canTick: boolean; ticked: false };
      /** How long it stays connected, in days: the choices, and the one chosen to begin with. */
      lasts: { maxDays: number; defaultDays: number };
      /** Where Cancel goes: back to the assistant, with a no. */
      cancelTo: string;
    }
  | { outcome: 'return'; redirectTo: string };

export async function reviewOAuthRequest(ctx: Ctx, rawQuery: unknown): Promise<OAuthConsent> {
  const staff = signedInStaff(ctx);
  const v = await understand(ctx.app, rawQuery);
  if (v.kind === 'return') return { outcome: 'return', redirectTo: v.redirectTo };
  const { request } = v;
  const venues = await connectableVenues(ctx, staff);
  if (!venues.length) throw new AppError('module_disabled', 'Assistant access is not switched on at any venue you work at.');
  const scopes = grantable(ctx.app, venues);
  const [org, person] = await Promise.all([
    ctx.db.selectFrom('orgs').select('trading_name').where('id', '=', ctx.orgId).executeTakeFirstOrThrow(),
    ctx.db.selectFrom('staff').select(['first_name', 'last_name']).where('id', '=', staff.staffId).executeTakeFirstOrThrow(),
  ]);
  const maxDays = Math.min(...venues.map((x) => x.config.key_max_lifetime_days));
  return {
    outcome: 'ask',
    assistant: { name: request.client.name, website: request.client.uri, clientId: request.client.clientId },
    returnsTo: request.returnsTo,
    account: { org: org.trading_name, person: [person.first_name, person.last_name].filter(Boolean).join(' '), isOwner: staff.isOwner },
    venues: venues.map((x) => ({ id: x.id, name: x.name, role: x.role })),
    scopes: { read: scopes.filter((s) => s.effect === 'read'), changes: scopes.filter((s) => s.effect === 'write') },
    allowChanges: { offered: request.asksWrite && scopes.some((s) => s.effect === 'write'), canTick: staff.isOwner, ticked: false },
    lasts: { maxDays, defaultDays: Math.min(30, maxDays) },
    cancelTo: redirectWith(request.redirectUri, { error: 'access_denied', error_description: 'The person chose not to connect.', state: request.state, iss: oauthIssuer(ctx.app) }),
  };
}

export const oauthDecisionInput = z.object({
  allow: z.boolean(),
  /** The "allow changes" box. Absent is unticked. */
  allowChanges: z.boolean().default(false),
  /** A subset of the venues offered. Absent: every venue offered, now and later. */
  venueIds: z.array(z.string().uuid()).min(1).max(200).nullish(),
  /** A subset of the scopes offered. Absent: every read offered, plus every change when the box is ticked. */
  scopes: z.array(z.string().min(1).max(80)).min(1).max(100).nullish(),
  lastsDays: z.number().int().min(1).max(365).optional(),
});
export type OAuthDecisionInput = z.input<typeof oauthDecisionInput>;

/**
 * The person's answer. A yes becomes a one-use code in the address returned, and nowhere else;
 * a no is an address that says no. The connection is for the person signed in, in the
 * organisation of their session: never anything named in the request.
 */
export async function decideOAuthRequest(ctx: Ctx, rawQuery: unknown, rawChoice: OAuthDecisionInput): Promise<{ redirectTo: string }> {
  const staff = signedInStaff(ctx);
  const choice = oauthDecisionInput.parse(rawChoice);
  const v = await understand(ctx.app, rawQuery);
  if (v.kind === 'return') return { redirectTo: v.redirectTo };
  const { request } = v;
  const issuer = oauthIssuer(ctx.app);

  if (!choice.allow) {
    await audit(ctx, { action: 'agent_oauth.declined', entityType: 'agent_oauth_client', entityId: null, after: { assistant: request.client.name, returnsTo: request.returnsTo.host } });
    return { redirectTo: redirectWith(request.redirectUri, { error: 'access_denied', error_description: 'The person chose not to connect.', state: request.state, iss: issuer }) };
  }

  const all = await connectableVenues(ctx, staff);
  if (!all.length) throw new AppError('module_disabled', 'Assistant access is not switched on at any venue you work at.');
  const picked = choice.venueIds ? [...new Set(choice.venueIds)] : null;
  for (const id of picked ?? []) if (!all.some((x) => x.id === id)) throw invalid('Choose venues from the list.');
  const venues = picked ? all.filter((x) => picked.includes(x.id)) : all;

  if (choice.allowChanges && !staff.isOwner) throw forbidden('Only an owner can allow an assistant to make changes.');
  const changes = choice.allowChanges && request.asksWrite;
  const offered = grantable(ctx.app, venues);
  const offeredSet = new Set(offered.filter((s) => s.effect === 'read' || changes).map((s) => s.scope));
  const scopes = choice.scopes ? [...new Set(choice.scopes)] : [...offeredSet];
  const outside = scopes.filter((s) => !offeredSet.has(s));
  if (outside.length) throw invalid(`Not something this connection can be given: ${outside.join(', ')}`);
  if (!scopes.length) throw invalid('Choose at least one thing the assistant may see.');
  const maxDays = Math.min(...venues.map((x) => x.config.key_max_lifetime_days));
  const lastsDays = choice.lastsDays ?? Math.min(30, maxDays);
  if (lastsDays > maxDays) throw invalid(`An assistant can stay connected at most ${maxDays} days here.`);

  const code = generateSecret('code');
  const now = ctx.now();
  await ctx.db
    .insertInto('agent_oauth_codes')
    .values({
      code_hash: hashToken(code),
      org_id: ctx.orgId,
      staff_id: staff.staffId,
      client_id: request.client.clientId,
      client_name: request.client.name,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      resource: mcpResourceUrl(ctx.app),
      scopes: scopes.sort(),
      venue_ids: picked,
      can_write: changes && scopes.some((s) => !isReadScope(s)),
      lasts_days: lastsDays,
      expires_at: new Date(now.getTime() + CODE_TTL_SECONDS * 1000),
      created_at: now,
    })
    .execute();
  await audit(ctx, {
    action: 'agent_oauth.agreed',
    entityType: 'agent_oauth_client',
    entityId: null,
    after: { assistant: request.client.name, returnsTo: request.returnsTo.host, scopes, venueIds: picked, canWrite: changes, lastsDays },
  });
  return { redirectTo: redirectWith(request.redirectUri, { code, state: request.state, iss: issuer }) };
}

// ── The token endpoint ──────────────────────────────────────────────────────

export interface OAuthTokenAnswer {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : undefined);
const SIGNIN = { kind: 'worker' as const, job: 'hub.oauth' };

/** A connection's scopes, said back in the two words an assistant uses. */
function scopeWords(scopes: readonly string[]): string {
  const out: string[] = [];
  if (scopes.some((s) => isReadScope(s))) out.push('read');
  if (scopes.some((s) => !isReadScope(s))) out.push('write');
  return out.join(' ');
}

/** Mint an access and a renewal token for a connection; stored as hashes only. The access token never outlives the connection. */
async function mintTokens(ctx: Ctx, keyId: string, keyExpires: Date, scopes: string[]): Promise<OAuthTokenAnswer> {
  const now = ctx.now().getTime();
  const access = generateSecret('access');
  const refresh = generateSecret('refresh');
  const accessExpires = new Date(Math.min(now + ACCESS_TTL_SECONDS * 1000, keyExpires.getTime()));
  const refreshExpires = new Date(Math.min(now + REFRESH_TTL_SECONDS * 1000, keyExpires.getTime()));
  const resource = mcpResourceUrl(ctx.app);
  await ctx.db
    .insertInto('agent_oauth_tokens')
    .values([
      { token_hash: hashToken(access), org_id: ctx.orgId, key_id: keyId, kind: 'access', resource, expires_at: accessExpires, created_at: ctx.now() },
      { token_hash: hashToken(refresh), org_id: ctx.orgId, key_id: keyId, kind: 'refresh', resource, expires_at: refreshExpires, created_at: ctx.now() },
    ])
    .execute();
  return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExpires.getTime() - now) / 1000)), refresh_token: refresh, scope: scopeWords(scopes) };
}

/** End a signed-in connection and everything it holds. */
async function endConnection(ctx: Ctx, keyId: string, reason: string): Promise<void> {
  const ended = await ctx.db.updateTable('agent_keys').set({ revoked_at: ctx.now() }).where('id', '=', keyId).where('revoked_at', 'is', null).returning('id').execute();
  await ctx.db.deleteFrom('agent_oauth_tokens').where('key_id', '=', keyId).execute();
  if (ended.length) await audit(ctx, { action: 'agent_key.revoked', entityType: 'agent_key', entityId: keyId, after: { reason } });
}

async function exchangeCode(app: App, form: Record<string, unknown>): Promise<OAuthTokenAnswer> {
  const clientId = str(form.client_id);
  if (!clientId) throw new OAuthFlowError('invalid_request', 'client_id is required.');
  if (!isSecret('code', form.code)) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  const codeHash = hashToken(form.code);
  // Sign-in: the org is not known until the code is found, so it is found outside any tenant.
  const row = await app.db
    .selectFrom('agent_oauth_codes')
    .select(['org_id', 'staff_id', 'client_id', 'client_name', 'redirect_uri', 'code_challenge', 'resource', 'scopes', 'venue_ids', 'can_write', 'lasts_days', 'expires_at', 'used_at', 'key_id'])
    .where('code_hash', '=', codeHash)
    .executeTakeFirst();
  // One answer for every way a code can be wrong, so nothing is learned from which.
  if (!row || row.client_id !== clientId) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  const redirectUri = str(form.redirect_uri);
  if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  const resource = str(form.resource);
  if (resource !== undefined && !sameResource(resource, row.resource)) throw new OAuthFlowError('invalid_target', 'resource must be the one the person agreed to.');
  if (!verifyPkce(form.code_verifier, row.code_challenge)) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);

  const out = await app.tenant(row.org_id, SIGNIN, async (ctx): Promise<OAuthTokenAnswer | { refused: string }> => {
    const now = ctx.now();
    // The claim: exactly one exchange wins; a second finds the code used.
    const claimed = await ctx.db.updateTable('agent_oauth_codes').set({ used_at: now }).where('code_hash', '=', codeHash).where('used_at', 'is', null).where('expires_at', '>', now).returning('code_hash').executeTakeFirst();
    if (!claimed) {
      // Presented a second time: what the first exchange made is ended (RFC 6749 section 4.1.2).
      // Returned, not thrown, so the ending is committed.
      if (row.used_at && row.key_id) await endConnection(ctx, row.key_id, 'code_replay');
      return { refused: INVALID_GRANT };
    }
    const venueIds = row.venue_ids ?? (await ctx.db.selectFrom('venues').select('id').execute()).map((v) => v.id);
    const states = await hubStates(ctx, venueIds);
    const on = venueIds.filter((id) => states.get(id)!.enabled);
    const cap = on.length ? Math.min(...on.map((id) => states.get(id)!.config.max_keys_per_staff)) : 0;
    const live = await ctx.db.selectFrom('agent_keys').select((eb) => eb.fn.countAll<string>().as('n')).where('staff_id', '=', row.staff_id).where('revoked_at', 'is', null).where('expires_at', '>', now).executeTakeFirstOrThrow();
    if (Number(live.n) >= cap) return { refused: `You already hold ${live.n} assistant connections, which is the most allowed here. End one in the console, then connect again.` };
    const expiresAt = new Date(now.getTime() + row.lasts_days * 86_400_000);
    const key = await ctx.db
      .insertInto('agent_keys')
      .values({
        org_id: ctx.orgId,
        staff_id: row.staff_id,
        name: row.client_name,
        key_prefix: 'signed in',
        // Never presented: an OAuth connection is reached through its tokens only.
        key_hash: hashToken(randomBytes(32).toString('base64url')),
        scopes: row.scopes,
        venue_ids: row.venue_ids,
        can_write: row.can_write,
        expires_at: expiresAt,
        created_at: now,
        kind: 'oauth',
        oauth_client_id: row.client_id,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await ctx.db.updateTable('agent_oauth_codes').set({ key_id: key.id }).where('code_hash', '=', codeHash).execute();
    await audit(ctx, { action: 'agent_key.created', entityType: 'agent_key', entityId: key.id, after: { kind: 'oauth', assistant: row.client_name, scopes: row.scopes, venueIds: row.venue_ids, canWrite: row.can_write, expiresAt: expiresAt.toISOString() } });
    return mintTokens(ctx, key.id, expiresAt, row.scopes);
  });
  if ('refused' in out) throw new OAuthFlowError('invalid_grant', out.refused);
  return out;
}

async function renew(app: App, form: Record<string, unknown>): Promise<OAuthTokenAnswer> {
  const clientId = str(form.client_id);
  if (!clientId) throw new OAuthFlowError('invalid_request', 'client_id is required.');
  if (!isSecret('refresh', form.refresh_token)) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  const resource = str(form.resource);
  if (resource !== undefined && !sameResource(resource, mcpResourceUrl(app))) throw new OAuthFlowError('invalid_target', 'resource must be the address of this MCP server.');
  const hash = hashToken(form.refresh_token);
  const token = await app.db.selectFrom('agent_oauth_tokens').select(['org_id', 'key_id']).where('token_hash', '=', hash).where('kind', '=', 'refresh').executeTakeFirst();
  if (!token) throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  const failure = await app.tenant(token.org_id, SIGNIN, async (ctx): Promise<OAuthTokenAnswer | 'reused' | 'bad'> => {
    const now = ctx.now();
    const key = await ctx.db.selectFrom('agent_keys').select(['id', 'scopes', 'expires_at', 'revoked_at', 'oauth_client_id']).where('id', '=', token.key_id).executeTakeFirst();
    if (!key || key.oauth_client_id !== clientId || key.revoked_at || key.expires_at <= now) return 'bad';
    const spent = await ctx.db.updateTable('agent_oauth_tokens').set({ used_at: now }).where('token_hash', '=', hash).where('used_at', 'is', null).where('expires_at', '>', now).returning('token_hash').executeTakeFirst();
    if (!spent) {
      const used = await ctx.db.selectFrom('agent_oauth_tokens').select('used_at').where('token_hash', '=', hash).executeTakeFirst();
      return used?.used_at ? 'reused' : 'bad';
    }
    // The old access tokens go with the old renewal token.
    await ctx.db.deleteFrom('agent_oauth_tokens').where('key_id', '=', key.id).where('kind', '=', 'access').execute();
    return mintTokens(ctx, key.id, key.expires_at, key.scopes);
  });
  if (failure === 'reused') {
    // A renewal token presented twice means two holders: the connection ends.
    await app.tenant(token.org_id, SIGNIN, (ctx) => endConnection(ctx, token.key_id, 'token_reuse'));
    throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  }
  if (failure === 'bad') throw new OAuthFlowError('invalid_grant', INVALID_GRANT);
  return failure;
}

/** The token endpoint: a code becomes a connection once; a connection renews itself. */
export async function oauthToken(app: App, form: Record<string, unknown>): Promise<OAuthTokenAnswer> {
  const grant = str(form.grant_type);
  if (grant === 'authorization_code') return exchangeCode(app, form);
  if (grant === 'refresh_token') return renew(app, form);
  throw new OAuthFlowError('unsupported_grant_type', 'grant_type must be "authorization_code" or "refresh_token".');
}

/** An assistant ends its own connection (RFC 7009). The same answer whether or not the token was ours. */
export async function oauthRevoke(app: App, form: Record<string, unknown>): Promise<void> {
  const tokenValue = form.token;
  const clientId = str(form.client_id);
  if (!clientId || !(isSecret('access', tokenValue) || isSecret('refresh', tokenValue))) return;
  const token = await app.db.selectFrom('agent_oauth_tokens').select(['org_id', 'key_id']).where('token_hash', '=', hashToken(tokenValue)).executeTakeFirst();
  if (!token) return;
  await app.tenant(token.org_id, SIGNIN, async (ctx) => {
    const key = await ctx.db.selectFrom('agent_keys').select('oauth_client_id').where('id', '=', token.key_id).executeTakeFirst();
    if (key?.oauth_client_id === clientId) await endConnection(ctx, token.key_id, 'assistant');
  });
}

// ── Web-standard handlers ───────────────────────────────────────────────────

/** What the server publishes about sign-in (RFC 8414). */
export function oauthServerMetadata(app: App): OAuthMetadata {
  const e = oauthEndpoints(app);
  return {
    issuer: oauthIssuer(app),
    authorization_endpoint: e.authorize,
    token_endpoint: e.token,
    registration_endpoint: e.register,
    revocation_endpoint: e.revoke,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['read', 'write'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: e.documentation,
  } as OAuthMetadata;
}

function oauthJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' } });
}

async function formOf(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('content-type') ?? '';
  const text = (await request.text()).slice(0, 16_384);
  if (type.includes('application/json')) {
    try {
      return toRecord(JSON.parse(text));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text).entries());
}

export interface OAuthRequestOptions {
  /** The client's address as the host that mounted the endpoint trusts it. Registration is rate-limited by it. */
  ip?: string;
}

/**
 * Every sign-in endpoint the web app mounts, in one web-standard handler. Answers the request, or
 * returns null when the path is not one of these (fall through to the app's own routing):
 *
 *   GET  /.well-known/oauth-protected-resource/api/mcp   (and without the path) RFC 9728
 *   GET  /.well-known/oauth-authorization-server         RFC 8414
 *   POST /api/hub/oauth/register                         RFC 7591
 *   POST /api/hub/oauth/token                            code exchange and renewal
 *   POST /api/hub/oauth/revoke                           RFC 7009
 *
 * The consent page (/console/oauth/authorize) is the console's: it calls reviewOAuthRequest and
 * decideOAuthRequest inside the signed-in person's own tenant transaction.
 */
export async function handleOAuthRequest(app: App, request: Request, opts: OAuthRequestOptions = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname.replace(/\/+$/, '');
  if (path === '/.well-known/oauth-protected-resource' || path.startsWith('/.well-known/oauth-')) {
    const meta = {
      oauthMetadata: oauthServerMetadata(app),
      resourceServerUrl: new URL(mcpResourceUrl(app)),
      serviceDocumentationUrl: new URL(oauthEndpoints(app).documentation),
      scopesSupported: ['read', 'write'],
      resourceName: 'Restaurant OS',
      // Local and test hosts are plain http; production is always https.
      ...(app.config.scheme === 'http' && app.config.env !== 'production' ? { dangerouslyAllowInsecureIssuerUrl: true } : {}),
    };
    // The protected-resource document at the root, for an assistant given the bare host.
    const asked = path === '/.well-known/oauth-protected-resource' ? new Request(new URL(`/.well-known/oauth-protected-resource${MCP_PATH}`, request.url), { method: request.method, headers: request.headers }) : request;
    return oauthMetadataResponse(asked, meta) ?? null;
  }
  if (!path.startsWith(OAUTH_PATH)) return null;
  const which = path.slice(OAUTH_PATH.length);
  if (!['/token', '/register', '/revoke'].includes(which)) return null;
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  try {
    if (which === '/register') {
      // Anybody may register, so how fast is what is limited.
      await rateLimit(app, `hub:oauth-register:${opts.ip ?? 'unknown'}`, { limit: 20, windowSeconds: 3600 });
      let body: unknown = {};
      try {
        body = JSON.parse((await request.text()).slice(0, 16_384));
      } catch {
        throw new OAuthFlowError('invalid_client_metadata', 'The registration must be JSON.');
      }
      return oauthJson(201, await registerOAuthClient(app, body));
    }
    const form = await formOf(request);
    if (which === '/token') {
      await rateLimit(app, `hub:oauth-token:${opts.ip ?? 'unknown'}`, { limit: 60, windowSeconds: 60 });
      return oauthJson(200, await oauthToken(app, form));
    }
    await oauthRevoke(app, form);
    return oauthJson(200, {});
  } catch (e) {
    if (e instanceof OAuthFlowError) return oauthJson(e.status, { error: e.error, error_description: e.description });
    if (e instanceof AppError && e.code === 'rate_limited') return oauthJson(429, { error: 'slow_down', error_description: e.message });
    app.log.error('hub oauth request failed', { path: which, error: (e as Error).message?.slice(0, 300) });
    return oauthJson(503, { error: 'server_error', error_description: 'Sign-in could not answer just now. Try again in a moment.' });
  }
}
