/**
 * An assistant that connects by signing in, as the official MCP client does it. Ported from
 * Criota's tests/helpers/mcpOauthClient.ts: `auth()` from the MCP client SDK runs the whole of
 * the assistant's side (discovery, registration, PKCE, the exchange, renewal). What it cannot do
 * is be the person: the test plays that part between `start` and `finish`, by calling the
 * console's consent functions as a signed-in member of staff. Nothing goes over a network.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, auth, type OAuthClientProvider } from '@modelcontextprotocol/client';
import { type App, createApp, tableSecretStore } from '@ros/core';
import { hub } from '@ros/modules';

export const ORIGIN = 'https://console.rosplatform.test';

/**
 * The test app speaks plain http; sign-in is only ever served over https (the MCP client refuses
 * to send a code to a plain-http token endpoint anywhere but localhost). So these tests use the
 * same database, providers and clock under an https configuration, as production has it.
 */
export function httpsApp(app: App): App {
  return createApp({ db: app.db, config: { ...app.config, scheme: 'https' }, adapters: app.adapters, secrets: tableSecretStore, clock: app.clock, log: app.log });
}
export const MCP = `${ORIGIN}/api/mcp`;
export const REDIRECT = 'http://127.0.0.1:33418/callback';

/** Every sign-in endpoint and the MCP endpoint, as the web app mounts them. */
export function platformFetch(app: App): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    if (path === '/api/mcp') return hub.handleMcpRequest(app, req, { ip: '203.0.113.20' });
    return (await hub.handleOAuthRequest(app, req, { ip: '203.0.113.20' })) ?? new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export interface HeldTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export function assistant(app: App, opts: { name?: string; scope?: string } = {}) {
  let info: Record<string, unknown> | undefined;
  let held: HeldTokens | undefined;
  let codeVerifier = '';
  let sentTo: URL | undefined;
  let discovery: unknown;
  const fetchFn = platformFetch(app);

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return REDIRECT;
    },
    get clientMetadata() {
      return { client_name: opts.name ?? 'Test Assistant', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(opts.scope ? { scope: opts.scope } : {}) };
    },
    state: () => `st-${randomBytes(6).toString('hex')}`,
    clientInformation: () => info as never,
    saveClientInformation: (i) => {
      info = i as unknown as Record<string, unknown>;
    },
    tokens: () => held as never,
    saveTokens: (t) => {
      held = t as unknown as HeldTokens;
    },
    redirectToAuthorization: (url) => {
      sentTo = url;
    },
    saveCodeVerifier: (v) => {
      codeVerifier = v;
    },
    codeVerifier: () => codeVerifier,
    saveDiscoveryState: (s) => {
      discovery = s;
    },
    discoveryState: () => discovery as never,
    invalidateCredentials: (scope) => {
      if (scope === 'all' || scope === 'tokens') held = undefined;
      if (scope === 'all' || scope === 'client') info = undefined;
      if (scope === 'all' || scope === 'verifier') codeVerifier = '';
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
    },
  };

  return {
    async start(): Promise<URL> {
      sentTo = undefined;
      const result = await auth(provider, { serverUrl: MCP, fetchFn: fetchFn as never, ...(opts.scope ? { scope: opts.scope } : {}) });
      if (result !== 'REDIRECT' || !sentTo) throw new Error(`expected to be sent to sign in, got ${result}`);
      return sentTo;
    },
    async finish(cameBackTo: string): Promise<string> {
      const back = new URL(cameBackTo);
      const code = back.searchParams.get('code');
      if (!code) throw new Error(`came back with no code: ${back.searchParams.get('error') ?? 'nothing'}`);
      return auth(provider, { serverUrl: MCP, fetchFn: fetchFn as never, authorizationCode: code, ...(back.searchParams.get('iss') ? { iss: back.searchParams.get('iss')! } : {}) } as never);
    },
    renew: () => auth(provider, { serverUrl: MCP, fetchFn: fetchFn as never }),
    tokens: () => held,
    setTokens: (t: HeldTokens | undefined) => {
      held = t;
    },
    clientId: () => info?.client_id as string | undefined,
    verifier: () => codeVerifier,
    async connect() {
      const transport = new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider, fetch: fetchFn as never });
      const client = new Client({ name: opts.name ?? 'Test Assistant', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(transport);
      return {
        async tools() {
          return (await client.listTools(undefined, { cacheMode: 'bypass' } as never)).tools.map((t) => t.name).sort();
        },
        async call(name: string, args: Record<string, unknown> = {}) {
          const r = (await client.callTool({ name, arguments: args })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: Record<string, unknown> };
          return { isError: r.isError === true, text: (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n'), structured: r.structuredContent ?? null };
        },
        close: () => client.close(),
      };
    },
  };
}

/** A PKCE pair, for requests written by hand. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** POST a form to a sign-in endpoint. */
export async function post(app: App, path: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, any> }> {
  const res = await platformFetch(app)(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export async function register(app: App, redirectUris = [REDIRECT]): Promise<string> {
  const res = await platformFetch(app)(`${ORIGIN}/api/hub/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Hand-written assistant', redirect_uris: redirectUris, token_endpoint_auth_method: 'none' }) });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

/** The query an assistant sends its person to, written by hand. */
export function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'abc', resource: MCP, ...extra });
}
