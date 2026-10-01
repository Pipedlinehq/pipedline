import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client';
import { type ConnectionHandle, type RemoteMcpAdapter, type RemoteMcpResult, type RemoteMcpTool, RemoteMcpAuthError } from '@ros/core';

export interface HttpRemoteMcpOptions {
  /** The adapter key a plug names in `adapters.remote_mcp`. */
  key: string;
  /**
   * The remote server's address. Fixed here, at the composition root, and never read from a
   * connection's config: a venue must not be able to point our servers at an address of its choosing.
   */
  url: string;
  /** True when the remote server asks before every change, so a declined call is a safe preview. */
  asksBeforeWriting?: boolean;
  /** Replaced in tests and by the simulators; global fetch otherwise. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  clientName?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The one boolean a confirmation form asks for, or null when the form asks for anything else. */
function soleBoolean(schema: unknown): string | null {
  const props = (schema as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties;
  if (!props) return null;
  const names = Object.keys(props);
  if (names.length !== 1) return null;
  return props[names[0]!]?.type === 'boolean' ? names[0]! : null;
}

function bearerOf(conn: ConnectionHandle): string {
  const token = conn.credentials.token ?? conn.credentials.accessKey ?? conn.credentials.access_token;
  if (!token) throw new RemoteMcpAuthError('The connection holds no access key.');
  return token;
}

/**
 * A remote MCP server over Streamable HTTP, with the connection's access key as the bearer
 * token. One short-lived client per call: nothing is kept between calls, so any instance can
 * make any call. It declares that it can put a question to a person, because the hub's gateway
 * does exactly that (docs/modules/hub.md section 2.4): without it a server such as Criota's
 * offers no change at all.
 */
export function createHttpRemoteMcpAdapter(opts: HttpRemoteMcpOptions): RemoteMcpAdapter {
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function withClient<T>(conn: ConnectionHandle, answer: ((question: string) => boolean | Promise<boolean>) | undefined, asked: string[], fn: (client: Client) => Promise<T>): Promise<T> {
    const token = bearerOf(conn);
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
      authProvider: { token: async () => token },
      ...(opts.fetch ? { fetch: opts.fetch as never } : {}),
    });
    const client = new Client(
      { name: opts.clientName ?? 'restaurant-os-gateway', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } }, versionNegotiation: { mode: 'auto' } },
    );
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as { message?: unknown; requestedSchema?: unknown };
      const question = String(params.message ?? '');
      asked.push(question);
      const field = soleBoolean(params.requestedSchema);
      // A form that asks for more than a yes cannot be answered from here.
      if (!field || !answer) return { action: 'decline' as const };
      return (await answer(question)) ? { action: 'accept' as const, content: { [field]: true } } : { action: 'decline' as const };
    });
    try {
      await client.connect(transport, { timeout });
      return await fn(client);
    } catch (e) {
      if (e instanceof UnauthorizedError || (e as { status?: number }).status === 401) throw new RemoteMcpAuthError();
      throw e;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return {
    key: opts.key,
    asksBeforeWriting: opts.asksBeforeWriting ?? false,

    async listTools(conn, o = {}) {
      return withClient(conn, undefined, [], async (client) => {
        const { tools } = await client.listTools(undefined, { timeout: o.timeoutMs ?? timeout, cacheMode: 'bypass' });
        return tools.map((t): RemoteMcpTool => {
          const tool = t as { name: string; title?: string; description?: string; inputSchema: unknown; outputSchema?: unknown; annotations?: RemoteMcpTool['annotations'] };
          return {
            name: tool.name,
            ...(tool.title !== undefined ? { title: tool.title } : {}),
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          };
        });
      });
    },

    async callTool(conn, name, args, o = {}) {
      const asked: string[] = [];
      return withClient(conn, o.answer, asked, async (client): Promise<RemoteMcpResult> => {
        const budget = o.timeoutMs ?? timeout;
        const result = (await client.callTool({ name, arguments: args }, { timeout: budget, maxTotalTimeout: budget * 2 })) as {
          content?: unknown;
          isError?: unknown;
          structuredContent?: unknown;
        };
        const content = Array.isArray(result.content) ? (result.content as Array<{ type: string; text?: string }>) : [];
        return {
          isError: result.isError === true,
          text: content
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('\n'),
          structured: result.structuredContent ?? null,
          asked,
        };
      });
    },
  };
}
