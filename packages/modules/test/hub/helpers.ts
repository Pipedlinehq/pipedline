/**
 * An MCP client, as an assistant would be one, talking to the hub's real request handler.
 * Ported from Criota's tests/helpers/mcpClient.ts. Nothing goes over a network: the client's
 * fetch is the handler itself.
 *
 * Three of them, because assistants come in three kinds:
 *   - `connectLegacy`: the older protocol (the 2025 handshake). It can read; it cannot be asked
 *     a question, so it is never offered a change.
 *   - `connectModern`: the current protocol (2026-07-28), which carries a question to the person
 *     and their answer back. `answer` plays the person.
 *   - `rawToolCall`: the current protocol by hand, for what a well-behaved client would never
 *     send: an answer with no note, a note used twice, a note carried to another key.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type App, type StaffPrincipal, setModule } from '@ros/core';
import type { Fixture } from '@ros/fixtures';
import { hub } from '@ros/modules';

export const MCP_URL = 'http://console.rosplatform.test/api/mcp';

export function hubFetch(app: App): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => hub.handleMcpRequest(app, input instanceof Request ? input : new Request(input, init), { ip: '203.0.113.9' });
}

export interface ToolSummary {
  name: string;
  title?: string;
  description?: string;
  readOnly: boolean | undefined;
  hasOutputShape: boolean;
  inputProperties: string[];
}

export interface ToolAnswer {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
}

export interface McpSession {
  serverName: string | undefined;
  instructions: string | undefined;
  tools(): Promise<ToolSummary[]>;
  names(): Promise<string[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolAnswer>;
  readCatalogue(): Promise<string>;
  close(): Promise<void>;
}

type Listed = { name: string; title?: string; description?: string; annotations?: { readOnlyHint?: boolean }; outputSchema?: unknown; inputSchema: unknown };
const summarise = (tools: Listed[]): ToolSummary[] =>
  tools.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    readOnly: t.annotations?.readOnlyHint,
    hasOutputShape: !!t.outputSchema,
    inputProperties: Object.keys((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}),
  }));
const answerOf = (result: { content?: unknown; isError?: unknown; structuredContent?: unknown }): ToolAnswer => {
  const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
  return {
    isError: result.isError === true,
    text: content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n'),
    structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
  };
};

function session(client: Client): McpSession {
  return {
    serverName: client.getServerVersion()?.name,
    instructions: client.getInstructions(),
    async tools() {
      const { tools } = await client.listTools(undefined, { cacheMode: 'bypass' });
      return summarise(tools as Listed[]);
    },
    async names() {
      return (await this.tools()).map((t) => t.name).sort();
    },
    async call(name, args = {}) {
      return answerOf(await client.callTool({ name, arguments: args }));
    },
    async readCatalogue() {
      const r = await client.readResource({ uri: hub.CATALOGUE_URI });
      return (r.contents as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
    },
    close: () => client.close(),
  };
}

export async function connectLegacy(app: App, key: string | null): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
    fetch: hubFetch(app) as never,
  });
  const client = new Client({ name: 'ros-test-legacy', version: '1.0.0' });
  await client.connect(transport);
  return session(client);
}

/** What the person says when the assistant puts the question to them. */
export type PersonSays = 'yes' | 'no' | 'cancel' | 'unticked';

export interface ModernSession extends McpSession {
  era: string | undefined;
  /** Every question the person was shown, in order. */
  asked: string[];
}

export async function connectModern(app: App, key: string | null, opts: { canAsk?: boolean; answer?: (question: string) => PersonSays } = {}): Promise<ModernSession> {
  const canAsk = opts.canAsk !== false;
  const asked: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
    fetch: hubFetch(app) as never,
  });
  const client = new Client({ name: 'ros-test', version: '2.0.0' }, { capabilities: canAsk ? { elicitation: { form: {} } } : {}, versionNegotiation: { mode: 'auto' } });
  if (canAsk) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const question = String((request.params as { message?: unknown }).message ?? '');
      asked.push(question);
      const says = opts.answer ? opts.answer(question) : 'cancel';
      if (says === 'yes') return { action: 'accept' as const, content: { confirm: true } };
      if (says === 'unticked') return { action: 'accept' as const, content: { confirm: false } };
      return { action: says === 'no' ? ('decline' as const) : ('cancel' as const) };
    });
  }
  await client.connect(transport);
  return { ...session(client), era: client.getProtocolEra(), asked };
}

export interface RawAnswer {
  http: number;
  /** A finished tool result, when there was one. */
  answer: ToolAnswer | null;
  /** The question and the note, when the tool asked instead of answering. */
  asking: { question: string; requestState: string } | null;
  /** A protocol error, when the request itself was refused. */
  error: { code: number; message: string } | null;
}

let rawId = 1000;

export const YES = { confirm: { action: 'accept', content: { confirm: true } } };
export const NO = { confirm: { action: 'decline' } };

/** One `tools/call` on the current protocol, written out by hand. */
export async function rawToolCall(
  app: App,
  key: string | null,
  name: string,
  args: Record<string, unknown>,
  extra: { inputResponses?: Record<string, unknown>; requestState?: string; canAsk?: boolean } = {},
): Promise<RawAnswer> {
  const res = await hubFetch(app)(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      // The current protocol says the tool's name twice, and refuses a request whose header and body disagree.
      'Mcp-Name': name,
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rawId++,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        ...(extra.inputResponses ? { inputResponses: extra.inputResponses } : {}),
        ...(extra.requestState !== undefined ? { requestState: extra.requestState } : {}),
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'ros-test-raw', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': extra.canAsk === false ? {} : { elicitation: { form: {} } },
        },
      },
    }),
  });
  const text = await res.text();
  // A reply is one JSON document, or the same inside a single event.
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  let message: { result?: Record<string, unknown>; error?: { code: number; message: string } } = {};
  try {
    message = JSON.parse(data ? data.slice(5) : text) as typeof message;
  } catch {
    return { http: res.status, answer: null, asking: null, error: { code: 0, message: text.slice(0, 200) } };
  }
  if (message.error) return { http: res.status, answer: null, asking: null, error: message.error };
  const result = message.result ?? {};
  if (result.resultType === 'input_required') {
    const requests = (result.inputRequests ?? {}) as Record<string, { params?: { message?: unknown } }>;
    return { http: res.status, answer: null, error: null, asking: { question: String(requests.confirm?.params?.message ?? ''), requestState: String(result.requestState ?? '') } };
  }
  return { http: res.status, answer: answerOf(result), asking: null, error: null };
}

/** Create a key as a signed-in member of staff would in the console. */
export async function issueKey(app: App, orgId: string, staff: StaffPrincipal, input: Partial<hub.CreateAgentKeyInput> & { scopes: string[] }): Promise<{ key: string; id: string }> {
  const made = await app.tenant(orgId, staff, (ctx) => hub.createAgentKey(ctx, { name: 'Test assistant', expiresInDays: 30, ...input }));
  return { key: made.key, id: made.view.id };
}

/** The fixture venues allow five keys a person. A test file makes more than that, so it raises the cap first. */
export async function roomForKeys(app: App, fixture: Fixture): Promise<void> {
  for (const org of [fixture.diner, fixture.group]) {
    await app.tenant(org.orgId, { kind: 'worker', job: 'test' }, async (ctx) => {
      for (const venue of Object.values(org.venues)) await setModule(ctx, hub.hubModule, { venueId: venue.id, config: { max_keys_per_staff: 50 } });
    });
  }
}
