import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type App,
  type ConnectionHandle,
  type OAuthPort,
  type OAuthTokens,
  type PlugDef,
  type Principal,
  AppError,
  OAuthRefusedError,
  defineJob,
  defineSchedule,
  enqueue,
  getPlug,
  hmacHex,
  invalid,
  listPlugs,
  localDate,
  markConnectionHealth,
  notFound,
  requireStaff,
  resolveConnection,
  revokeConnection,
  safeEqual,
  staffOf,
  updateConnectionCredentials,
  audit,
  type Ctx,
} from '@ros/core';
import { queueMessage } from '../comms/outbox';
import { defineTemplate } from '../comms/templates';
import { MAX_BACKFILL_MONTHS, type PosConnection, type PosConnectionView, connectPos, livePosConnections, loadPosConnection } from './ingest';

/**
 * Connecting a point of sale by signing in at the provider (OAuth), keeping that access alive,
 * and ending it. Square is the first such plug; nothing here names it.
 *
 * The flow, as the console drives it:
 *   1. startPosOAuth      → the provider's sign-in URL, carrying a signed `state`
 *   2. the provider redirects back to the console with `code` and `state`
 *   3. completePosOAuth   → exchanges the code. One location: connected. Several: the tokens
 *                           are sealed in the secret store and the console is handed the list
 *   4. finishPosOAuth     → connects the chosen location (or cancelPosOAuth to walk away)
 *
 * Access tokens expire. `ledger.pos_oauth_sweep` runs on a schedule and queues one
 * `ledger.pos_oauth_refresh` per connection; a refresh the provider refuses marks the
 * connection unhealthy and tells whoever connected it.
 *
 * Provider calls are never made inside a tenant transaction. Tokens are held only in the
 * secret store: never on a row, in a job payload, in the audit log or in a log line.
 */
const WORKER = { kind: 'worker' as const, job: 'ledger.pos_oauth' };
const STATE_TTL_MS = 15 * 60_000;
const PENDING_TTL_MS = 30 * 60_000;
const SWEEP_EVERY_MINUTES = 360;

export const posReconnect = defineTemplate({
  key: 'ledger.pos_reconnect',
  channel: 'email',
  kind: 'transactional',
  description: 'Tells the person who connected a point of sale that its sign-in has ended, so sales have stopped arriving until it is connected again.',
  subject: '{{service}} needs connecting again',
  body: 'Hi {{first_name}},\n\n{{service}} is no longer accepting the sign-in saved for {{org_name}}, so sales have stopped arriving from it and online orders cannot be paid through it.\n\nConnect it again at {{console_url}}.',
  variables: z.object({ first_name: z.string(), service: z.string(), console_url: z.string().url() }),
});

// ── signed tokens (state, pending) ───────────────────────────────────────────────────────────

function sign(app: App, purpose: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmacHex(app.config.signingKey, `${purpose}:${body}`)}`;
}

function unsign<T>(app: App, purpose: string, token: string, schema: z.ZodType<T>): T | null {
  const [body, sig, ...rest] = token.split('.');
  if (!body || !sig || rest.length) return null;
  if (!safeEqual(sig, hmacHex(app.config.signingKey, `${purpose}:${body}`))) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const stateShape = z.object({
  o: z.string().uuid(),
  v: z.string().uuid(),
  s: z.string().uuid(),
  p: z.string(),
  sc: z.array(z.string()),
  b: z.number().int().min(0),
  n: z.string(),
  e: z.number(),
});
type OAuthState = z.infer<typeof stateShape>;

const pendingShape = z.object({ o: z.string().uuid(), s: z.string().uuid(), r: z.string().uuid(), e: z.number() });

const heldShape = z.object({
  state: stateShape,
  tokens: z.object({ accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.string().nullable(), externalAccountId: z.string() }),
  locations: z.array(z.object({ ref: z.string(), name: z.string(), timezone: z.string().optional() })),
});

const EXPIRED = 'That sign-in has expired. Start connecting again.';

/** The plug, if it is a point of sale connected by sign-in and this deployment holds its application credentials. */
function oauthPosPlug(app: App, plugKey: string): { plug: PlugDef; oauth: OAuthPort } {
  const plug = getPlug(plugKey);
  if (plug.simulated && app.config.env === 'production') throw notFound('That service is not in the catalogue.');
  if (!plug.adapters.pos || plug.auth !== 'oauth') throw invalid(`${plug.name} is not connected by signing in.`);
  if (!app.adapters.has('oauth', plug.key)) throw new AppError('unavailable', `${plug.name} sign-in is not set up on this platform yet.`);
  return { plug, oauth: app.adapters.get('oauth', plug.key) };
}

/** A person at the console, not an assistant acting for one: connecting a till is a person's decision. */
function staffIdOf(principal: Principal): string {
  if (principal.kind !== 'staff') throw new AppError('forbidden', 'Sign in to the console to connect a point of sale.');
  return principal.staffId;
}

// ── 1 · start ────────────────────────────────────────────────────────────────────────────────

const startInput = z.object({
  plugKey: z.string().min(1).max(60),
  venueId: z.string().uuid(),
  /** What to ask the seller for. Default: everything the plug may be granted. */
  scopes: z.array(z.string().min(1).max(80)).max(40).optional(),
  backfillMonths: z.number().int().min(0).max(MAX_BACKFILL_MONTHS).default(0),
});

export interface PosOAuthStart {
  /** Send the browser here. */
  url: string;
  /** The same value the provider will hand back on the redirect. */
  state: string;
  expiresAt: Date;
}

/** Begin connecting a venue's point of sale by sign-in. A manager of that venue, at the console. */
export async function startPosOAuth(ctx: Ctx, raw: z.input<typeof startInput>): Promise<PosOAuthStart> {
  const input = startInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  return beginPosOAuth(ctx, input, staffIdOf(ctx.principal));
}

/** Scopes that only read, by the providers' own naming (`…_READ`, `…:read`). */
export function readOnlyScopes(plug: PlugDef): string[] {
  return plug.scopes.filter((s) => /(_READ|:read)$/.test(s));
}

const signInInput = startInput.omit({ scopes: true }).extend({
  /** read_only asks the provider for nothing that changes anything there: sales in, nothing out. */
  access: z.enum(['read_only', 'full']).default('full'),
});

/**
 * The same start, asked for by a manager's assistant (docs/PIPEDLINE.md `connection_start`).
 * The assistant is handed the provider's sign-in address and nothing else. The address carries a
 * signed `state` bound to the staff member behind the assistant, so only that person, signed in
 * at the console in their own browser, can finish it (completePosOAuth still takes a console
 * session and nothing else). No token, secret or location is ever returned here.
 */
export async function startPosSignIn(ctx: Ctx, raw: z.input<typeof signInInput>): Promise<{ plugKey: string; plugName: string; url: string; expiresAt: Date; scopes: string[] }> {
  const input = signInInput.parse(raw);
  requireStaff(ctx, { venueId: input.venueId, minRole: 'manager' });
  const staff = staffOf(ctx);
  if (!staff) throw new AppError('forbidden', 'Connecting a point of sale is done by a person, or by their assistant for them.');
  const { plug } = oauthPosPlug(ctx.app, input.plugKey);
  const scopes = input.access === 'read_only' ? readOnlyScopes(plug) : plug.scopes;
  if (!scopes.length) throw invalid(`${plug.name} has no read-only access to ask for.`);
  const started = await beginPosOAuth(ctx, { plugKey: input.plugKey, venueId: input.venueId, scopes, backfillMonths: input.backfillMonths }, staff.staffId);
  await audit(ctx, { action: 'connection.signin_started', entityType: 'connection', entityId: null, venueId: input.venueId, after: { plug: plug.key, scopes, access: input.access } });
  return { plugKey: plug.key, plugName: plug.name, url: started.url, expiresAt: started.expiresAt, scopes };
}

/** What a sign-in for this plug would ask for, without starting one: for the question put to the person. */
export function describePosSignIn(ctx: Ctx, raw: { plugKey: string; access?: 'read_only' | 'full' }): { plugName: string; scopes: string[] } {
  const { plug } = oauthPosPlug(ctx.app, raw.plugKey);
  return { plugName: plug.name, scopes: raw.access === 'read_only' ? readOnlyScopes(plug) : plug.scopes };
}

async function beginPosOAuth(ctx: Ctx, input: z.output<typeof startInput>, staffId: string): Promise<PosOAuthStart> {
  const { plug, oauth } = oauthPosPlug(ctx.app, input.plugKey);
  const scopes = input.scopes ?? plug.scopes;
  const unknown = scopes.filter((s) => !plug.scopes.includes(s));
  if (unknown.length) throw invalid(`${plug.name} cannot be granted: ${unknown.join(', ')}`);
  const expiresAt = new Date(ctx.now().getTime() + STATE_TTL_MS);
  const state = sign(ctx.app, 'pos-oauth-state', {
    o: ctx.orgId,
    v: input.venueId,
    s: staffId,
    p: plug.key,
    sc: scopes,
    b: input.backfillMonths,
    n: randomBytes(12).toString('base64url'),
    e: expiresAt.getTime(),
  } satisfies OAuthState);
  return { url: oauth.authorizeUrl({ state, scopes }), state, expiresAt };
}

// ── 2 · the redirect back ────────────────────────────────────────────────────────────────────

export interface PosOAuthCallback {
  /** From the signed-in session. Never from the query string. */
  orgId: string;
  principal: Principal;
  /** `state`, `code` and `error` exactly as the provider put them on the redirect. */
  state: string;
  code?: string | null;
  error?: string | null;
}

export type PosOAuthOutcome =
  | { status: 'connected'; connection: PosConnectionView }
  | { status: 'choose_location'; pending: string; locations: Array<{ ref: string; name: string; timezone?: string }>; expiresAt: Date }
  | { status: 'declined' };

function readState(app: App, args: { orgId: string; principal: Principal; state: string }): OAuthState {
  const st = unsign(app, 'pos-oauth-state', args.state, stateShape);
  // One answer for forged, expired, another org's and another person's: nothing to probe.
  if (!st || st.e < app.clock().getTime() || st.o !== args.orgId || st.s !== staffIdOf(args.principal)) throw invalid(EXPIRED);
  return st;
}

async function connectWithTokens(app: App, principal: Principal, st: OAuthState, oauth: OAuthPort, tokens: OAuthTokens, locationRef: string): Promise<PosConnectionView> {
  const defaults = oauth.connectionDefaults();
  return app.tenant(st.o, principal, (ctx) =>
    connectPos(ctx, {
      plugKey: st.p,
      venueId: st.v,
      externalAccountId: tokens.externalAccountId,
      locationRef,
      credentials: { ...defaults.credentials, accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) },
      scopes: st.sc,
      config: defaults.config,
      expiresAt: tokens.expiresAt,
      backfillMonths: st.b,
    }),
  );
}

/**
 * The provider sent the person back. Checks the state belongs to this person and org, checks
 * they may still connect that venue, exchanges the code, and either connects the account's
 * only location or hands back the list to choose from.
 *
 * Takes the App, not a Ctx: the exchange is a provider call and sits between transactions.
 */
export async function completePosOAuth(app: App, args: PosOAuthCallback): Promise<PosOAuthOutcome> {
  const st = readState(app, args);
  const { plug, oauth } = oauthPosPlug(app, st.p);
  if (args.error || !args.code) return { status: 'declined' };
  // The role is checked again now: it may have changed since the link was made.
  await app.tenant(st.o, args.principal, async (ctx) => void requireStaff(ctx, { venueId: st.v, minRole: 'manager' }));

  let tokens: OAuthTokens;
  try {
    tokens = await oauth.exchangeCode({ code: args.code });
  } catch (e) {
    if (e instanceof OAuthRefusedError) throw invalid(`${plug.name} did not accept that sign-in. Start connecting again.`);
    throw new AppError('provider_error', `${plug.name} could not be reached. Try again shortly.`);
  }

  const defaults = oauth.connectionDefaults();
  let locations: Array<{ ref: string; name: string; timezone?: string }>;
  try {
    locations = await app.adapters.get('pos', plug.adapters.pos!).listLocations({
      id: 'unconnected',
      orgId: st.o,
      venueId: st.v,
      plugKey: plug.key,
      externalAccountId: tokens.externalAccountId,
      scopes: st.sc,
      config: defaults.config,
      credentials: { accessToken: tokens.accessToken },
    });
  } catch {
    await oauth.revoke({ accessToken: tokens.accessToken, everything: false }).catch(() => undefined);
    throw new AppError('provider_error', `${plug.name} could not list its locations. Try connecting again shortly.`);
  }
  if (!locations.length) {
    await oauth.revoke({ accessToken: tokens.accessToken, everything: false }).catch(() => undefined);
    throw invalid(`That ${plug.name} account has no locations to connect.`);
  }

  if (locations.length === 1) {
    return { status: 'connected', connection: await connectWithTokens(app, args.principal, st, oauth, tokens, locations[0]!.ref) };
  }

  // Several locations: the person chooses. Until then the tokens wait sealed in the secret store.
  const expiresAt = new Date(app.clock().getTime() + PENDING_TTL_MS);
  const held: z.infer<typeof heldShape> = { state: st, tokens: { ...tokens, expiresAt: tokens.expiresAt?.toISOString() ?? null }, locations };
  const ref = await app.secrets.put(st.o, `oauth_pending:${plug.key}`, JSON.stringify(held));
  return { status: 'choose_location', pending: sign(app, 'pos-oauth-pending', { o: st.o, s: st.s, r: ref, e: expiresAt.getTime() }), locations, expiresAt };
}

// ── 3 · choosing a location ──────────────────────────────────────────────────────────────────

async function readPending(app: App, args: { orgId: string; principal: Principal; pending: string }): Promise<{ ref: string; held: z.infer<typeof heldShape>; expired: boolean }> {
  const p = unsign(app, 'pos-oauth-pending', args.pending, pendingShape);
  if (!p || p.o !== args.orgId || p.s !== staffIdOf(args.principal)) throw invalid(EXPIRED);
  let held: z.infer<typeof heldShape>;
  try {
    held = heldShape.parse(JSON.parse(await app.secrets.get(p.o, p.r)));
  } catch {
    throw invalid(EXPIRED);
  }
  return { ref: p.r, held, expired: p.e < app.clock().getTime() };
}

const tokensOf = (held: z.infer<typeof heldShape>): OAuthTokens => ({ ...held.tokens, expiresAt: held.tokens.expiresAt ? new Date(held.tokens.expiresAt) : null });

/** Connect the location chosen after completePosOAuth answered `choose_location`. */
export async function finishPosOAuth(app: App, args: { orgId: string; principal: Principal; pending: string; locationRef: string }): Promise<PosConnectionView> {
  const { ref, held, expired } = await readPending(app, args);
  const { oauth } = oauthPosPlug(app, held.state.p);
  if (expired) {
    await discardPending(app, args.orgId, ref, oauth, held);
    throw invalid(EXPIRED);
  }
  if (!held.locations.some((l) => l.ref === args.locationRef)) throw invalid('Choose one of the locations listed.');
  // connectPos checks the role again and refuses a location another venue already holds; the
  // sealed tokens stay until it succeeds, so the person can choose a different one.
  const view = await connectWithTokens(app, args.principal, held.state, oauth, tokensOf(held), args.locationRef);
  await app.secrets.remove(args.orgId, ref);
  return view;
}

async function discardPending(app: App, orgId: string, ref: string, oauth: OAuthPort, held: z.infer<typeof heldShape>): Promise<void> {
  await app.secrets.remove(orgId, ref);
  // Nothing was connected with it, so the token is ended at the provider too. Only this one:
  // the same account may be connected to another venue.
  await oauth.revoke({ accessToken: held.tokens.accessToken, everything: false }).catch((e) => {
    app.log.warn('ledger: an unused sign-in could not be revoked at the provider', { plug: held.state.p, error: (e as Error).message?.slice(0, 200) });
  });
}

/** The person walked away from the location list: forget the tokens and end them at the provider. */
export async function cancelPosOAuth(app: App, args: { orgId: string; principal: Principal; pending: string }): Promise<void> {
  const { ref, held } = await readPending(app, args);
  await discardPending(app, args.orgId, ref, oauthPosPlug(app, held.state.p).oauth, held);
}

// ── keeping it alive ─────────────────────────────────────────────────────────────────────────

/**
 * Mark a POS connection unhealthy and, when that is news, tell the person who connected it
 * (or the owners). Same shape as the hub's notice for a plug (hub/health.ts).
 */
async function markPosUnhealthy(app: App, conn: PosConnection, error: string): Promise<void> {
  await markConnectionHealth(app, conn.id, { ok: false, error });
  if (conn.row.status !== 'connected') return; // already known to be down: one notice, not one per sweep
  try {
    await app.tenant(conn.orgId, WORKER, async (ctx) => {
      const row = await ctx.db.selectFrom('connections').select(['connected_by_staff_id']).where('id', '=', conn.id).executeTakeFirst();
      let people = row?.connected_by_staff_id
        ? await ctx.db.selectFrom('staff').select(['id', 'first_name', 'email', 'status']).where('id', '=', row.connected_by_staff_id).execute()
        : [];
      people = people.filter((p) => p.status !== 'disabled');
      if (!people.length) people = await ctx.db.selectFrom('staff').select(['id', 'first_name', 'email', 'status']).where('is_owner', '=', true).where('status', '!=', 'disabled').execute();
      const org = await ctx.db.selectFrom('orgs').select('timezone').where('id', '=', ctx.orgId).executeTakeFirstOrThrow();
      const day = localDate(ctx.now(), org.timezone);
      for (const p of people) {
        await queueMessage(ctx, {
          templateKey: posReconnect.key,
          channel: 'email',
          to: p.email,
          venueId: conn.venueId,
          idempotencyKey: `ledger.pos_reconnect:${conn.id}:${p.id}:${day}`,
          variables: { first_name: p.first_name, service: getPlug(conn.plugKey).name, console_url: `${app.config.scheme}://${app.config.platformHost}/console` },
        });
      }
    });
  } catch (e) {
    // The connection is already marked; a notice that could not be queued must not undo that.
    app.log.error('ledger: could not queue the reconnect notice', { connectionId: conn.id, error: (e as Error).message?.slice(0, 200) });
  }
}

export type PosOAuthRefresh = 'refreshed' | 'not_due' | 'refused' | 'skipped';

/** True when a provider error says "these credentials are not accepted", as against "I am down". Adapters put the HTTP status on their errors. */
function saysUnauthorised(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 401 || status === 403;
}

/**
 * Renew one connection's access token if it is due (or `force`). Safe to run twice: the second
 * run finds a fresh token and does nothing.
 *
 *   refreshed  a new token is sealed and the connection is healthy
 *   not_due    the token has longer to live than the provider's renewal window
 *   refused    the provider no longer honours the sign-in: unhealthy, owner told
 *   skipped    not an OAuth connection, revoked, or this deployment has no credentials for it
 *
 * An outage throws, so the job retries; once the token has actually expired the connection is
 * marked unhealthy as well.
 */
export async function refreshPosOAuth(app: App, args: { orgId: string; connectionId: string; force?: boolean }): Promise<PosOAuthRefresh> {
  const conn = await app.tenant(args.orgId, WORKER, (ctx) => loadPosConnection(ctx, args.connectionId));
  if (!conn) return 'skipped';
  const plug = getPlug(conn.plugKey);
  if (plug.auth !== 'oauth' || !app.adapters.has('oauth', plug.key)) return 'skipped';
  const oauth = app.adapters.get('oauth', plug.key);
  const now = app.clock().getTime();
  const expiresAt = conn.row.expires_at?.getTime() ?? null;
  const expired = expiresAt !== null && expiresAt <= now;
  // An unhealthy connection is always tried: an expired token is the usual reason, and this is how it recovers.
  const due = args.force || conn.row.status === 'unhealthy' || expiresAt === null || expiresAt - now <= oauth.refreshAheadMs;
  if (!due) return 'not_due';

  let handle: ConnectionHandle;
  try {
    handle = await resolveConnection(app, conn.row);
  } catch {
    return 'skipped';
  }
  const refreshToken = handle.credentials.refreshToken;
  if (!refreshToken) {
    // Connected with a pasted token, or the provider issued no refresh token: it ends when it ends.
    if (expired) {
      await markPosUnhealthy(app, conn, `${plug.name} sign-in has expired and cannot be renewed.`);
      return 'refused';
    }
    return 'skipped';
  }

  let tokens: OAuthTokens;
  try {
    tokens = await oauth.refresh({ refreshToken });
  } catch (e) {
    if (e instanceof OAuthRefusedError) {
      // A refusal can also mean OUR application secret is wrong, which is not the venue's to
      // fix. If the access token we hold still works, the seller has not withdrawn anything.
      if (!expired) {
        try {
          await app.adapters.get('pos', plug.adapters.pos!).listLocations(handle);
          app.log.error('ledger: a token refresh was refused although the saved access token still works; check the application credentials', { plug: plug.key, connectionId: conn.id });
          throw new AppError('provider_error', `${plug.name} refused to renew a sign-in that is still valid.`);
        } catch (probe) {
          if (probe instanceof AppError) throw probe;
          if (!saysUnauthorised(probe)) throw new AppError('provider_error', `${plug.name} could not be reached. It will be tried again shortly.`);
        }
      }
      await markPosUnhealthy(app, conn, `${plug.name} no longer accepts the saved sign-in.`);
      return 'refused';
    }
    if (expired) await markPosUnhealthy(app, conn, `${plug.name} sign-in has expired and could not be renewed.`);
    throw new AppError('provider_error', `${plug.name} could not be reached. It will be tried again shortly.`);
  }

  if (tokens.externalAccountId !== conn.row.external_account_id) {
    // Never store a token for a different account under this connection.
    app.log.error('ledger: a refreshed token named a different account; it was not stored', { plug: plug.key, connectionId: conn.id });
    throw new AppError('provider_error', `${plug.name} answered for a different account.`);
  }
  await updateConnectionCredentials(app, conn.row, {
    credentials: { ...handle.credentials, accessToken: tokens.accessToken, ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}) },
    expiresAt: tokens.expiresAt,
  });
  return 'refreshed';
}

export const posOAuthRefreshJob = defineJob({
  kind: 'ledger.pos_oauth_refresh',
  schema: z.object({ connectionId: z.string().uuid() }),
  maxAttempts: 4,
  async handler(app, job) {
    if (!job.orgId) throw new Error('ledger.pos_oauth_refresh is an org job');
    await refreshPosOAuth(app, { orgId: job.orgId, connectionId: job.payload.connectionId });
  },
});

function oauthPosPlugKeys(app: App): string[] {
  return listPlugs()
    .filter((p) => p.adapters.pos && p.auth === 'oauth' && app.adapters.has('oauth', p.key))
    .map((p) => p.key);
}

export const posOAuthSweepJob = defineJob({
  kind: 'ledger.pos_oauth_sweep',
  schema: z.object({ bucket: z.string() }),
  maxAttempts: 3,
  async handler(app, job) {
    const orgId = job.orgId;
    if (!orgId) throw new Error('ledger.pos_oauth_sweep is an org job');
    const keys = oauthPosPlugKeys(app);
    // One job per connection, so one seller's revoked sign-in never holds up another venue's renewal.
    await app.tenant(orgId, WORKER, async (ctx) => {
      for (const conn of await livePosConnections(ctx)) {
        if (keys.includes(conn.plugKey)) await enqueue(ctx, posOAuthRefreshJob, { connectionId: conn.id }, { key: `sweep:${conn.id}:${job.payload.bucket}` });
      }
    });
  },
});

/**
 * Every six hours each sign-in connection is looked at; a token is renewed once it is inside
 * the provider's renewal window (for Square: a week old), so a missed run costs nothing.
 */
export const posOAuthSweepSchedule = defineSchedule({
  key: 'ledger.pos_oauth_sweep',
  everyMinutes: SWEEP_EVERY_MINUTES,
  scope: 'org',
  job: posOAuthSweepJob,
  payload: ({ bucket }) => ({ bucket: bucket.toISOString() }),
  async appliesTo(app, orgId) {
    const keys = oauthPosPlugKeys(app);
    if (!keys.length) return false;
    // app.db: the scheduler runs outside any tenant and asks only "does this org have a sign-in POS at all".
    const row = await app.db
      .selectFrom('connections')
      .select('id')
      .where('org_id', '=', orgId)
      .where('plug_key', 'in', keys)
      .where('status', 'in', ['connected', 'unhealthy'])
      .limit(1)
      .executeTakeFirst();
    return !!row;
  },
});

// ── ending it ────────────────────────────────────────────────────────────────────────────────

/**
 * Disconnect a point of sale: the connection is revoked here first (so nothing more is read or
 * charged through it whatever the provider answers), then the token is ended at the provider.
 * `revokedAtProvider: false` means the provider could not be told; the token then lapses on
 * its own expiry and the seller can remove the application in their own account.
 */
export async function disconnectPosOAuth(app: App, args: { orgId: string; principal: Principal; connectionId: string }): Promise<{ revokedAtProvider: boolean }> {
  const conn = await app.tenant(args.orgId, args.principal, async (ctx) => {
    const c = await loadPosConnection(ctx, args.connectionId);
    if (!c) throw notFound('Connection not found');
    requireStaff(ctx, { venueId: c.venueId, minRole: 'manager' });
    return c;
  });
  const plug = getPlug(conn.plugKey);
  const oauth = plug.auth === 'oauth' && app.adapters.has('oauth', plug.key) ? app.adapters.get('oauth', plug.key) : null;
  let accessToken: string | null = null;
  try {
    accessToken = (await resolveConnection(app, conn.row)).credentials.accessToken ?? null;
  } catch {
    accessToken = null;
  }
  // app.db: one merchant account can be connected to several venues, in this org or another.
  // Only when this is the last of them is the whole grant ended; otherwise just this token.
  const others = await app.db
    .selectFrom('connections')
    .select('id')
    .where('plug_key', '=', conn.plugKey)
    .where('external_account_id', '=', conn.row.external_account_id)
    .where('status', 'in', ['connected', 'unhealthy', 'pending'])
    .where('id', '!=', conn.id)
    .limit(1)
    .executeTakeFirst();

  await app.tenant(args.orgId, args.principal, (ctx) => revokeConnection(ctx, conn.id));

  if (!oauth || !accessToken) return { revokedAtProvider: false };
  try {
    await oauth.revoke({ accessToken, everything: !others });
    return { revokedAtProvider: true };
  } catch (e) {
    app.log.warn('ledger: a disconnected point of sale could not be revoked at the provider', { plug: plug.key, connectionId: conn.id, error: (e as Error).message?.slice(0, 200) });
    return { revokedAtProvider: false };
  }
}
