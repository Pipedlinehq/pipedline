import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  readRequestBody,
  type CallToolResult,
  type InputRequiredResult,
  type McpHttpHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { type App, getTool, isAppError, rateLimit } from '@ros/core';
import { type Asking, SAID, type ToolOutcome, runTool } from './calls';
import { CATALOGUE_URI, type Offer, catalogueText, serverInstructions } from './catalogue';
import { CONFIRM_SCHEMA, type ConfirmState, canAsk as assistantCanAsk, confirmCodec, consoleUrl } from './confirm';
import { type PlugOffer, type Withdrawal, loadPlugOffers, plugCandidates, plugEnvelope, runPlugTool } from './gateway';
import { type ResolvedAgentKey, bearerKey, resolveAgentKey } from './keys';
import { offeredTools } from './offer';
import { plugNamespace } from './plugs';
import { oauthEndpoints } from './address';

/**
 * The venue's MCP server: the tools one access key may use (docs/modules/hub.md sections 1a
 * and 2). Ported from Criota's `mcp/server.ts` and `routes/mcp.ts`.
 *
 * Built per request for the identity the key resolved to, so nothing is shared between two
 * callers and nothing is remembered between two requests: any instance can answer any request,
 * including the second half of a confirmation. It serves both protocol generations from the
 * same tools: an assistant on the current revision (2026-07-28), and one that still opens with
 * `initialize`, which can read and is never offered a change (it cannot be asked a question).
 *
 * The tenant is the key's organisation. No tool takes an organisation, and `venue` only chooses
 * among the venues the key already sees.
 */
export const SERVER_INFO = { name: 'restaurant-os', title: 'Pipedline', version: '1.0.0' } as const;

/** What the server is told about the assistant on the other end. */
export interface ClientFacts {
  era: 'legacy' | 'modern';
  /** What the assistant declared it can do, as it sent it. */
  capabilities?: unknown;
}

export interface PlugOffers {
  offers: PlugOffer[];
  withdrawn: Withdrawal[];
}

function respond(result: ToolOutcome): CallToolResult | InputRequiredResult {
  if (result.ok) return { content: [{ type: 'text', text: JSON.stringify(result.output) }], structuredContent: result.output };
  if (result.ask) {
    return inputRequired({
      inputRequests: { confirm: inputRequired.elicit({ message: result.ask.question, requestedSchema: CONFIRM_SCHEMA }) },
      requestState: result.ask.requestState,
    });
  }
  return { isError: true, content: [{ type: 'text', text: result.message }] };
}

/** The server for one request. Exported so it can be driven without HTTP. */
export function buildServer(app: App, caller: ResolvedAgentKey, client: ClientFacts = { era: 'legacy' }, plugs: PlugOffers = { offers: [], withdrawn: [] }): McpServer {
  const asks = assistantCanAsk(client.era, client.capabilities);
  const codec = confirmCodec(app);
  const offer: Offer = {
    tools: offeredTools(caller, { canAsk: asks }),
    services: plugCandidates(app, caller).map((p) => ({ name: p.name, namespace: plugNamespace(p.key) })),
    plugs: plugs.offers,
    withdrawn: plugs.withdrawn,
    canAsk: asks,
  };

  const server = new McpServer(SERVER_INFO, {
    instructions: serverInstructions(app, caller, offer),
    // Said on every request, whatever is registered for this one: a key whose only tools are a
    // plug's has none on the request that opens the connection, and an assistant that is told
    // "no tools" then never asks for the list.
    capabilities: { tools: {} },
    // The note that travels with a question is verified before any tool sees it.
    requestState: { verify: codec.verify },
  });

  const asking = (mcp: ServerContext): Asking => ({
    canAsk: assistantCanAsk(client.era, (mcp.mcpReq.envelope as Record<string, unknown> | undefined)?.[CLIENT_CAPABILITIES_META_KEY] ?? client.capabilities),
    inputResponses: mcp.mcpReq.inputResponses,
    state: mcp.mcpReq.requestState<ConfirmState>(),
    mint: (state) => codec.mint(state, mcp),
  });

  // One tool that cannot be published (a shape with no JSON Schema form, say) must not take the rest down with it.
  const register = (name: string, add: () => void) => {
    try {
      add();
    } catch (e) {
      app.log.error('hub: a tool could not be offered', { tool: name, error: (e as Error).message?.slice(0, 300) });
    }
  };

  for (const offered of offer.tools) {
    const { tool } = offered;
    const writes = tool.effect === 'write';
    register(tool.name, () => server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: offered.input as unknown as StandardSchemaWithJSON,
        outputSchema: tool.output as unknown as StandardSchemaWithJSON,
        annotations: {
          title: tool.title,
          readOnlyHint: !writes,
          destructiveHint: false,
          idempotentHint: !writes,
          // Everything one of our own tools touches is this organisation's data here.
          openWorldHint: false,
        },
      },
      async (args: unknown, mcp: ServerContext) => respond(await runTool(app, caller, offered, args ?? {}, writes ? asking(mcp) : undefined)),
    ));
  }

  for (const plug of offer.plugs) {
    for (const tool of plug.tools) {
      const writes = tool.effect === 'write';
      const title = tool.remote.title ?? tool.remote.name;
      register(tool.name, () => server.registerTool(
        tool.name,
        {
          title: `${plug.plug.name}: ${title}`,
          // The reviewed words, with whose they are said first. The live copy is never shown.
          description: `From ${plug.plug.name}, a service this venue connected. ${tool.remote.description ?? title}`,
          inputSchema: fromJsonSchema(tool.remote.inputSchema as never),
          outputSchema: plugEnvelope as unknown as StandardSchemaWithJSON,
          annotations: {
            title: `${plug.plug.name}: ${title}`,
            readOnlyHint: !writes,
            destructiveHint: tool.remote.annotations?.destructiveHint ?? false,
            idempotentHint: !writes && tool.remote.annotations?.idempotentHint === true,
            // A connected service is outside this platform.
            openWorldHint: true,
          },
        },
        async (args: unknown, mcp: ServerContext) => respond(await runPlugTool(app, caller, plug, tool, args ?? {}, writes ? asking(mcp) : undefined)),
      ));
    }
  }

  server.registerResource(
    'catalogue',
    CATALOGUE_URI,
    { title: 'What this connection can do', description: 'The venues this access key sees, what each tool is for, and how a change is confirmed.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: catalogueText(app, caller, offer) }] }),
  );

  return server;
}

/** What handleMcpRequest found out, carried to the server that is built for this one request. */
interface RequestCaller {
  key: ResolvedAgentKey;
  capabilities: unknown;
  plugs: { wanted: boolean; only?: string };
}

const handlers = new WeakMap<App, McpHttpHandler>();

// One handler for the life of an App; one SERVER per request. The handler holds nothing between requests.
function handlerFor(app: App): McpHttpHandler {
  let handler = handlers.get(app);
  if (!handler) {
    handler = createMcpHandler(
      async ({ era, authInfo }) => {
        const caller = authInfo?.extra?.caller as RequestCaller | undefined;
        // handleMcpRequest resolves the key before this on every request. No caller, no server.
        if (!caller) throw new Error('mcp request reached the server without an identity');
        const asks = assistantCanAsk(era, caller.capabilities);
        // A plug's live tool list is read only by a request that needs it: a list, the catalogue, or a call to one of its tools.
        const plugs = caller.plugs.wanted ? await loadPlugOffers(app, caller.key, { canAsk: asks, only: caller.plugs.only }) : { offers: [], withdrawn: [] };
        return buildServer(app, caller.key, { era, capabilities: caller.capabilities }, plugs);
      },
      { legacy: 'stateless', onerror: (e) => app.log.warn('mcp request refused or failed', { error: e.message }) },
    );
    handlers.set(app, handler);
  }
  return handler;
}

type Message = { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } } | null | undefined;

/** What the assistant said it can do, from the request's own envelope. Absent on the older protocol. */
function declaredCapabilities(body: unknown): unknown {
  const first = (Array.isArray(body) ? body[0] : body) as Message;
  return first?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
}

/** Whether this request needs any plug's live tool list, and whether one plug's is enough. */
function plugNeeds(body: unknown): { wanted: boolean; only?: string } {
  const namespaces = new Set<string>();
  for (const m of (Array.isArray(body) ? body : [body]) as Message[]) {
    if (m?.method === 'tools/list' || m?.method === 'resources/read') return { wanted: true };
    if (m?.method !== 'tools/call') continue;
    const name = typeof m.params?.name === 'string' ? m.params.name : '';
    const at = name.indexOf('__');
    // One of our own tools is never looked for at a plug, whatever it is called.
    if (at > 0 && !getTool(name)) namespaces.add(name.slice(0, at));
  }
  if (!namespaces.size) return { wanted: false };
  return namespaces.size === 1 ? { wanted: true, only: [...namespaces][0] } : { wanted: true };
}

/** A JSON-RPC error, which is the only kind of error an MCP client reads. */
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export interface McpRequestOptions {
  /** The client's address as the host that mounted the endpoint trusts it (never read from a header here). */
  ip?: string;
}

/**
 * The MCP endpoint: one message in, one answer out. Web-standard, so any host can mount it.
 *
 *   POST    an assistant lists the tools, calls one, or answers a question
 *   other   405: there is no stream to open and no session to end
 *
 * The caller is an assistant, and what it presents is an access key a staff member created.
 * Every refusal of a key is the same 401, whether it is malformed, unknown, revoked, expired,
 * its person disabled, or assistants switched off wherever it could see.
 */
export async function handleMcpRequest(app: App, request: Request, opts: McpRequestOptions = {}): Promise<Response> {
  if (request.method !== 'POST') return rpcError(405, -32000, 'Method not allowed. Send MCP messages with POST.', { Allow: 'POST' });

  let key: ResolvedAgentKey | null;
  try {
    key = await resolveAgentKey(app, bearerKey(request.headers.get('authorization')));
  } catch (e) {
    // The key could not be checked. That is not a yes.
    app.log.error('mcp key check failed', { error: (e as Error).message?.slice(0, 300) });
    return rpcError(503, -32002, 'The access key could not be checked just now. Try again in a moment.');
  }
  if (!key) {
    // The challenge says where sign-in is described (RFC 9728), so an assistant given only this
    // address can send its person to sign in instead of asking them to paste a key.
    const presented = bearerKey(request.headers.get('authorization'));
    const error = presented ? ', error="invalid_token", error_description="The access key or sign-in is not valid, has expired, or was ended."' : '';
    return rpcError(401, -32001, `Sign in from your assistant, or send an access key created in the console at ${consoleUrl(app)} as "Authorization: Bearer <key>".`, {
      'WWW-Authenticate': `Bearer realm="restaurant-os-hub"${error}, resource_metadata="${oauthEndpoints(app).resourceMetadata}", scope="read write"`,
    });
  }
  if (opts.ip) key.ip = opts.ip;

  try {
    // Every request costs a key lookup, so requests are bounded too. Tool calls have their own, tighter allowance.
    await rateLimit(app, `hub:req:${key.keyId}`, { limit: key.limits.calls_per_key_per_minute * 4, windowSeconds: 60 }, SAID.tooMany);
  } catch (e) {
    if (isAppError(e) && e.code === 'rate_limited') return rpcError(429, -32000, e.message, { 'Retry-After': '60' });
    throw e;
  }

  const body = await readRequestBody(request);
  if (body.tooLarge) return rpcError(413, -32600, 'That request is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    parsed = undefined;
  }

  const caller: RequestCaller = { key, capabilities: declaredCapabilities(parsed), plugs: plugNeeds(parsed) };
  // The key itself goes no further: what travels on is who it resolved to. `clientId` is what a confirmation is bound to.
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  const inner = new Request(request.url, { method: 'POST', headers, body: body.text });
  try {
    return await handlerFor(app).fetch(inner, {
      authInfo: { token: 'resolved', clientId: key.keyId, scopes: key.principal.scopes, extra: { caller } },
      ...(parsed !== undefined ? { parsedBody: parsed } : {}),
    });
  } catch (e) {
    app.log.error('mcp request failed', { keyId: key.keyId, error: (e as Error).message?.slice(0, 300) });
    return rpcError(500, -32603, SAID.unavailable);
  }
}
