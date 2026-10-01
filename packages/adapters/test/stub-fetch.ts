/** A fetch that answers from a handler and records what it was asked. No network. */
export interface StubCall {
  method: string;
  url: URL;
  path: string;
  headers: Record<string, string>;
  /** The raw body as sent. */
  raw: string;
  /** The body parsed as JSON, or as a form, or null. */
  body: any;
}

export type StubAnswer = { status?: number; body?: unknown } | undefined;

export function stubFetch(handler: (call: StubCall) => StubAnswer) {
  const calls: StubCall[] = [];
  const fetch = (async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: any = null;
    if (raw) {
      if ((headers['content-type'] ?? '').includes('json')) body = JSON.parse(raw);
      else body = Object.fromEntries(new URLSearchParams(raw));
    }
    const call: StubCall = { method: init?.method ?? 'GET', url, path: url.pathname, headers, raw, body };
    calls.push(call);
    const answer = handler(call) ?? { status: 500, body: { error: 'unhandled' } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
